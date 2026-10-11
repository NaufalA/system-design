# API Design — ppob-service

Owns the PPOB transaction lifecycle, the PPOB product catalog (Letslink feed + admin overrides), catalogue configuration, Letslink integration (balance check, purchase, product sync), failure unwinds, and completion notifications. Global conventions live in [`api/README.md`](../README.md).

## Base URL

Internal only — no public exposure. Consumed over the internal network by `bff-mobile`, `bff-admin`, `bnpl-service`.

## Auth

- Issued by: company PKI / certificate authority (per company standard) — every caller service holds a client certificate.
- Credential: client certificate (mTLS).
- Transport: **mutual TLS at the transport layer only** — no auth headers, no tokens.
- Validation: the caller's client certificate is verified during the TLS handshake, before any application code runs. No customer JWT ever reaches this service.
- Downstream: outbound calls use this service's own mTLS identity; where customer context is needed, calling BFFs pass the resolved internal user id with the request (application-level context, not authentication).

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |
| PPOB catalogue configuration | Admin-defined catalogues (`catalogueType` identifier, name, icon, order, visibility) | `GET /api/v1/ppob/catalogues`; `GET /api/v1/ppob/catalogues/{catalogueType}`; admin CRUD _(story 07)_ |
| Customer identification | One stateless method per identifier type — `identifyMeter` (Letslink validation) and `identifyPhoneNumber` (in-house prefix table); both return the identify core | `POST /api/v1/ppob/identifyMeter`, `POST /api/v1/ppob/identifyPhoneNumber` |
| Phone-prefix → provider table | In-house mapping used to identify data-package numbers (static config for pilot; admin management TBD in story 07 scope) | consumed by `identifyPhoneNumber` (below) |
| PPOB product catalog | Products from Letslink feed with admin price/enable overrides | `GET /api/v1/ppob/catalogues/{catalogueType}/products`, admin overrides _(story 07)_ |
| PPOB transactions | Lifecycle: pending → delivered / failed; Letslink refs, token code | execution _(story 04)_, detail reads _(story 05/06)_ |
| Letslink balance & purchase | Integration facade to the aggregator | balance check, purchase _(story 04)_ |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |
| PPOB product feed | Letslink (external) | Periodic sync (REST) for base product/pricing data | 02, 03, 07 |
| Customer/meter validation | Letslink (external) | Sync REST for electricity meter validation (customer identity + meter specs) | 02, 04 |
| Deposit balance | Letslink (external) | Sync REST balance check | 04 |
| PPOB purchase | Letslink (external) | Sync REST purchase call | 04 |
| BNPL limit refund + order cancellation | bnpl-service | Sync REST, initiated on purchase failure | 06 |
| Push notification delivery | notification-service | Fire-and-forget call on completion/failure | 08 |

## Endpoints

### Resource: PPOB catalogue configuration

`catalogueType` is the resource identifier (AIP-style name substitution) — configured by admin alongside the other catalogue fields and consistent across every layer (admin config, BFF paths, microservice paths, payloads). See `api/README.md` for naming semantics.

#### List catalogues

`GET /api/v1/ppob/catalogues`

Returns the active, visible catalogues, ordered by `order`, paginated.

| | |
| --- | --- |
| Derived from story | 01-browse-catalogues |
| Auth | service-to-service |

**Flow**

1. Read catalogue configuration; keep only rows with `isActive = true` (`showInactive=true` relaxes the filter for admin-originated calls).
2. Sort by `order` ascending.
3. Slice `page`/`size`; compute `totalRows` and `totalPage`.
4. Return the wrapper with the paginated `result`.

**Request**

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 0 | 0-based page index |
| size | int | 20 | Page size |
| showInactive | bool | false | Honored only for admin-originated calls; forced `false` for customer-originated calls |

_No path params. No request body._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each catalogue item:

| Field | Type | Notes |
| --- | --- | --- |
| catalogueType | string | The single catalogue identifier — path segment in every catalogue-scoped endpoint |
| name | string | Display name |
| icon | string | Icon URL |
| order | int | Sort position (ascending) |
| isActive | bool | Always `true` here — inactive/hidden catalogues are never returned on customer calls |

**Example**

```
GET /api/v1/ppob/catalogues?page=0&size=20
```

```json
{
  "response": 200,
  "message": "Catalogues retrieved successfully",
  "result": {
    "page": 0,
    "size": 20,
    "totalRows": 1,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "electricity-token",
        "name": "Electricity Token",
        "icon": "https://cdn.example/ppob/electricity.svg",
        "order": 1,
        "isActive": true
      }
    ]
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 500 | Internal failure reading config | `INTERNAL: ...` |

#### Get catalogue

`GET /api/v1/ppob/catalogues/{catalogueType}`

Reads a single catalogue configuration by identifier.

| | |
| --- | --- |
| Derived from story | 01-browse-catalogues; 07-admin-catalog-management |
| Auth | service-to-service |

**Flow**

1. Look up the catalogue by `catalogueType` → unknown → `404`.
2. Disabled catalogue (`isActive = false`) with `showInactive=false` → `404` (same not-found behavior).
3. Return the catalogue as `result`.

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown |

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| showInactive | bool | false | When `true`, allows reading a disabled catalogue |

_No request body._

**Response**

`result` is one catalogue item with the same fields as [List catalogues](#list-catalogues) (`catalogueType`, `name`, `icon`, `order`, `isActive`).

**Example**

```
GET /api/v1/ppob/catalogues/electricity-token
```

```json
{
  "response": 200,
  "message": "Catalogue retrieved successfully",
  "result": {
    "catalogueType": "electricity-token",
    "name": "Electricity Token",
    "icon": "https://cdn.example/ppob/electricity.svg",
    "order": 1,
    "isActive": true
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 404 | Unknown `catalogueType` (or disabled without `showInactive`) | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure reading config | `INTERNAL: ...` |

### Resource: customer identification

Two stateless custom methods (regular `/` path, camelCase verb, POST) with typed request signatures — one per identifier type. Both responses follow the uniform identify core (`valid`, `identifierType`, `customerId` + typed `details` — per [`api/README.md`](../README.md#identify-response-core)). Responses do **not** carry `catalogueType` — one method may serve multiple catalogues (`identifyMeter` also serves a future `electricity-postpaid`).

#### Identify meter

`POST /api/v1/ppob/identifyMeter`

Validates an electricity customer/meter number against Letslink and returns the identify core with meter details.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 04-buy-with-bnpl |
| Auth | service-to-service |

**Flow**

1. Reject with `400` if `meterNumber` is missing/blank.
2. Forward the meter number to **Letslink** customer/meter validation (external REST).
3. Map the Letslink response to the identify core — `identifierType: METER_NUMBER`, `customerId` = submitted `meterNumber`, `details = { customerName, wattage, meterSpecs }` (wattage extracted from meter specs).
4. Letslink unreachable/erroring → `503 UPSTREAM_UNAVAILABLE`. Meter rejected by Letslink (invalid/inactive) → return `200` with `valid: false` and the reason in `message`.
5. Otherwise → `200` with `valid: true`.

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| meterNumber | string | yes | The meter/customer ID entered for identification |

**Response**

`result` is the identify core plus meter `details`:

| Field | Type | Notes |
| --- | --- | --- |
| valid | bool | The checkout gate. `false` → reason in `message`, `details` may be empty |
| identifierType | string | Constant `METER_NUMBER` |
| customerId | string | Echo of the submitted `meterNumber` |
| details.customerName | string | Customer identity as known by Letslink |
| details.wattage | int | Meter wattage — carried into checkout and passed to Letslink at purchase, where the provider backend mints the token value (kWh) for that wattage. **Not** a product-list filter |
| details.meterSpecs | object | Meter specifications (e.g. `power`, `installationDate`) |

**Example**

```json
{ "meterNumber": "5432176543" }
```

```json
{
  "response": 200,
  "message": "Customer identified successfully",
  "result": {
    "valid": true,
    "identifierType": "METER_NUMBER",
    "customerId": "5432176543",
    "details": {
      "customerName": "SKU. 5432176543",
      "wattage": 2200,
      "meterSpecs": { "power": "2200VA", "installationDate": "2019-04-01" }
    }
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 200 + `valid: false` | Rejected meter (invalid/inactive) | reason |
| 400 | Missing/blank `meterNumber` | `BAD_REQUEST: meterNumber is required` |
| 503 | Letslink unavailable | `UPSTREAM_UNAVAILABLE: ...` |
| 500 | Internal failure | `INTERNAL: ...` |

#### Identify phone number

`POST /api/v1/ppob/identifyPhoneNumber`

Resolves a mobile number to its provider via an in-house prefix lookup against the phone-prefix → provider table — no external call.

| | |
| --- | --- |
| Derived from story | 03-browse-data-package; 04-buy-with-bnpl |
| Auth | service-to-service |

**Flow**

1. Reject with `400` if `phoneNumber` is missing/blank.
2. Look up the number's prefix in the phone-prefix → provider table (longest-match).
3. Match → `valid: true`, `identifierType: PHONE_NUMBER`, `customerId` = submitted `phoneNumber`, `details = { providerCode, providerName }`.
4. No match → `200` with `valid: false` and the reason in `message`.
5. Internal failure → `500`.

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| phoneNumber | string | yes | The phone number entered for identification |

**Response**

`result` is the identify core plus provider `details`:

| Field | Type | Notes |
| --- | --- | --- |
| valid | bool | The checkout gate. `false` (unrecognized prefix) → reason in `message` |
| identifierType | string | Constant `PHONE_NUMBER` |
| customerId | string | Echo of the submitted `phoneNumber` |
| details.providerCode | string | Provider code — used as the `mobile-data` products filter; advisory only, re-derived server-side at purchase |
| details.providerName | string | Display name of the provider |

**Example**

```json
{ "phoneNumber": "081234567890" }
```

```json
{
  "response": 200,
  "message": "Customer identified successfully",
  "result": {
    "valid": true,
    "identifierType": "PHONE_NUMBER",
    "customerId": "081234567890",
    "details": {
      "providerCode": "TSEL",
      "providerName": "Telkomsel"
    }
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 200 + `valid: false` | Unrecognized number prefix | reason |
| 400 | Missing/blank `phoneNumber` | `BAD_REQUEST: phoneNumber is required` |
| 500 | Internal failure | `INTERNAL: ...` |

### Resource: PPOB product catalog

#### List products

`GET /api/v1/ppob/catalogues/{catalogueType}/products`

Returns the products of one catalogue — Letslink feed base data with admin override (`price`, `isActive`) applied, sorted by display order, paginated. Filtering is per catalogue: `electricity-token` is never filtered (identical price for all; wattage handled at purchase by the provider backend), while `mobile-data` requires `providerCode` — an unfiltered data list is never served.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 03-browse-data-package; 07-admin-catalog-management |
| Auth | service-to-service |

**Flow**

1. Resolve `catalogueType` → unknown or inactive catalogue → `404`.
2. Apply the catalogue's filter rule:
   - `mobile-data` → `providerCode` required; missing → `400`.
   - `electricity-token` → no filter (`providerCode` ignored).
3. Read the feed products for the catalogue; apply admin overrides (`price`, `isActive` → `hasOverride`); drop `isActive = false` rows unless `showInactive=true` (admin-originated calls only).
4. Sort by display order; slice `page`/`size`; compute `totalRows` and `totalPage`.
5. Return the wrapper with the paginated `result`.

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown or inactive |

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 0 | 0-based page index |
| size | int | 20 | Page size |
| showInactive | bool | false | Honored only for admin-originated calls; forced `false` for customer-originated calls |
| providerCode | string | — | **Required for `mobile-data`** (`400` without it). Ignored for `electricity-token`. Advisory only — re-derived server-side at purchase (never trusted to authorize a purchase) |

_No request body._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each product item:

| Field | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Owning catalogue identifier |
| id | string | Product id |
| name | string | Display name |
| operator | string | Provider/operator display (e.g. `PLN`, `Telkomsel`) |
| denomination | int | `electricity-token` only — nominal token value (IDR) |
| packageSize | string | `mobile-data` only — package size/duration (e.g. `10 GB`) |
| basePrice | int | Letslink feed base price |
| price | int | Sale price (override applied over `basePrice`) |
| hasOverride | bool | Whether an admin override is active |
| isActive | bool | Always `true` for customer calls; `false` rows only via admin calls with `showInactive` |

**Example**

```
GET /api/v1/ppob/catalogues/electricity-token/products?page=0&size=20
```

```json
{
  "response": 200,
  "message": "Products retrieved successfully",
  "result": {
    "page": 0,
    "size": 20,
    "totalRows": 1,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "electricity-token",
        "id": "prod-pln-200",
        "name": "PLN Token 200.000",
        "operator": "PLN",
        "denomination": 200000,
        "basePrice": 200000,
        "price": 205000,
        "hasOverride": true,
        "isActive": true
      }
    ]
  }
}
```

```
GET /api/v1/ppob/catalogues/mobile-data/products?providerCode=TSEL&page=0&size=20
```

```json
{
  "response": 200,
  "message": "Products retrieved successfully",
  "result": {
    "page": 0,
    "size": 20,
    "totalRows": 1,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "mobile-data",
        "id": "prod-tsel-10gb",
        "name": "Telkomsel 10 GB 30 days",
        "operator": "Telkomsel",
        "packageSize": "10 GB",
        "basePrice": 110000,
        "price": 115000,
        "hasOverride": true,
        "isActive": true
      }
    ]
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 400 | `mobile-data`: `providerCode` not supplied | `BAD_REQUEST: providerCode is required` |
| 404 | Unknown/inactive `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure | `INTERNAL: ...` |

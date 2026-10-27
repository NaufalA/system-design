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
| Customer identifications | Previously identified identifiers (meter numbers / phone numbers) with typed details and last-used time; upserted as a side effect of a successful full-number identify | `GET /api/v1/ppob/customer-identifications`; `POST /api/v1/ppob/customer-identifications/identifyMeter`; `POST /api/v1/ppob/customer-identifications/identifyPhoneNumber` |
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

Returns the active, visible catalogues, paginated.

| | |
| --- | --- |
| Derived from story | 01-browse-catalogues |
| Auth | service-to-service |

**Flow**

1. Read catalogue configuration; keep only rows with `isActive = true` (`showInactive=true` includes inactive rows as well — honored unconditionally; caller-type restrictions are enforced by the calling BFF).
2. Apply `orderBy` if supplied (e.g. `order ASC`); no default order — database order when `orderBy` is omitted.
3. Slice `page`/`size`; compute `totalRows` and `totalPage`.
4. Return the wrapper with the paginated `result`.

**Request**

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 1 | 1-based page index |
| size | int | 20 | Page size |
| orderBy | string | — | Comma-separated `fieldName ORDER` (`ASC`\|`DESC`, required per entry), e.g. `order ASC,catalogueType ASC`; unknown field/malformed → `400`. No default order |
| showInactive | bool | false | When `true`, inactive rows are included; honored unconditionally — which callers may pass it is a BFF-layer concern |

_No path params. No request body._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each catalogue item:

| Field | Type | Notes |
| --- | --- | --- |
| catalogueType | string | The single catalogue identifier — path segment in every catalogue-scoped endpoint |
| name | string | Display name |
| icon | string | Icon URL |
| order | int | Admin-defined sort position (ascending) — applied only via `orderBy=order ASC` |
| createdDate | string | ISO 8601 (timestamptz) |
| updatedDate | string | ISO 8601 (timestamptz) |
| createdBy | string | Actor (≤ 50 chars) |
| updatedBy | string | Actor (≤ 50 chars) |
| isActive | bool | `true` unless the row is soft-deleted (`false` rows appear only when `showInactive=true`) |

**Example**

```
GET /api/v1/ppob/catalogues?page=1&size=20&orderBy=order ASC
```

```json
{
  "response": 200,
  "message": "Catalogues retrieved successfully",
  "result": {
    "page": 1,
    "size": 20,
    "totalRows": 1,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "electricity-token",
        "name": "Electricity Token",
        "icon": "https://cdn.example/ppob/electricity.svg",
        "order": 1,
        "createdDate": "2026-10-01T03:00:00Z",
        "updatedDate": "2026-10-05T07:15:00Z",
        "createdBy": "admin.andi",
        "updatedBy": "admin.andi",
        "isActive": true
      }
    ]
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 400 | Unknown `orderBy` field or malformed entry | `BAD_REQUEST: invalid orderBy` |
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
2. Return the catalogue as `result` regardless of `isActive` (soft-deleted resources remain readable; only unknown identifiers 404).

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown |

_No request body. No query params._

**Response**

`result` is one catalogue item with the same fields as [List catalogues](#list-catalogues) (`catalogueType`, `name`, `icon`, `order`, `createdDate`, `updatedDate`, `createdBy`, `updatedBy`, `isActive`).

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
    "createdDate": "2026-10-01T03:00:00Z",
    "updatedDate": "2026-10-05T07:15:00Z",
    "createdBy": "admin.andi",
    "updatedBy": "admin.andi",
    "isActive": true
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure reading config | `INTERNAL: ...` |

### Resource: customer identifications

A persistent collection of the customer's previously identified identifiers (meter numbers / phone numbers), keyed by `(userId, identifierType, customerId)`. Entries are **created only after a successful purchase transaction** (story 04 background chain) — never on identify. `details` are stored from the transaction's identification result and not updated on repeat (only `lastUsedDate` moves). Identification history is soft-deleted like any other resource; reads default to active rows.

#### List customer identifications

`GET /api/v1/ppob/customer-identifications`

Returns the caller's previously identified identifiers, paginated, most-recently-used first. Filtering is per identifier type: the caller (via the BFF) passes `identifierType` derived from the catalogue being entered, so a catalogue screen only shows identifiers of the matching type.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 03-browse-data-package |
| Auth | service-to-service |

**Flow**

1. Resolve the caller's internal user id from the request context (passed by the BFF) → missing → `401`.
2. Read `identifierType` filter (optional) → invalid value → `400`.
3. Read the customer-identification rows for `userId`, applying the `identifierType` filter and `isActive` filter (`showInactive` relaxes it — honored unconditionally; caller-type restrictions are the BFF's).
4. Apply `orderBy` if supplied (default `lastUsedDate DESC`); no default order beyond that — database order when `orderBy` is omitted. Slice `page`/`size`; compute `totalRows` and `totalPage`.
5. Return the wrapper with the paginated `result`.

**Request**

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 1 | 1-based page index |
| size | int | 20 | Page size |
| orderBy | string | `lastUsedDate DESC` | Comma-separated `fieldName ORDER` (`ASC`\|`DESC`); unknown field/malformed → `400` |
| identifierType | string | — | Filter: `METER_NUMBER` or `PHONE_NUMBER`. Supplied by the BFF from the catalogue's first part |
| showInactive | bool | false | When `true`, soft-deleted rows are included; honored unconditionally (caller-type restrictions are the BFF's) |

_No path params. No request body._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each identification item:

| Field | Type | Notes |
| --- | --- | --- |
| id | string | Identification record id |
| identifierType | string | `METER_NUMBER` or `PHONE_NUMBER` |
| customerId | string | The meter number / phone number |
| details | object | Typed details from the last successful identify (meter: `{customerName, wattage, meterSpecs}`; phone: `{providerCode, providerName}`) |
| lastUsedDate | string | ISO 8601 (timestamptz) — updated on every successful transaction that uses this identifier |
| createdDate | string | ISO 8601 (timestamptz) |
| updatedDate | string | ISO 8601 (timestamptz) |
| createdBy | string | Actor (≤ 50 chars) — the `userId` |
| updatedBy | string | Actor (≤ 50 chars) — the `userId` |
| isActive | bool | Soft-delete flag |

**Example**

```
GET /api/v1/ppob/customer-identifications?identifierType=METER_NUMBER&page=1&size=20&orderBy=lastUsedDate DESC
```

```json
{
  "response": 200,
  "message": "Customer identifications retrieved successfully",
  "result": {
    "page": 1,
    "size": 20,
    "totalRows": 1,
    "totalPage": 1,
    "data": [
      {
        "id": "ci-001",
        "identifierType": "METER_NUMBER",
        "customerId": "5432176543",
        "details": { "customerName": "SKU. 5432176543", "wattage": 2200, "meterSpecs": { "power": "2200VA" } },
        "lastUsedDate": "2026-10-20T09:15:00Z",
        "createdDate": "2026-10-01T03:00:00Z",
        "updatedDate": "2026-10-20T09:15:00Z",
        "createdBy": "user-123",
        "updatedBy": "user-123",
        "isActive": true
      }
    ]
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 400 | Invalid `identifierType` | `BAD_REQUEST: invalid identifierType` |
| 400 | Unknown `orderBy` field or malformed entry | `BAD_REQUEST: invalid orderBy` |
| 500 | Internal failure reading identifications | `INTERNAL: ...` |

#### Identify phone number

`POST /api/v1/ppob/customer-identifications/identifyPhoneNumber`

Resolves a mobile number to its provider via an in-house prefix lookup against the phone-prefix → provider table — no external call. The prefix lookup runs for inputs of **at least 4 digits** (the minimum needed to resolve a provider prefix); persistence happens only when the number is **full and valid** (length > 10 and prefix matched) — as a background side effect.

| | |
| --- | --- |
| Derived from story | 03-browse-data-package; 04-buy-with-bnpl |
| Auth | service-to-service |

**Flow**

1. Reject with `400` if `phoneNumber` is missing/blank, or shorter than 4 digits.
2. Look up the number's prefix in the phone-prefix → provider table (longest-match).
3. Match → `valid: true`, `identifierType: PHONE_NUMBER`, `customerId` = submitted `phoneNumber`, `details = { providerCode, providerName }`.
4. No match → `200` with `valid: false` and the reason in `message`.
5. Internal failure → `500`.
_No background history write here — identification history is recorded only after a successful purchase transaction (story 04 background chain), not on identify._

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| phoneNumber | string | yes | The phone number entered for identification (minimum 4 digits) |

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
| 400 | Missing/blank `phoneNumber`, or fewer than 4 digits | `BAD_REQUEST: phoneNumber must be at least 4 digits` |
| 500 | Internal failure | `INTERNAL: ...` |

### Resource: PPOB product catalog

#### List products

`GET /api/v1/ppob/catalogues/{catalogueType}/products`

Returns the products of one catalogue — Letslink feed base data with admin override (`price`, `isActive`) applied, paginated. Filtering is per catalogue: `electricity-token` is never filtered (identical price for all; wattage handled at purchase by the provider backend), while `mobile-data` requires `providerCode` — an unfiltered data list is never served.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 03-browse-data-package; 07-admin-catalog-management |
| Auth | service-to-service |

**Flow**

1. Resolve `catalogueType` → unknown or inactive catalogue → `404`.
2. Apply the catalogue's filter rule:
   - `mobile-data` → `providerCode` required; missing → `400`.
   - `electricity-token` → no filter (`providerCode` ignored).
3. Read the feed products for the catalogue; apply admin overrides (`price`, `isActive` → `hasOverride`); drop `isActive = false` rows unless `showInactive=true` (honored unconditionally; caller-type restrictions are enforced by the calling BFF).
4. Apply `orderBy` if supplied (e.g. `displayOrder ASC`); no default order — database order when `orderBy` is omitted. Slice `page`/`size`; compute `totalRows` and `totalPage`.
5. Return the wrapper with the paginated `result`.

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown or inactive |

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 1 | 1-based page index |
| size | int | 20 | Page size |
| orderBy | string | — | Comma-separated `fieldName ORDER` (`ASC`\|`DESC`, required per entry), e.g. `displayOrder ASC`; unknown field/malformed → `400`. No default order |
| showInactive | bool | false | When `true`, inactive rows are included; honored unconditionally — which callers may pass it is a BFF-layer concern |
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
| displayOrder | int | Feed display order (ascending) — the basis for `orderBy=displayOrder ASC` |
| createdDate | string | ISO 8601 (timestamptz) — feed sync / override creation |
| updatedDate | string | ISO 8601 (timestamptz) |
| createdBy | string | Actor (≤ 50 chars) — caller-supplied at creation; `"system"` for feed-synced rows |
| updatedBy | string | Actor (≤ 50 chars) — caller-supplied on override |
| isActive | bool | `true` unless the row is soft-deleted (`false` rows appear only when `showInactive=true`) |

**Example**

```
GET /api/v1/ppob/catalogues/electricity-token/products?page=1&size=20&orderBy=displayOrder ASC
```

```json
{
  "response": 200,
  "message": "Products retrieved successfully",
  "result": {
    "page": 1,
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
        "displayOrder": 1,
        "createdDate": "2026-10-01T03:00:00Z",
        "updatedDate": "2026-10-05T07:15:00Z",
        "createdBy": "system",
        "updatedBy": "admin.andi",
        "isActive": true
      }
    ]
  }
}
```

```
GET /api/v1/ppob/catalogues/mobile-data/products?providerCode=TSEL&page=1&size=20
```

```json
{
  "response": 200,
  "message": "Products retrieved successfully",
  "result": {
    "page": 1,
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
        "displayOrder": 1,
        "createdDate": "2026-10-01T03:00:00Z",
        "updatedDate": "2026-10-01T03:00:00Z",
        "createdBy": "system",
        "updatedBy": "system",
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
| 400 | Unknown `orderBy` field or malformed entry | `BAD_REQUEST: invalid orderBy` |
| 404 | Unknown/inactive `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure | `INTERNAL: ...` |

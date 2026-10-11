# API Design — bff-mobile

Backend-for-frontend for `mobile-app`: authenticates the customer JWT, orchestrates PPOB browse/checkout flows, and aggregates data from backend services. Holds no PPOB business data. Global conventions live in [`api/README.md`](../README.md).

## Base URL

Exposed to `mobile-app` through the **public API gateway**:

`https://<gateway-host>/bff-mobile/v1/...`

The gateway terminates TLS and routes `/bff-mobile/**` to this BFF; the path convention (`/bff-mobile/v1/...`) is unchanged behind it.

## Auth

- Issued by: `user-service` — the existing customer session JWT.
- Credential: JWT.
- Transport: `Authorization: Bearer <JWT>` header on every request — presented to the public API gateway and forwarded unchanged to this BFF.
- Validation: at this BFF (the gateway only routes) — signature, expiry, session revocation; invalid/expired → `401` without calling any downstream service.
- Downstream: the BFF resolves the internal user id and injects it into its service-to-service calls; the customer JWT is never forwarded to microservices.

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |
| PPOB catalogues (view) | Customer-facing catalogue list | `GET /bff-mobile/v1/ppob/catalogues` |
| Customer identification | Shared identify step for all catalogues — uniform identify core + `catalogueType` | `POST /bff-mobile/v1/ppob/catalogues/{catalogueType}/identify` |
| PPOB products (view) | Product catalog per catalogue (`electricity-token`, `mobile-data`) | `GET /bff-mobile/v1/ppob/catalogues/{catalogueType}/products` |
| PPOB checkout orchestration | Draft creation, submission of a PPOB purchase | _(defined with story 04)_ |
| PPOB transaction history (view) | Order history aggregated from `sales-portal-service` + `ppob-service` | _(defined with story 05)_ |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |
| JWT authentication / session | user-service | Token validation for every inbound request (existing auth mechanism) | — |
| PPOB catalogue configuration | ppob-service | Sync REST `GET /api/v1/ppob/catalogues` (`catalogueType` passed through — no id mapping) | 01 |
| PPOB product catalog | ppob-service | Sync REST `GET /api/v1/ppob/catalogues/{catalogueType}/products` | 02, 03 |
| Meter identification | ppob-service | Sync REST `POST /api/v1/ppob/identifyMeter` (Letslink validation) | 02 |
| Phone number identification | ppob-service | Sync REST `POST /api/v1/ppob/identifyPhoneNumber` (in-house prefix lookup) | 03 |

## Endpoints

### Resource: PPOB catalogues

#### List catalogues

`GET /bff-mobile/v1/ppob/catalogues`

Returns the customer-facing catalogue list, active-only, paginated.

| | |
| --- | --- |
| Derived from story | 01-browse-catalogues |
| Auth | Bearer JWT (customer) |

**Flow**

1. Validate JWT → invalid/expired → `401` (downstream not called).
2. Forward `page`/`size` to `ppob-service` `GET /api/v1/ppob/catalogues` with the screen's ordering injected as `orderBy=order ASC` — active-only is forced (`showInactive` is never forwarded).
3. Return the upstream paginated `result` unchanged.
4. Upstream unavailable/5xx → `503 UPSTREAM_UNAVAILABLE`.

**Request**

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 1 | 1-based page index |
| size | int | 20 | Page size |

_No path params. No request body. No `showInactive` (customers only ever see active items) and no `orderBy` — this screen's ordering is fixed and injected by the BFF._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each catalogue item (upstream audit fields stripped — only `isActive` is passed through):

| Field | Type | Notes |
| --- | --- | --- |
| catalogueType | string | The single catalogue identifier — this app's path segment for its catalogue-scoped endpoints |
| name | string | Display name |
| icon | string | Icon URL |
| order | int | Sort position (ascending) |
| isActive | bool | Always `true` here |

**Example**

```
GET /bff-mobile/v1/ppob/catalogues?page=1&size=20
```

```json
{
  "response": 200,
  "message": "Catalogues retrieved successfully",
  "result": {
    "page": 1,
    "size": 20,
    "totalRows": 2,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "electricity-token",
        "name": "Electricity Token",
        "icon": "https://cdn.example/ppob/electricity.svg",
        "order": 1,
        "isActive": true
      },
      {
        "catalogueType": "mobile-data",
        "name": "Mobile Data",
        "icon": "https://cdn.example/ppob/data.svg",
        "order": 2,
        "isActive": true
      }
    ]
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` unavailable | `UPSTREAM_UNAVAILABLE: try again` |

### Resource: customer identification

One shared endpoint for all catalogues. The response follows the uniform identify core ([`api/README.md`](../README.md#identify-response-core)): `valid`, `identifierType`, `customerId`, `details` — this layer adds `catalogueType`. `valid` is the checkout gate: checkout is never reached without a successful identification in this session. It does not gate or filter the product list.

#### Identify customer

`POST /bff-mobile/v1/ppob/catalogues/{catalogueType}/identify`

Identifies the customer for a catalogue by interpreting `customerId` per catalogue type and returning the uniform identify core with typed `details`.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 03-browse-data-package |
| Auth | Bearer JWT (customer) |

**Flow**

1. Validate JWT → invalid/expired → `401` (downstream not called).
2. Resolve `catalogueType` → unknown → `404`.
3. Reject with `400` if `customerId` is missing/blank.
4. Interpret `customerId` by the first part of `catalogueType` and forward with the typed field:
   - `electricity-*` (e.g. `electricity-token`) → `meterNumber` → `POST /api/v1/ppob/identifyMeter` (Letslink validation);
   - `mobile-*` (e.g. `mobile-data`) → `phoneNumber` → `POST /api/v1/ppob/identifyPhoneNumber` (in-house prefix lookup);
   - any other first part → `400` (no identification supported for that catalogue).
5. Take `valid`, `identifierType`, `customerId`, `details` from the upstream response; add `catalogueType`.
6. Upstream unavailable/5xx → `503 UPSTREAM_UNAVAILABLE`.

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown; its first part selects the identification method |

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| customerId | string | yes | The customer ID entered on the screen — interpreted as meter number (`electricity-*`) or phone number (`mobile-*`) |

**Response**

`result` is the identify core plus `catalogueType`:

| Field | Type | Notes |
| --- | --- | --- |
| valid | bool | The checkout gate. `false` → reason in `message` |
| catalogueType | string | Echo of the path segment (added at this layer — internal identify methods don't carry it) |
| identifierType | string | `METER_NUMBER` or `PHONE_NUMBER` |
| customerId | string | Echo of the submitted value |
| details.customerName | string | `METER_NUMBER` only — customer identity as known by Letslink |
| details.wattage | int | `METER_NUMBER` only — carried into checkout; passed to Letslink at purchase (mints the token value). Not a list filter |
| details.meterSpecs | object | `METER_NUMBER` only — meter specifications |
| details.providerCode | string | `PHONE_NUMBER` only — provider code; used as the `mobile-data` products filter |
| details.providerName | string | `PHONE_NUMBER` only — display name of the provider |

**Example**

```json
{ "customerId": "5432176543" }
```

`electricity-token`:

```json
{
  "response": 200,
  "message": "Customer identified successfully",
  "result": {
    "valid": true,
    "catalogueType": "electricity-token",
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

`mobile-data`:

```json
{
  "response": 200,
  "message": "Customer identified successfully",
  "result": {
    "valid": true,
    "catalogueType": "mobile-data",
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
| 200 + `valid: false` | Rejected meter / unrecognized number prefix | reason in `message` |
| 400 | Missing/blank `customerId` | `BAD_REQUEST: customerId is required` |
| 400 | `catalogueType` first part maps to no known identifier | `BAD_REQUEST: identification type not supported for catalogueType` |
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` / Letslink unavailable | `UPSTREAM_UNAVAILABLE: try again` |

### Resource: PPOB products

#### List products

`GET /bff-mobile/v1/ppob/catalogues/{catalogueType}/products`

Returns the active products of one catalogue, paginated. Filtering is per catalogue: `electricity-token` is never fetched with filters (price identical for all; wattage handled at purchase), while `mobile-data` requires `providerCode` — an unfiltered data list is never fetched. The list is decoupled from identification: whether the customer identifies first is per-catalogue screen behaviour.

| | |
| --- | --- |
| Derived from story | 02-browse-electricity-token; 03-browse-data-package |
| Auth | Bearer JWT (customer) |

**Flow**

1. Validate JWT → invalid/expired → `401` (downstream not called).
2. Validate params for the catalogue: `mobile-data` → `providerCode` required, missing → `400`; `electricity-token` → no filter params. (The same rule is enforced by `ppob-service` — an unfiltered data list is never served.)
3. Forward `page`/`size` (+ `providerCode`) to `ppob-service` `GET /api/v1/ppob/catalogues/{catalogueType}/products` with the feed display order injected as `orderBy=displayOrder ASC` — active-only is forced (`showInactive` is never forwarded).
4. Return the upstream paginated `result`.
5. Upstream unavailable/5xx → `503 UPSTREAM_UNAVAILABLE`; upstream `404` (unknown catalogue) → passed through.

**Request**

| Path params | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Required. `404` if unknown |

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |
| page | int | 1 | 1-based page index |
| size | int | 20 | Page size |
| providerCode | string | — | **Required for `mobile-data`** (`400` without it; value comes from the identify response). Not applicable to `electricity-token` |

_No request body. No `showInactive`. No `orderBy` — this screen's ordering is fixed and injected by the BFF._

**Response**

`result` is the paginated shape (`page`, `size`, `totalRows`, `totalPage`, `data[]`); each product item (upstream audit fields stripped — only `isActive` is passed through):

| Field | Type | Notes |
| --- | --- | --- |
| catalogueType | string | Owning catalogue identifier |
| id | string | Product id |
| name | string | Display name |
| operator | string | Provider/operator display (e.g. `PLN`, `Telkomsel`) |
| denomination | int | `electricity-token` only — nominal token value (IDR) |
| packageSize | string | `mobile-data` only — package size/duration (e.g. `10 GB`) |
| price | int | Sale price (admin override applied over the Letslink base) |
| displayOrder | int | Feed display order (ascending) — the BFF-injected ordering basis |
| isActive | bool | Always `true` for customers |

**Example**

```
GET /bff-mobile/v1/ppob/catalogues/electricity-token/products?page=1&size=20
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
        "price": 205000,
        "displayOrder": 1,
        "isActive": true
      }
    ]
  }
}
```

```
GET /bff-mobile/v1/ppob/catalogues/mobile-data/products?providerCode=TSEL&page=1&size=20
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
        "price": 115000,
        "displayOrder": 1,
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
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` unavailable | `UPSTREAM_UNAVAILABLE: try again` |

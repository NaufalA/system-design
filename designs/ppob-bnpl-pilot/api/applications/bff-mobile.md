# API Design — bff-mobile

Backend-for-frontend for `mobile-app`: authenticates the customer JWT, orchestrates PPOB browse/checkout flows, and aggregates data from backend services. Holds no PPOB business data.

## Base URL & Auth

- Base URL: `https://<host>` (public, TLS only). Global conventions — path scheme, response wrapper, pagination, soft delete, auth, identify-response core, trust rule — are defined once in [`api/README.md`](../README.md); only this app's deltas follow.
- Path delta (screen-aligned, all catalogue-scoped under the `catalogues` resource): catalogue list → `/ppob/catalogues`; per-catalogue product types → `/ppob/catalogues/{catalogueType}/identify` and `/ppob/catalogues/{catalogueType}/products`; checkout → `/ppob/checkout`; history → `/ppob/history`.
- Auth: Bearer JWT validated per [`api/README.md`](../README.md#auth); this BFF additionally injects the resolved internal user id into downstream calls.
- Content type: `application/json`

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |
| PPOB catalogues (view) | Customer-facing catalogue list, aggregated from `ppob-service` | `GET /bff-mobile/v1/ppob/catalogues` |
| Customer identification | Shared identify step per catalogue — routes to `ppob-service`'s per-type method based on the first part of `catalogueType` | `POST /bff-mobile/v1/ppob/catalogues/{catalogueType}/identify` |
| PPOB products (view) | Product catalog per catalogue (`electricity-token`, `mobile-data`), aggregated from `ppob-service` | `GET /bff-mobile/v1/ppob/catalogues/{catalogueType}/products` |
| PPOB checkout orchestration | Draft creation, submission of a PPOB purchase (story 04) | _(defined with story 04)_ |
| PPOB transaction history (view) | Order history aggregated from `sales-portal-service` + `ppob-service` (story 05) | _(defined with story 05)_ |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |
| JWT authentication / session | user-service | Token validation for every inbound request (existing auth mechanism) | — |
| PPOB catalogue configuration | ppob-service | Sync REST `GET /api/v1/ppob/catalogues` (`catalogueType` is passed through to the client — no id mapping) | 01 |
| PPOB product catalog | ppob-service | Sync REST `GET /api/v1/ppob/catalogues/{catalogueType}/products` | 02, 03 |
| Meter identification | ppob-service | Sync REST `POST /api/v1/ppob/identifyMeter` (proxies Letslink) — called when the identify request's `catalogueType` starts with `electricity`; story 04's re-validation runs inside `ppob-service`, not through the BFF | 02 |
| Phone number identification | ppob-service | Sync REST `POST /api/v1/ppob/identifyPhoneNumber` (in-house prefix lookup) — called when the identify request's `catalogueType` starts with `mobile` | 03 |

## Endpoints

### Resource: PPOB catalogues

#### `GET /bff-mobile/v1/ppob/catalogues`

- Derived from story: 01-browse-catalogues
- Auth: Bearer JWT (customer)
- Request: query params `page` (default 0), `size` (default 20). No `showInactive` — customers only ever see active items.
- Response: each catalogue carries `catalogueType` — the single identifier used in every catalogue path segment on both layers (configured by admin alongside the other catalogue fields; see `api/README.md` for the naming semantics).

```json
{
  "response": 200,
  "message": "Catalogues retrieved successfully",
  "result": {
    "page": 0,
    "size": 20,
    "totalRows": 2,
    "totalPage": 1,
    "data": [
      {
        "catalogueType": "electricity-token",
        "name": "Electricity Token",
        "icon": "https://cdn.example/ppob/electricity.svg",
        "order": 1
      },
      {
        "catalogueType": "mobile-data",
        "name": "Mobile Data",
        "icon": "https://cdn.example/ppob/data.svg",
        "order": 2
      }
    ]
  }
}
```

- Errors (wrapper per [`api/README.md`](../README.md)):

| Status | Case | message |
| --- | --- | --- |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` unavailable | `UPSTREAM_UNAVAILABLE: try again` |

### Resource: customer identification

One shared BFF endpoint for all catalogues: the request carries `{ customerId }` plus the `catalogueType` path segment; the BFF interprets `customerId` per catalogue **by routing on the first part of `catalogueType`** (`electricity-*` → meter number, `mobile-*` → phone number) and forwards to the per-type `ppob-service` method with the typed field name (`meterNumber` / `phoneNumber`). The per-type methods keep their own typed signatures — the BFF does the translation, `ppob-service` stays type-specific.

The response follows the uniform identify core ([`api/README.md`](../README.md#identify-response-core)): `valid`, `identifierType`, `customerId` + typed `details` — the BFF adds `catalogueType` to the core. `valid` is the checkout gate (story 04): checkout is never reached without a successful identification in this session. It does **not** gate the product list — `electricity-token` fetches its list immediately on screen open; `mobile-data` uses the identified `providerCode` as the products filter.

#### `POST /bff-mobile/v1/ppob/catalogues/{catalogueType}/identify`

- Derived from story: 02-browse-electricity-token (`electricity-token`), 03-browse-data-package (`mobile-data`)
- Auth: Bearer JWT (customer)
- Path params: `catalogueType` (required; `404` if unknown catalogue).
- Routing (first part of `catalogueType` — user-decided for the pilot, tracked as an open question in `00-overview.md`):

| First part | `customerId` interpreted as | Forwarded as | Downstream method |
| --- | --- | --- | --- |
| `electricity` | meter number | `meterNumber` | `POST /api/v1/ppob/identifyMeter` (Letslink) |
| `mobile` | phone number | `phoneNumber` | `POST /api/v1/ppob/identifyPhoneNumber` (in-house) |

- Request:

```json
{ "customerId": "5432176543" }
```

- Response (`electricity-token` — customer identity + meter specs; `wattage` is **not a list filter** — it is carried into checkout and passed to Letslink at purchase, where the provider backend mints the token value (kWh) for that wattage):

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

- Response (`mobile-data` — in-house prefix lookup; `providerCode` filters the data package product list):

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

- Errors:

| Status | Case | message |
| --- | --- | --- |
| 200 + `valid: false` | Rejected meter / unrecognized number prefix | reason in `message` |
| 400 | Missing/blank `customerId` | `BAD_REQUEST: customerId is required` |
| 400 | `catalogueType` first part maps to no known identifier | `BAD_REQUEST: identification type not supported for catalogueType` |
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` / Letslink unavailable | `UPSTREAM_UNAVAILABLE: try again` |

### Resource: PPOB products

#### `GET /bff-mobile/v1/ppob/catalogues/{catalogueType}/products`

Catalogue types in use: `electricity-token`, `mobile-data`. This endpoint is **decoupled from identification** — no identification params, no inline identification in the response; whether the customer identifies first is per-catalogue app behaviour:

- `electricity-token`: **list fetched immediately on screen open** — no filter (price is identical per product; wattage determines the token value at fulfillment). Identification is still mandatory before checkout (story 04), but never gates or filters this list.
- `mobile-data`: **identify first, then list** — `providerCode` (from the identify response) is **required**; the list is never served unfiltered.

- Derived from story: 02-browse-electricity-token (electricity-token), 03-browse-data-package (mobile-data)
- Auth: Bearer JWT (customer)
- Path params: `catalogueType` (required; `404` if unknown catalogue).
- Query params: `page` (default 0), `size` (default 20). No `showInactive`.
  - `electricity-token`: no other params.
  - `mobile-data`: `providerCode` (required — `400` without it; the app supplies the value from the identify response).
- Response: products in the catalogue, active-only, price = admin override applied over Letslink base; each item carries its `catalogueType`.

`electricity-token`:

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
        "price": 205000,
        "isActive": true
      }
    ]
  }
}
```

`mobile-data` (called with `?providerCode=TSEL`, list filtered to the provider):

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
        "price": 115000,
        "isActive": true
      }
    ]
  }
}
```

- Errors (wrapper per [`api/README.md`](../README.md)):

| Status | Case | message |
| --- | --- | --- |
| 400 | `mobile-data`: `providerCode` not supplied | `BAD_REQUEST: providerCode is required` |
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 503 | `ppob-service` unavailable | `UPSTREAM_UNAVAILABLE: try again` |

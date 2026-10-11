# API Design — ppob-service

Owns the PPOB transaction lifecycle, the PPOB product catalog (Letslink feed + admin overrides), catalogue configuration, Letslink integration (balance check, purchase, product sync), failure unwinds, and completion notifications.

## Base URL & Auth

- Base URL: internal only (no public exposure). Global conventions — path scheme (incl. AIP + project deviations), response wrapper, pagination, soft delete, auth, identify-response core, trust rule — are defined once in [`api/README.md`](../README.md). Callers: `bff-mobile`, `bff-admin`, `bnpl-service`.
- Auth: service-to-service per [`api/README.md`](../README.md#auth); no customer JWT reaches this service; BFFs pass the resolved internal user id where needed.
- Content type: `application/json`

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |
| PPOB catalogue configuration | Admin-defined catalogues (`catalogueType` identifier, name, icon, order, visibility) | `GET /api/v1/ppob/catalogues`; `GET /api/v1/ppob/catalogues/{catalogueType}`; admin CRUD _(story 07)_ |
| Customer identification | One stateless method per identifier type — `identifyMeter` (Letslink) and `identifyPhoneNumber` (in-house prefix table); both called by `bff-mobile` (via the shared `/identify` endpoint, story 02/03) and re-run internally in story 04 | `POST /api/v1/ppob/identifyMeter`, `POST /api/v1/ppob/identifyPhoneNumber` |
| Phone-prefix → provider table | In-house mapping used to identify data-package numbers (static config for pilot; admin management TBD in story 07 scope) | consumed by `identifyPhoneNumber` (below) |
| PPOB product catalog | Products from Letslink feed with admin price/enable overrides | `GET /api/v1/ppob/catalogues/{catalogueType}/products`, admin overrides _(story 07)_ |
| PPOB transactions | Lifecycle: pending → delivered / failed; Letslink refs, token code | execution _(story 04)_, detail reads _(story 05/06)_ |
| Letslink balance & purchase | Integration facade to the aggregator | balance check, purchase _(story 04)_ |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |
| PPOB product feed | Letslink (external) | Periodic sync (REST) for base product/pricing data | 02, 03, 07 |
| Customer/meter validation | Letslink (external) | Sync REST on identify for the electricity catalogues (customer identity + meter specs); re-run server-side before purchase | 02, 04 |
| Deposit balance | Letslink (external) | Sync REST check before checkout | 04 |
| PPOB purchase | Letslink (external) | Sync REST purchase call | 04 |
| BNPL limit refund + order cancellation | bnpl-service | Sync REST, initiated on purchase failure | 06 |
| Push notification delivery | notification-service | Fire-and-forget call on completion/failure | 08 |

## Endpoints

### Resource: customer identification

Two stateless custom methods (regular `/` path, camelCase verb, POST) with typed request signatures — one per identifier type. No mode-dispatch here: the BFF routes to the right method by the first part of `catalogueType` before calling (see `bff-mobile.md`). Both responses follow the uniform identify core (`valid`, `identifierType`, `customerId` + typed `details` — per [`api/README.md`](../README.md#identify-response-core)); they do not carry `catalogueType` (a method may serve multiple catalogues — `identifyMeter` also serves a future `electricity-postpaid`); the BFF adds it.

#### `POST /api/v1/ppob/identifyMeter`

- Derived from story: 02-browse-electricity-token (re-used server-side by story 04 before purchase)
- Caller: `bff-mobile` (story 02) and `ppob-service` itself during the story 04 chain
- Auth: service-to-service
- Behavior: forwards to **Letslink** customer/meter validation (external REST).
- Request (typed — `customerId` translation happens in the BFF):

```json
{ "meterNumber": "5432176543" }
```

- Response:

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

  - `details.wattage` extracted from Letslink meter specs — passed to Letslink at purchase so the provider backend mints the token value for that wattage (does **not** filter the product list).
- Errors:

| Status | Case | message |
| --- | --- | --- |
| 200 + `valid: false` | Rejected meter (invalid/inactive) | reason |
| 400 | Missing/blank `meterNumber` | `BAD_REQUEST: meterNumber is required` |
| 503 | Letslink unavailable | `UPSTREAM_UNAVAILABLE: ...` |
| 500 | Internal failure | `INTERNAL: ...` |

#### `POST /api/v1/ppob/identifyPhoneNumber`

- Derived from story: 03-browse-data-package, 04-buy-with-bnpl (server-side re-validation before purchase)
- Caller: `bff-mobile` (story 03, routed from the shared `/identify` endpoint) and `ppob-service` itself during the story 04 chain
- Auth: service-to-service
- Behavior: in-house prefix lookup against the phone-prefix → provider table (owned by `ppob-service`) — no external call.
- Request (typed — `customerId` translation happens in the BFF):

```json
{ "phoneNumber": "081234567890" }
```

- Response:

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

  - `details.providerCode` is supplied by the app as the products filter (story 03).
- Errors:

| Status | Case | message |
| --- | --- | --- |
| 200 + `valid: false` | Unrecognized number prefix | reason |
| 400 | Missing/blank `phoneNumber` | `BAD_REQUEST: phoneNumber is required` |
| 500 | Internal failure | `INTERNAL: ...` |

### Resource: PPOB catalogue configuration

`catalogueType` is the resource identifier (AIP-style name substitution) — configured by admin alongside the other catalogue fields and consistent across every layer (admin config, BFF paths, microservice paths, payloads). See `api/README.md` for naming semantics.

#### `GET /api/v1/ppob/catalogues`

- Derived from story: 01-browse-catalogues
- Caller: `bff-mobile`
- Auth: service-to-service
- Request: query params `page` (default 0), `size` (default 20). No `showInactive` from `bff-mobile` (forced active-only).
- Response: **active, visible** catalogues (`isActive = true`), ordered by `order`. Inactive/hidden catalogues are never returned.

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

- Errors (wrapper per [`api/README.md`](../README.md)):

| Status | Case | message |
| --- | --- | --- |
| 500 | Internal failure reading config | `INTERNAL: ...` |

#### `GET /api/v1/ppob/catalogues/{catalogueType}`

- Derived from story: 01-browse-catalogues (single-catalogue read; primarily the admin management view, story 07)
- Caller: `bff-admin`
- Auth: service-to-service
- Path params: `catalogueType` (required; `404` if unknown).
- Response: one catalogue config; `showInactive=true` (default `false`) allows reading a disabled catalogue for admin purposes.

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

- Errors (wrapper per [`api/README.md`](../README.md)):

| Status | Case | message |
| --- | --- | --- |
| 404 | Unknown `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure reading config | `INTERNAL: ...` |

### Resource: PPOB product catalog

#### `GET /api/v1/ppob/catalogues/{catalogueType}/products`

- Derived from story: 02-browse-electricity-token, 03-browse-data-package, 07-admin-catalog-management (`bff-admin` management view)
- Caller: `bff-mobile` (customer), `bff-admin` (management view)
- Auth: service-to-service
- Path params: `catalogueType` (required; `404` if unknown/inactive catalogue).
- Query params: `page` (default 0), `size` (default 20), `showInactive` (default `false`; honored only when the caller is `bff-admin` — forced `false` for `bff-mobile`), `providerCode` (required for `mobile-data`, ignored for `electricity-token`).
  - `mobile-data`: `providerCode` filters the list to that provider's packages — **required** (`400` without it; the list is never served unfiltered). The value comes from the identify response and is advisory only — re-derived server-side at purchase (never trusted to authorize a purchase).
  - `electricity-token`: no filter — unfiltered (identical price for all, wattage handled at purchase by the provider backend).
- Response: products for the catalogue — Letslink feed base data with admin override (`price`, `isActive`) applied, sorted by display order; each item carries its `catalogueType`.

`electricity-token` (customer view):

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

`mobile-data` (called with `?providerCode=TSEL`, filtered):

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

- Errors (wrapper per [`api/README.md`](../README.md)):

| Status | Case | message |
| --- | --- | --- |
| 400 | `mobile-data`: `providerCode` not supplied | `BAD_REQUEST: providerCode is required` |
| 404 | Unknown/inactive `catalogueType` | `NOT_FOUND: catalogue does not exist` |
| 500 | Internal failure | `INTERNAL: ...` |

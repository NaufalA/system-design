# API Design — Story 03: Browse Mobile Data Package Catalog

Same shared endpoints as story 02, but per-catalogue behaviour differs: `mobile-data` **identifies first, then lists** — the phone number is identified in-house (`ppob-service` prefix table, no Letslink) via the shared `/identify` endpoint, and the resulting `providerCode` is the **required** filter for the products request. The list is never served unfiltered (the microservice rejects a products call without `providerCode`).

## Sequence

```mermaid
sequenceDiagram
    participant app as mobile-app
    participant bff as bff-mobile
    participant ppob as ppob-service

    Note over app: customer enters phone number (before any list fetch)

    app->>bff: GET /bff-mobile/v1/ppob/catalogues/mobile-data/customer-identifications?page&size (Bearer JWT)
    bff->>ppob: GET /api/v1/ppob/customer-identifications?identifierType=PHONE_NUMBER&page&size&orderBy=lastUsedDate DESC
    ppob-->>bff: previous identifications (phone numbers, most-recent first)
    bff-->>app: 200 OK result.data[] (audit fields stripped)
    Note over app: list of previous numbers shown

    app->>bff: POST /bff-mobile/v1/ppob/catalogues/mobile-data/identify { customerId }
    bff->>bff: validate JWT, route: first part "mobile" → phone number
    bff->>ppob: POST /api/v1/ppob/customer-identifications/identifyPhoneNumber { phoneNumber }
    ppob->>ppob: in-house prefix lookup
    ppob-->>bff: 200 core { valid, identifierType, customerId, details { providerCode, providerName } }
    bff-->>app: 200 OK core + catalogueType
    Note over app: identification passed — providerCode in hand

    app->>bff: GET /bff-mobile/v1/ppob/catalogues/mobile-data/products?providerCode=TSEL&page&size
    bff->>ppob: GET /api/v1/ppob/catalogues/mobile-data/products?providerCode=TSEL&page&size&orderBy=displayOrder ASC
    ppob-->>bff: products filtered by provider (base + admin override, active only)
    bff-->>app: 200 OK result.data[] (audit fields stripped)
    Note over app: customer selects a product → story 04
```

## Interaction Flow

| # | Caller | Callee | Call | Sync/Async | Reference |
| --- | --- | --- | --- | --- | --- |
| 1 | mobile-app | bff-mobile | `GET /bff-mobile/v1/ppob/catalogues/mobile-data/customer-identifications?page&size` (on screen open) | Sync | `api/applications/bff-mobile.md#list-customer-identifications` |
| 2 | bff-mobile | ppob-service | `GET /api/v1/ppob/customer-identifications?identifierType=PHONE_NUMBER&page&size&orderBy=lastUsedDate DESC` | Sync | `api/applications/ppob-service.md#list-customer-identifications` |
| 3 | mobile-app | bff-mobile | `POST /bff-mobile/v1/ppob/catalogues/mobile-data/identify` body `{ customerId }` (phone number, before any list fetch / on selection) | Sync | `api/applications/bff-mobile.md#identify-customer` |
| 4 | bff-mobile | ppob-service | `POST /api/v1/ppob/customer-identifications/identifyPhoneNumber` body `{ phoneNumber }` (routed by first part `mobile`) | Sync | `api/applications/ppob-service.md#identify-phone-number` |
| 5 | mobile-app | bff-mobile | `GET /bff-mobile/v1/ppob/catalogues/mobile-data/products?providerCode=...&page&size` (after step 3 returns `valid: true`) | Sync | `api/applications/bff-mobile.md#list-products` |
| 6 | bff-mobile | ppob-service | `GET /api/v1/ppob/catalogues/mobile-data/products?providerCode=...&page&size&orderBy=displayOrder ASC` | Sync | `api/applications/ppob-service.md#list-products` |
| — | Letslink | ppob-service | Product feed sync (periodic) | Async (scheduled) | `api/applications/ppob-service.md#resources-used` |

## Data Passed Between Steps

- Step 1 → 2: `bff-mobile` forwards `page`/`size` and injects `orderBy=lastUsedDate DESC`; active-only is forced.
- Step 2 → 1: paginated list of the caller's previous phone identifications (audit fields stripped, `lastUsedDate` kept), most-recent first; selecting one re-runs identify (which upserts `lastUsedDate` as a background side effect).
- Step 3 → 4: BFF routes on the first part of `catalogueType` (`mobile` → phone identification) and translates `customerId` → typed `phoneNumber`.
- Step 4 → 3: `ppob-service` returns the identify core `{ valid, identifierType: PHONE_NUMBER, customerId, details: { providerCode, providerName } }`; `bff-mobile` adds `catalogueType` and passes through — the app stores `providerCode` for the products call (and paging). Identification history is **not** written here — it is recorded only after a successful purchase transaction (story 04).
- Step 5 → 6: `providerCode` from the identify response + `catalogueType` path segment + pagination. `bff-mobile` injects the screen's fixed ordering (`orderBy=displayOrder ASC` — microservices have no default order; the app cannot supply `orderBy`) and never forwards `showInactive`.
- Step 6 → 5: microservice-paginated `result.data`, filtered to the provider; `bff-mobile` strips the audit fields (passes `isActive` only) and passes it through.

## Failure & Consistency Behavior

- **Identify-first is enforced end-to-end:** the app fetches no list before `valid: true`, and the microservice rejects a `mobile-data` products call without `providerCode` (`400`) — an unfiltered list is never served. Unrecognized prefix → `200` with `valid: false`, reason in `message`; customer retries the input.
- **Prefix table incomplete/stale** → number not recognized → same failure path; table is `ppob-service` config (maintainable per story 07 scope note).
- **`providerCode` trust:** fine as a browse filter (cheap to game, no money at stake), but story 04 **re-runs identification server-side** before the Letslink purchase — a client-supplied `providerCode` is never trusted to authorize a purchase.
- **Customer changes the phone number** → re-identify (step 1); the new `providerCode` replaces the old one for subsequent list requests.
- **No active products for the provider** → `200` with empty `result.data`, `totalRows: 0`; app shows "temporarily unavailable".
- **Feed sync stale/unavailable** → serve last-known catalog with overrides applied.
- **`ppob-service` unavailable/5xx** → `bff-mobile` returns wrapper error; app shows retry state.
- **Unknown `catalogueType`** → `404` wrapper error on both endpoints.
- **Price consistency:** browse price is advisory; re-validated in the story 04 submission chain.
- **JWT invalid** → `401`, `ppob-service` not called.

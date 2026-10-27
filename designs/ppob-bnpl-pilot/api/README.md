# API Conventions — PPOB on BNPL (Pilot)

Canonical rules for **every** endpoint in `api/applications/*.md` and every interaction in `api/stories/*.md`. These are defined once here — application docs carry only their app-specific deltas and link back. Where an app doc or story appears to restate a rule below, this file wins.

## Base Paths & Naming

- **BFFs (public):** `/{service-short-name}/v1/...` → `/bff-mobile/v1/...` (later `/bff-admin/v1/...`).
- **Microservices (internal):** `/api/v1/...` — the service short name is carried by the host/port, not the path. No public exposure.
- **BFF paths are screen-aligned:** an endpoint mirrors what a page consumes (catalogue list → `/ppob/catalogues`, checkout → `/ppob/checkout`, history → `/ppob/history`).
- **`catalogueType` is the single catalogue identifier** across every layer (admin config, BFF paths, microservice paths, payloads) — there is no separate internal id or code, and no id mapping in the BFF. Both layers address catalogue-scoped resources through it: BFF `/ppob/catalogues/{catalogueType}/identify`, `/ppob/catalogues/{catalogueType}/products`; microservice `/api/v1/ppob/catalogues/{catalogueType}`, `.../products`. Pilot values: `electricity-token`, `mobile-data`. Adding a catalogue adds a path segment, not an endpoint.
- **`catalogueType` naming semantics:** the identifier has two parts — catalogues handling the **same customer identifier** share the first part (e.g. `electricity-token` and a future `electricity-postpaid` both handle the electricity meter number). `bff-mobile` uses this first part to route `/identify` requests to the right internal method (`electricity-*` → meter number, `mobile-*` → phone number); a catalogue with an unrecognized first part has no supported identification. (The prefix-based routing scheme is user-decided for the pilot — kept open as a question in `00-overview.md`.)
- **Microservices are resource-based per Google AIP**, with these project deviations (explicit conventions outrank AIP):
  - Only **GET** (reads) and **POST** (creates) are used.
  - **Update and delete are custom methods** expressed as regular URL paths with POST (e.g. `POST .../update`), never PUT/PATCH/DELETE.
  - Custom methods use **`/` as a regular path segment, not AIP's `:verb`**, with a lowerCamelCase verb (AIP-136), e.g. `POST /api/v1/ppob/customer-identifications/identifyMeter`.
  - **Every custom method's placement in the resource structure is asked about individually** — never assumed.
  - AIP applies to microservices only; BFFs stay screen-aligned.

## Response Wrapper

All endpoints, both layers:

```json
{ "response": <status code>, "message": "...", "result": { } }
```

- `response` — numeric status code, mirrors the HTTP status.
- Content type: all requests and responses are `application/json`.
- `message` — on success, describes the action performed (`"Catalogues retrieved successfully"`); on failure, describes the error (style: `CODE: description`, e.g. `NOT_FOUND: catalogue does not exist`).
- `result` — the actual payload; `null` on error.
- HTTP status codes apply alongside the wrapper (401/404/5xx...).
- **Gate pattern:** a rejected identification returns `200` with `result.valid = false` + reason in `message` — not an HTTP error.

## Field Naming

- **Response fields match the database field naming by default** — what is stored is what is returned, same name, no renames at the API layer.
- A field deviating from its stored name must be **explicitly documented** at the endpoint that returns it, with the reason (e.g. renamed to match endpoint consumer requirements, normalized across upstream sources, wrapped for the identify core). Examples in this pilot: `catalogueType` (canonical identifier, not a stored id), `id` on products (Letslink feed product id), the typed `details.*` wrappers in the identify core.

## Identify Response Core

Customer identification (stories 02/03) is exposed through **one shared BFF endpoint per catalogue** (`POST /ppob/catalogues/{catalogueType}/identify`, body `{ customerId }`); the underlying `ppob-service` method is per identifier type. To stay consistent across types, every identify response (both layers) shares a **fixed core + typed `details`**:

- Core: `{ valid, identifierType, customerId }` — `valid` (the gate), `identifierType` (`METER_NUMBER` | `PHONE_NUMBER`), `customerId` (echo of the submitted value). The **BFF adds `catalogueType`** to the core; the internal methods don't carry it (one method may serve several catalogues, e.g. `identifyMeter` for `electricity-token` and a future `electricity-postpaid`).
- `details` schema is per `identifierType`:
  - `METER_NUMBER`: `{ customerName, wattage, meterSpecs }` — `wattage` is carried into checkout and passed to Letslink at purchase (mints the token value); it is not a list filter.
  - `PHONE_NUMBER`: `{ providerCode, providerName }` — `providerCode` filters the `mobile-data` product list.
- `details` is typed per identifier — never a generic bag, never null-padded fields from other types. Adding an identifier type = new `identifierType` value + new `details` schema; the core is never reshaped.

## Audit Fields

- Every resource backed by persistent data carries **`createdDate`, `updatedDate`, `createdBy`, `updatedBy`** alongside the canonical soft-delete field **`isActive`**.
- Date audit fields are stored timezone-aware (e.g. PostgreSQL `timestamptz`) and returned in ISO 8601 format (e.g. `2026-10-11T09:15:00Z`).
- Actor fields (`createdBy`, `updatedBy`) are strings, max 50 characters, **supplied by the caller, not derived by the service**: create endpoints accept `createdBy` in the request; update/delete/custom-method endpoints accept `updatedBy`. The calling party fills it based on use case — the admin username for portal writes, the `customerId` for customer-driven writes, `"system"` for automated writes (e.g. Letslink feed sync). No default is assumed by the microservice.
- **Exposure per layer:** microservices return the full audit set on every entity; `bff-admin` passes it through; `bff-mobile` strips all audit fields except `isActive` (customers never see who/when).

## Pagination

- Request: `?page=1&size=20` (**1-based** page).
- Paginated `result` shape: `{ page, size, totalRows, totalPage, data: [...] }`.
- **The microservice paginates** (slices + computes totals); BFFs forward `page`/`size` and pass the result through — never fetch-all-and-slice.
- **`orderBy`** — every microservice list endpoint accepts `orderBy`: comma-separated `fieldName ORDER` entries (`ORDER` ∈ `ASC` | `DESC`, required per entry), e.g. `?orderBy=catalogueGroup ASC,catalogueType ASC`. Unknown field or malformed entry → `400`. There is **no default order** — when `orderBy` is omitted the database order is returned; deterministic ordering is always the caller's responsibility. (`orderBy` fields are stored resource fields/columns per an endpoint whitelist — not necessarily response fields.)
- **BFFs control `orderBy` usage per screen:** a BFF list endpoint accepts `orderBy` from the app only where the screen requires user-driven ordering; otherwise the BFF injects the screen's intended `orderBy` into its microservice call (e.g. `order ASC` for catalogues) and the app never sees the param. Pilot BFF list endpoints expose no `orderBy`.
- **Additional filters:** flat, single-value, lowerCamelCase query params named after the field (e.g. `providerCode=TSEL`); each endpoint documents its filterable fields.
- Endpoints may place additional fields **beside** the pagination fields in `result`; the five fields above remain the standard set (no extra fields on the products endpoint today).

## Soft Delete

- **All resources use soft deletion unless stated otherwise** — deletion flips the canonical `isActive` flag; there is no hard delete and no separate visibility flag (admin "disable" and delete are the same operation).
- In the frontend UI a soft delete may take different forms — a delete button with confirmation, or an active/inactive toggle — both result in `isActive = false` at the API level.
- **Lists** default to active-only. Every microservice list endpoint supports `showInactive=true` to include deleted rows and honors it **unconditionally** — the microservice never gates params by caller/user type. **Who may pass `showInactive` is enforced at the BFF layer:** `bff-admin` forwards it from the admin UI (story 07); `bff-mobile` never forwards it, so customers always get active-only.
- **Get** endpoints always return the resource regardless of `isActive` — `404` only for unknown identifiers.
- **Update or delete** of a soft-deleted resource fails with `409`.

## Auth

- **BFF:** `Authorization: Bearer <JWT>` issued by `user-service`, validated at the BFF (signature, expiry, session revocation). Invalid token → `401` without calling downstream. Internal service endpoints are never exposed to the client.
- **Microservices:** service-to-service over the internal network with **mTLS** (client certificates per company PKI — transport layer only, no auth headers/tokens). No customer JWT reaches a microservice; BFFs pass the resolved internal user id where needed.

## Server-Side Re-validation (Trust Rule)

Client-supplied results are **advisory, never authoritative**:

- Identification results (`wattage`, `providerCode`), browse-time prices, and filters are fine for display/filtering, but the **story 04 background chain re-runs identification (`identifyMeter` / `identifyPhoneNumber`) and price validation server-side before the Letslink purchase** — a client-supplied value never authorizes a purchase or refund.
- Consequence: browse endpoints state this once (here + the endpoint's contract note); per-story docs describe *when* re-validation runs, not *why*.

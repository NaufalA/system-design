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
  - Custom methods use **`/` as a regular path segment, not AIP's `:verb`**, with a lowerCamelCase verb (AIP-136), e.g. `POST /api/v1/ppob/identifyMeter`.
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

## Identify Response Core

Customer identification (stories 02/03) is exposed through **one shared BFF endpoint per catalogue** (`POST /ppob/catalogues/{catalogueType}/identify`, body `{ customerId }`); the underlying `ppob-service` method is per identifier type. To stay consistent across types, every identify response (both layers) shares a **fixed core + typed `details`**:

- Core: `{ valid, identifierType, customerId }` — `valid` (the gate), `identifierType` (`METER_NUMBER` | `PHONE_NUMBER`), `customerId` (echo of the submitted value). The **BFF adds `catalogueType`** to the core; the internal methods don't carry it (one method may serve several catalogues, e.g. `identifyMeter` for `electricity-token` and a future `electricity-postpaid`).
- `details` schema is per `identifierType`:
  - `METER_NUMBER`: `{ customerName, wattage, meterSpecs }` — `wattage` is carried into checkout and passed to Letslink at purchase (mints the token value); it is not a list filter.
  - `PHONE_NUMBER`: `{ providerCode, providerName }` — `providerCode` filters the `mobile-data` product list.
- `details` is typed per identifier — never a generic bag, never null-padded fields from other types. Adding an identifier type = new `identifierType` value + new `details` schema; the core is never reshaped.

## Pagination

- Request: `?page=0&size=20` (0-based page).
- Paginated `result` shape: `{ page, size, totalRows, totalPage, data: [...] }`.
- **The microservice paginates** (slices + computes totals); BFFs forward `page`/`size` and pass the result through — never fetch-all-and-slice.
- Endpoints may place additional fields **beside** the pagination fields in `result`; the five fields above remain the standard set (no extra fields on the products endpoint today).

## Soft Delete

- Entities carry `isActive`; reads default to `isActive = true`.
- `showInactive=true` is honored **only** for admin-originated calls (`bff-admin`, story 07); `bff-mobile` requests are always forced active-only regardless of params.
- Admin "disable" and delete are the same flag (`isActive` → `false`); there is no separate visibility flag.

## Auth

- **BFF:** `Authorization: Bearer <JWT>` issued by `user-service`, validated at the BFF (signature, expiry, session revocation). Invalid token → `401` without calling downstream. Internal service endpoints are never exposed to the client.
- **Microservices:** service-to-service over the internal network with **mTLS** (client certificates per company PKI — transport layer only, no auth headers/tokens). No customer JWT reaches a microservice; BFFs pass the resolved internal user id where needed.

## Server-Side Re-validation (Trust Rule)

Client-supplied results are **advisory, never authoritative**:

- Identification results (`wattage`, `providerCode`), browse-time prices, and filters are fine for display/filtering, but the **story 04 background chain re-runs identification (`identifyMeter` / `identifyPhoneNumber`) and price validation server-side before the Letslink purchase** — a client-supplied value never authorizes a purchase or refund.
- Consequence: browse endpoints state this once (here + the endpoint's contract note); per-story docs describe *when* re-validation runs, not *why*.

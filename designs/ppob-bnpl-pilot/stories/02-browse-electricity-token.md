# Story 02: Browse Electricity Token Catalog

## User Story

As a customer, I want to browse available electricity token products (operator, denomination, price), so that I can pick the token I want to buy.

## Priority & Dependencies

- Priority: P0
- Depends on: story 01 (catalogue selection is the entry), product feed synced from Letslink + admin overrides (story 07)

## Acceptance Criteria

- Selecting the Electricity catalogue **fetches the product list immediately** — no filter, no identification needed to browse (price is the same for all customers).
- The screen also shows the customer's **previously identified meter numbers** (from customer-identification history), most-recent first, so the customer can re-select one instead of re-typing.
- The screen also shows a **customer ID (meter number) input**; a **successful identification** is **mandatory before checkout** (before balance check + draft creation — story 04) but never blocks browsing the list.
- Identification uses the shared identify endpoint (`POST /ppob/catalogues/{catalogueType}/identify`, `customerId` in) and is served by **Letslink through `ppob-service`**, returning the uniform identify core with **meter details including wattage** — shown to the customer as confirmation.
- **All electricity products are shown regardless of wattage** — price is the same per product; wattage affects the **token value** (kWh) minted by the provider backend at fulfillment, which is only visible afterwards in the token code (story 05). The wattage is carried into checkout and passed to Letslink at purchase.
- The list shows available token denominations with: operator/PLN, nominal value, **sale price** (admin override applied over the Letslink base price).
- Identification is server-validated again inside the story 04 submission chain — the client-side result is never trusted.
- Disabled products are not shown.
- Prices reflect the latest admin override or feed sync immediately.
- Empty/failed response shows a retryable error state.

## Actors & Trigger

- Actor: customer
- Trigger: customer taps the Electricity catalogue (story 01)

## Happy Path

1. Customer taps the Electricity catalogue → product list screen opens; the list is **fetched immediately** (`bff-mobile` → `ppob-service`: Letslink feed base + admin overrides, active products only, unfiltered). The screen also fetches the customer's **previous meter identifications** (most-recent first) for quick re-selection.
2. List rendered: operator, denomination, price. The screen also shows a **meter/customer ID input** and the list of previous meters.
3. Customer enters or selects a meter number → `mobile-app` → `bff-mobile` `POST /bff-mobile/v1/ppob/catalogues/electricity-token/identify { customerId }` (BFF routes on the first part `electricity` → internal `POST /api/v1/ppob/customer-identifications/identifyMeter { meterNumber }` → Letslink). Selecting a previous meter re-runs identification, which bumps its `lastUsedAt` (background side effect).
4. Letslink customer validation returns the identify core: customer identity + **wattage** in `details`. Identification success = checkout gate passed. On a successful full-number identify, a history row is upserted in the background (fire-and-forget) — the response is never blocked by it.
5. Customer selects a product → navigates to checkout (story 04). The entered customer ID and identification result travel with the checkout (passed at draft creation/submit). Note: the same price yields a different token value depending on meter wattage — decided by the provider backend at fulfillment and shown after purchase (token code in story 05).

## Error / Edge Cases

- **Identification fails / invalid meter** → error inline at the input; the **list stays visible** but checkout is blocked; customer can correct the ID and retry. Checkout never reached without `valid: true`.
- **Letslink validation unavailable** → retryable error at the identify step (browsing still works; checkout cannot proceed).
- All products in catalogue disabled by admin → empty state ("temporarily unavailable").
- Feed sync stale/unavailable → serve last known catalog (admin overrides still applied); `ppob-service` refreshes periodically.
- `ppob-service` unavailable → error state with retry.
- Price changed by admin while customer is on the screen → checkout re-validates price server-side (story 04).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders catalog on open, meter ID input (checkout gate), navigates to checkout |
| bff-mobile | Auth; shared `identify` endpoint (routed to `identifyMeter`); catalog aggregation |
| ppob-service | Owns catalog (feed + overrides); proxies customer identification to Letslink |
| Letslink | Customer/meter validation (identity + meter specs) |

## Data

- Reads: PPOB product catalog (base from Letslink feed + admin overrides), catalogue configuration — owned by `ppob-service`; customer/meter validation — Letslink (external); **customer identification history** — `ppob-service` (read on catalogue entry)
- Writes: none by the customer (background feed-sync refresh only; identification is a read-only check — except a **background upsert of identification history** on a successful full-number identify, fire-and-forget)

## Derived API Interactions

See `api/stories/02-browse-electricity-token.md`.

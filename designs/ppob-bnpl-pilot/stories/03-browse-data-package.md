# Story 03: Browse Mobile Data Package Catalog

## User Story

As a customer, I want to browse available mobile data packages (provider, package size, price), so that I can pick the data package I want to buy.

## Priority & Dependencies

- Priority: P0
- Depends on: story 01 (catalogue selection is the entry), product feed synced from Letslink + admin overrides (story 07)

## Acceptance Criteria

- Selecting the Data catalogue shows a **phone number input**; the product list is fetched **only after a successful identification** (blocking, required before balance check + draft creation — story 04). The list is **never shown unfiltered** — a products call without the identified `providerCode` is rejected server-side.
- The screen also shows the customer's **previously identified phone numbers** (from customer-identification history), most-recent first, so the customer can re-select one; phone numbers can be identified from 4 digits (prefix lookup), but only full, valid numbers are stored.
- Identification uses the shared identify endpoint (`POST /ppob/catalogues/{catalogueType}/identify`, `customerId` in — interpreted as the phone number for `mobile-data`) and is served **in-house by `ppob-service`** (own phone-prefix → provider table, not Letslink), returning the uniform identify core with a `providerCode` used to **filter the data package list** to that provider's products.
- Once identified, subsequent list requests reuse the `providerCode` (paging/scroll) until the customer changes the phone number (then re-identify).
- The list shows available packages with: provider, package size/duration, **sale price** (admin override applied over the Letslink base price).
- Identification is re-validated inside the story 04 submission chain — the client-side `providerCode` is never trusted for filtering the purchasable set.
- Disabled products are not shown.
- Prices reflect the latest admin override or feed sync immediately.
- Empty/failed response shows a retryable error state.

## Actors & Trigger

- Actor: customer
- Trigger: customer taps the Data catalogue (story 01)

## Happy Path

1. Customer taps the Data catalogue → screen opens with a **phone number input** and **no list yet**; the screen also fetches the customer's **previous phone identifications** (most-recent first) for quick re-selection.
2. Customer enters the number (or selects a previous one) → `mobile-app` → `bff-mobile` `POST /bff-mobile/v1/ppob/catalogues/mobile-data/identify { customerId }` (BFF routes on the first part `mobile` → internal `POST /api/v1/ppob/customer-identifications/identifyPhoneNumber { phoneNumber }` → in-house prefix lookup → identify core with `providerCode` + provider name, e.g. `TSEL`). Prefix lookup runs from 4 digits; only a full, valid number is stored (background side effect).
3. Identification success (blocking gate passed) → `mobile-app` fetches the product list with the `providerCode` → `bff-mobile` → `ppob-service`: Letslink feed (base) + admin overrides, active products **filtered to the provider** (server rejects the call without `providerCode`).
4. List rendered: provider, package, price. The `providerCode` is reused on subsequent requests (paging/scroll) until the customer changes the number.
5. Customer selects a product → navigates to checkout (story 04). The entered phone number and identification result travel with the checkout (passed at draft creation/submit).

## Error / Edge Cases

- **Identification fails / unrecognized number prefix** → error inline at the input; no list fetched; customer corrects the number and retries. Checkout never reached.
- **Prefix table incomplete** → number not recognized → same as failure; prefix table is admin-maintainable config in `ppob-service` (see story 07 note).
- All products for the identified provider disabled → empty provider-filtered list ("temporarily unavailable").
- Feed sync stale/unavailable → serve last known catalog with overrides applied.
- `ppob-service` unavailable → error state with retry.
- Price changed by admin while customer is on the screen → checkout re-validates price server-side (story 04).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Phone number input (blocking gate), renders filtered catalog, navigates to checkout |
| bff-mobile | Auth; shared `identify` endpoint (routed to `identifyPhoneNumber`); catalog aggregation |
| ppob-service | Owns catalog (feed + overrides); **in-house phone identification** (prefix → provider table) |
| Letslink | Product feed only (no identification role in this story) |

## Data

- Reads: PPOB product catalog (base + overrides), catalogue configuration, phone-prefix → provider mapping — owned by `ppob-service`; **customer identification history** — `ppob-service` (read on catalogue entry)
- Writes: none by the customer (background feed-sync refresh only; identification is a read-only lookup — except a **background upsert of identification history** on a successful full-number identify, fire-and-forget)

## Derived API Interactions

See `api/stories/03-browse-data-package.md`.

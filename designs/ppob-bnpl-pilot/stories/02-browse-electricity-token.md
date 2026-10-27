# Story 02: Browse Electricity Token Catalog

## User Story

As a customer, I want to browse available electricity token products (operator, denomination, price), so that I can pick the token I want to buy.

## Priority & Dependencies

- Priority: P0
- Depends on: story 01 (catalogue selection is the entry), product feed synced from Letslink + admin overrides (story 07)

## Acceptance Criteria

- Selecting the Electricity catalogue **fetches the product list immediately** — no filter, no identification needed to browse (price is the same for all customers).
- The screen also shows the customer's **previously identified meter numbers** (from customer-identification history), most-recent first, so the customer can re-select one instead of re-typing. Selecting just fills the meter number input (no validation during browsing).
- The screen also shows a **customer ID (meter number) input**; there is **no separate identification step during browsing** — meter validation and wattage resolution happen during the purchase inquiry (story 04). The customer enters the meter number and proceeds to checkout.
- **All electricity products are shown regardless of wattage** — price is the same per product; wattage affects the **token value** (kWh) minted by the provider backend at fulfillment, which is only visible afterwards in the token code (story 05).
- The list shows available token denominations with: operator/PLN, nominal value, **sale price** (admin override applied over the Letslink base price).
- Identification is re-validated inside the story 04 submission chain — the client-side meter number is never trusted.
- Disabled products are not shown.
- Prices reflect the latest admin override or feed sync immediately.
- Empty/failed response shows a retryable error state.

## Actors & Trigger

- Actor: customer
- Trigger: customer taps the Electricity catalogue (story 01)

## Happy Path

1. Customer taps the Electricity catalogue → product list screen opens; the list is **fetched immediately** (`bff-mobile` → `ppob-service`: Letslink feed base + admin overrides, active products only, unfiltered). The screen also fetches the customer's **previous meter identifications** (most-recent first) for quick re-selection.
2. List rendered: operator, denomination, price. The screen also shows a **meter/customer ID input** and the list of previous meters.
3. Customer enters or selects a meter number (selecting just fills the input — no validation during browsing). No separate identification call is made; the meter number is carried into checkout (story 04), where it is validated during the purchase inquiry to Letslink.
4. Customer selects a product → navigates to checkout (story 04). The entered meter number travels with the checkout (passed at draft creation/submit). Note: the same price yields a different token value depending on meter wattage — decided by the provider backend at fulfillment and shown after purchase (token code in story 05).

## Error / Edge Cases

- **Meter number format invalid** → client-side format check blocks checkout; no server call is made during browsing.
- **Meter invalid at purchase** → handled in the story 04 background chain (Letslink inquiry rejects the meter → purchase fails → unwind); the customer sees the failure in history + a failure notification (story 06).
- All products in catalogue disabled by admin → empty state ("temporarily unavailable").
- Feed sync stale/unavailable → serve last known catalog (admin overrides still applied); `ppob-service` refreshes periodically.
- `ppob-service` unavailable → error state with retry.
- Price changed by admin while customer is on the screen → checkout re-validates price server-side (story 04).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders catalog on open, meter ID input, list of previous meters, navigates to checkout |
| bff-mobile | Auth; catalog aggregation; customer-identification list endpoint (no identify for electricity) |
| ppob-service | Owns catalog (feed + overrides); owns customer-identification history (read on catalogue entry) |
| Letslink | (no call during browsing — meter validation happens at purchase, story 04) |

## Data

- Reads: PPOB product catalog (base from Letslink feed + admin overrides), catalogue configuration — owned by `ppob-service`; **customer identification history** — `ppob-service` (read on catalogue entry)
- Writes: none by the customer (background feed-sync refresh only). Identification history is written only after a successful purchase transaction (story 04).

## Derived API Interactions

See `api/stories/02-browse-electricity-token.md`.

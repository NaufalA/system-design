# Story 02: Browse Electricity Token Catalog

## User Story

As a customer, I want to browse available electricity token products (operator, denomination, price), so that I can pick the token I want to buy.

## Priority & Dependencies

- Priority: P0
- Depends on: story 01 (category selection is the entry), product feed synced from Letslink + admin overrides (story 07)

## Acceptance Criteria

- Selecting the Electricity category lists available token denominations with: operator/PLN, nominal value, **sale price** (admin override applied over the Letslink base price).
- Disabled products are not shown.
- Prices reflect the latest admin override or feed sync immediately.
- Empty/failed response shows a retryable error state.

## Actors & Trigger

- Actor: customer
- Trigger: customer taps the Electricity category (story 01)

## Happy Path

1. Customer taps the Electricity category.
2. `mobile-app` → `bff-mobile` requests the electricity catalog.
3. `bff-mobile` → `ppob-service` reads the catalog: Letslink product feed (base) overlaid with admin overrides, filtered to visible/enabled products in this category.
4. List rendered: operator, denomination, price.
5. Customer selects a product → navigates to checkout (story 04). Customer may first enter the meter/customer number on the checkout page (input captured by `mobile-app`, passed at submission).

## Error / Edge Cases

- All products in category disabled by admin → empty state ("temporarily unavailable").
- Feed sync stale/unavailable → serve last known catalog (admin overrides still applied); `ppob-service` refreshes periodically.
- `ppob-service` unavailable → error state with retry.
- Price changed by admin while customer is on the screen → checkout re-validates price server-side (story 04).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders catalog, captures meter number input, navigates to checkout |
| bff-mobile | Auth + aggregation endpoint for catalog |
| ppob-service | Owns catalog (feed + overrides), serves filtered list |

## Data

- Reads: PPOB product catalog (base from Letslink feed + admin overrides), category configuration — owned by `ppob-service`
- Writes: none (a background feed-sync refresh may update base data; not user-triggered)

## Derived API Interactions

See `api/stories/02-browse-electricity-token.md`.

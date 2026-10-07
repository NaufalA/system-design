# Story 03: Browse Mobile Data Package Catalog

## User Story

As a customer, I want to browse available mobile data packages (provider, package size, price), so that I can pick the data package I want to buy.

## Priority & Dependencies

- Priority: P0
- Depends on: story 01 (category selection is the entry), product feed synced from Letslink + admin overrides (story 07)

## Acceptance Criteria

- Selecting the Data category lists available packages with: provider, package size/duration, **sale price** (admin override applied over the Letslink base price).
- Disabled products are not shown.
- Prices reflect the latest admin override or feed sync immediately.
- Empty/failed response shows a retryable error state.

## Actors & Trigger

- Actor: customer
- Trigger: customer taps the Data category (story 01)

## Happy Path

1. Customer taps the Data category.
2. `mobile-app` → `bff-mobile` requests the data catalog.
3. `bff-mobile` → `ppob-service` reads the catalog: Letslink feed (base) + admin overrides, filtered to enabled products in this category.
4. List rendered: provider, package, price.
5. Customer selects a product → navigates to checkout (story 04). The target phone number is entered on the checkout page and passed at submission.

## Error / Edge Cases

- All products in category disabled by admin → empty state ("temporarily unavailable").
- Feed sync stale/unavailable → serve last known catalog with overrides applied.
- `ppob-service` unavailable → error state with retry.
- Price changed by admin while customer is on the screen → checkout re-validates price server-side (story 04).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders catalog, captures phone number input, navigates to checkout |
| bff-mobile | Auth + aggregation endpoint for catalog |
| ppob-service | Owns catalog (feed + overrides), serves filtered list |

## Data

- Reads: PPOB product catalog (base + overrides), category configuration — owned by `ppob-service`
- Writes: none (background feed-sync refresh only)

## Derived API Interactions

See `api/stories/03-browse-data-package.md`.

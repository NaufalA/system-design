# Story 01: Browse PPOB Catalog Categories

## User Story

As a customer, I want to see the PPOB categories (e.g. Electricity, Data) when I open the PPOB feature, so that I can choose which type of product I want to purchase.

## Priority & Dependencies

- Priority: P0
- Depends on: story 07 (admin must be able to define/configure categories; the pilot still works with seeded defaults)

## Acceptance Criteria

- Opening the PPOB entry point lists all **visible** categories configured by admin: name, icon, ordering.
- Categories created/disabled/reordered by admin via story 07 are reflected without an app release.
- Hidden/disabled categories are never shown to customers.
- Empty/failed response shows a retryable error state, not a blank screen.

## Actors & Trigger

- Actor: customer
- Trigger: customer opens the PPOB feature from the mobile-app home/menu

## Happy Path

1. Customer opens the PPOB feature.
2. `mobile-app` → `bff-mobile` requests the category list (JWT auth).
3. `bff-mobile` → `ppob-service` reads categories (admin config, stored in `ppob-service`).
4. Categories returned, rendered with name/icon in configured order.
5. Customer taps a category → navigates to the product catalog of that type (story 02 for Electricity, story 03 for Data).

## Error / Edge Cases

- No visible categories configured → empty state with message (and no PPOB entry dead-ends: app may hide the entry).
- `ppob-service` unavailable → error state with retry; no partial list rendered.
- Category visible but its catalog later returns empty (products disabled in story 07) → story 02/03 handles the empty catalog state.

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders category list, navigates on selection |
| bff-mobile | Auth + aggregation endpoint for categories |
| ppob-service | Owns category configuration data |

## Data

- Reads: PPOB category configuration (name, icon, order, visibility) — owned by `ppob-service`
- Writes: none

## Derived API Interactions

See `api/stories/01-browse-categories.md`.

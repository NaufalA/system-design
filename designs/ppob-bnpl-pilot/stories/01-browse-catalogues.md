# Story 01: Browse PPOB Catalogues

## User Story

As a customer, I want to see the PPOB catalogues (e.g. Electricity, Data) when I open the PPOB feature, so that I can choose which type of product I want to purchase.

## Priority & Dependencies

- Priority: P0
- Depends on: story 07 (admin must be able to define/configure catalogues; the pilot still works with seeded defaults)

## Acceptance Criteria

- Opening the PPOB entry point lists all **visible** catalogues configured by admin: name, icon, ordering, and **`catalogueType`** — the single identifier used consistently across the whole system (admin config, BFF paths, microservice paths).
- `catalogueType` is configured alongside the other catalogue fields in the admin dashboard (story 07). Pilot values: `electricity-token`, `mobile-data`.
- **Naming semantics:** a `catalogueType` has two parts — catalogues that handle the **same customer identifier** share the first part (e.g. `electricity-token` and a future `electricity-postpaid` both handle the electricity meter number). The first part drives BFF identification routing (story 02/03).
- Catalogues created/disabled/reordered by admin via story 07 are reflected without an app release.
- Hidden/disabled catalogues are never shown to customers.
- Empty/failed response shows a retryable error state, not a blank screen.

## Actors & Trigger

- Actor: customer
- Trigger: customer opens the PPOB feature from the mobile-app home/menu

## Happy Path

1. Customer opens the PPOB feature.
2. `mobile-app` → `bff-mobile` requests the catalogue list (JWT auth).
3. `bff-mobile` → `ppob-service` reads catalogues (admin config, stored in `ppob-service`).
4. Catalogues returned, rendered with name/icon in configured order; each entry exposes its `catalogueType`.
5. Customer taps a catalogue → navigates to the product catalog of that type (story 02 for Electricity, story 03 for Data).

## Error / Edge Cases

- No visible catalogues configured → empty state with message (and no PPOB entry dead-ends: app may hide the entry).
- `ppob-service` unavailable → error state with retry; no partial list rendered.
- Catalogue visible but its catalog later returns empty (products disabled in story 07) → story 02/03 handles the empty catalog state.

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Renders catalogue list, navigates on selection |
| bff-mobile | Auth + aggregation endpoint for catalogues |
| ppob-service | Owns catalogue configuration data |

## Data

- Reads: PPOB catalogue configuration (`catalogueType`, name, icon, order, visibility) — owned by `ppob-service`
- Writes: none

## Derived API Interactions

See `api/stories/01-browse-catalogues.md`.

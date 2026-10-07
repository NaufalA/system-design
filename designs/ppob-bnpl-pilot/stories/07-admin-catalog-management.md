# Story 07: Admin Catalog & Category Management

## User Story

As a business admin, I want to manage PPOB catalog categories (name, icon, ordering, visibility) and override product price/enablement, so that I control what customers see in the mobile app without a release.

## Priority & Dependencies

- Priority: P1
- Depends on: Letslink product feed sync (`ppob-service`); stories 01–03 consume the results

## Acceptance Criteria

- Admin can **create/edit/delete** categories: name, icon, ordering, visibility (enable/disable).
- Admin can **override** a product's sale price relative to the Letslink base price and enable/disable a product.
- Overridden price is what customers see (stories 02/03) and what checkout validates against (story 04).
- Disabling a product removes it from customer catalogs immediately; it cannot be purchased afterwards.
- Category changes are visible to customers without an app release.
- Actions are performed only through `bff-admin` → `ppob-service` (never directly from the dashboard).

## Actors & Trigger

- Actor: business admin (via `mobile-app-admin-dashboard`)
- Trigger: admin edits categories or product overrides

## Happy Path

1. Admin opens the PPOB catalog management screen.
2. `mobile-app-admin-dashboard` → `bff-admin` → `ppob-service`: list categories + products (base feed price, current override).
3. Admin creates a category (name/icon/order) or sets a product override (price / disable).
4. `ppob-service` stores the change; customer-facing catalog (stories 01–03) reflects it on next request.
5. Checkout (story 04) re-validates against the current overridden price at submit.

## Error / Edge Cases

- Override price set below aggregator cost / invalid value → rejected with validation error (`ppob-service` rule; confirm thresholds — open question).
- Delete a category that customers have products attached to → blocked, or requires reassignment (decide: block for pilot).
- Letslink feed sync later updates base price → admin override still wins; admin can clear the override to fall back to base.
- Concurrent edits by two admins → last-write-wins acceptable for pilot, or optimistic locking (confirm if needed).
- Disabling a product while a customer is mid-checkout → submit-time validation rejects; customer told product is unavailable.

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app-admin-dashboard | Admin UI for categories + overrides |
| bff-admin | BFF: auth + admin endpoints |
| ppob-service | Owns category config + product overrides; applies them to customer-facing reads |
| Letslink | Product feed (base data) used as the source for overrideable products |

## Data

- Reads: category config, product catalog + overrides — `ppob-service`; Letslink feed for base products
- Writes: category configuration; product override records (price, enabled flag) — `ppob-service`

## Derived API Interactions

See `api/stories/07-admin-catalog-management.md`.

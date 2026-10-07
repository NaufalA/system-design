# System Design Overview: PPOB on BNPL (Pilot)

## Summary

Add a Payment Point Online Bank (PPOB) feature to the existing financing mobile app, letting customers buy electricity tokens and mobile data packages (IDR 150k+) paid through their existing BNPL limit as a full-tenor installment. PPOB fulfillment is handled by a third-party aggregator, **Letslink**, while a new `ppob-service` owns the PPOB transaction lifecycle and integrates with Letslink. A new `bff-mobile` acts as the main orchestrator for the mobile app; the existing order/credit/financing pipeline (sales-portal, core-credit, core-financing) processes the order through its normal validation path.

## Goals & Non-Goals

- Goals:
  - Pilot PPOB purchases (electricity token, mobile data package) payable via BNPL installment.
  - Reuse the existing BNPL order + credit validation + financing pipeline instead of building a parallel one.
  - Keep the customer-facing checkout responsive: the app waits only until the BNPL order is created.
  - Own PPOB transaction state (pending → paid → delivered/failed) in `ppob-service`, including Letslink references and product catalog with admin overrides.
  - Provide push notification on order completion and PPOB transaction history via `sales-portal-service`.
- Non-goals:
  - Automating aggregator deposit top-up (business users top up the Letslink balance outside this system).
  - Admin operations tooling beyond product catalog overrides.
  - Payment methods other than BNPL for this pilot.
  - Any non-PPOB changes to the existing BNPL/financing flow.

## Components

| Name | Type | In-house/Third-party | Responsibility | Tech | Data owned |
| --- | --- | --- | --- | --- | --- |
| mobile-app | frontend (mobile) | In-house | Customer UI: browse products, checkout, order history, notifications | not chosen | client-local state only |
| mobile-app-admin-dashboard | frontend (web) | In-house | Business user UI: PPOB product catalog overrides | not chosen | client-local state only |
| bff-mobile | backend (BFF) | In-house (new) | Main orchestrator for mobile: auth token handling, balance check, checkout entry point, aggregation of history/result for the app | not chosen | no owned business data (orchestration/session only) |
| bff-admin | backend (BFF) | In-house (new) | BFF for admin dashboard: exposes catalog override operations | not chosen | no owned business data |
| ppob-service | backend application | In-house (new) | PPOB transaction lifecycle (pending → paid → delivered/failed), Letslink integration (balance check, purchase, product catalog), failure unwind initiator, push notification on completion | not chosen | PPOB transactions (incl. Letslink refs, token code, status), PPOB product catalog + admin overrides |
| bnpl-service | backend application | In-house (existing) | BNPL account & orders; reserve limit at order creation, deduct on transaction execution, refund on cancellation; references PPOB transaction id | existing | BNPL accounts, BNPL orders (with PPOB tx id reference) |
| sales-portal-service | backend application | In-house (existing) | Registers the order (all order types incl. PPOB), forwards to core-credit, exposes transaction/order history consumed by the app; cancels order on unwind | existing | Orders (with PPOB tx id reference), order history |
| core-credit-service | backend application | In-house (existing) | Credit eligibility + eKYC validation; on hold confirmation from core-financing, starts the PPOB transaction via bnpl-service; releases/cancels on unwind | existing | Credit validation records, tenor/interest config for PPOB orders |
| core-financing-service | backend application | In-house (existing) | Places the approved order on hold; releases the hold when the order is cancelled | existing | Financing holds, financing process records |
| user-service | backend application | In-house (existing) | Main user account + JWT authentication | existing | Users, credentials/tokens |
| notification-service | backend application | In-house (existing) | Push notifications to the mobile app (order completion) | existing | Notification records/device tokens |
| Letslink | external service | Third-party | PPOB aggregator: deposit balance query, synchronous purchase against service providers, product/pricing feed, transaction dashboard (internal to Letslink) | external | Aggregator-side transaction & balance records |
| PPOB product feed | database | In-house (derived) | Catalog synced from Letslink, overlapped by admin overrides | not chosen | Product catalog (base data + overrides) |

<!-- Types: backend application, database, frontend (mobile/web), API gateway (public/private), messaging platform, external service. -->

## Interactions Overview

| From | To | Interface | Sync/Async | Purpose |
| --- | --- | --- | --- | --- |
| mobile-app | bff-mobile | REST (JWT) | Sync | Browse PPOB products, balance pre-check entry, checkout, history queries |
| mobile-app-admin-dashboard | bff-admin | REST | Sync | Product catalog overrides (price/markup, enable/disable) |
| bff-admin | ppob-service | REST | Sync | Apply catalog overrides, read catalog |
| bff-mobile | ppob-service | REST | Sync | Product catalog read, Letslink balance check |
| ppob-service | Letslink | REST | Sync | Deposit balance check, PPOB purchase, product feed sync |
| bff-mobile | bnpl-service | REST | Sync | Checkout: create BNPL order (reserve limit) — synchronous wait boundary for the app |
| bnpl-service | sales-portal-service | REST (chained) | Sync, non-blocking for client | Register order, forward to next step |
| sales-portal-service | core-credit-service | REST (chained) | Sync, non-blocking for client | Forward order for credit eligibility + eKYC validation |
| core-credit-service | core-financing-service | REST | Sync | Check/confirm order hold status |
| core-credit-service | bnpl-service | REST | Sync | Start PPOB transaction: deduct BNPL limit, execute purchase |
| bnpl-service | ppob-service | REST | Sync | Execute PPOB purchase against Letslink |
| ppob-service | notification-service | REST/event | Async (fire-and-forget) | Push notification when the order completes |
| bnpl-service | notification-service | REST/event | Async (fire-and-forget) | Push notification on order expiry auto-cancel / manual draft cancel |
| ppob-service | bnpl-service | REST | Sync (failure path) | Refund BNPL limit and cancel the order |
| bnpl-service | sales-portal-service | REST | Sync (failure path) | Forward cancellation |
| sales-portal-service | core-credit-service | REST | Sync (failure path) | Forward cancellation; hold released (cancelled) via core-financing |
| mobile-app | sales-portal-service (via bff-mobile) | REST | Sync (polling) | Order/transaction history: in-progress and completed |
| business user | Letslink dashboard | — | n/a (outside system) | Deposit balance top-up, aggregator-side transaction view |

## Key Decisions & Trade-offs

| Decision | Options considered | Choice | Rationale |
| --- | --- | --- | --- |
| Owner of PPOB transaction record | A: stateless orchestrator, data spread across bnpl/sales-portal; B: `ppob-service` owns lifecycle record | **B** | PPOB-specific state (aggregator ref, token code, pending/failed status, unwind state) has a clean home; other services only hold references; single source of truth for PPOB lifecycle |
| Checkout synchronous boundary | A: app waits for entire chain; B: app waits only until BNPL order creation, rest continues in background | **B** | Credit validation + financing + purchase can take long; keeps checkout responsive; history UI + push notification cover the rest |
| Order chain continuation | A: chained calls with each service forwarding to the next; B: event broker choreography; C: single workflow owner | **A** (per existing pattern) | Matches how the existing pipeline already forwards orders (bnpl → sales-portal → core-credit); no new infrastructure |
| Aggregator settlement | A: pay aggregator per transaction; B: prepaid deposit balance held by Letslink, checked before purchase | **B** | Top-up handled manually by business users outside the system; balance pre-check avoids failed purchases |
| Product catalog | A: sync from Letslink + admin overrides; B: manual admin config only; C: live fetch on every browse | **A** | Accurate base data from aggregator, admin control over pricing/enablement, no per-browse dependency on Letslink |
| Failure unwind path | A: client-driven compensation; B: `ppob-service` initiates refund + cancellation through the order chain | **B** | `ppob-service` is the first component that knows of failure; refund and hold release happen through the same path the order was created |
| Push notification source | A: `ppob-service` directly; B: via sales-portal/core-financing order-completion path | **A** | `ppob-service` learns the exact outcome (delivered/failed) first and can notify immediately |
| BNPL payment shape | A: full-tenor installment; B: one-shot/pay-later; C: mixed | **A** | Reuses existing credit/financing pipeline; PPOB pilot products are ≥ IDR 150k |

## Open Questions

- **Timeout/unknown outcome at Letslink:** a status-check endpoint was mentioned but not confirmed. Without it, a timed-out purchase can only be parked as `pending` in `ppob-service` and reconciled later; refunding immediately risks refunding a successful purchase.
- **Resilience of the chained continuation:** if a service crashes mid-chain (e.g., between order registration and validation), what retries/recovery exist today? Is there a stuck-order reconciliation process?
- **Failure unwind from `core-credit-service` onward:** confirmation that the cancellation path reaches `core-financing-service` to release the hold (currently implied by "hold released through the same path").
- **History payload:** does `sales-portal-service` history include enough PPOB detail (product, token code, status) or does the app need to join with `ppob-service` data via `bff-mobile`?
- **Letslink dashboard:** not yet verified; it is aggregator-internal and not accessible to the mobile app, so it does not affect this design.

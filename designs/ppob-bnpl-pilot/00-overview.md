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
| public API gateway | API gateway (public) | In-house (existing) | Public entry point for the mobile app: TLS termination, routing of `/bff-mobile/**` to `bff-mobile` (no auth performed at the gateway) | existing (company standard) | none |
| bff-mobile | backend (BFF) | In-house (new) | Main orchestrator for mobile: auth token handling, browse/catalog aggregation, customer identification gate, balance check, checkout entry point, aggregation of history/result for the app | not chosen | no owned business data (orchestration/session only) |
| bff-admin | backend (BFF) | In-house (new) | BFF for admin dashboard: exposes catalog override operations | not chosen | no owned business data |
| ppob-service | backend application | In-house (new) | PPOB transaction lifecycle (pending → paid → delivered/failed), Letslink integration (balance check, purchase, customer/meter validation, product sync), customer identification (incl. in-house phone-prefix lookup), product catalog + catalogue config with admin overrides, failure unwind initiator, push notification on completion | not chosen | PPOB transactions (incl. Letslink refs, token code, status), PPOB product catalog + admin overrides, catalogue config (`catalogueType`), phone-prefix table |
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
| mobile-app | public API gateway | HTTPS | Sync | Public entry: TLS termination, routes `/bff-mobile/**` |
| mobile-app | bff-mobile | REST (JWT) | Sync | Browse PPOB products, balance pre-check entry, checkout, history queries (via the public API gateway) |
| mobile-app-admin-dashboard | bff-admin | REST | Sync | Product catalog overrides (price/markup, enable/disable) |
| bff-admin | ppob-service | REST | Sync | Apply catalog overrides, read catalog |
| bff-mobile | ppob-service | REST | Sync | Product catalog read, Letslink balance check, customer identification (`identifyMeter` / `identifyPhoneNumber` via the shared `/identify` endpoint) |
| ppob-service | Letslink | REST | Sync | Deposit balance check, PPOB purchase, customer/meter validation, product feed sync |
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
| Response wrapper | A: `{response, message, result}` with `response` = status code; B: boolean success flag; C: bare payloads / error-object style | **A** (status-code variant) | Uniform envelope on success and failure; `message` describes the action performed; project convention outranks AIP-style bare resources |
| Pagination & ordering | A: offset `{page, size, totalRows, totalPage, data}`; B: AIP-158 opaque `pageToken` cursors | **A** | Explicit project convention; small catalogs make offset paging simple and sufficient; 1-based `page`; microservice owns slicing, BFFs pass through. Every microservice list endpoint takes `orderBy` (`fieldName ORDER` comma-separated, no default order, invalid → 400); BFFs inject their screen's ordering (apps can't supply `orderBy`) |
| API path design | A: AIP resource-based everywhere; B: screen-aligned everywhere; C: hybrid — AIP on microservices, screen-aligned on BFFs | **C** | Microservice endpoints stay resource-based (AIP + deviations: GET/POST only, update/delete as POST custom methods, `/`-path camelCase verbs, custom-method placement asked case-by-case); BFFs mirror what a page consumes so backend resource design never leaks to the app |
| Mobile exposure | A: `mobile-app` calls `bff-mobile` directly; B: via the existing public API gateway | **B** (user-decided) | Gateway terminates TLS and routes `/bff-mobile/**` (no auth at the gateway — JWT validation stays at the BFF); also the natural place for client rate limiting (open question). Internal services stay mTLS-only, unexposed |
| Catalogue identity | A: separate internal `id` + stable `code` field; B: single `catalogueType` everywhere (admin config, BFF/microservice paths, payloads) | **B** | One admin-configured value consistent across all layers — no id mapping in the BFF; the two-part naming convention (shared first part per customer identifier) groups semantically and doubles as the identify routing key |
| Customer identification | A: per-type endpoints at the BFF (`identifyMeter`, `identifyPhoneNumber`); B: shared BFF `POST /ppob/catalogues/{catalogueType}/identify { customerId }` routed to per-type internal methods by the first part of `catalogueType`; C: dispatch inside `ppob-service` on an explicit config field | **B** (user-decided; routing mechanism open — see Open Questions) | One consistent app-facing endpoint while internal methods keep typed signatures (story 04 re-validation reuses them); responses unified by a fixed core + typed `details` (canonical: `api/README.md`); products list decoupled from identification |
| Product-type list behaviour | A: same for all catalogues (list after identify); B: per catalogue — `electricity-token` fetches immediately (unfiltered, identify only gates checkout), `mobile-data` identifies first then lists filtered by required `providerCode` | **B** | Electricity price is identical for all, so browsing needs no identification; data packages must never appear unfiltered — `providerCode` is enforced server-side |
| Balance check ordering | A: check at draft creation; B: check before any draft exists | **B** | Insufficient aggregator balance means no draft is ever created (nothing to cancel) |
| Unfinished checkout | A: abandon + recreate; B: draft resumable from history | **B** | Customers leave mid-flow; drafts appear in history with a Continue action; draft creation is skipped on resume (balance check re-run) |
| Order expiry & auto-cancel | A: hard deadline regardless of state; B: state-scoped timers (1 day draft / 5 min submitted; off once processing starts) | **B** | A hard deadline against the synchronous Letslink call creates a cancel-vs-purchase race; timers only fire while the order is cancellable; auto-cancel notifies via `notification-service` |
| Notification routing | A: `ppob-service` for everything; B: centralized `notification-service`, multiple senders | **B** | `notification-service` is an existing centralized utility — `ppob-service` sends purchase outcomes, `bnpl-service` sends expiry/manual-cancel events |
| Electricity pricing semantics | A: price tiers by wattage; B: uniform price, wattage affects minted token value | **B** | Price is identical for all customers; the provider backend mints kWh by meter wattage at fulfillment — visible only post-purchase in the token code; therefore identification never filters the list (it gates checkout instead) |
| Client-supplied results | A: trust browse-time identification/price; B: re-validate server-side in the story 04 chain | **B** | Trust rule (canonical: `api/README.md`): client results are advisory; identification and price are re-derived before the Letslink purchase — never authoritative |
| PPOB transaction history | A: app joins `sales-portal-service` orders + `ppob-service` detail via `bff-mobile`; B: duplicate PPOB detail into `sales-portal-service` | **A** | History source of truth stays `sales-portal-service` (all order types); PPOB-specific fields (status, token code) joined by the BFF without duplication |

## Open Questions

- **Timeout/unknown outcome at Letslink:** a status-check endpoint was mentioned but not confirmed. Without it, a timed-out purchase can only be parked as `pending` in `ppob-service` and reconciled later; refunding immediately risks refunding a successful purchase.
- **Resilience of the chained continuation:** if a service crashes mid-chain (e.g., between order registration and validation), what retries/recovery exist today? Is there a stuck-order reconciliation process?
- **Failure unwind from `core-credit-service` onward:** confirmation that the cancellation path reaches `core-financing-service` to release the hold (currently implied by "hold released through the same path").
- **Letslink dashboard:** not yet verified; it is aggregator-internal and not accessible to the mobile app, so it does not affect this design.
- **Identify routing by `catalogueType` naming prefix (user-decided for the pilot, kept open):** `bff-mobile` routes `/identify` on the first part of `catalogueType` (`electricity-*` → `identifyMeter`, `mobile-*` → `identifyPhoneNumber`). Concerns: the prefix→method map lives in BFF code, so a new first part (e.g. `water-token`, also a meter) needs a code deploy; a typo'd `catalogueType` fails to match at runtime; and the name can only encode one identifier per group. Alternatives when the catalogue set grows: an explicit `identifierType` field on the catalogue config (admin-set, naming convention kept as a human/validation rule), or dispatch inside `ppob-service` (config owner). Decide before onboarding the next catalogue.
- **Catalogue capability config:** catalogue behavior (which identification routing applies, whether/which filter the list needs) is hard-coded per `catalogueType` in the pilot (see Key Decisions). Promote to configuration on the catalogue resource when catalogue #3 arrives — decide before then (the naming-prefix question above is part of this decision).
- **Story 07 scope gaps:** the `catalogueType` lifecycle (creation validation, uniqueness, immutability after creation — now partially reflected in story 07 AC) and the phone-prefix table management ("TBD in story 07 scope" in `api/applications/ppob-service.md`) must be settled before story 07 is implemented.
- **Missing backlog stories:** Letslink product feed sync (schedule, cold start, stale alerting) and pilot seeding (default catalogues/products) are referenced by existing stories but owned by none.
- **Identification rate limiting:** `identifyMeter` triggers a paid external call per customer attempt — quota/abuse protection is unspecified; the public API gateway is the natural enforcement point.

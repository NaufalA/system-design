# Story 04: Buy PPOB Product with BNPL

## User Story

As a customer, I want to buy a PPOB product (electricity token or mobile data package) paying with my BNPL limit in installments, so that I can complete the purchase through the financing I already have.

## Priority & Dependencies

- Priority: P0
- Depends on: story 02 or 03 (product selected); existing BNPL/credit/financing pipeline; Letslink deposit balance sufficient

## Acceptance Criteria

- Checkout flow completes with: **balance check → draft order** → tenor selection → T&C checklist (incl. financing document acceptance) → transaction PIN → submit.
- **Precondition:** customer identification (shared identify endpoint `POST /ppob/catalogues/{catalogueType}/identify`, `customerId` in — story 02: routed to `identifyMeter` via Letslink; story 03: routed to `identifyPhoneNumber`, in-house) has succeeded **explicitly before** the balance check and draft creation; the entered customer ID + identification result are carried into checkout. The identification is **re-run server-side** in the background chain before the Letslink purchase — the earlier client-facing result is never trusted.
- The order is only forwarded to core system checks after PIN entry; no limit is reserved before that.
- **Letslink deposit balance is checked first, before any draft order exists**; insufficient balance means no draft is ever created.
- A **draft order** is created in `bnpl-service`, `sales-portal-service`, and `core-credit-service` when the checkout page is opened — unless an existing draft for this customer/product is resumed (story 05), in which case the existing draft is reused, not duplicated.
- Draft expiry: **1 day** (auto-cancel + notification). Submitted-order expiry: **5 minutes** (auto-cancel + notification) — the timer only applies while the order is in draft/submitted state; once the chain starts processing it no longer fires.
- Customer can **manually cancel** a draft.
- On Letslink failure: BNPL limit refunded, order cancelled through the chain, hold released — customer sees a clear failure state.
- On success: PPOB transaction marked delivered, token code shown for electricity (via history/story 05), push notification on completion.
- Insufficient Letslink deposit balance is detected **before** creating the order.

## Actors & Trigger

- Actor: customer
- Trigger: customer selects a product (story 02/03) and enters the checkout page

## Happy Path

1. Customer selects a product (story 02/03) — identification already passed — and **enters the checkout page**:
   a. `bff-mobile` → `ppob-service` → Letslink: **deposit balance check**. Insufficient → error, checkout blocked, **no draft created**.
   b. Balance OK → `bff-mobile` creates a **draft order** carrying the customer ID + identification result: `bnpl-service` → `sales-portal-service` → `core-credit-service` (chained). No limit reserved. The 1-day draft expiry starts.
   (Resuming a draft from history — story 05 — skips draft creation but **re-runs the balance check**.)
2. Customer selects an **installment tenor** (options from `core-credit-service`). Purchase details (meter number / phone number) were entered during identification (stories 02/03) and are shown for confirmation.
3. Customer taps checkout → **order summary** with T&C acceptance checklist. One item requires opening the **financing document draft**; the customer accepts it inside that view, which marks the checklist item as accepted.
4. Customer enters **transaction PIN** (validated by `bnpl-service`) → order is **submitted**; the 5-minute submitted expiry starts.
5. **Background chain** (customer no longer waits; app polls history — story 05):
   a. `sales-portal-service` forwards the order → `core-credit-service`.
   b. `core-credit-service` runs credit eligibility + eKYC validation.
   c. Validation passed → `core-credit-service` checks hold status with `core-financing-service`; order is **held**; **BNPL limit is reserved/deducted** via `bnpl-service`.
   d. `core-credit-service` → `bnpl-service` starts the PPOB transaction → `ppob-service` **re-identifies server-side** (`identifyMeter` → Letslink for electricity; `identifyPhoneNumber` in-house for data), then executes the **Letslink purchase** (synchronous), records PPOB transaction status (pending → delivered/failed) with the PPOB tx id referenced by `bnpl-service` and `sales-portal-service`.
   e. Success → `ppob-service` sends completion push via `notification-service` (story 08). Token code (electricity) visible in history (story 05).


## Error / Edge Cases

- **Letslink failure** → `ppob-service` initiates unwind: refund BNPL limit + cancel order → `bnpl-service` → `sales-portal-service` → `core-credit-service` → hold released (`core-financing-service`); customer sees failure in history + failure notification (story 06).
- **Server-side re-identification fails** in the background chain (meter now invalid, prefix mismatch) → treated like a purchase failure: `ppob-service` unwinds the same way (refund + cancel).
- **Draft expiry (1 day)** or **manual cancel** → order cancelled through the chain; no refund needed (no limit touched yet); notification sent.
- **Submitted expiry (5 min)** → auto-cancel only while still in `submitted` state; if the chain has begun processing, the timer does not fire (no cancel-vs-Letslink race).
- **Insufficient Letslink balance** → blocked at entry before draft creation; for a resumed draft (story 05), checkout cannot proceed and the draft sits until expiry or manual cancel (customer informed).
- **Price changed by admin/feed during checkout** → server-side re-validation at submit; customer asked to re-confirm if price differs.
- **PIN invalid / locked** → submission rejected; order remains draft (subject to 1-day expiry).
- **Customer abandons checkout** → draft expires after 1 day (or is manually cancelled).
- **T&C / financing document not accepted** → submit button remains disabled client-side; server rejects submission without recorded acceptance.
- **Timeout/unknown outcome at Letslink** → PPOB transaction parked as `pending` in `ppob-service`, reconciled via Letslink status check (open question — see `00-overview.md`).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | Checkout UI: draft page, tenor select, T&C checklist, financing document view, PIN entry, result state |
| bff-mobile | Main orchestrator: balance pre-check, draft creation entry, submit, result polling support |
| ppob-service | Balance check, Letslink purchase execution, PPOB transaction lifecycle, failure unwind initiator, completion push |
| bnpl-service | Draft/BNPL order creation, limit reserve/deduct/refund, PIN validation, expiry timers + auto-cancel, holds PPOB tx id |
| sales-portal-service | Order registration (draft → submitted), forwards to core-credit, cancellation forwarding, holds PPOB tx id |
| core-credit-service | Credit eligibility + eKYC validation, hold status check with core-financing, starts PPOB transaction |
| core-financing-service | Places/approves hold, releases hold on cancel |
| notification-service | Completion / auto-cancel / failure push (story 08) |
| Letslink | Deposit balance check, synchronous purchase |

## Data

- Reads:
  - Letslink deposit balance, product price (via `ppob-service`)
  - Tenor options (via `core-credit-service`)
  - BNPL account/limit status (`bnpl-service`)
- Writes:
  - Draft/submitted BNPL order + limit reserve/deduct/refund — `bnpl-service`
  - Order (draft → submitted → completed/cancelled), PPOB tx id reference — `sales-portal-service`
  - Credit validation record, order hold — `core-credit-service` / `core-financing-service`
  - PPOB transaction lifecycle (pending → delivered/failed), Letslink reference, token code — `ppob-service`

## Derived API Interactions

See `api/stories/04-buy-with-bnpl.md`.

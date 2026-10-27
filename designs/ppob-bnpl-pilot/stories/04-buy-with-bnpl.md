# Story 04: Buy PPOB Product with BNPL

## User Story

As a customer, I want to buy a PPOB product (electricity token or mobile data package) paying with my BNPL limit in installments, so that I can complete the purchase through the financing I already have.

## Priority & Dependencies

- Priority: P0
- Depends on: story 02 or 03 (product selected); existing BNPL/credit/financing pipeline; Letslink deposit balance sufficient

## Acceptance Criteria

- Checkout flow completes with: **balance check → inquiry (draft order)** → payment screen (loads BNPL transaction, tenor options, insurance, financing figures and installment schedule; customer selects a tenor and triggers the calculation) → order summary + T&C/financing document acceptance → **submit** → e-sign screen (transaction PIN). The inquiry-first order mirrors the current partner flow and is kept for consistency.
- **Precondition:** customer identification (shared identify endpoint `POST /ppob/catalogues/{catalogueType}/identify`, `customerId` in — story 02: routed to `identifyMeter` via Letslink; story 03: routed to `identifyPhoneNumber`, in-house) has succeeded **explicitly before** the balance check and draft creation; the entered customer ID + identification result are carried into checkout. The identification is **re-run server-side** in the background chain before the Letslink purchase — the earlier client-facing result is never trusted.
- **Letslink deposit balance is checked first, before any draft order exists**; insufficient balance means no draft is ever created.
- A **draft order** is created in `bnpl-service` and `sales-portal-service` (inquiry flow — `bnpl-service` forwards to the sales-portal create-order endpoint, then saves to `bnpl_order`) when the customer **clicks buy** on the product catalog screen — i.e. **before** the payment screen. Unless an existing draft for this customer/product is resumed (story 05), in which case the existing draft is reused, not duplicated. The order is created in `core-credit-service` **at submit, not at draft**.
- **Financing-term acceptance is enforced client-side only** — the app blocks navigation until the document is viewed and accepted; there is **no server-side acceptance record**, so the server does not (and cannot) verify it.
- The order is **forwarded to core system checks at submit**, before the e-sign PIN (which happens on a later screen) — but **no limit is reserved** until the chain's credit validation passes.
- Draft expiry: **1 day** (auto-cancel + notification). Submitted-order expiry: **15 minutes** (auto-cancel + notification) — the timer only applies while the order is in draft/submitted state; once the chain starts processing it no longer fires.
- Customer can **manually cancel** a draft.
- On Letslink failure: BNPL limit refunded, order cancelled through the chain, hold released — customer sees a clear failure state.
- On success: PPOB transaction marked delivered, token code shown for electricity (via history/story 05), push notification on completion.
- Insufficient Letslink deposit balance is detected **before** creating the order.

## Actors & Trigger

- Actor: customer
- Trigger: customer selects a product (story 02/03) and enters the checkout page

## Happy Path

1. Customer taps **buy** on a product in the catalog screen (story 02/03) — identification already passed:
   a. `bff-mobile` → `ppob-service` → Letslink: **deposit balance check**. Insufficient → error, checkout blocked, **no draft created**.
   b. Balance OK → `bff-mobile` → `bnpl-service` **inquiry** → draft order created (`sales-portal-service` + `bnpl_order`). The 1-day draft expiry starts.
   c. App navigates to the **payment screen**, which loads its data with **sequential calls**: **get BNPL transaction → list tenor → list insurance → calculate financing → get installment schedule**. A **calculate button** is present but **disabled on screen load**.
   (Resuming a draft from history — story 05 — skips the inquiry but **re-runs the balance check**.)
2. Customer selects an **installment tenor** (options via `bnpl-service` → `core-credit-service`):
   a. **list insurance** runs again for the new tenor.
   b. The **calculate button is enabled**; the **checkout button is disabled** (no financing figures yet for this tenor).
   c. On **calculate** → **calculate financing → get installment schedule** — the figures and the schedule for the chosen tenor are shown.
3. **Order summary** with T&C acceptance checklist. One item requires opening the **financing term document** (rendered by `bnpl-service` from the transaction); the customer accepts it in that view — the checklist state is **client-side only**.
4. Customer taps **submit** → `bnpl-service` **submit transaction** → order submitted (limit check, sales-portal submit, core-credit order created). The submitted expiry starts.
5. **E-sign screen** (separate screen after submit): customer enters the **transaction PIN**.
6. **Background chain** (customer no longer waits; app polls history — story 05):
   a. `sales-portal-service` forwards the order → `core-credit-service`.
   b. `core-credit-service` runs credit eligibility + eKYC validation.
   c. Validation passed → `core-credit-service` checks hold status with `core-financing-service`; order is **held**; **BNPL limit is reserved/deducted** via `bnpl-service`.
   d. `core-credit-service` → `bnpl-service` starts the PPOB transaction → `ppob-service` **re-identifies server-side** (`identifyMeter` → Letslink for electricity; `identifyPhoneNumber` in-house for data), then executes the **Letslink purchase** (synchronous), records PPOB transaction status (pending → delivered/failed) with the PPOB tx id referenced by `bnpl-service` and `sales-portal-service`.
   e. Success → `ppob-service` sends completion push via `notification-service` (story 08). Token code (electricity) visible in history (story 05).


## Error / Edge Cases

- **Letslink failure** → `ppob-service` initiates unwind: refund BNPL limit + cancel order → `bnpl-service` → `sales-portal-service` → `core-credit-service` → hold released (`core-financing-service`); customer sees failure in history + failure notification (story 06).
- **Server-side re-identification fails** in the background chain (meter now invalid, prefix mismatch) → treated like a purchase failure: `ppob-service` unwinds the same way (refund + cancel).
- **Draft expiry (1 day)** or **manual cancel** → order cancelled through the chain; no refund needed (no limit touched yet); notification sent.
- **Submitted expiry (15 min)** → auto-cancel only while still in `submitted` state; if the chain has begun processing, the timer does not fire (no cancel-vs-Letslink race).
- **Insufficient Letslink balance** → blocked at entry before draft creation; for a resumed draft (story 05), checkout cannot proceed and the draft sits until expiry or manual cancel (customer informed).
- **Price changed by admin/feed during checkout** → server-side re-validation at submit; customer asked to re-confirm if price differs.
- **PIN invalid / locked** → the e-sign step fails after the order was already submitted; the order stays in its submitted state and follows the submitted-expiry/auto-cancel path (no draft remains to fall back to).
- **Customer abandons checkout** → draft expires after 1 day (or is manually cancelled).
- **T&C / financing document not accepted** → the app blocks navigation client-side; there is no server-side acceptance record, so the server does not reject the submission on that basis.
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

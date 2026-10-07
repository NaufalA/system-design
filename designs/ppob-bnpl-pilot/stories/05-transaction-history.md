# Story 05: PPOB Transaction History

## User Story

As a customer, I want to see my in-progress and completed PPOB transactions (including the electricity token code) and continue any draft order I left unfinished, so that I can track orders, resume where I left off, and retrieve what I bought.

## Priority & Dependencies

- Priority: P0
- Depends on: story 04 (orders/transactions to show)

## Acceptance Criteria

- History lists both **in-progress** and **completed** (and failed) PPOB orders.
- Each entry shows: product info (operator/provider, denomination/package), amount/price, order status, created/paid timestamps.
- Electricity token code is shown on delivered transactions; data package entries show delivery status instead.
- **Draft orders** (customer left the checkout page before submitting) appear in history with a **"Continue"** action that resumes checkout (story 04) with the existing draft — draft creation is skipped, the balance check is re-run, and entered data (tenor, meter/phone number, T&C state) is restored where stored.
- Drafts respect their remaining **1-day expiry**; a cancelled/expired draft is read-only in history.
- Tapping an entry opens detail; polling keeps in-progress statuses fresh while the screen is open.
- History source of truth is `sales-portal-service`; PPOB-specific fields are joined by `bff-mobile` from `ppob-service`.

## Actors & Trigger

- Actor: customer
- Trigger: customer opens the order/transaction history interface

## Happy Path

1. Customer opens history.
2. `mobile-app` → `bff-mobile` requests history.
3. `bff-mobile` → `sales-portal-service` fetches orders (all order types; PPOB ones identified by the PPOB tx id reference).
4. `bff-mobile` → `ppob-service` fetches PPOB detail for those orders (product, PPOB status, token code).
5. `bff-mobile` joins both into the history payload → rendered, sorted newest first.
6. Entries in **draft** state show a **Continue** action → customer resumes checkout: `bff-mobile` loads the draft (tenor, purchase details, T&C state) → balance check re-run → checkout continues from story 04 step 2 (draft creation skipped, no duplicate).
7. While the screen is open, in-progress orders are re-polled until they reach a terminal state.

## Error / Edge Cases

- **Resuming an expired/cancelled draft** → Continue action gone or rejected; entry read-only.
- **Draft expiry while viewing** → next poll shows cancelled (auto-cancel notification per story 08).

- Orders exist but PPOB detail fetch fails → show orders with generic info, degrade token code/status (retry in background).
- `sales-portal-service` unavailable → error state with retry.
- In-progress order cancels (expiry) while on screen → status flips to cancelled on next poll.
- Old orders beyond retention/page limit → pagination.
- Non-PPOB orders appear in the same history but without PPOB-specific fields (no join attempted).

## Participating Components

| Component | Role in this story |
| --- | --- |
| mobile-app | History list/detail UI, polling while open, "Continue" entry point for drafts |
| bff-mobile | Fetches from both owners, joins, returns unified payload; loads/resumes draft state |
| sales-portal-service | Owns order history (status, amounts, timestamps) incl. draft orders |
| ppob-service | Owns PPOB detail (product, PPOB status, token code); balance check on resume |

## Data

- Reads:
  - Orders incl. PPOB tx id reference — `sales-portal-service`
  - PPOB transaction (status, product, token code) — `ppob-service`
  - Draft state (tenor, purchase details, T&C acceptance) — `sales-portal-service` / `core-credit-service` (confirm owner at API time)
- Writes: none (resuming a draft writes only once the customer proceeds in story 04)

## Derived API Interactions

See `api/stories/05-transaction-history.md`.

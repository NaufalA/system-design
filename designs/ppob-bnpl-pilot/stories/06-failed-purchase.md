# Story 06: Failed Purchase Handling

## User Story

As a customer, I want to be clearly informed when my PPOB purchase fails and to see that any BNPL charge has been refunded, so that I trust the feature with my money.

## Priority & Dependencies

- Priority: P0
- Depends on: story 04 (purchase), story 05 (history display), story 08 (notification)

## Acceptance Criteria

- A Letslink purchase failure results in: PPOB transaction marked `failed` in `ppob-service`, BNPL limit refunded, order cancelled, hold released — all through the unwind chain.
- Customer sees a clear failure state (push notification + history entry) with a reason category (e.g. "provider unavailable", "balance issue") where known.
- Refund is visible: BNPL limit/available credit reflects the refund; the order shows cancelled/failed, not partially paid.
- No double-charge: exactly one deduction and one refund per failed transaction.
- Timeout/unknown outcome is shown as **pending** (not failed) until reconciled — never reported as failed while the outcome is unknown.

## Actors & Trigger

- Actors: customer (affected), `ppob-service` (initiates the unwind on Letslink failure)
- Trigger: Letslink purchase returns failure (or is reconciled as failed)

## Happy Path (system-driven)

1. `ppob-service` receives a failure from Letslink.
2. `ppob-service` → `bnpl-service`: refund BNPL limit + cancel order.
3. `bnpl-service` → `sales-portal-service`: cancel order (also records the refund against the BNPL order).
4. `sales-portal-service` → `core-credit-service`: cancel → hold released by `core-financing-service`.
5. `ppob-service` marks the PPOB transaction `failed`.
6. `ppob-service` → `notification-service`: failure push (story 08).
7. Customer opens history (story 05): failed status + refund visible; BNPL available limit restored.

## Error / Edge Cases

- **Unwind itself fails midway** (e.g. refund succeeded but cancellation not forwarded) → `ppob-service` retries the unwind; order/hold inconsistency is surfaced via correlation-id alerting (see `01-architecture.md` observability) — no silent stuck states.
- **Letslink outcome unknown (timeout)** → transaction stays `pending`; reconciled via status check; reported as failed only after reconciliation confirms failure.
- **Customer already pushed notification** for an order that later resolves as pending → history shows pending until reconciliation settles it.
- **Partial failure of push** → history remains the source of truth; notification is best-effort.

## Participating Components

| Component | Role in this story |
| --- | --- |
| ppob-service | Detects failure, marks PPOB tx failed, initiates retryable unwind, requests failure push |
| bnpl-service | Refunds limit, cancels order, forwards cancellation |
| sales-portal-service | Cancels order, forwards to core-credit |
| core-credit-service | Processes cancellation |
| core-financing-service | Releases hold |
| notification-service | Failure push |
| mobile-app | Failure state, refund indication |
| bff-mobile | Joins failed status + refund info for history/detail |

## Data

- Reads: Letslink purchase outcome (`ppob-service`); BNPL limit/order state (`bnpl-service`)
- Writes:
  - PPOB transaction status → `failed`, unwind state — `ppob-service`
  - Refund record, BNPL order cancelled, limit restored — `bnpl-service`
  - Order cancelled — `sales-portal-service`
  - Hold released — `core-financing-service`

## Derived API Interactions

See `api/stories/06-failed-purchase.md`.

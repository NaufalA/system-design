# Story 08: Completion & Auto-Cancel Notifications

## User Story

As a customer, I want to receive a push notification when my PPOB order completes (or is auto-cancelled), so that I know the outcome without checking history myself.

## Priority & Dependencies

- Priority: P1 (P0-adjacent: it is the primary out-of-app outcome signal since checkout returns early)
- Depends on: story 04 (orders producing outcomes), existing `notification-service`

## Acceptance Criteria

- Push sent when the PPOB purchase **succeeds** (delivered): includes order/product summary; electricity includes that the token is available (token code itself retrieved in-app).
- Push sent when the purchase **fails**: refund initiated, clear failure wording.
- Push sent on **auto-cancel** (draft 1-day expiry, submitted 5-min expiry) and on **manual cancel** of a draft.
- Notification is **best-effort**: history (story 05) remains the source of truth; no notification ⇒ customer still sees status in-app.
- `notification-service` is a **centralized utility**: `ppob-service` sends purchase outcomes (delivered/failed), `bnpl-service` sends auto-cancel/manual-cancel events — both call the same service.

## Actors & Trigger

- Actor: customer (recipient)
- Triggers:
  - `ppob-service` records PPOB transaction delivered/failed → push via `notification-service`
  - `bnpl-service` auto-cancel fires (expiry) or customer manually cancels draft → push via `notification-service`

## Happy Path

1. Background chain completes (story 04).
2. `ppob-service` marks the PPOB transaction `delivered` (or `failed` after unwind).
3. `ppob-service` → `notification-service`: send completion push (device token from `notification-service` registry).
4. `notification-service` → FCM → `mobile-app` renders the notification; tap opens history (story 05) with the order detail.

## Error / Edge Cases

- `notification-service` unavailable → notification dropped (fire-and-forget); retry best-effort at most once; never blocks the purchase chain.
- Push delivered but customer never opens → history still shows final state.
- Auto-cancel fires → notification sent (owner: `bnpl-service` → `notification-service`).
- Device has notifications disabled/permission denied → no error path; history is the fallback.

## Participating Components

| Component | Role in this story |
| --- | --- |
| ppob-service | Sends purchase-outcome notifications (delivered/failed) |
| bnpl-service | Sends auto-cancel / manual-cancel draft notifications (timer owner) |
| notification-service | Formats + delivers push to the device |
| mobile-app | Renders notification, deep-links to order detail |

## Data

- Reads: PPOB transaction outcome (`ppob-service`), order status/expiry events (`bnpl-service`), device tokens (`notification-service`)
- Writes: notification records/device token registry — `notification-service`

## Derived API Interactions

See `api/stories/08-completion-notification.md`.

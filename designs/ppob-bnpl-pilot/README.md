# PPOB on BNPL (Pilot)

PPOB feature (electricity token, mobile data package) on the existing financing mobile app, paid via BNPL installment, fulfilled through the third-party aggregator Letslink. Microservices architecture with BFFs.

## Artifacts

| Doc | Contents |
| --- | --- |
| [00-overview.md](00-overview.md) | System design overview: components, interactions, key decisions, open questions |
| [01-architecture.md](01-architecture.md) | Solution architecture: diagrams (overview, happy path, failure path), component details, data flow |
| [stories/](stories/) | User stories (per story) |
| [api/stories/](api/stories/) | API design per story |
| [api/applications/](api/applications/) | API design per application (source of truth for endpoint contracts) |

## Story List

| ID | Actor | Goal | Priority |
| --- | --- | --- | --- |
| [01](stories/01-browse-categories.md) | Customer | View PPOB catalog categories and pick a product type (categories admin-configurable) | P0 |
| [02](stories/02-browse-electricity-token.md) | Customer | Browse electricity token catalog (operator, denomination, price) | P0 |
| [03](stories/03-browse-data-package.md) | Customer | Browse mobile data package catalog (provider, package, price) | P0 |
| [04](stories/04-buy-with-bnpl.md) | Customer | Purchase with BNPL: draft order, tenor, T&C + financing doc acceptance, PIN, submit, background chain, result | P0 |
| [05](stories/05-transaction-history.md) | Customer | View in-progress & completed PPOB transaction history (incl. token code) | P0 |
| [06](stories/06-failed-purchase.md) | Customer | Handle failed purchase: refund visible, clear status | P0 |
| [07](stories/07-admin-catalog-management.md) | Admin | Manage catalog categories + override product price/enablement | P1 |
| [08](stories/08-completion-notification.md) | Customer | Receive push notification on completion (incl. auto-cancel) | P1 |

## Cross-story Notes

- **PPOB transactions are treated exactly like other BNPL orders** in the existing flow; `ppob-service` only adds the PPOB side.
- **Balance check first** — Letslink deposit balance is checked before any draft order is created; insufficient balance means no draft exists.
- **Draft resume** — draft orders left unfinished appear in history (story 05) with a Continue action that resumes checkout (story 04) without duplicating the draft.
- **Order expiry & auto-cancel** (owner: `bnpl-service`): 1 day in draft state (entry to checkout page until submit), 5 minutes once submitted for core system checks. Auto-cancel only fires while the order is still in a cancellable state (draft/submitted) — once the background chain starts processing, the timer no longer applies (avoids cancel-vs-Letslink race). Auto-cancel emits a notification (story 08).
- **Manual cancel of a draft** by the customer is supported.
- **No BNPL limit reservation at draft time** — the limit is only reserved/deducted after submission.
- **History payload:** `sales-portal-service` owns history; `bff-mobile` joins PPOB detail (product, PPOB status, token code) from `ppob-service`.
- **Notification routing:** `notification-service` is the centralized utility for all pushes; both `ppob-service` (purchase outcomes) and `bnpl-service` (expiry/manual-cancel events) call it.

## Status

- Phase 0: intake ✅
- Phase 1: high-level architecture ✅ (open questions tracked in `00-overview.md`)
- Phase 2: stories ✅ (01–08) · API design ⬜

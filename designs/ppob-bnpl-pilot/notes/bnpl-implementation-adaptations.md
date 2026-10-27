# BNPL Service — Implementation Adaptations for the PPOB Project

Working notes on how **existing `bnpl-service` endpoints** behave and how the PPOB pilot adapts to them. Endpoint contracts themselves live in [`api/applications/bnpl-service.md`](../api/applications/bnpl-service.md); this document records the discussion — signatures, entities, DB effects, and the decisions taken — so the "why" behind the story/API docs is preserved.

## Standing decisions

- **Document existing endpoints verbatim** — exactly how they behave today (paths, auth, payload shapes, upstream field names), even where they deviate from this project's conventions. Convention deltas are noted inline, not normalized.
- **Reuse over re-wrap** — if an existing endpoint already serves the requirement, no new BFF endpoint is introduced (reduces implementation backlog). Where an existing endpoint is used as-is, the caller pattern of the current implementation is kept.
- **`bff-mobile` is a partner of `bnpl-service`** for the PPOB side of the business: from `bnpl-service`'s perspective the whole PPOB side acts as one partner, using the same partner-facing endpoints other partners use.
- **Existing endpoint inventory used in the current transaction flow:** List Tenor, Inquiry Transaction, Get Important Information, Submit Transaction.

## List Tenor

**Q1 — Exact signatures?**
- `bnpl-service`: `POST /v2/private/bnpl/calculate/financing/listtenor`
- `core-credit-service`: `POST /core-credit/calculateFinancingAndListTenor` — the **same** endpoint used by the internal calls (get-important-information / submit); only the `branchCode` field was omitted from that explanation.

**Q2 — Client input shape?**
- Only `price` in the POST body. `customerType` is derived server-side, following the same pattern as submit transaction: `USER` (user_management DB) by `userId` → `CREDIT_USER_DATA` (universal_data DB) by `userData.citizenId` → `customerType`. `branchCode` is **hardcoded to `889`** server-side (not sent by the caller, not derived). (The first walkthrough described a `bnpl_account` lookup yielding `customerType` + `branchCode`; superseded.)

**Q3 — Result nesting / field mapping?**
- No transformation. The core-credit response is placed in an inner `Result` field under the wrapper's `result` (verbatim upstream field names).
- Core-credit `ListTenor[]` item fields: `installmentAmount`, `adminFee`, `serviceFee`, `interestRate`, `tenor`, `outstandingAmount`, **`withInsurance`** — `withInsurance` is a **string** `"0"`/`"1"` (legacy insurance option from the previous business; expected off for PPOB).

**Q4 — DB effect?**
- **Read only** (no writes): `USER` + `CREDIT_USER_DATA` lookups; core-credit reads tenor/interest config.

**Caller:** `mobile-app` calls `bnpl-service` **directly** with its JWT (current implementation — BFF services and BFF-handled auth were only introduced with this project). No BFF endpoint added for this.

## Inquiry Transaction

**Q1 — Signature and auth?**
- `POST /bnpl/v1/public/user/payment/inquiry`
- Auth: **Public-Key header**, key configured in database (partner-style auth — not the customer JWT).
- Request: commerce-shaped — `transactionDetails` (`orderId` = `{MerchantPrefix}-{uniqueId}`, `amount`, `items[]`), `customerDetails`, `sellers[]`, billing/shipping addresses, insurance arrays, callback URLs (`approvedNotificationUrl`, `cancellationRedirectUrl`, `backToStoreUrl`, `invoiceUrl`), `expirationDate`, `paymentType`.
- Response: wrapper with `result.RedirectUrl` (redirect to checkout page with token).

**Q2 — Role in the flow / who calls it?**
- Creates the **draft order**. Process goes **up to `sales-portal-service` only**: `bnpl-service` forwards to the sales-portal create-order endpoint and, on success, saves the order into its own `bnpl_order` table. No `core-credit-service` involvement at this point.
- **Caller is `bff-mobile`** (option A): from `bnpl-service`'s perspective `bff-mobile`/the PPOB side is a partner. The BFF's balance check precedes it — ordering is enforced server-side, the app never calls inquiry directly.

**Q3 — When is the draft created (interaction timing)?**
- PPOB follows the current partner flow: the draft is created **only after the customer clicks checkout** on the checkout screen — **not** when the checkout page is opened.
- Consequence: the tenor is already chosen before inquiry runs, so `paymentType` (e.g. `"12_months"`) reflects the selected tenor at draft-creation time.

**Q4 — `expirationDate`?**
- **Caller-supplied** (by the `bff-mobile` checkout endpoint). With the settled expiry rules: **inquiry → now + 1 day** (draft expiry); **submit → now + 15 minutes** (submitted expiry).

**Q5 — Commerce fields for PPOB?**
- `items[]` follows the current implementation, with the **discount voucher sent as one of the items**; some arrays may be left empty.
- `RedirectUrl` in the response **can be ignored** by the mobile flow.

**Q6 — Core-credit correction to story 04?**
- Confirmed correction: the order is created in `core-credit-service` **at order submit, not at order draft**. (Story 04's previous statement — draft created in core-credit at page open — was wrong on both counts.)

**Q7 — Draft expiry and balance-check timing (settled)?**
- **Draft expiry stays 1 day** (auto-cancel + notification) — the 1-day decision stands.
- **Balance check stays on checkout-page open** (separate step, before any draft exists); the draft is created later, on checkout click.

**DB effect:** insert into `bnpl_order` (bnpl-service) after sales-portal's create-order succeeds; sales-portal-service inserts its own order record. Read: partner/public-key config from DB.

## Get Important Information

**Q1 — Signature?**
- `POST /v2/private/bnpl/important-information`
- Request: `{ orderId }`
- Response: standard wrapper, `result = { HTML_Base64 }` (base64-rendered financing term document).

**Q2 — Auth / caller?**
- JWT issued by `user-service`; `userId` taken from the token claim → missing → `400`.
- Purpose: renders the **financing term document draft** the customer must view and agree to before checkout proceeds (story 04's T&C step).

**Q3 — Processing steps (as described)?**
1. Take `userId` from token claim → `400` if missing.
2. Read request body.
3. Get `bnplTrx` from table **`BNPL_TRX`** by `requestBody.orderId` → failure → `500` (fail processing data).
4. List tenor data:
   - `userData` from table **`USER`** (user_management) by `userId`;
   - `creditUserData` from table **`CREDIT_USER_DATA`** (universal_data) by `userData.citizenId`;
   - call **core-credit-service List Tenor endpoint** with `{ customerType: creditUserData.customerType, price: bnplTrx.amount }`.
5. `insuranceData` from table **`INSURANCE_BNPL`** by `bnplTrx.bnplTrxId`.
6. `GenerateBnplBase64FileV2(ctx, bnplTrx.bnplTrxId, bnplTrx.paymentType (selected tenor), bnplTrx.amount, documentType="financing-term", orderId, listTenor, insuranceData, userId)` — renders HTML/PDF template → base64; failure → `500`.
7. `200 { HTML_Base64 }`.

**DB effect:** **read only** — `BNPL_TRX`, `USER`, `CREDIT_USER_DATA`, `INSURANCE_BNPL` + core-credit tenor calculation upstream. No writes.

## Submit Transaction

**Q1 — Signature?**
- `POST /v3/private/bnpl/submitTransaction`
- Request: **mostly matches the inquiry body**, plus two added fields:
  - `limitUsageAmount` (string, decimal value) — the BNPL limit amount used for this order;
  - `voucherAmount` (string) — subtotal of the items whose `id` is `"discount"`.
- Response: standard wrapper, `result = { Response3RdParty: { Status, Message, CreditOrderCode, OrderCode, ErrorMessage } }` (sales-portal response nested verbatim).

**Q2 — Auth / caller / role?**
- JWT issued by `user-service`; `userId` is taken from the token claim and **overwrites** `requestBody.userId` (server-side).
- Called **after the customer agreed to the financing term** in the mobile-app UI (story 04's T&C step) — this is the endpoint that submits the order.

**Q3 — Processing steps (as described)?**
1. Read request body.
2. Set `requestBody.userId` from the token claim.
3. `userData` (citizenId, username, mobilePhone) from `USER_ACCOUNT` (user_management DB).
4. Compare `requestBody.limitUsageAmount` with `limitRemainingAmount` → usage > remaining → **402 "limit exceeded"**.
5. Loop items → map to `OrderServiceSubmitTransactionItem` (**only the last item survives**).
6. Convert `paymentType` — strip `_months`, remaining numeric value → int.
7. List tenor data: `USER` (by userId) → `CREDIT_USER_DATA` (by `citizenId`) → core-credit List Tenor with `{ customerType, price: bnplTrx.amount }`.
9. Pick `installmentAmount`, `biayaAdmin`, `serviceFee`, `interestRate` for the matching tenor.
10. Per item, resolve brand code / order id (best-effort; errors logged).
11. Build `ItemsData[]` **excluding** `discount` and `shippingfee` items; capture the shipping fee price as `ShippingFee`.
12. Build `OrderServiceBillingAddress` + `OrderServiceShippingAddress`.
13. Resolve `referenceNo`: `GetProspectNoPrivyByPhoneNumber(phone)` → if empty `GetPrivyDataByNik(NIK).AppNo` → else `""`; `GetMerchantNameByMerchantOrderIdV2(MerchantOrderId)` → `btrTrx{BeatriceTrxID, MerchantName}` → **failure → 404**.
14. If `MerchantName` is `SalesAssociate`/`SalesMerchant` → `GetIdSeller(bnpkTrxId)` → sellerId; else `PartnerCode = "SBNPL"`.
15. Build the sales-portal request mapping (CitizenId, PartnerCode, OrderId, Id, Name, …, BillingAddress, ShippingAddress, ItemsData, AdminFee, ServiceFee, ShippingFee, LimitUsageAmount, InstallmentAmount, Tenor, InterestRate, TotalAmount, BnplAccountNumber, VoucherAmount, ChannelSales, PrimaryInsurance, AdditionalInsurance).
16. Call the **sales-portal Submit Transaction** endpoint — error → `404` (after `LogRequest`); success → update `BNPL_TRX` by `OrderId`, set `SalesOrderCode` / `CreditOrderCode`, set `LimitUsageAmount` from the response.
17. Fire-and-forget: WhatsApp notification.
18. Fire-and-forget: **auto-cancel on expiry** — poll `GetExpiredAndStatus(AppNo)` every 2 minutes; if `orderStat == "RESERVED_LIMIT"` after `expiredTime` → find `BNPL_TRX` by `CreditOrderCode` → call core-credit **Cancel Order** → call sales-portal **Update Order Status**.
19. Respond `200`.

**DB effect:** reads `USER_ACCOUNT`, `USER`, `CREDIT_USER_DATA`, `BNPL_TRX`; **writes** `BNPL_TRX` (order submitted, `SalesOrderCode`/`CreditOrderCode`, `LimitUsageAmount`) and creates the order in **sales-portal-service** (and, via sales-portal, in `core-credit-service`).

## PPOB Flow Decisions (checkout walkthrough)

**D1 — Entry flow order (inquiry first)?**
- **Inquiry happens before the payment screen and before tenor selection** — kept consistent with the current partner flow, even though a balance-check-only entry would be possible. Entry flow: **click buy on the product catalog screen → check balance → inquiry → navigate to payment screen → get BNPL transaction → list tenor**.
- Consequence: the inquiry body carries `paymentType` **before** the customer has picked a tenor — the selected tenor is applied later (at submit), and the financing document renders from the transaction's stored tenor.

**D2 — Inquiry response change?**
- The inquiry response is **extended with `orderId`** so the caller can address the created order in the following steps (get BNPL transaction, important information, submit). Change to an existing endpoint (additive).

**D3 — Where does the PIN happen?**
- **After `submitTransaction`**, on a **separate e-sign screen** — the PIN is no longer part of the submit request.

**D4 — T&C / financing-term acceptance?**
- **No acceptance record is stored in the database** — the mobile-app blocks screen navigation client-side. The server does not (and cannot) verify acceptance.

**D5 — core-credit List Tenor call pattern?**
- `bnpl-service`'s list tenor call follows the same pattern as submit: `USER` (by userId) → `CREDIT_USER_DATA` (by `citizenId`) → core-credit `POST /core-credit/calculateFinancingAndListTenor` with `{ customerType, price, branchCode }`, where `branchCode` is **hardcoded to `889`**. Same core-credit endpoint as the internal calls — only `branchCode` was omitted in the earlier explanation.

**D6 — Payment screen flow (multiple sequential calls)?**
- On screen load, called **sequentially**: **get BNPL transaction → list tenor → list insurance → calculate financing → get installment schedule**. A **calculate button** is present but **disabled on screen load**.
- On **tenor change**: **list insurance** runs again; the **calculate button is enabled**, the **checkout button disabled**.
- On **calculate button click**: **calculate financing → get installment schedule**.

**D7 — "Get BNPL transaction" is a new endpoint?**
- Yes — a new endpoint (to be documented), used by the payment screen to load the transaction.

**Expiry (settled):** draft expiry **1 day**; submitted expiry **15 minutes** — and the submitted clock starts at submit. Since both inquiry and submit carry `expirationDate`, the caller supplies: inquiry → **now + 1 day** (draft expiry), submit → **now + 15 minutes** (submitted expiry).

## Open / to confirm

- **List Tenor upstream call** — **resolved** (D5): one endpoint, `POST /core-credit/calculateFinancingAndListTenor`; `branchCode` hardcoded `889`.
- **Payment screen endpoints still to document** (D6): **get BNPL transaction** (new), **list insurance**, **calculate financing**, **get installment schedule** — signatures, auth, request/response, DB effects to be walked through like the four above.
- **Submitted-order expiry** — confirmed 15 minutes (story 04 updated from 5). The auto-cancel is implemented in `bnpl-service` (poll `GetExpiredAndStatus` every 2 min → core-credit Cancel Order → sales-portal Update Order Status).
- **Tenor write-back** — the selected tenor must reach the transaction before submit (the inquiry body already carries a `paymentType`); where it is written (a dedicated endpoint vs. the submit body) is still open.

## Open / to confirm

- ~~Submitted-order expiry: 5 vs 15 min~~ — **resolved: 15 minutes**, starting at submit. See "Expiry (settled)" above.
- Remaining endpoints to discuss: **Get Important Information**, **Submit Transaction**.

## Customer Identification History — Revision

**Constraint 1:** No eager recording. `customer-identifications` rows are created **only after a successful purchase transaction** (story 04 background chain), never on identify.

**Constraint 2:** Letslink meter identification is **not a separate endpoint** — it happens during the ppob inquiry (purchase) request to Letslink's inquiry endpoint. Invalid meter → error response at purchase time.

**Decisions:**
- **Meters:** no separate identification during browsing. The customer enters/selects a meter number (no validation, no wattage display). Validation + wattage resolution happen during the purchase inquiry (story 04). `identifyMeter` ppob endpoint **removed**.
- **Phones:** in-house prefix lookup stays during browsing (cheap, needed for product filtering). History recorded on success only.
- **BFF `/identify`:** only supports `mobile-*` (phone). `electricity-*` → `400` (identification not supported for this catalogue — meter identification happens during the purchase inquiry).
- **History recording on failed transactions:** never created (only on success).
- **`lastUsedDate`** = last successful transaction time. Selecting a previous identifier without transacting does not update it.
- **Story 02 (electricity):** no checkout gate from identification; meter number carried into checkout. Wattage shown post-purchase (token code, story 05).
- **Story 04 background chain:** re-identification = Letslink inquiry for electricity (validates meter + returns wattage) + in-house prefix lookup for data; on success, upsert `customer-identifications` row as a background side effect (fire-and-forget).

**Impact on the committed `customer-identifications` collection:** the collection, list endpoint, and upsert key are unchanged; only the *trigger* of the upsert moved (from identify to purchase success) and the `identifyMeter` custom method was removed.

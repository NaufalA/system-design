# API Design — bnpl-service

Existing BNPL order service: draft/submitted order lifecycle, PIN validation, limit reserve/deduct/refund, expiry timers + auto-cancel, tenor/financing calculation (proxying `core-credit-service`). This document covers the endpoints **interacted with within this project** — existing contracts documented verbatim as they behave today (project-convention deltas are noted inline, not normalized). Global conventions live in [`api/README.md`](../README.md).

## Base URL

- `<bnpl-base-url>` — existing production host. Integrated **directly by `mobile-app`** (the current implementation predates the BFF layer); not routed through `bff-mobile`.

## Auth

Two patterns coexist in this service:

**Customer endpoints (JWT)** — List Tenor, Get Important Information, Submit Transaction:

- Issued by: `user-service` — the existing customer session JWT (same token the app uses for `bff-mobile`).
- Credential: JWT.
- Transport: `Authorization: Bearer <JWT>` header, presented directly by `mobile-app`.
- Validation: at `bnpl-service` itself — signature/expiry checked, and the **`userIdentity` claim is read** to resolve the customer's `bnpl_account` and to set `userId` on the request. Invalid token → rejected without upstream calls.
- Downstream: the JWT is **not** forwarded to `core-credit-service` or `sales-portal-service`; account-derived fields (`customerType`) are passed instead.

**Partner endpoint (public key)** — Inquiry Transaction:

- Issued by: the partner key configured in the `bnpl-service` database.
- Credential: Public-Key header value.
- Transport: Public-Key header on the request.
- Validation: at `bnpl-service` — the key must match the configured partner key.
- Downstream: none — the request body is forwarded to `sales-portal-service` as-is.

> **Documented deviation from [`api/README.md`](../README.md#auth):** the customer JWT normally stops at the BFF ("no customer JWT reaches a microservice"). These are existing endpoints the app already calls directly; per project decision, existing endpoints that already serve the requirement are reused as-is rather than re-wrapped behind a BFF endpoint.

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |
| BNPL transactions | Existing order lifecycle (draft → submitted → completed/cancelled), PIN validation, limit operations, expiry timers | `POST /v2/private/bnpl/calculate/financing/listtenor`, `POST /v2/private/bnpl/important-information`, `POST /v3/private/bnpl/submitTransaction` _(this doc)_; Inquiry Transaction _(to be documented)_ |
| Financing calculation (proxy) | Wraps the `core-credit-service` tenor calculation for the checkout screen | List Tenor, Get Important Information, Submit Transaction (below) |
| Financing term document | Renders the financing term document draft (HTML → base64) the customer must accept before checkout | Get Important Information (below) |
| Order submission | Submits the order (limit check → sales-portal submit → core-credit order) | Submit Transaction (below) |
| Order creation (draft) | Creates the draft order — forwards to sales-portal, then saves locally in `bnpl_order` | Inquiry Transaction (below) |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |
| Financing/tenor calculation | core-credit-service | Sync REST `POST /core-credit/calculateFinancingAndListTenor` — tenor options for a price (customerType derived from `USER` → `CREDIT_USER_DATA`, branchCode hardcoded `889`) | 04 |
| Customer session | user-service | JWT validation on inbound requests (existing mechanism) | — |
| User / credit profile | `USER` (user_management DB), `CREDIT_USER_DATA` (universal_data DB) | Read for `customerType` before calling core-credit's List Tenor | 04 |

## Endpoints

### Resource: BNPL transaction calculation

Existing endpoint used in the current transaction flow; for the PPOB pilot it feeds tenor selection on the checkout screen.

#### Calculate financing & list tenor

`POST /v2/private/bnpl/calculate/financing/listtenor`

Computes the financing/tenor options for a price and returns them for tenor selection — wraps `core-credit-service`'s `calculateFinancingAndListTenor`, deriving the account-bound request fields from the caller's JWT.

| | |
| --- | --- |
| Derived from story | 04-buy-with-bnpl |
| Auth | Bearer JWT (customer) — validated at this service |

**Flow**

1. Validate the JWT; read the `userIdentity` claim → missing/invalid → rejected (`401`).
2. Reject with `400` if `price` is missing/invalid.
3. Gather the customer context — `USER` (user_management DB) by `userId` → `CREDIT_USER_DATA` (universal_data DB) by `userData.citizenId` → `customerType`.
4. Call core-credit's `POST /core-credit/calculateFinancingAndListTenor` with `{ customerType, price, branchCode }` — `branchCode` is **hardcoded to `889`** server-side, never client-supplied.
5. Place the core-credit response **untransformed** into `result.Result` (verbatim upstream field names — documented case under Field Naming).
6. core-credit erroring/unreachable → error wrapper (status per upstream failure).

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| price | number | yes | Transaction price (for PPOB: product price, ≥ IDR 150k) |

_No path params. No query params — `customerType` and `branchCode` are derived/hardcoded server-side, not accepted from the client._

**Response**

`result` = `{ Result: { Status, Message, ErrorMessage, ListTenor[] } }` — the upstream payload nested as-is (no field remapping):

| Field | Type | Notes |
| --- | --- | --- |
| Result.Status | int/string | core-credit internal status code |
| Result.Message | string | Success message; empty on error |
| Result.ErrorMessage | string/null | `null` on success; error description otherwise |
| Result.ListTenor[] | array | Tenor options for selection |
| Result.ListTenor[].tenor | int | Tenor length (months) |
| Result.ListTenor[].installmentAmount | number | Per-installment amount |
| Result.ListTenor[].adminFee | number | Admin fee |
| Result.ListTenor[].serviceFee | number | Service fee |
| Result.ListTenor[].interestRate | number | Interest rate for the tenor |
| Result.ListTenor[].outstandingAmount | number | Total outstanding across the tenor |
| Result.ListTenor[].withInsurance | string | `"0"` / `"1"` — legacy insurance option (previous business could add insurance; off for PPOB) |

**Example**

```json
{ "price": 150000 }
```

```json
{
  "response": 200,
  "message": "Financing calculated successfully",
  "result": {
    "Result": {
      "Status": 0,
      "Message": "Success",
      "ErrorMessage": null,
      "ListTenor": [
        {
          "tenor": 3,
          "installmentAmount": 52000,
          "adminFee": 5000,
          "serviceFee": 0,
          "interestRate": 1.5,
          "outstandingAmount": 156000,
          "withInsurance": "0"
        },
        {
          "tenor": 6,
          "installmentAmount": 27000,
          "adminFee": 5000,
          "serviceFee": 0,
          "interestRate": 1.75,
          "outstandingAmount": 162000,
          "withInsurance": "0"
        }
      ]
    }
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 400 | Missing/invalid `price` | `BAD_REQUEST: price is required` |
| 401 | Invalid/expired JWT | `UNAUTHORIZED: token invalid or expired` |
| 500 | `bnpl_account` lookup failure / internal error | `INTERNAL: ...` |
| 503 | `core-credit-service` unavailable | `UPSTREAM_UNAVAILABLE: ...` |

#### Get important information

`POST /v2/private/bnpl/important-information`

Renders the financing term document draft for a created order as base64 HTML — the document the customer must view and accept before proceeding with checkout. Requires an existing order (`orderId` from the inquiry step).

| | |
| --- | --- |
| Derived from story | 04-buy-with-bnpl |
| Auth | Bearer JWT (customer) — validated at this service |

**Flow**

1. Take `userId` from the JWT claim → missing → `400`.
2. Read `orderId` from the body → look up `bnplTrx` in `BNPL_TRX` → not found/lookup failure → `500` (fail processing data).
3. Gather tenor data for the document:
   - `userData` from `USER` (user_management DB) by `userId`;
   - `creditUserData` from `CREDIT_USER_DATA` (universal_data DB) by `userData.citizenId`;
   - call core-credit's List Tenor endpoint with `{ customerType: creditUserData.customerType, price: bnplTrx.amount }`.
4. Read `insuranceData` from `INSURANCE_BNPL` by `bnplTrx.bnplTrxId`.
5. `GenerateBnplBase64FileV2(bnplTrx.bnplTrxId, bnplTrx.paymentType /* selected tenor */, bnplTrx.amount, documentType = "financing-term", orderId, listTenor, insuranceData, userId)` — renders the HTML/PDF template → base64; failure → `500`.
6. Return `200` with the base64 document.

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| orderId | string | yes | Order id of the created draft (from inquiry) — resolved against `BNPL_TRX` |

_No path params. No query params._

**Response**

| Field | Type | Notes |
| --- | --- | --- |
| HTML_Base64 | string | Base64-encoded financing term document (HTML/PDF render) — decoded and displayed by the app for customer acceptance |

**Example**

```json
{ "orderId": "MRC-1760500000" }
```

```json
{
  "response": 200,
  "message": "Important information retrieved successfully",
  "result": {
    "HTML_Base64": "PGh0bWw+Li4uPC9odG1sPg=="
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 400 | `userId` missing from token claim | `BAD_REQUEST: userId is required` |
| 500 | `BNPL_TRX` lookup failure / template render failure | `INTERNAL: fail processing data` |
| 503 | core-credit List Tenor unavailable | `UPSTREAM_UNAVAILABLE: ...` |

#### Submit transaction

`POST /v3/private/bnpl/submitTransaction`

Submits the order after the customer has agreed to the financing term: checks the BNPL limit, maps the request into a sales-portal submission, and creates the order (sales-portal → core-credit). Request body mirrors the inquiry body, plus `limitUsageAmount` and `voucherAmount`.

| | |
| --- | --- |
| Derived from story | 04-buy-with-bnpl |
| Auth | Bearer JWT (customer) — validated at this service |

**Flow**

1. Read the request body; set `userId` from the JWT claim (overrides any client-supplied value).
2. Read `userData` (citizenId, username, mobilePhone) from `USER_ACCOUNT` (user_management DB).
3. Compare `limitUsageAmount` with the customer's `limitRemainingAmount` → usage > remaining → `402` (limit exceeded).
4. Map `items[]` to `OrderServiceSubmitTransactionItem` (only the last item survives the loop).
5. Convert `paymentType` — strip `_months`, remaining numeric value → int (tenor in months).
6. Gather tenor data: `USER` (by userId) → `CREDIT_USER_DATA` (by `citizenId`) → core-credit List Tenor with `{ customerType, price: bnplTrx.amount }`; pick `installmentAmount`, `biayaAdmin`, `serviceFee`, `interestRate` for the matching tenor.
7. Per item, resolve brand code / order id (best-effort; errors logged).
8. Build `ItemsData[]` excluding the `discount` and `shippingfee` items; capture the shipping fee price as `ShippingFee`.
9. Build `OrderServiceBillingAddress` + `OrderServiceShippingAddress`.
10. Resolve `referenceNo`: `GetProspectNoPrivyByPhoneNumber(phone)` → if empty `GetPrivyDataByNik(NIK).AppNo` → else `""`. Resolve `btrTrx{BeatriceTrxID, MerchantName}` via `GetMerchantNameByMerchantOrderIdV2(MerchantOrderId)` → failure → `404`.
11. If `MerchantName` is `SalesAssociate`/`SalesMerchant` → `GetIdSeller(bnpkTrxId)` → sellerId; else `PartnerCode = "SBNPL"`.
12. Build the sales-portal request mapping (CitizenId, PartnerCode, OrderId, Id, Name, …, Billing/ShippingAddress, ItemsData, AdminFee, ServiceFee, ShippingFee, LimitUsageAmount, InstallmentAmount, Tenor, InterestRate, TotalAmount, BnplAccountNumber, VoucherAmount, ChannelSales, PrimaryInsurance, AdditionalInsurance) and call the sales-portal **Submit Transaction** endpoint → error → `404` (after `LogRequest`).
13. On success: update `BNPL_TRX` by `OrderId` — set `SalesOrderCode` / `CreditOrderCode`, and `LimitUsageAmount` from the response.
14. Fire-and-forget: WhatsApp notification.
15. Fire-and-forget: auto-cancel on expiry — poll `GetExpiredAndStatus(AppNo)` every 2 minutes; when `orderStat == "RESERVED_LIMIT"` past `expiredTime` → find `BNPL_TRX` by `CreditOrderCode` → core-credit **Cancel Order** → sales-portal **Update Order Status**.
16. Return `200`.

**Request**

_Body mirrors the inquiry body_ — `transactionDetails` (`orderId`, `amount`, `items[]`), `customerDetails`, `sellers[]`, `billingAddress`, `shippingAddress`, `primaryInsurance[]`, `additionalInsurance[]`, callback URLs (`approvedNotificationUrl`, `cancellationRedirectUrl`, `backToStoreUrl`, `invoiceUrl`), `expirationDate`, `paymentType` — plus:

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| limitUsageAmount | string | yes | Decimal string — BNPL limit amount used for this order; compared against the customer's `limitRemainingAmount` (`402` if exceeded) |
| voucherAmount | string | yes | Decimal string — subtotal of the items whose `id` is `"discount"` |

`userId` is taken from the JWT claim server-side, not from the client.

**Response**

`result` = `{ Response3RdParty: { Status, Message, CreditOrderCode, OrderCode, ErrorMessage } }` — the sales-portal response nested verbatim:

| Field | Type | Notes |
| --- | --- | --- |
| Response3RdParty.Status | string | sales-portal status code |
| Response3RdParty.Message | string | Status message |
| Response3RdParty.CreditOrderCode | string | Credit order code assigned by sales-portal/core-credit |
| Response3RdParty.OrderCode | string | Sales order code |
| Response3RdParty.ErrorMessage | string | Empty on success |

**Example**

```json
{
  "transactionDetails": {
    "orderId": "SBNPL-1760500000",
    "amount": "959000.00",
    "items": [
      { "id": "PD2033203", "name": "PLN Token 200.000", "price": 1029000, "quantity": 1, "sellerName": "SELLER", "sellerId": "0220" },
      { "id": "discount", "name": "Voucher Product", "price": 100000, "quantity": 1, "sellerName": "SELLER", "sellerId": "VOUCHER" }
    ]
  },
  "customerDetails": { "firstName": "Customer", "lastName": "Name", "phone": "08xxxx" },
  "paymentType": "12_months",
  "limitUsageAmount": "150000.00",
  "voucherAmount": "100000.00"
}
```

```json
{
  "response": 200,
  "message": "Success Hit 3rd Party",
  "result": {
    "Response3RdParty": {
      "Status": "0",
      "Message": "Success",
      "CreditOrderCode": "CR-20261016-0001",
      "OrderCode": "SO-20261016-0001",
      "ErrorMessage": ""
    }
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 402 | `limitUsageAmount` exceeds the customer's `limitRemainingAmount` | `PAYMENT_REQUIRED: limit exceeded` |
| 404 | Merchant lookup failure (`GetMerchantNameByMerchantOrderIdV2`) or sales-portal submit returned an error | `NOT_FOUND: ...` |
| 500 | Internal processing failure | `INTERNAL: ...` |

#### Inquiry transaction

`POST /bnpl/v1/public/user/payment/inquiry`

Creates the **draft order**: forwards the transaction data to `sales-portal-service`'s create-order endpoint and, on success, saves the order into `bnpl-service`'s own `bnpl_order` table. Partner-facing endpoint (public-key auth), reached through `bff-mobile` for the PPOB flow.

| | |
| --- | --- |
| Derived from story | 04-buy-with-bnpl |
| Auth | Public-Key header (partner key configured in the database) |

**Flow**

1. Validate the Public-Key header → invalid → rejected.
2. Read the request body (`transactionDetails`, `customerDetails`, `sellers[]`, addresses, callback URLs, `expirationDate`, `paymentType`).
3. Forward to `sales-portal-service`'s **create order** endpoint.
4. sales-portal error → propagate the failure (no local order saved).
5. On success → save the order into `bnpl-service`'s `bnpl_order` table.
6. Return `200` with `result.RedirectUrl` and `result.orderId`.

**Request**

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |
| transactionDetails.orderId | string | yes | `{MerchantPrefix}-{uniqueId}` — echoed back in the response (`result.orderId`) so the caller can address the created order |
| transactionDetails.amount | string | yes | Decimal string, e.g. `"959000.00"` |
| transactionDetails.items[] | array | yes | Product lines — `id`, `name`, `price`, `quantity`, `sellerName`, `sellerId`, `url`, `imageUrl`, `brand_code`, `type`. The **discount voucher is sent as one of the items** (`id: "discount"`); arrays may be left empty where not applicable |
| customerDetails | object | yes | `firstName`, `lastName`, `email`, `phone`, `address`, `city`, `province`, `postalCode`, `countryCode` |
| sellers[] | array | no | Seller records (partner-commerce shape) |
| billingAddress | object | yes | Same shape as `customerDetails` |
| shippingAddress | object | yes | Same shape as `customerDetails` |
| primaryInsurance[] / additionalInsurance[] | array | no | Legacy insurance options (off for PPOB) |
| approvedNotificationUrl | string | no | Partner callback for payment notification |
| cancellationRedirectUrl / backToStoreUrl / invoiceUrl | string | no | Partner callback / redirect URLs |
| expirationDate | string | no | ISO 8601 with offset (e.g. `2026-10-15T09:40:22+07:00`) — draft expiry as supplied by the caller |
| paymentType | string | yes | Selected tenor, e.g. `"12_months"` |

**Response**

| Field | Type | Notes |
| --- | --- | --- |
| RedirectUrl | string | Checkout redirect link with token — **ignored by the mobile flow** |
| orderId | string | The created order's id — **added for the PPOB flow** so the caller can address the order in the next steps (get BNPL transaction, important information, submit) |

**Example**

```json
{
  "transactionDetails": {
    "orderId": "SBNPL-1760500000",
    "amount": "150000.00",
    "items": [
      { "id": "PD2033203", "name": "PLN Token 200.000", "price": 150000, "quantity": 1, "sellerName": "SELLER", "sellerId": "0220" },
      { "id": "discount", "name": "Voucher Product", "price": 100000, "quantity": 1, "sellerName": "SELLER", "sellerId": "VOUCHER" }
    ]
  },
  "customerDetails": { "firstName": "Customer", "lastName": "Name", "phone": "08xxxx", "countryCode": "ID" },
  "billingAddress": { "firstName": "Customer", "lastName": "Name", "countryCode": "ID" },
  "shippingAddress": { "firstName": "Customer", "lastName": "Name", "countryCode": "ID" },
  "paymentType": "12_months",
  "expirationDate": "2026-10-17T09:40:22+07:00"
}
```

```json
{
  "response": 200,
  "message": "Success Payment Inquiry",
  "result": {
    "RedirectUrl": "/link/to/checkout/page?token=...",
    "orderId": "SBNPL-1760500000"
  }
}
```

**Errors**

| Status | Case | message |
| --- | --- | --- |
| 401 | Missing/invalid Public-Key header | `UNAUTHORIZED: invalid public key` |
| 400 | Invalid request body | `BAD_REQUEST: ...` |
| 500 | sales-portal create-order failed / local save failed | `INTERNAL: ...` |

# API Design — <Application Name>

<One or two sentences: what this application owns/exposes.>

## Base URL

- <base URL — plus how frontends integrate with it: direct or through a gateway>

## Auth

- Issued by: <who issues the credential — user service / admin SSO / company service identity>
- Credential: <JWT / API key / session token>
- Transport: <how it's presented — `Authorization: Bearer ...` header / API-key header / cookie>
- Validation: <where it's validated, what's checked, failure behaviour>
- Downstream: <how identity is propagated to downstream calls, if at all>

Global conventions (content type, wrapper, pagination, soft delete, trust rule) live in the project's `api/README.md` — don't restate them here.

## Resources

### Resources handled (owned/exposed)

| Resource | Description | Endpoints |
| --- | --- | --- |

### Resources used (consumed from other applications)

| Resource | Owner application | How it's used | Derived from story |
| --- | --- | --- | --- |

## Endpoints

Each endpoint gets a descriptive-name heading (`#### <name>`) with the `METHOD path` on the line below it. Blocks appear only where they apply — omit input modes an endpoint doesn't have (use `_No request body._` when that reads better than silence). **Flow** describes the endpoint's own processing (validation, upstream calls, mapping, error exits); who calls it, when, and why lives in `api/stories/*` — not here.

### Resource: <name>

<Optional resource-level context (naming rules, shared semantics). No caller behaviour.>

#### <descriptive endpoint name>

`<METHOD> /path`

<One or two sentences: what the endpoint does. No caller/story narrative.>

| | |
| --- | --- |
| Derived from story | NN-<slug> (add more with `; `) |
| Auth | <Bearer JWT (customer) / service-to-service> |

**Flow**

1. <numbered steps: validation → upstream/lookup → mapping → error exits>

**Request**

| Path params | Type | Notes |
| --- | --- | --- |

| Query params | Type | Default | Notes |
| --- | --- | --- | --- |

| Body fields | Type | Required | Notes |
| --- | --- | --- | --- |

**Response**

<`result` shape; field table: Field | Type | Notes — semantics per field (gates, filters, trust notes)>

**Example**

<request line (GET) or request body (POST) + response JSON, wrapper per `api/README.md`>

**Errors**

| Status | Case | message |
| --- | --- | --- |
| <status> | <case> | <`CODE: description` style; gate pattern: `200 + valid: false`> |

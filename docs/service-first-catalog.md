# Service-first Demo catalog

The procurement form searches for services; it does not require an enterprise
target. Each request names one service category. A stock symbol, market or crypto
asset can be included in the query but is optional. Invoice and certification
requirements are independent, and enterprise payment policy still applies.

| Service ID | Service | Supplier display name | Test USDC | Demo invoice |
| --- | --- | --- | --- | --- |
| stock-analysis | 個股分析 | 會飛分析師 | 0.04 | No |
| macro-analysis | 總經分析 | mello資本 | 0.05 | Yes |
| crypto-market | 加密市場資訊 | mello資本 | 0.05 | Yes |
| futures-analysis | 期貨分析 | 會飛分析師 | 0.04 | No |

The API catalog in `apps/api/src/shared/service-catalog.ts` is the product source
of truth. These are display brands, not new legal-identity or KYB assertions.
Existing legal seller names, business IDs, wallets, prices and invoice capability
are not overwritten. The frontend always distinguishes service and supplier.

## Contract and evidence

New intents use `serviceCategory` and `serviceQuery`, not `targetCompanyName`.
Unknown or ambiguous categories fail with an actionable error; an unrelated cheap
service is never substituted. The current form has one required multiline
`需求說明` (1–1000 characters), with optional files in the same area. Its full
description determines one category. A strict final budget/settings suffix is
parsed separately: settings-looking text inside the description cannot override
form controls. The former `搜尋服務` format remains readable for existing tasks.
Only fixed category terms go to public Bazaar discovery; new multiline requests
also send only the canonical service label to Sellers, not the private description.

## Automatic discovery and attachments

The visible flow is **提交需求 → 選擇服務 → 付款與憑證**. Creating a request with
`requirements` atomically stores Task, TaskControl, attachment references and one
durable `DISCOVER_TASK`. There is no second discovery click. The create response
reports actual `status: CREATED` and `discoveryQueued: true`, not a fictional
running state. Replaying the same request key recovers the original task and never
requeues discovery or authorizes payment. Legacy CREATED drafts with no queued
discovery retain an explicit resume action; GET/recovery does not mutate them.

Discovery always stops at service selection and never pays. Selection queues a
separate `RUN_TASK`. Task-level locking, a cross-kind active-job unique index and
a discovery generation ID protect concurrent requests and late worker errors.
Normal demo invoices use `MOCK_INVOICE_FAIL_ONCE=false`: one attempt, one issued
event, no deliberate retry. Genuine failures retain dedicated recovery paths.
Historical invoices/events are not rewritten. The normal UI omits raw invoice
provider mode names; test invoice and truthful payment-environment labels remain.

| Endpoint | Purpose |
| --- | --- |
| `POST /api/v1/attachments` | Save one file before creating a task |
| `POST /api/v1/tasks` | Link `attachmentIds` with matching `requestKey`, create and queue atomically |
| `GET /api/v1/tasks/:taskId/attachments` | Saved metadata only |
| `GET /api/v1/tasks/:taskId/attachments/:id` | Authenticated JSON/base64 download |

Uploads use `{ requestKey, clientFileId, fileName, mediaType, sizeBytes,
contentBase64 }`; UUID draft/file IDs make retries idempotent. Metadata is
`{ id, fileName, mediaType, sizeBytes, sha256, createdAt }`. Files are PostgreSQL
BYTEA, not ephemeral deployment files. Allowed extensions are PDF/DOCX/TXT/MD,
maximum 3 files per draft, 2 MiB each. The authenticated upload alone accepts
3 MiB JSON; other API/BFF writes remain 64 KiB. Lists/events never include bytes,
downloads validate stored size/hash and are saved as attachments rather than
rendered inline. The BFF checks session/origin before reading a bounded stream.

This version **stores files only**: no extraction, antivirus scan, embedding,
document analysis or Agent reading is implemented. The search uses the typed
description, not attachment names/content. The browser stores only pending task
references, not document bytes. Unsubmitted uploads expire for linking after
24 hours; attached records remain downloadable. Confirmed `ATTACHMENT_EXPIRED`
allows an explicit new draft/re-upload, but timeouts never change the request key.
Abandoned drafts are not automatically deleted: demo quotas are 100 unclaimed
files, 1000 total files and 100 MiB total bytes. At capacity an administrator must
review retention before removing any data. This is one authenticated workspace,
not per-user/tenant isolation or production document management.

Both existing `/v1/credit-report` Seller endpoints accept a backward-compatible
modern request: `serviceId`, `serviceCategory`, `serviceQuery`, and an optional
public/required internal `purchaseContextToken`. A `market-v1` report has distinct
Demo research content per category. Buyer validation binds provider, service ID,
category and query. No live market data or investment advice is claimed. Old
credit-report requests, cached reports, settlement evidence and invoice history
remain readable without rewriting them.

## Controlled rollout

1. Deploy the updated Sellers first. Their public 402 metadata advertises exact
   service ID/category pairs as well as the legacy request shape.
2. API `db:prepare` adds nullable `Seller.displayName`, then runs the guarded
   `db:market-service-catalog` transition after the existing initialization steps.
   It creates the four new IDs and archives legacy A–D, retaining historical
   metadata, legal identities, payments, invoices and verification records.
3. Deploy Web only after API preparation succeeds. The current catalog excludes
   archived services; historical purchases retain their old names.
4. Review new service scopes explicitly and refresh their Bazaar metadata/index.
   **New services start UNREVIEWED.** Old certification is not copied. Stale
   credit-only Bazaar metadata does not qualify as a market service. Any indexing
   payment requires separate target/amount confirmation; deployment does not pay.

The next rollout must also apply attachment/generation and workflow CHECK/index
migrations, and explicitly set any existing `MOCK_INVOICE_FAIL_ONCE=true` runtime
variable to false. Code defaults do not override a deployed explicit value.
The cross-kind index intentionally refuses pre-existing overlapping active jobs;
investigate instead of deleting work. Do not run old workers alongside new
`DISCOVER_TASK` jobs. Merge/deployment remains paused while this change is reviewed.

The catalog transition refuses in-flight work, uncertain payments, custom legacy
identities/prices, or collisions with pre-existing new IDs. Its audit marker makes
subsequent startup a no-op, preserving later administrative edits. Investigate a
guard failure; do not delete jobs or reset seed data to force deployment.

The existing destructive administrator `resetDemo` remains a legacy fixture reset;
it is not a catalog migration or an appropriate way to rename services. This
change does not invoke it. A deliberately reset isolated stack must run
`db:prepare` before service-first UI testing.

## Verification

- Web: `npm test --workspace @mello/web`, lint, typecheck and production build.
- Browser: install Python Playwright/Chromium, start local Web on
  `127.0.0.1:3046`, then `npm run qa:service-first --workspace @mello/web`.
  All API responses, uploads, discovery and selected purchases are intercepted
  fixtures. External requests are blocked; no wallet or actual payment is used.
  Covers unified descriptions, attachment validation/download, response recovery,
  automatic discovery, four services, first-attempt invoices and 375/768/1280 widths.
  Evidence is written to a fresh temporary directory.
  The older `qa:visual` runner targets the legacy credit-report flow; use this
  dedicated runner for the service-first UI.
- API unit tests cover schemas, parsing, seller ownership, report binding, legacy
  cache replay, and stale Bazaar metadata.
- Dedicated loopback PostgreSQL tests cover catalog guards/history/idempotence
  and all four market-service workflows, including invoice item names and
  duplicate-payment prevention, durable discovery and actual attachment storage.
  All transports and settlement are fixtures.
- The separate `local-stack.integration.test.ts` needs its own local Anvil and
  HTTP-stack setup. Do not substitute public Base RPC or real wallet credentials.

These timings/results are local fixture verification, not a funded testnet run.

2026-09-06 verification: API 550 unit tests, PostgreSQL 123 integration tests,
Web 27 unit tests; Web/Docs typecheck, lint and production builds pass (Docs retains
its pre-existing image lint warning). Browser QA covers 13 completed fixture
purchases, 41 intercepted writes including lost/expired responses, 3 viewports,
keyboard file selection, old/new queued drafts and byte-identical downloads.
No public Seller, wallet, indexing payment or deployed database was used.

The separate `apps/web/scripts/attachment-proxy-qa.py` checks the real Next BFF
against its own loopback fixture on port 3047 (no browser route interception).
Start local Web on 3046 with `WEB_PUBLIC_URL=http://127.0.0.1:3046`,
`CORE_API_URL=http://127.0.0.1:3047`,
`MELLO_ACCESS_CODE=local-attachment-access-fixture-only`,
`MELLO_SESSION_SECRET=local-attachment-proxy-session-fixture-only`,
`API_ACCESS_TOKEN=local-attachment-proxy-api-fixture-only`, and
`DEMO_ADMIN_TOKEN=local-attachment-proxy-admin-fixture-only`. These are deliberately
public local-test values, never deployment credentials. It checks 401/403/404,
the two body limits, protected metadata and a byte-identical 168 KB download.

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
service is never substituted. The `搜尋服務` line determines the category; notes
cannot switch it. Only fixed category terms go to public Bazaar discovery.

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
  All API responses and create/discover calls are intercepted fixtures. External
  requests and any payment action are blocked. Covers four queries without an
  enterprise target, supplier/service columns, category filtering and
  375/768/1280 widths. Evidence is written to a fresh temporary directory.
  The older `qa:visual` runner targets the legacy credit-report flow; use this
  dedicated runner for the service-first UI.
- API unit tests cover schemas, parsing, seller ownership, report binding, legacy
  cache replay, and stale Bazaar metadata.
- Dedicated loopback PostgreSQL tests cover catalog guards/history/idempotence
  and all four market-service workflows, including invoice item names and
  duplicate-payment prevention. All transports and settlement are fixtures.
- The separate `local-stack.integration.test.ts` needs its own local Anvil and
  HTTP-stack setup. Do not substitute public Base RPC or real wallet credentials.

These timings/results are local fixture verification, not a funded testnet run.

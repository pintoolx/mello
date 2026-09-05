# Mello API

採購 workflow、x402 buyer、Prisma/PostgreSQL、發票重試、對帳與稽核 API。這個 npm workspace 的名稱是 `@mello/api`，預設使用 demo parser、mock payment、mock invoice 與 mock anchors。

本次整合保留既有 `apps/web` Next.js 視覺 Demo。它目前尚未呼叫本 API；前端欄位、狀態與 endpoint 的對照見 [前端串接交接](docs/FRONTEND_INTEGRATION.md)。

## 目錄

```text
apps/api/
├── src/
│   ├── server.ts / app.ts / bootstrap.ts
│   ├── routes/ / http/ / security/
│   ├── modules/              # procurement、policy、payment、invoice、audit、worker
│   ├── db/                   # Prisma client、seed；generated 不提交
│   ├── shared/               # 內部 schema、狀態、金額工具
│   ├── seller-kit/            # x402 server 與持久化 idempotency
│   ├── tw-einvoice-extension/
│   └── contracts-client/     # 鏈上／mock anchor adapter
├── prisma/                   # schema 與全部 12 份既有 migration
├── sellers/seller-a/          # 0.04 USDC，無台灣發票能力
├── sellers/seller-b/          # 0.05 USDC，demo 發票能力
├── scripts/                  # health、smoke、部署與測試工具
├── docs/FRONTEND_INTEGRATION.md
└── .env.example
contracts/                    # 實際位於 repo 根目錄，見 ../../contracts
```

原本的五個 `@mello/*` 共用套件現在是 API 內部模組，透過本 workspace 的 TypeScript paths、tsx 與 Vitest aliases 解析；不再需要 pnpm 的 `workspace:*` dependency，也不把資料庫／簽章程式輸出給瀏覽器。

## 啟動

需要 Node.js 22.9+、npm 11.19.1+，以及 PostgreSQL。以下命令都在 repo 根目錄執行；`npx` 的寫法可在不升級全域 npm 的情況下使用固定版本：

```bash
npx --yes npm@11.19.1 ci
cp apps/api/.env.example apps/api/.env
# 編輯 apps/api/.env，設定 DATABASE_URL 與 DIRECT_DATABASE_URL。
# 設定自己的 DEMO_ADMIN_TOKEN；API 與 Sellers 共用同一份環境檔。
npm run db:migrate
npm run seed
npm run dev:backend
```

`npm ci` 會自動產生 Prisma client。`npm run dev:backend` 同時啟動 API（4000）、Seller A（4011）、Seller B（4012）；只需要 API 時使用 `npm run dev:api`。外部環境變數優先於 `apps/api/.env`。原本的 `npm run dev` 仍只啟動 Next.js 前端。

- API base：`http://localhost:4000/api/v1`
- Backend health：`npm run demo:health`
- 完整 mock smoke：`npm run demo:smoke`

Mock smoke 要求 `MOCK_INVOICE_FAIL_ONCE=true`，會跑三筆採購、逐筆重試發票、檢查不重複扣款，再驗證低預算拒絕。它只接受 payment 和 anchor 都是 mock 的 stack。

公司 profile、policy、Seller/Service registry 由 seed 建立。若改了 `SELLER_*_URL` 或 `SELLER_*_PAY_TO`，需重新 seed，才能讓資料庫 registry 與 seller response 一致。seed 也會重設 demo 公司與 policy；保留自訂設定時請使用專用 demo database。

## 執行與部署

```bash
npm run build --workspace @mello/api
npm run start --workspace @mello/api
```

API 以 tsx 執行 TypeScript；build 產生 Prisma client 並檢查型別，不輸出獨立的 JavaScript bundle。部署時保留 `apps/api`、root npm lockfile 及 `contracts/abi/MelloAuditRegistry.json`，並在建置階段安裝／產生依賴。API 有長期執行的 background workflow worker，應部署為持續運行的 Node.js service，與 Next.js service 分開。

API 預設綁定 loopback；容器部署需設定 `CORE_API_HOST=0.0.0.0`，seller 亦可設定 `SELLER_BIND_HOST`。瀏覽器直連 API 時，`WEB_ORIGIN` 必須符合實際前端 origin。

## 模式與憑證

| 功能 | 預設 | 可選模式 |
| --- | --- | --- |
| 意圖解析 | `AGENT_MODE=demo` | `openai`，需要 API key 與明確 model |
| 付款 | `PAYMENT_MODE=mock` | `x402`，Base Sepolia Test USDC 與 test-only EOA |
| 發票 | `INVOICE_PROVIDER=mock` | ECPay Stage adapter 尚未實作 |
| 稽核錨定 | `CONTRACT_ANCHOR_MODE=mock` | `onchain`，需要已部署合約與 operator |
| Facilitator | 公開 x402.org | CDP URL 加 API key ID／secret |

使用 CDP 時設定：

```dotenv
X402_FACILITATOR_URL=https://api.cdp.coinbase.com/platform/v2/x402
CDP_API_KEY_ID=
CDP_API_KEY_SECRET=
```

Buyer 使用 `EVM_PRIVATE_KEY`，operator 使用 `CONTRACT_OPERATOR_PRIVATE_KEY`；目前不使用 CDP managed wallets，因此不需要 `CDP_WALLET_SECRET`。JWT 只會附加到 CDP 的指定 HTTPS facilitator。以上秘密只放後端環境，不使用 `NEXT_PUBLIC_*`，也不複製到 frontend。

`ISSUED_DEMO` 不是正式台灣統一發票；mock 付款紀錄也不是鏈上資金移轉。以 health 的當前 modes、purchase 的歷史 modes 分別呈現。

## 合約與 Base Sepolia

建議保留根目錄 [contracts](../../contracts/README.md)，因 Solidity 編譯、測試和部署生命週期與 API 不同。API 只使用 checked-in ABI 與設定的 registry address；API 啟動不會自動部署。搬 repo 不會改變既有合約地址，也不要求重新部署。

```bash
npm run contract:test
npm run contract:compile --workspace @mello/api
npm run contract:deploy:base-sepolia --workspace @mello/api
```

部署需要 Foundry 在 PATH。部署後在 `apps/api/.env` 設定 `AUDIT_REGISTRY_ADDRESS`、`CONTRACT_ANCHOR_MODE=onchain`。Buyer 至少準備 0.15 Test USDC，operator 準備 Base Sepolia ETH；recipient 必須替換 placeholder 且不能是 registry。完成設定與重新 seed、重啟後：

```bash
npm run fund:check --workspace @mello/api
npm run demo:health
MELLO_TESTNET_PAYMENT_APPROVED=true npm run demo:smoke:testnet --workspace @mello/api
```

遠端 smoke 最多三筆 0.05 Test USDC，另有六筆 operator-paid anchors。不要把批准旗標持久化設為 true。本次 repo 整合驗證使用 mock settlement／本地 Anvil；先前 Base Sepolia 驗收不代表在新 checkout 又送出了付款。

## 驗證

```bash
npm test
npm run lint
npm run typecheck
npm run build
npm run contract:test
```

上述 unit tests 不需要 PostgreSQL 或外部付款。整合測試另行執行：

```bash
npm run test:integration
```

完整 integration suite 需要獨立的本地 PostgreSQL（例如 `mello_integration`）以及運行中的 API、Sellers、Anvil。請使用 `PAYMENT_MODE=mock`、`CONTRACT_ANCHOR_MODE=onchain`、`AGENT_MODE=demo`、`INVOICE_PROVIDER=mock`、`MOCK_INVOICE_FAIL_ONCE=false`；Anvil 回報 chain ID 84532，RPC URL 必須是 loopback，registry 必須已在該 Anvil 部署。測試會清理 demo fixtures，不要指向保留中的展示資料庫。Prisma Dev 可供 UI smoke 使用，但不能替代 PostgreSQL 的 concurrency 測試。

## API 邊界

Settings 寫入、demo reset、payment reconciliation 需要 `x-demo-admin-token`；一般任務與讀取 API 目前是單一 demo 公司範圍，尚無正式多租戶登入／授權。Next.js proxy 不會自動補足這項能力。

POST 操作傳回 202 表示已排入 durable job；請輪詢 task／purchase。失敗時依 `availableActions` 顯示專用重試，不能用建立新 task 取代 invoice retry 或不確定的 settlement reconciliation。完整欄位、HTTP 狀態與缺口見 [前端串接交接](docs/FRONTEND_INTEGRATION.md)。

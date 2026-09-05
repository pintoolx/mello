# Mello monorepo

Mello 是台灣企業的 Agent Purchase-to-Pay 控制層。`apps/web` 沿用現有 Next.js 視覺，透過有 session 驗證的同源 BFF 串接 `apps/api` 的採購 workflow、PostgreSQL、x402 與稽核後端。付款支援 Base Sepolia Test USDC；發票仍為明確標示的 DEMO，正式電子發票 adapter 尚未實作。

## Repository structure

```text
mello/
├── apps/
│   ├── web/     # Next.js 官網與可點操作台
│   └── api/     # 採購 workflow、x402、資料庫、Sellers 與測試
├── contracts/  # 獨立 Foundry 合約與 API 共用的 ABI
├── package.json
└── package-lock.json
```

根目錄使用 npm workspaces。前端保留完整 UI/UX、品牌資產與舊文書／企業內控系統的視覺語言，不是空白 scaffold。

需要 Node.js 22.9+ 與 npm 11.19.1+。本 repo 固定 `packageManager=npm@11.19.1` 並啟用 engine 檢查，避免舊版 npm 在 workspace 邊界漏套用 dependency overrides（[上游修正](https://github.com/npm/cli/pull/9673)）。若全域 npm 尚未升級，可用 `npx --yes npm@11.19.1 ci` 安裝，不必修改全域工具。

## Run the web app

```bash
npx --yes npm@11.19.1 ci
cp apps/web/.env.example apps/web/.env.local
# 設定 CORE_API_URL，以及與 API 相同的 API_ACCESS_TOKEN / DEMO_ADMIN_TOKEN。
# 另外產生 MELLO_ACCESS_CODE、MELLO_SESSION_SECRET，詳見下方部署文件。
npm run dev
```

- 官網：`http://localhost:3000/`
- 操作台：`http://localhost:3000/app`

也可以明確指定 workspace：

```bash
npm run dev:web
npm run build
npm run lint
npm run typecheck
```

## Demo flow

1. 以私有存取碼登入操作台，讀取 API 的公司與政策。
2. 執行採購，輪詢真實比較、政策、付款、交付、發票、對帳及合約錨定。
3. 開票失敗可「重試發票（不重付）」；重複下單重用 request key，不新增付款。
4. 測試低預算、收款地址不符，以及「超過 0.03 USDC 先問我」的人工核准。
5. 凍結由 PostgreSQL 保存且後端強制執行；已取得放行許可的在途付款不會被撤銷。
6. Reload 恢復同一採購；「重置 Demo」只清空畫面，不刪除帳務紀錄。

畫面分別呈現 payment / invoice / anchor 模式；`x402` 是真實測試網移轉，`mock` 才是模擬。沒有主網付款或正式開票。

## Visual QA

目前接線版的完整驗收使用 Playwright（Python 套件及 Chromium）。啟動 API、Sellers 與 Web 後：

```bash
set -a
. apps/web/.env.local
set +a
MELLO_E2E_URL=http://localhost:3000 python3 apps/web/scripts/demo-e2e.py
```

驗收涵蓋登入／CSRF、三筆採購、重試不重付、重複 request key、凍結、拒絕、核准與 375／768／1280 px。Mock 驗收須設 `MOCK_INVOICE_FAIL_ONCE=true`。遠端 `--live` 另需當次明確設定 `MELLO_TESTNET_PAYMENT_APPROVED=true`，最多支付 0.15 Test USDC；不要在服務環境永久開啟此旗標。舊 `qa:visual`／錄影腳本針對純視覺 Demo，不是接線版驗收。

首頁的產品操作錄影由新版企業系統介面產生。需要重新錄製時，先啟動 production server，再執行：

```bash
npm run record:demo
```

## Backend teammate workflow

完整設定與驗證見 [apps/api/README.md](apps/api/README.md)，欄位／狀態／endpoint 對照見 [串接交接](apps/api/docs/FRONTEND_INTEGRATION.md)，Railway 組態見 [部署說明](docs/RAILWAY.md)。

```bash
npx --yes npm@11.19.1 ci
cp apps/api/.env.example apps/api/.env
# 設定 apps/api/.env 的 PostgreSQL URLs 與 DEMO_ADMIN_TOKEN
npm run db:migrate
npm run seed
npm run dev:backend
```

`npm run dev` 仍只啟動前端；`npm run dev:api` 只啟動 API。`npm run lint`、`npm run typecheck` 和 `npm run build` 會驗證兩個 workspace，`npm test` 執行後端 unit tests。

已具備 `pintoolx/mello` 寫入權限的 organization 成員可直接執行：

```bash
git clone git@github.com:pintoolx/mello.git
cd mello
git switch -c feat/backend-foundation
```

在 `apps/api` 的 `@mello/api` workspace 開發，再從根目錄安裝與驗證：

```bash
npx --yes npm@11.19.1 install
npm run dev --workspace @mello/api
git add apps/api package-lock.json package.json
git commit -m "Build backend foundation"
git push -u origin feat/backend-foundation
gh pr create --base main --fill
```

後端變更集中於 `apps/api`、合約 `contracts/`、共用 lockfile 與根目錄啟動設定。需要串接前端時再改 `apps/web`，並在 PR 說明受影響的 Demo 狀態。

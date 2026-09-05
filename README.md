# Mello monorepo

Mello 是台灣企業的 Agent Purchase-to-Pay 控制層。`apps/web` 保留已完成的 Next.js 黑客松視覺 Demo，`apps/api` 已整合採購 workflow、PostgreSQL、x402 與稽核後端。前端目前仍使用本地模擬資料，尚未接線到 API；正式電子發票 adapter 尚未實作。

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

1. 在 Task Composer 點「執行採購任務」。
2. 畫面依序亮起比較、Policy ALLOW、付款、Sandbox Invoice 與 MATCHED。
3. 點「模擬財務 Agent 重複下單」，展示 `DUPLICATE_PURCHASE`。
4. 可用「測試 0.03 預算」與「測試 payTo 不符」展示拒絕狀態。
5. 「凍結所有新付款」只切換前端狀態。

所有付款與發票皆明確標示為 `SIMULATED` / `SANDBOX` / `TEST INVOICE`。

## Visual QA

先以 production mode 啟動在 4173，再從另一個 terminal 執行 QA：

```bash
PORT=4173 npm run start
npm run qa:visual
```

QA 會以 headless Chrome 驗證桌機與手機的正常、重複採購、低預算、地址不符及凍結狀態；報告與全頁截圖輸出到系統暫存目錄的 `mello-visual-qa`。

首頁的產品操作錄影由新版企業系統介面產生。需要重新錄製時，先啟動 production server，再執行：

```bash
npm run record:demo
```

## Backend teammate workflow

後端已可啟動；完整設定與驗證見 [apps/api/README.md](apps/api/README.md)，前端欄位／狀態／endpoint 對照與待決事項見 [串接交接](apps/api/docs/FRONTEND_INTEGRATION.md)。

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

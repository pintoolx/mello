# Mello monorepo

Mello 是台灣企業的 Agent Purchase-to-Pay 控制層。`apps/web` 是企業採購主系統，已串接 `apps/api` 的採購 workflow、PostgreSQL、付款、發票與稽核紀錄。`apps/docs` 是完全獨立的文件站，取代原本的官網。付款依後端環境使用 mock 或 testnet；正式電子發票 adapter 尚未實作。

[目前 Railway / Base Sepolia 實測與交易證據](docs/WORKSPACE_LIVE_ACCEPTANCE.md)：新版工作區已重新部署，兩筆合計 0.10 Test USDC 的真實付款與四筆存證通過驗證。信用報告與發票仍為 Demo。[舊版控制台紀錄](docs/DEMO_ACCEPTANCE.md) 另行保留。

[開啟主系統](https://web-production-158a1.up.railway.app/app) · [獨立文件站](https://docs-production-8a88.up.railway.app)

[新版工作區整合驗收](docs/WORKSPACE_MERGE_ACCEPTANCE.md) · [前端欄位／狀態／endpoint 對照](apps/api/docs/FRONTEND_INTEGRATION.md)

## Repository structure

```text
mello/
├── apps/
│   ├── web/     # 採購主系統；操作與錄影用
│   ├── api/     # 採購 workflow、x402、資料庫、Sellers 與測試
│   └── docs/    # 獨立文件站；不連 API、不與主系統互相導流
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
# 設定 CORE_API_URL、與 API 相同的 API_ACCESS_TOKEN / DEMO_ADMIN_TOKEN，
# 以及私有 MELLO_ACCESS_CODE（至少 16 字元）、MELLO_SESSION_SECRET（至少 32 字元）。
# WEB_PUBLIC_URL 必須符合瀏覽器使用的完整 origin。
npm run dev
```

- 主系統：`http://localhost:3000/`（直接進入 `/app`）
- 不再提供產品行銷首頁。

也可以明確指定 workspace：

```bash
npm run dev:web
npm run build
npm run lint
npm run typecheck
```

操作台需要後端一起啟動（見下方 Backend 設定）。Next.js 的 `/api/v1/*` Route Handler 先驗證 HttpOnly session、寫入的同源檢查與 endpoint allowlist，再轉送至伺服器端 `CORE_API_URL` 並附加 API key；核准、凍結與付款核對才使用 admin token。沒有 API 時顯示可恢復錯誤，不補虛構資料。以上秘密不得使用 `NEXT_PUBLIC_*`，錢包金鑰只放 API。修改伺服器環境後需重啟；部署設定見 [Railway 說明](docs/RAILWAY.md)。

## Run the independent documentation site

```bash
npm run dev:docs
# http://localhost:3002
```

文件站包含產品概念、採購操作、政策、付款／發票／對帳、架構與實作範圍。它不需要 API、資料庫或 Seller；主系統與文件站沒有互相連結、導流按鈕、共用導覽或 API/session 相依，可各自部署。

```bash
npm run build:docs
npm run start:docs
# http://localhost:4174
```

## Product workflow

1. 以私有存取碼登入 `/app`：採購申請清單，搜尋本頁需求並篩選案件狀態。
2. 「新增採購申請」：輸入企業名稱、預算與補充需求；費用歸屬取自公司設定。「付款前控制」可填人工核准門檻與限定收款地址。
3. 「建立申請」：保存草稿與 UUID，尚不執行付款。
4. 案件內「送出採購」：後端評估、授權與執行；頁面輪詢實際狀態。
5. 「供應商與政策」：查看候選拒絕原因、實際選用服務與政策快照。
6. 「付款與對帳」：核對付款、交付報告、發票與歸檔資料。失敗時僅顯示 API 允許的發票／歸檔重試。
7. 付款、發票、政策、稽核皆有獨立頁面；重新整理或直接開案件 URL 仍能找回紀錄。

工作區不包含 Demo 重置或測試用錯誤注入按鈕。政策唯讀；報價超過門檻時，案件暫停並顯示金額、服務與收款地址，核准後才繼續。採購政策頁提供真正持久化的「凍結新付款」；已放行的在途付款不撤銷。建立回應遺失時以保存的 request key 找回原申請，不自動重建；不同 Agent 需共用同一業務 key 才能去重，相似 prompt 不算同一請求。

公司與供應商名稱沿用後端資料，不在前端改名偽裝；seed 預設為 `Mello Demo Corp.` 與 Seller A/B。公司設定經受保護的後端管理 API 修改。此 MVP 有存取碼登入，但所有受邀者共用單公司操作員權限，尚無多租戶、SSO 或正式財務職務分權；勿公開暴露可支出資金的 API。信用報告與發票仍為 Demo，真實測試網交易不代表資料經徵信或財政部認證。

錄製 Hackathon Demo Video 時，請依照 [`docs/demo-recording-script.md`](docs/demo-recording-script.md) 的畫面設定、點擊順序與旁白節奏操作主系統。影片不嵌入主系統或文件站。

## Visual QA

先以 production mode 啟動在 4173，再從另一個 terminal 執行 QA：

```bash
PORT=4173 npm run start
# 另一個 terminal 啟動已 build 的文件站
npm run start:docs
# 再執行驗收
node --env-file=apps/web/.env.local apps/web/scripts/visual-qa.mjs
```

QA 需要後端與兩個 Seller 已啟動，且必須為 `AGENT_MODE=demo`、`PAYMENT_MODE=mock`、`CONTRACT_ANCHOR_MODE=mock`、`INVOICE_PROVIDER=mock`、`MOCK_INVOICE_FAIL_ONCE=false`。測試會先讀取模式，拒絕使用付費模型或 testnet 資金。請使用獨立測試資料庫：每次執行會保留桌機／手機各一筆成功與低預算申請，不清除既有資料。

QA 以 headless Chrome 驗證桌機與手機的表單建立、API 結算／測試發票／對帳、重整保存、拒絕無發票的 Seller A、低預算無付款、同 task 冪等重跑，以及所有工作區與文件頁面的水平溢出。也驗證主系統根路徑直接進工作區，且兩個站點沒有交叉導流。報告與全頁截圖輸出到系統暫存目錄的 `mello-visual-qa`。可用 `MELLO_QA_URL` 與 `MELLO_QA_DOCS_URL` 指定兩個獨立站點。

登入與付款控制的完整新版回歸使用 Python Playwright + Chromium：

```bash
# 本地隔離 API：AGENT_MODE=demo、PAYMENT_MODE=mock、CONTRACT_ANCHOR_MODE=mock、
# INVOICE_PROVIDER=mock、MOCK_INVOICE_FAIL_ONCE=true。Web 預設 3400，Docs 4174。
# 將 MELLO_ACCESS_CODE 載入 QA 程序的環境，勿貼到終端參數或提交 Git。
python3 apps/web/scripts/workspace-e2e.py
npm test
```

`workspace-e2e.py` 預設只允許本地 mock，保留兩筆成功採購、低預算與地址不符的拒絕案件，涵蓋登入／CSRF、付款凍結、人工核准、發票重試不重付、建立回應遺失後找回原單、session 失效與 375／768／1280 px。只在斷線案例中攔截已實際保存的 create 回應，不偽造付款結果。明確批准的 Base Sepolia `--live` 模式、兩筆合計 0.10 Test USDC 的限制與只讀鏈上驗證見 [部署驗收說明](docs/RAILWAY.md#explicitly-approved-live-acceptance)。`demo-e2e.py` 僅保留供先前 Railway 舊版控制台驗收，不適用新版頁面。

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

`npm run dev` 只啟動主系統前端，`npm run dev:docs` 只啟動文件站，`npm run dev:api` 只啟動 API。`npm run lint`、`npm run typecheck` 和 `npm run build` 會驗證三個 workspace；`npm test` 執行 API 單元測試與 Web 的 request key／金額／輪詢回歸。

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

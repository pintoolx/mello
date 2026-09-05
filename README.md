# Mello monorepo

Mello 是台灣企業的 Agent Purchase-to-Pay 控制層。目前 repository 內含已完成的黑客松視覺 MVP；付款、對帳與發票狀態均為前端模擬，不含真實後端、資金移轉或正式電子發票。

## Repository structure

```text
mello/
├── apps/
│   ├── web/     # Next.js 官網與可點操作台
│   └── api/     # 後端夥伴的獨立 workspace
├── package.json
└── package-lock.json
```

根目錄使用 npm workspaces。前端保留完整 UI/UX、品牌資產與舊文書／企業內控系統的視覺語言，不是空白 scaffold。

## Run the web app

```bash
npm install
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

## Backend teammate workflow

Repository owner 先在 GitHub 的 **Settings → Collaborators and teams** 將後端夥伴或所屬 team 設為 **Write**。後端夥伴接著執行：

```bash
git clone git@github.com:pintoolx/mello.git
cd mello
git switch -c feat/backend-foundation
```

在 `apps/api` 建立 `package.json`，套件名稱使用 `@mello/api`，再從根目錄安裝與驗證：

```bash
npm install
npm run dev --workspace @mello/api
git add apps/api package-lock.json package.json
git commit -m "Build backend foundation"
git push -u origin feat/backend-foundation
gh pr create --base main --fill
```

後端 PR 原則上只改 `apps/api` 與共用 lockfile。需要串接前端時再改 `apps/web`，並在 PR 說明受影響的 Demo 狀態。

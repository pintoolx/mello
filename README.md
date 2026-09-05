# Mello

> 讓企業透過 AI Agent 找到可信任服務，以 x402 一鍵啟動採購。

## 問題與目標

x402 讓服務能透過 HTTP 完成付款，但企業在購買時，仍需要知道 seller 是誰、來自哪裡，以及服務是否經過審查。當供應商的身分與背景不透明，企業就難以建立信任，放心讓 AI Agent 代為採購。

Mello 是企業 AI 採購的 orchestration（流程協調）平台，協助 AI Agent 找到符合需求的可信任服務。企業可依 Mello Registry 認證、發票能力與採購政策篩選服務，在人工確認後，一鍵透過 x402 啟動採購，並串接付款、發票、對帳與稽核流程。目標是降低採購、財務與營運團隊採用 Agent 採購的信任門檻，同時保有決策權與可追溯的支出紀錄。

## 核心功能

- **採購申請與服務探索**：輸入目標企業、預算與補充需求，選擇是否需要發票、是否需要 Mello Registry 認證；建立申請後，按「開始探索」比較服務。
- **人工選用與條件篩選**：勾選必要條件時，只顯示符合條件的服務；不限制時，列出服務並標示有無發票與有效認證。由使用者選用一個服務，再送出採購並開始付款。
- **企業付款控制**：檢查單筆／每日額度、供應商、網路與代幣限制，支援人工核准門檻、指定收款地址與凍結新付款。
- **付款、發票與對帳**：支援本機 Mock 與 Base Sepolia x402 測試網付款；串接交付結果、Demo 發票、對帳與稽核紀錄，發票失敗可獨立重試。
- **持久化工作區**：保存申請、服務比較、付款狀態與事件紀錄；重新整理後可繼續查看案件。公司與發票收件資訊可在設定頁編輯。

探索條件與公司政策會分別檢查。例如取消「需要發票」後，可以看到無發票服務；若公司政策仍要求發票，該服務會顯示付款限制，無法選用。

## 系統架構

```mermaid
flowchart TD
    User[採購／財務人員] --> Web[Next.js 採購工作區]
    Web --> BFF[伺服器端 Session 與 API 代理]
    BFF --> API[Express 採購 API]
    API --> Agent[需求解析 Agent]
    Agent -. openai 模式 .-> Model[OpenAI Responses API]
    API --> Registry[Mello Registry 與服務比較]
    Registry -. bazaar 模式 .-> Bazaar[Coinbase CDP Bazaar]
    API -->|人工選用後| Workflow[政策檢查與持久化工作佇列]
    API --> DB[(PostgreSQL / Prisma)]
    Registry --> DB
    Workflow --> DB
    Workflow --> Seller[x402 Seller API]
    Seller -. x402 模式 .-> Facilitator[x402 Facilitator]
    Facilitator --> Chain[Base Sepolia / Test USDC]
    Workflow --> Invoice[Demo 發票與對帳]
    Invoice --> DB
    Workflow --> Audit[稽核存證 Adapter]
    Audit -. onchain 模式 .-> Contract[MelloAuditRegistry 合約]
    Contract --> Chain
```

前端透過 Next.js 伺服器端代理驗證工作區 Session，再呼叫後端。後端將需求解析成結構化資料，從服務目錄取得候選項目，檢查認證、需求與企業政策，再將比較結果交給使用者決定。模型負責解析需求；付款資格與金額限制由程式規則判定。

使用者確認服務後，後端工作佇列執行付款、取得交付結果、處理發票並對帳。PostgreSQL 保存案件、付款、重試與稽核資料；啟用鏈上模式時，合約另外保存授權與結果的雜湊存證。`apps/docs` 是可獨立啟動的文件站，不依賴採購 API 或資料庫。

```text
mello/
├── apps/
│   ├── web/       # Next.js 採購工作區與伺服器端 API 代理
│   ├── api/       # Agent、Registry、政策、付款、Sellers、Prisma migrations
│   └── docs/      # 獨立文件站
├── contracts/    # Solidity 合約、Foundry 測試與共用 ABI
├── docs/         # 串接、部署、驗收證據與錄影腳本
├── package.json  # npm workspaces 與共用指令
└── LICENSE
```

更多實作細節見 [API 文件](apps/api/README.md)、[前後端串接](apps/api/docs/FRONTEND_INTEGRATION.md)與 [Registry / Bazaar 整合](docs/BAZAAR_IMPLEMENTATION.md)。

## 使用技術

| 類型 | 技術／服務 | 用途 |
| --- | --- | --- |
| AI 模型 | OpenAI Responses API、Structured Outputs；模型由 `OPENAI_MODEL` 指定 | 將採購需求解析為結構化資料；`demo` 模式使用規則解析，不呼叫模型 |
| 前端 | Next.js 16、React 19、TypeScript、Tailwind CSS 4 | 採購工作區、Session、伺服器端 API 代理與文件站 |
| 後端 | Node.js、Express 5、Zod、持久化 Workflow Worker | API、輸入驗證、政策檢查與採購工作排程 |
| 資料庫 | PostgreSQL 16、Prisma 6 | 案件、服務認證、公司設定、付款與稽核紀錄 |
| 付款與服務發現 | x402 SDK、Coinbase CDP SDK、Bazaar、viem | 探索付費 API、驗證與結算測試網付款 |
| 區塊鏈 | Base Sepolia、Test USDC、Solidity、Foundry、OpenZeppelin | ERC-3009 付款授權及採購雜湊存證 |
| 部署與測試 | Railway、Docker、GitHub Actions、Vitest、Playwright | 部署各服務、持續整合與瀏覽器驗收 |
| Sponsor 技術 | 無 | — |

## 安裝與執行

以下步驟在新 checkout 執行，以本機 Demo 模式重現流程。需要 Git、Node.js **22.9 以上**（CI 使用 Node.js 24）、npm **11.19.1 以上**及已啟動的 Docker。安裝依賴與首次載入／建置 Google Fonts 需要網路；本機 Demo 不需要模型金鑰或錢包資金。

**1. 取得專案並安裝依賴**

```bash
git clone https://github.com/pintoolx/mello.git
cd mello
npx --yes npm@11.19.1 ci
```

**2. 啟動本機專用 PostgreSQL**

```bash
docker run --name mello-readme-db \
  -e POSTGRES_USER=mello \
  -e POSTGRES_PASSWORD=mello-local-only \
  -e POSTGRES_DB=mello \
  -p 127.0.0.1:55432:5432 \
  -v mello-readme-pgdata:/var/lib/postgresql/data \
  -d postgres:16-alpine

# 等待資料庫可以接受連線，再進行下一步。
until docker exec mello-readme-db pg_isready -U mello -d mello; do sleep 1; done
```

此帳密只用於上述綁定本機的 Demo 資料庫。資料保存在 `mello-readme-pgdata`；日後再次使用，可執行 `docker start mello-readme-db`，不需重建。

**3. 產生本機環境設定**

以下程式依照 `.env.example` 產生 API 與 Web 的環境檔，隨機建立共用 API 憑證、Session 密鑰及本機登入碼；若已有環境檔，會停止以保留原設定。

```bash
node --input-type=module <<'JS'
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

const paths = ['apps/api/.env', 'apps/web/.env.local'];
if (paths.some(existsSync)) throw new Error('環境檔已存在，請保留並手動核對設定。');
const secret = () => randomBytes(32).toString('hex');
const shared = { API_ACCESS_TOKEN: secret(), DEMO_ADMIN_TOKEN: secret() };
const database = 'postgresql://mello:mello-local-only@127.0.0.1:55432/mello?schema=public';
function createEnv(example, target, values) {
  let content = readFileSync(example, 'utf8');
  for (const [key, value] of Object.entries(values)) {
    content = content.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
  }
  writeFileSync(target, content, { flag: 'wx', mode: 0o600 });
}
createEnv('apps/api/.env.example', paths[0], {
  ...shared, DATABASE_URL: database, DIRECT_DATABASE_URL: database,
  AGENT_MODE: 'demo', SERVICE_DISCOVERY_MODE: 'local_demo',
  PAYMENT_MODE: 'mock', CONTRACT_ANCHOR_MODE: 'mock',
  INVOICE_PROVIDER: 'mock', MOCK_INVOICE_FAIL_ONCE: 'true',
  SELLER_CONTEXT_HMAC_SECRET: secret(),
});
createEnv('apps/web/.env.example', paths[1], {
  ...shared, MELLO_ACCESS_CODE: secret(), MELLO_SESSION_SECRET: secret(),
  CORE_API_URL: 'http://127.0.0.1:4000', WEB_PUBLIC_URL: 'http://localhost:3000',
});
JS
```

本機登入時使用 `apps/web/.env.local` 中的 `MELLO_ACCESS_CODE`；畫面提示的共用展示碼不會覆寫你的本機設定。環境檔已列入 `.gitignore`，請勿提交實際 API key、Token、錢包私鑰或個人資料。

**4. 套用 migrations 並初始化展示資料**

```bash
npm run db:prepare --workspace @mello/api
```

此指令會套用 migrations、在空資料庫建立 Demo 公司／政策與 Seller A/B，並補上服務 C/D。既有公司與政策不會被初始化流程覆寫。四個服務共用兩個 Demo Seller，其中 B/C 支援 Demo 發票，A/D 不支援；初始化不會自動核發 Mello Registry 認證。

**5. 分別啟動後端與前端**

```bash
# 終端機 A：在專案根目錄啟動 API（4000）及 Seller A/B（4011／4012）
npm run dev:backend
```

```bash
# 終端機 B：在同一專案根目錄啟動採購工作區
npm run dev:web
# 開啟 http://localhost:3000/app
```

```bash
# 終端機 C：選用，啟動獨立文件站
npm run dev:docs
# 開啟 http://localhost:3002
```

**6. 體驗與驗證**

登入後新增申請，例如目標企業填「範例企業」、預算填 `0.10 USDC`。本機首次操作請保留「需要發票」，取消「需要 Mello Registry 認證」，再依序操作「建立申請 → 開始探索 → 選擇 B 或 C → 送出採購並開始付款」。預設會模擬第一次發票失敗，可在案件頁重試發票並查看對帳結果。若要驗證認證篩選，請依 [認證管理流程](docs/BAZAAR_IMPLEMENTATION.md)另行建立服務審查紀錄。

```bash
# 後端與 Sellers 啟動後，在另一個終端機檢查本機服務。
npm run demo:health

# 使用上述專用 Demo 資料庫，建立測試採購並驗證發票重試不重複付款。
npm run demo:smoke

# 開發檢查：單元測試不需要模型金鑰或測試網資金。
npm test
npm run lint
npm run typecheck
npm run build
```

如需啟用 AI 解析，在 API 環境檔設定 `AGENT_MODE=openai`、`OPENAI_API_KEY` 與 `OPENAI_MODEL` 後重啟後端。模型名稱須由使用者明確指定；未設定或解析失敗時會使用規則解析，並在案件留下 fallback 紀錄。

Base Sepolia 付款、鏈上存證、Bazaar 公開服務發現與 Railway 部署需要額外設定，請參考 [API 模式與憑證](apps/api/README.md#模式與憑證)、[合約說明](contracts/README.md)與 [部署文件](docs/RAILWAY.md)。整合測試需要獨立測試資料庫；設定見 [API 驗證說明](apps/api/README.md#驗證)。

## 作品展示

- 作品展示網址：[Mello 採購工作區](https://mello402.up.railway.app)
- 技術文件網址：[Mello 技術文件](https://mello-docs.up.railway.app)
- 評選影片：待補。
- 展示順序：建立申請 → 探索服務 → 比較發票與認證 → 人工選用 → 付款 → 發票／對帳／稽核。
- 既有測試網驗收：[Base Sepolia 付款與存證紀錄](docs/WORKSPACE_LIVE_ACCEPTANCE.md)。
- 錄影參考：[Demo 腳本](docs/demo-recording-script.md)。

## 限制與未來工作

- **服務與資料範圍**：目前支援 `credit_report`；報告由 Demo 程式產生，沒有串接真實徵信資料。後續擴充服務類型、供應商與真實資料來源。
- **發票尚為 Demo**：目前使用 Mock adapter，未完成正式台灣電子發票介接；ECPay Stage 僅預留設定。後續串接開立、作廢與正式財務對帳流程。
- **認證需人工管理**：加入目錄與取得有效認證是不同狀態。認證包含審查範圍、服務綁定與期限，並非自動 KYB，也不保證正式發票能力；後續完善審查、續期與撤銷工具。
- **付款與權限範圍**：目前提供 Mock／Base Sepolia Test USDC，尚未提供主網付款；採單公司共用工作區權限，尚無多租戶、SSO 或完整職務分權。
- **採購與財務功能**：每筆申請選用一個服務；公司政策目前在前端唯讀，Credit Top up 為 Mock。後續加入多服務採購、政策編輯、正式資金入帳及 ERP／會計系統串接。

## 第三方服務、資料與素材

下列授權適用於各自的套件或素材；託管 API 另依供應商服務條款。完整 npm 套件版本與授權欄位見 [package-lock.json](package-lock.json)，各套件附帶的 LICENSE／NOTICE 仍需保留。

| 來源／連結 | 使用方式 | 授權方式 |
| --- | --- | --- |
| [OpenAI API](https://platform.openai.com/docs/overview)、[OpenAI Node SDK](https://github.com/openai/openai-node) | 選用的需求解析模型與 SDK | API 依 [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)；SDK 為 Apache-2.0 |
| [Next.js](https://github.com/vercel/next.js)、[React](https://github.com/facebook/react)、[Tailwind CSS](https://github.com/tailwindlabs/tailwindcss) | 工作區與文件站介面 | MIT |
| [Node.js](https://github.com/nodejs/node)、[npm CLI](https://github.com/npm/cli)、[TypeScript](https://github.com/microsoft/TypeScript) | 執行環境、套件管理與型別檢查 | Node.js 為 MIT，內含元件依其 NOTICE；npm 為 Artistic-2.0；TypeScript 為 Apache-2.0 |
| [Express](https://github.com/expressjs/express)、[cors](https://github.com/expressjs/cors)、[Zod](https://github.com/colinhacks/zod)、[Pino](https://github.com/pinojs/pino) | API、驗證與日誌 | MIT |
| [dotenv](https://github.com/motdotla/dotenv) | 本機環境設定 | BSD-2-Clause |
| [Prisma](https://github.com/prisma/prisma)、[PostgreSQL](https://www.postgresql.org/about/licence/) | 資料庫存取與儲存 | Prisma 為 Apache-2.0；PostgreSQL License |
| [x402](https://github.com/coinbase/x402) | HTTP 付款協定、buyer／seller SDK 與 Bazaar extension | Apache-2.0 |
| [Coinbase CDP SDK](https://github.com/coinbase/cdp-sdk)、[Bazaar](https://docs.cdp.coinbase.com/x402/buyer/discover-services) | Facilitator 認證與外部服務目錄 | SDK 為 MIT；託管服務依 [CDP 條款](https://www.coinbase.com/legal/developer-platform/terms-of-service)，目錄服務依各供應商條款 |
| [Base](https://docs.base.org/)、[Circle USDC](https://developers.circle.com/stablecoins/usdc-contract-addresses) | Base Sepolia 測試網與 Test USDC | 外部測試網服務與代幣；依各提供者條款，非本專案 MIT 授權標的 |
| [viem](https://github.com/wevm/viem)、[OpenZeppelin Contracts](https://github.com/OpenZeppelin/openzeppelin-contracts) | 鏈上讀寫與合約權限元件 | MIT |
| [Solidity](https://github.com/ethereum/solidity)、[Foundry](https://github.com/foundry-rs/foundry) | 合約編譯、測試與部署 | Solidity 編譯器為 GPL-3.0；Foundry 為 MIT 或 Apache-2.0 |
| [ESLint](https://github.com/eslint/eslint)、[typescript-eslint](https://github.com/typescript-eslint/typescript-eslint)、[DefinitelyTyped](https://github.com/DefinitelyTyped/DefinitelyTyped)、[tsx](https://github.com/privatenumber/tsx)、[concurrently](https://github.com/open-cli-tools/concurrently) | 開發檢查、型別定義與本機服務啟動 | MIT；Next.js／Tailwind 相關設定套件同其上游授權 |
| [Vitest](https://github.com/vitest-dev/vitest)、[Supertest](https://github.com/forwardemail/supertest)、[Playwright](https://github.com/microsoft/playwright) | 單元、API 與瀏覽器驗收 | Vitest／Supertest 為 MIT；Playwright 為 Apache-2.0 |
| [Railway](https://railway.com/legal/terms)、[Docker](https://www.docker.com/legal/)、[GitHub Actions](https://docs.github.com/en/site-policy/github-terms/github-terms-of-service) | 部署、本機容器與 CI | 依各供應商服務／產品條款；容器內套件保留原授權 |
| [Noto Sans TC](https://github.com/google/fonts/blob/main/ofl/notosanstc/OFL.txt)、[Roboto Mono](https://github.com/google/fonts/blob/main/ofl/robotomono/OFL.txt) | 介面字型，透過 Google Fonts 取得 | SIL Open Font License 1.1 |
| [Next.js 範本](https://github.com/vercel/next.js/tree/canary/packages/create-next-app/templates)、[Vercel 品牌資源](https://vercel.com/geist/brands) | 儲存庫保留的 Next.js／Vercel 與通用 SVG 範本圖示 | 範本程式碼為 MIT；品牌標誌另依原權利人品牌規範 |
| [Demo 報告產生器](apps/api/src/seller-kit/report.ts)、[Demo seed](apps/api/src/db/seed-data.ts) | 程式生成的展示報告與公司／供應商範例資料 | 本專案 MIT；不包含授權徵信資料集 |
| [Mello 品牌素材](apps/web/public/brand) | 儲存庫既有 Logo 與介面素材 | 本專案自有素材適用 MIT；第三方字型依上列授權 |

## 團隊成員

| 姓名 | 分工 |
| --- | --- |
| 郭啟霖 | 後端 |
| Lin Hong Sheng | 設計 |
| 蕭孟汝 | 前端 |

## License

本專案採用 [MIT License](LICENSE)，版權聲明為 `Copyright (c) 2026 Mello contributors`。第三方套件、字型、標誌與外部服務依各自授權或條款。

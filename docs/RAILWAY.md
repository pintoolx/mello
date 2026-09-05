# Railway / Base Sepolia deployment

使用根目錄完整 monorepo build context，不把 root directory 設為 apps/api 或 apps/web。Web 保留現有視覺；只有 Next.js server 的 BFF 能連私有 API。合約獨立保留 contracts/，API 使用 ABI，不需要前端錢包連線。

新版主系統與 `apps/docs` 分開部署；文件站不使用任何 API／session／錢包環境。Dockerfiles 的安裝階段包含三個 workspace manifests，實際 runtime 仍只放目標服務。PR #2 的合併與後續部署分別驗收，舊版控制台紀錄見 [歷史驗收](DEMO_ACCEPTANCE.md)。

目前線上網址、新合約、五個服務的指定 deployment IDs 與兩筆真實付款，見 [新版工作區 live 驗收](WORKSPACE_LIVE_ACCEPTANCE.md)。

| Service | Build | Start | Health |
| --- | --- | --- | --- |
| api | Dockerfile.api | image default | /healthz |
| seller-a | Dockerfile.api | npm run start:seller-a --workspace @mello/api | /health |
| seller-b | Dockerfile.api | npm run start:seller-b --workspace @mello/api | /health |
| web | Dockerfile.web | image default | /healthz |
| docs | Dockerfile.docs | image default | / |
| Postgres | Railway PostgreSQL template + persistent volume | template | template |

API pre-deploy: `npm run db:prepare --workspace @mello/api`。由 npm script 順序執行 migrate 與 init，不仰賴 Railway 解析複合 shell 指令。db:init 僅初始化空 DB，不覆寫既有公司與 policy。API 內建 durable worker，停用 app sleeping、使用一個持續運行 replica。若增加 API replicas，operator transaction nonce 協調需另做壓力驗證。

## Runtime variables

所有服務 port 8080。API 設 `CORE_API_PORT=8080`、`CORE_API_HOST=::`；Sellers 各設 SELLER_A_PORT / SELLER_B_PORT、`SELLER_BIND_HOST=::`。

- API / Sellers：`DATABASE_URL`、`DIRECT_DATABASE_URL` 都引用 `${{Postgres.DATABASE_URL}}`，不使用 public DB URL。
- API / Sellers：SELLER_A_URL / SELLER_B_URL 引用 `http://${{seller-a.RAILWAY_PRIVATE_DOMAIN}}:8080` 等，資料庫 registry 與 seller response 須一致。
- API：PAYMENT_MODE=x402、CONTRACT_ANCHOR_MODE=onchain、AGENT_MODE=demo、INVOICE_PROVIDER=mock、DEMO_ALLOW_OFFCHAIN_AUTH=false。
- API：EVM_PRIVATE_KEY（test buyer）、CONTRACT_OPERATOR_PRIVATE_KEY（gas operator）、AUDIT_REGISTRY_ADDRESS、Base Sepolia RPC、seller recipient addresses；只使用測試網。
- API / Sellers：CDP facilitator URL、CDP_API_KEY_ID、CDP_API_KEY_SECRET、共用 SELLER_CONTEXT_HMAC_SECRET。Sellers 不需 buyer/operator 私鑰。
- API：API_ACCESS_TOKEN、DEMO_ADMIN_TOKEN（高熵隨機秘密）；所有 /api/v1 routes 受 API key 保護。
- Web：CORE_API_URL=`http://${{api.RAILWAY_PRIVATE_DOMAIN}}:8080`、同一 API_ACCESS_TOKEN / DEMO_ADMIN_TOKEN、獨立 MELLO_SESSION_SECRET 與 MELLO_ACCESS_CODE，WEB_PUBLIC_URL 為其公開 HTTPS origin。
- `MOCK_INVOICE_FAIL_ONCE=true` 刻意提供 demo 開票重試流程。ISSUED_DEMO 不是正式統一發票。

秘密用 Railway CLI stdin／sealed variables，不出现在 CLI arguments、Git、browser bundle 或 NEXT_PUBLIC_*。對外使用 Web 與獨立 Docs domain，API 與 Sellers 使用 private networking。Docs 只需 PORT=8080 與 NODE_ENV=production，不傳入任何操作台秘密。不要把測試批准旗標永久設到 Railway。

## Deploy and verify

1. 先驗證 typecheck、lint、unit、PostgreSQL + Anvil integration、Foundry 及本機 Playwright。
2. 切換新 registry 前先凍結新付款，確認沒有在途任務／採購；保留既有 DB 與舊合約。核對 chain ID=84532、operator pending nonce 與 gas 預算。`contract:deploy:base-sepolia` 部署後獨立讀取 receipt success、合約 bytecode、operator/admin roles，不要只相信 dry-run 地址。只更新 API 的 AUDIT_REGISTRY_ADDRESS。
3. 配好變數／migrations，分 service 執行 `railway up --detach --json -m "release summary"`，逐一保存 deploymentId 並等待該 ID 到 SUCCESS。
4. 檢查 public Web health、登入、BFF 與完整 dependency health；匿名讀取／付款須拒絕。
5. 新版工作區先跑 `workspace-e2e.py` 的本地 mock 回歸。服務健康後解除切換用凍結，當次明確批准最多兩筆各 0.05 Test USDC，再使用下方 live 模式。`demo-e2e.py --live` 僅適用歷史控制台，不可用來驗收新版 UI。
6. Live 報告需記錄 task／purchase IDs、實際金額、settlement hashes 與 authorize/finalize anchors。獨立比對鏈上 receipt 與 USDC Transfer logs，不以 UI 的 COMPLETED 單獨作為鏈上證據。

失敗先檢查已有採購與 hash，恢復原任務，不能盲目重跑多付款。完整本地報告及 375／768／1280 px 截圖由 MELLO_E2E_OUTPUT 指定。登入碼是單一 demo 操作員權限，不是多租戶 SSO／財務分權產品。

## Explicitly approved live acceptance

將 MELLO_ACCESS_CODE、WEB_PUBLIC_URL、BASE_SEPOLIA_RPC_URL 安全載入測試程序環境，勿把秘密放在命令參數。另設 MELLO_E2E_URL 與 WEB_PUBLIC_URL 相同、MELLO_E2E_DOCS_URL 為獨立文件站 HTTPS origin、MELLO_E2E_REGISTRY_ADDRESS 為已驗證的新合約地址。

```bash
# 僅在本次兩筆合計 0.10 Test USDC 已獲批准後執行：
MELLO_TESTNET_PAYMENT_APPROVED=true python3 apps/web/scripts/workspace-e2e.py --live
# 以下只讀鏈上及 API，不會再付款：
node apps/web/scripts/verify-live.mjs /tmp/mello-workspace-live/report.json
```

Live 腳本在付款前檢查真實 Base Sepolia RPC、指定合約、Test USDC 餘額、x402/onchain 模式、關閉 off-chain fallback 與固定 0.05 報價。低預算／錯收款地址測試另加 0 元人工核准門檻。發票 fail-once 重試必須保留原 purchase／payment ID 與 settlement hash。報告逐步寫入 request keys／task IDs；已有 live journal 時拒絕重新執行。失敗後不要換輸出目錄繞過保護，應先核對原任務及已發生的支出。

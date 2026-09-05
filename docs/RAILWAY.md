# Railway / Base Sepolia deployment

使用根目錄完整 monorepo build context，不把 root directory 設為 apps/api 或 apps/web。Web 保留現有視覺；只有 Next.js server 的 BFF 能連私有 API。合約獨立保留 contracts/，API 使用 ABI，不需要前端錢包連線。

| Service | Build | Start | Health |
| --- | --- | --- | --- |
| api | Dockerfile.api | image default | /healthz |
| seller-a | Dockerfile.api | npm run start:seller-a --workspace @mello/api | /health |
| seller-b | Dockerfile.api | npm run start:seller-b --workspace @mello/api | /health |
| web | Dockerfile.web | image default | /healthz |
| Postgres | Railway PostgreSQL template + persistent volume | template | template |

API pre-deploy: `npm run db:migrate --workspace @mello/api && npm run db:init --workspace @mello/api`。db:init 僅初始化空 DB，不覆寫既有公司與 policy。API 內建 durable worker，停用 app sleeping、使用一個持續運行 replica。若增加 API replicas，operator transaction nonce 協調需另做壓力驗證。

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

秘密用 Railway CLI stdin／sealed variables，不出现在 CLI arguments、Git、browser bundle 或 NEXT_PUBLIC_*。對外只需 Web domain，API 與 Sellers 使用 private networking。不要把測試批准旗標永久設到 Railway。

## Deploy and verify

1. 先驗證 typecheck、lint、unit、PostgreSQL + Anvil integration、Foundry 及本機 Playwright。
2. `contract:deploy:base-sepolia` 部署後，讀取 RPC chain ID=84532、receipt success、合約 bytecode。不要只相信 dry-run 地址。
3. 配好變數／migrations，分 service 執行 `railway up --detach --json -m "release summary"`，逐一保存 deploymentId 並等待該 ID 到 SUCCESS。
4. 檢查 public Web health、登入、BFF 與完整 dependency health；匿名讀取／付款須拒絕。
5. 當次明確設定 MELLO_TESTNET_PAYMENT_APPROVED=true，使用 `MELLO_E2E_URL=https://... python3 apps/web/scripts/demo-e2e.py --live`。MELLO_ACCESS_CODE 從本地 ignored 環境檔載入。
6. 報告包含三筆 0.05 Test USDC 的 task／purchase IDs、settlement hashes、authorize/finalize anchors。獨立比對鏈上 receipt 與 USDC Transfer logs，不以 UI 的 COMPLETED 單獨作為鏈上證據。

腳本每個步驟都寫 progress.json；失敗先檢查已有採購與 hash，恢復原任務，不能盲目重跑多付款。完整報告及 375／768／1280 px 截圖由 MELLO_E2E_OUTPUT 指定。登入碼是單一 demo 操作員權限，不是多租戶 SSO／財務分權產品。

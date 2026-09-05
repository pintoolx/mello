# Bazaar 發現 + Mello 服務認證

## 本輪交付範圍

Bazaar 是公開服務目錄，Mello registry 是服務身分與人工審核層，企業 policy
是另一層採購授權。x402 buyer 直接呼叫 Seller，不把 Bazaar 當作 HTTP 代理。
沿用現有前端視覺，不新增認證合約。

```text
CDP Bazaar 候選
  → 精確匹配 Mello 已登錄服務與有效認證
  → 企業白名單、網路／Token、額度與發票政策
  → x402 直接呼叫 Seller → facilitator → Base Sepolia / Test USDC
  → Demo 報告、Demo 發票與既有對帳／稽核
```

初版支援現有 Seller A／B 的 POST 信用報告協定，不是任意外部 API 的
自動接線器。未知服務只計入目錄結果，不自動加入 registry、不自動認證，
也不自動變更企業白名單。API 提供既有服務的 endpoint／價格更新、認證
與撤銷；任意商家註冊 UI、KYB、正式電子發票驗證均不在本輪。

報告內容、發票介接仍是 Demo，與付款是否使用真實測試網是兩個維度。
本輪測試除目錄唯讀查詢外均使用本地 fixture／mock，沒有新增鏈上交易。

## 設定與資料遷移

| 設定 | 預設 | 用途 |
| --- | --- | --- |
| API `SERVICE_DISCOVERY_MODE` | `local_demo` | 改成 `bazaar` 才強制目錄、認證、政策三層交集；目錄失敗不退回本地服務 |
| API `BAZAAR_TIMEOUT_MS` | `5000` | CDP 查詢逾時，允許 100–15000 ms |
| Seller `BAZAAR_PUBLIC_ENABLED` | `false` | 明確啟用公開 402／Bazaar metadata 與不需 Mello token 的 x402 購買；僅允許 x402 + 公開 HTTPS |

CDP public search 不使用 API key、wallet secret、cookie 或使用者公司資料。
此 adapter 固定查詢 CDP，與 x402.org 的目錄分開。query 使用服務分類
`credit report`；付款前以已審核 endpoint + payTo 縮小查詢，再做精確比對。
最多取 20 筆；`partialResults` 及候選筆數會顯示、留存，不保證搜尋全市場。
即使 partialResults=false，也不表示不存在排名外或其他未回傳服務。

新增 migration：`20260905020000_service_verification_bazaar`。

- `ServiceVerification` 保存目前審核版本；變更沿用 audit ledger 留存。
- `Purchase.discoveryEvidence` 保存原始來源、時間、條款 hash、認證版本與期限。
- migration 不回填認證，不把 ACTIVE 或企業白名單當成 VERIFIED。
- 舊採購證據保持 null。Bazaar 模式禁止為缺少證據的舊案件重新簽付；
  已付款的發票／最終 anchor 恢復仍走專用流程，不重新付款。
- 切回 local_demo 不會解除既有 Bazaar 案件重新付款時的認證檢查。
- 不要在保留資料的遠端 DB 重跑 seed；seed 會重設 Demo 公司與 policy。

## 認證含義與失效規則

VERIFIED 僅代表 MANUAL_SCOPED_REVIEW，不是自動身分驗證或正式開票資格。
管理員需自行完成控制權查驗，提交內部審核單參照 `evidenceRef`；不可填入
API secret、私鑰或原始敏感證件。目前 actor 是共用 demo-admin，尚非個人化身分。

必要範圍：ENDPOINT_CONTROL、PAYMENT_WALLET_CONTROL；宣告 Demo 發票的
服務另需 DEMO_INVOICE_INTEGRATION。有效期須在未來 90 天內。

綁定 hash 包含 seller／service ID、商家名稱／統編、完整 endpoint、method、
network、asset、decimals、payTo、付款 scheme 與發票能力／provider。
網址僅接受 canonical 公開 HTTPS，不接受 query、fragment、帳密、IP 或內部名稱。
端點變更需重審。價格不屬於身分 hash，但目錄／402／policy／採購證據均須匹配
目前價格；價格變更不會讓既有採購沿用舊的付款批准。

| 對外狀態 | 意義 |
| --- | --- |
| UNREVIEWED | 尚無有效審核紀錄 |
| VERIFIED | 目前 binding、期限與必要範圍均通過 |
| REVOKED | 已撤銷；重新審核須產生新版本 |
| EXPIRED | 審核已到期或時間不有效 |
| BINDING_CHANGED | 服務身分／網址／付款或發票能力變更 |
| INVALID_ENDPOINT | 不符合公開 HTTPS 身分限制 |
| SCOPE_INCOMPLETE | 缺少必要審核範圍 |

簽章前與付款放行前重新查詢目錄、比對認證；目錄 await 後再讀一次本地認證。
最終本地檢查與付款 release permit 共用短 DB transaction，並以同一服務鎖
與撤銷／更新操作排序。撤銷早於 permit 就拒絕；permit 已核發則視為在途付款，
不能承諾撤回已傳出的簽章或已結算交易。DB 鎖不跨越目錄或 Seller 網路請求。
目錄本身不是交易式資料來源，無法保證放行後完全不變；實際付款條款仍受既有
x402 live-terms 檢查約束。

## Endpoint 與前端對照

以下皆加 /api/v1；API access key 仍由私有 BFF 補上。

| Endpoint | 用途／回應 | 前端與權限 |
| --- | --- | --- |
| GET /registry | discoveryMode, catalog, services[].verification | 登入後唯讀 |
| GET /registry/discovery | CDP 筆數、partial flag、各登錄服務的 listed, verification, reasonCodes, evidence | 政策頁手動「查詢 Bazaar」；不付款、不寫認證 |
| GET /settings | 新增 discoveryMode 與 services[].verification | 沿用政策表格，新增認證／期限 |
| GET /tasks/:id | 候選 discoverySource, verificationStatus | 案件供應商／政策分頁 |
| GET /purchases/:id | 新增不可變的 discoveryEvidence | 顯示原始來源、認證版本與查詢時間 |
| PUT /registry/services/:id/binding | { expectedBindingHash, endpoint, priceAtomic } | 僅 API + admin credentials；瀏覽器 BFF 不代理 |
| POST /registry/services/:id/verify | { expectedBindingHash, scopes, evidenceRef, expiresAt } | 僅 API + admin credentials；先讀最新 hash |
| POST /registry/services/:id/revoke | { reason } | 僅 API + admin credentials；留存版本與原因 |

認證寫入沒有藏在共用存取碼操作台內；企業白名單仍由原有 policy 控制，
不因 registry 認證通過而自動加入。畫面沿用既有色彩、表格與按鈕，包含
loading／error／empty／partial 狀態，不使用假徽章表示已完成真實認證。
完整欄位對照見 [前端串接文件](../apps/api/docs/FRONTEND_INTEGRATION.md)。

## Seller 的公開模式

保持 BAZAAR_PUBLIC_ENABLED=false 時，原有 Mello context 驗證不變。
明確開啟後，未付款 probe 可取得 402 與固定範例 schema；公開 paid request 可
省略 purchaseContextToken，但若有提交就必須通過驗證。付款 request 的業務
body 在 verify／settle 前檢查。內部 task／purchase correlation header 不接受偽造。

Bazaar metadata 使用固定的 Example Co. 與 Demo output，不包含真實採購的
公司名稱、統編、context token 或付款簽章。不下載／執行 catalog 的遠端 skills
或 schema；目錄 body 有 512 KiB、筆數、格式、逾時限制。Buyer 禁止 Seller redirect。

公開模式仍需既有 payment-identifier extension；重放相同請求使用 idempotency
紀錄，避免重複 settle。外部公開 buyer 可取得 Demo 報告；這不等於取得 Mello
內部採購／發票 API 權限，invoice orchestration 仍屬 Mello 自身採購流程。

公開 Demo 在 JSON parsing／facilitator 之前有單一 replica 的全域限制：每個
60 秒固定區間最多 120 個報告請求、其中 12 個帶付款簽章的嘗試，同時最多 4 個
處理中請求。超限回 429／503 與 Retry-After；health 不受影響。這是基本容量保護，
不是分散式限流或完整 DDoS 防護；擴 replica 前須改用共用 limiter／邊緣控制。

## 本地驗證與尚未執行事項

檢查指令：

```sh
npm run db:migrate
npm run lint
npm run typecheck
npm test
npm run test:integration --workspace @mello/api -- --exclude src/local-stack.integration.test.ts
npm run build
npm run bazaar:check --workspace @mello/api
```

DB 測試必須指向專用本地測試 DB，不能使用遠端或保留中的展示 DB。
unit／DB integration 涵蓋目錄失敗不 fallback、未知／未認證拒絕、政策獨立、
審核失效／撤銷、付款放行鎖、證據持久化、已付案件只補發票，以及公開 Seller
協定與 metadata 隱私。公開 Seller 協定使用 fixture facilitator，不是鏈上成交證據。
local-stack.integration.test.ts 需要另起 Anvil 與專用完整服務；現有服務未滿足
onchain preflight，保護檢查已阻擋執行，不能宣稱這 6 個 full-stack 案例通過。

apps/web/scripts/bazaar-e2e.py 先執行既有本地工作區流程，再以 browser fixture
檢查 Bazaar loading／失敗／空目錄／部分結果、三種尺寸與認證寫入隔離。
需 Playwright Chromium、本地 mock API／Seller／Web／Docs、MELLO_ACCESS_CODE、
MELLO_E2E_URL、MELLO_E2E_DOCS_URL、MELLO_E2E_OUTPUT，並開啟
MOCK_INVOICE_FAIL_ONCE=true。只允許本地網址，不可拿 fixture 成功宣稱已收錄。

2026-09-05 的真實 CDP 唯讀查詢成功取得 1 筆符合條件的資源，paidRequests=0；
這不是我們 Seller A／B 已收錄的證據。GitHub Actions 的 lint、typecheck、unit、
17 項 registry DB integration 及 build 已在 [PR #5 最新 CI](https://github.com/pintoolx/mello/actions/runs/33965634140)
通過，程式碼已合併為 03ff11acb283af05511e917121548f4d8839ab57。

本地整合與公開容量限制通過：API unit 362 項、前端 unit 6 項、PostgreSQL integration 52 項（13 個檔案，
不含上述 Anvil full-stack）、工作區瀏覽器流程 10 項、Bazaar 畫面檢查 7 項。
全 workspace lint、typecheck 與 production build 亦通過。
瀏覽器報告保留於 `/tmp/mello-bazaar-workspace/report.json` 與 `bazaar-report.json`；
使用獨立的 `mello_bazaar_test` 本地 DB，不修改原開發 stack 或遠端資料。

## 公開上線與後續啟用

公開部署已獲使用者同意，執行狀態及確切付款草案見 [rollout 紀錄](BAZAAR_ROLLOUT.md)。
下列付款、認證與切換 Bazaar 採購仍各有獨立 gate，不能以部署同意代替。

1. 確認要公開的 Seller HTTPS 網域、Demo 定價與流量／速率限制；API 保持私有。
   靜態 URL 驗證不是 DNS pinning，任意新商家接入前還須補 public DNS／egress
   限制、控制權挑戰與個別審核 actor；不能把 manual review 當成 SSRF 沙箱。
2. migrate 並部署 opt-in Seller，確認外部無 Mello token 可取得正確 402、resource、
   method、Demo metadata、network／asset／payTo；只讀查驗不付款。
3. 管理員更新既有 registry endpoint，查驗網域及收款控制權、Demo 發票介接，
   以最新 binding hash 審核。不能直接把全部 seeded seller 設為 VERIFIED。
4. CDP 收錄可能需要首筆成功的 facilitator 付款。這是獨立、限額、可稽核的
   onboarding 動作，須事先核准金額與目標；不在一般買方建立「找不到就付款」的
   bypass。不可盲目重跑或因等待索引而重複付款。
5. 唯讀確認我們的完整 endpoint 已出現在 CDP catalog，再切 API 至 bazaar；
   以已核准的 Test USDC 額度跑端到端驗收，保存目錄、認證、付款與發票證據。

程式碼實作本身不會公開 Seller 或發出付款。公開部署的實際結果以 rollout 紀錄為準；
未切換 live discovery mode、未重部署合約、未送出付費索引請求，也沒有啟用真實
LLM parser。歷史付款不得在上線或 onboarding 時改寫。

## 官方依據

- [CDP buyer discovery](https://docs.cdp.coinbase.com/x402/buyer/discover-services)
- [CDP search API](https://docs.cdp.coinbase.com/api-reference/v2/rest-api/x402-facilitator/search-x402-resources)
- [Seller indexing](https://docs.cdp.coinbase.com/x402/seller/get-discovered)

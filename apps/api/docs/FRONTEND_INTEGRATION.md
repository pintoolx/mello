# Next.js 前端串接交接

本文件對照現有 `apps/web/src/components/mello-console.tsx` 與已移入 `apps/api` 的實作。此次交付不修改前端；表中「建議／待補」不是已存在的 endpoint 或功能。

## 整合方式

保留現有 Next.js 官網、品牌、版面與操作台，將 console 的 timer/local state 改為 API 驅動。建議分出前端的 `lib/api-client.ts`（HTTP／錯誤）、`lib/console-view-model.ts`（API → 畫面）與 task polling hook，讓 `mello-console.tsx` 保持呈現與互動職責。

```text
Next.js Client Component
  → 同 origin /api/v1/*（建議新增 Next.js rewrite）
  → apps/api 的 Express /api/v1/*
  → PostgreSQL + durable worker + Seller A/B
  → x402 facilitator / Base Sepolia（啟用時）
```

API 是持續運行的 Node.js service，與 Next.js 各自部署。Next.js rewrite 只處理路由，不提供登入／權限。若後續改用 Route Handler BFF 代加 admin token，必須先驗證使用者 session 與操作權限；不能為匿名 proxy 自動附加 admin token。

建議在 Next.js server env 設定 `CORE_API_URL=http://127.0.0.1:4000`，將 `/api/v1/:path*` rewrite 到同一路徑的 API。這是待串接時才新增的設定。瀏覽器直連 API 亦可，但需對齊 `WEB_ORIGIN`；目前 API 預設只接受 `http://localhost:3000`。不要讓 frontend import API 的 Prisma、wallet 或 `src/shared` barrel；若日後需要共用型別，可抽出只含 JSON DTO 的 `packages/api-contracts`。

## Endpoint 對照

下列路徑都加上 `/api/v1`。ID 使用後端回傳 UUID，不使用畫面上的 `PI-...` 或 `pay_mello_001` 字串代替。

| 畫面／操作 | Endpoint | 請求／回應重點 |
| --- | --- | --- |
| 初始載入公司、政策、供應商 | `GET /settings` | `{ company, policy, sellers, services }` |
| 儀表板／採購紀錄摘要 | `GET /dashboard/summary` | `counts, taskStatuses, purchaseStatuses, settledAmountAtomic, recentPurchases, modes` |
| 系統狀態 | `GET /demo/health` | `status, checkedAt, modes, checks`；即使 degraded 也可回 HTTP 200 |
| 開立採購任務 | `POST /tasks` | body 只有 `{ prompt: string }`；201 → `{ taskId, status: "CREATED" }` |
| 執行任務 | `POST /tasks/:taskId/run` | 無 body；202 → `{ taskId, status: "PARSING" }`，實際是排入 worker |
| 任務輪詢／回復頁面 | `GET /tasks/:taskId` | `status, intent, candidates, decisionSummary, error, purchaseId, purchase, timeline` |
| 任務列表 | `GET /tasks?limit=20&offset=0` | `{ items, total, limit, offset }` |
| 採購詳情與證據 | `GET /purchases/:id` | `payment, delivery, invoice, reconciliation, anchors, availableActions, modes` |
| 付款紀錄列表 | `GET /purchases?limit=20&offset=0` | `{ items, total, limit, offset }`；列表與詳情 shape 不完全相同 |
| 服務 registry | `GET /services?category=credit_report` | `{ services: [...] }` |
| 供應商 registry | `GET /sellers` | `{ sellers: [...] }` |
| 任務／採購稽核事件 | `GET /tasks/:taskId/events`、`GET /purchases/:id/events` | 回 array；支援 `limit, offset`，依 `sequence` 遞增 |
| 全部稽核事件 | `GET /audit-events` | 回 paginated envelope；可加 `taskId, purchaseId, aggregateType, aggregateId` |
| 只重試發票 | `POST /purchases/:id/retry-invoice` | 無 body；202；需 `availableActions.retryInvoice=true` |
| 只重試 anchor | `POST /purchases/:id/retry-anchor` | 無 body；202；需 `availableActions.retryAnchor=true` |
| 核對未確定付款 | `POST /purchases/:id/reconcile-payment` | admin；202；需 `availableActions.reconcilePayment=true`，且已有候選 tx hash |
| 編輯公司 | `PUT /company` | admin；`{ legalName, businessId, email, defaultCostCenter }` |
| 編輯 policy | `PUT /policies/active` | admin；完整 policy input，見下表 |
| 清除 demo database | `POST /demo/reset` | admin；只接受 local DB，worker 有 active jobs 時拒絕 |

Invoice retry、anchor retry、payment reconciliation 亦提供 `/tasks/:taskId/...` 的別名。Admin 操作要帶 `x-demo-admin-token`。無效 token 回 401；不存在資源回 404；重複執行中／狀態不允許操作通常回 409。

## 畫面欄位對照

| 現有畫面資料 | API 來源 | 串接注意事項 |
| --- | --- | --- |
| 公司名稱、統編、成本中心 | `settings.company.legalName / businessId / defaultCostCenter` | 現有硬編碼「青葉電子」與 backend seed「Mello Demo Corp.」不同，需先由公司設定更新 |
| 申請人「林佳穎」、截止時間「17:00」 | 尚無對應欄位 | 顯示為展示內容或後續新增 actor／deadline model |
| 採購需求 | `task.prompt` | `POST /tasks` 只接受 prompt，3–2000 字；沒有獨立 budget/company/payTo 欄位 |
| 案件編號 | `task.taskId`／`purchase.purchaseId` | 可縮短顯示；不要虛構完整業務流水號 |
| 預算上限 | `task.intent.maxAmount.atomic / display` | 傳入時要反映在 prompt；獨立 budget state 不會自動影響 API |
| 採購目標 | `task.intent.targetCompanyName` | Demo parser 只支援有限句型，見下文 |
| 公司發票資料 | `task.intent.buyerBusinessId / costCenter` | 從儲存的 company profile 取得，不直接接受 prompt 任意覆蓋 |
| 供應商名稱／service ID | `task.candidates[].sellerLegalName / serviceId / sellerId` | 實際 ID 是 `seller-a/b`、`credit-report-a/b`；不要直接使用 `taiwanrisk` |
| 報價 | `candidates[].priceAtomic` | USDC 六位小數；`"50000"` = 0.05 USDC |
| 台灣發票能力 | `supportsTwInvoice, invoiceCapability` | Seller B 是 `TW_B2B_DEMO`，不是正式開票能力 |
| 白名單欄 | `settings.policy.allowedSellerIds` | seed 允許 A 和 B；A 被拒的原因是發票要求，不是未在白名單 |
| 可用候選／拒絕原因 | `candidates[].eligible / reasonCodes / humanSummary` | 不按 row index 判定；後端會重新排序 |
| 最終選用服務 | `purchase.selectedService` | `eligible=true` 只表示候選符合，不代表已選用或已付款 |
| `recommendedAction`、`confidence=0.99` | 尚無這兩個 response 欄位 | 顯示後端 `decisionSummary`；不自行假造 confidence |
| 政策 ALLOW | `purchase.policyDecision.approved` | 只有後端真正核准後才顯示 ALLOW |
| 政策拒絕 | `task.error`、`task.candidates[].reasonCodes`、`task.timeline` | 有些拒絕發生在 purchase 建立前，此時 `purchase=null` |
| Policy 版本與金額 | `purchase.policySnapshot / policyDecision` | 詳情應顯示付款當時 snapshot，不用目前設定覆蓋歷史 |
| Logical Payment ID | `purchase.paymentAuthorization.paymentId` | purchase 列表相同資料位於 `authorization.paymentId` |
| 授權 fingerprint／nonce | `paymentAuthorizationHash`、`paymentAuthorization.nonce / typedDataHash` | 與 settlement tx hash 是不同證據 |
| 付款交易 | `purchase.payment.transactionHash` | 可能為 null；pending 不能視為未付或允許重付 |
| 服務報告 | `purchase.delivery.responseBody` | 僅 `delivery.status=DELIVERED` 可取得付費內容 |
| 發票 | `purchase.invoice.status / invoiceNumber / ...` | 使用 `ISSUED_DEMO`，前端目前的 `ISSUED_TEST` 不是此 API enum |
| 三方對帳 | `purchase.reconciliation.status` | `PENDING / MATCHED / MISMATCH` |
| 合約狀態 | `purchase.anchors[]` | 依 `kind=AUTHORIZE / FINALIZE / FAIL` 查找；不要依陣列 index |
| Explorer 連結 | `purchase.explorerLinks.payment / anchor` 加 `/tx/:hash` | 回傳的是各自 explorer base URL；mock／local 可為 null，不能拼假遠端連結 |
| 稽核時間與事件 | `timeline[].createdAt / sequence / eventType / payload` | 不使用固定 17:03、17:04；支付及 invoice 是各自事件 |
| footer 更新時間 | `task.updatedAt` 或 health `checkedAt` | 時間為 ISO string，由 UI 格式化 |
| 系統環境 | health 的 `modes`；purchase 詳情的歷史 `modes` | 分別標示 payment、invoice、anchor，不能用單一 SANDBOX 字串代表全部 |

Policy 寫入 body：

```json
{
  "perTxLimitAtomic": "100000",
  "dailyLimitAtomic": "1000000",
  "requireTwInvoice": true,
  "allowedNetworks": ["eip155:84532"],
  "allowedTokens": [{
    "symbol": "USDC",
    "address": "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
    "decimals": 6
  }],
  "allowedSellerIds": ["seller-a", "seller-b"]
}
```

`version` 由後端管理。以上皆為 atomic-unit 整數字串；不要用 JavaScript 浮點數處理帳務加總。回傳的資料庫 bigint、block number 與 audit sequence 也使用字串。

## 六步進度與終止狀態

API 沒有單一 `stage` 欄位。建議由 task status 推導進度位置，同時獨立呈現各證據狀態。

| UI 步驟 | 對應 task status | 呈現規則 |
| --- | --- | --- |
| 1 任務受理 | `CREATED, PARSING` | 已受理／解析中 |
| 2 供應商比較 | `DISCOVERING, EVALUATING` | 顯示實際 candidates 與 reason codes |
| 3 政策檢核／付款前授權 | `AUTH_ANCHOR_PENDING` | Policy 已核准，但 authorization anchor 尚未確認 |
| 4 付款驗證／交付 | `PAYING, DELIVERING` | payment 與 delivery 各自顯示，不能假設一起完成 |
| 5 發票對帳 | `INVOICING, RECONCILING` | 發票及 reconciliation 各自顯示 |
| 6 完成歸檔 | `FINAL_ANCHOR_PENDING, COMPLETED` | 前者仍在等待 anchor，只有後者能標為完全完成 |
| 拒絕 | `REJECTED` | 顯示原因，停止輪詢；不能一律假設沒有 purchase |
| 需人工處理 | `ACTION_REQUIRED` | 停止一般輪詢，保留已付款證據，依 availableActions 提供恢復 |
| 失敗 | `FAILED` | 顯示 error／timeline；不要自動建立另一筆採購 |

付款可能是 `NOT_STARTED / AUTHORIZED / SETTLEMENT_PENDING / SETTLED / FAILED`；交付是 `PENDING / DELIVERED / FAILED`。發票可能是 `NOT_REQUIRED / PENDING / ISSUED_DEMO / ISSUED_STAGE / FAILED_RETRYABLE / FAILED_FINAL`，但本次實作只會由 mock adapter 開出 `ISSUED_DEMO`。

Anchor 是 `NOT_STARTED / PENDING / SUBMITTED / CONFIRMED / FAILED_RETRYABLE`。完成條件不要只看 reconciliation=MATCHED，仍須以 task/purchase 的最終狀態判定。

## 已存在的特殊操作與缺口

| 現有 Demo 操作 | 後端目前能力 | 建議下一步 |
| --- | --- | --- |
| 「測試 0.03 預算」 | 有 | 用明確包含 0.03 USDC 的 prompt 建新 task；測試 API 真正拒絕，不只改畫面 budget |
| 「模擬財務 Agent 重複下單」 | 僅同一 task 的冪等重跑 | 對既有 task 再 POST run；已完成回 200 同一 task，不建立新 settlement。另開新 task 不屬於此保證；跨 Agent 業務去重需要新規格 |
| 「凍結所有新付款」 | 沒有全域 freeze endpoint／資料模型 | 先定義權限、待執行／已授權付款邊界，再做 server-side gate；不能只禁用按鈕就宣稱已凍結 |
| 「測試 payTo 不符」 | Policy/live terms 已有比對 | 使用隔離的測試 seller fixture；目前沒有面向 UI 的注入 endpoint。錯誤可能出現在 validation 或 policy，需讀取實際 error/reason |
| 「超過 0.08 先問我」 | 沒有人工審批 API 或 approval state | demo parser 將每個明確 USDC 金額視為上限並取最小值，即 0.08；不會進入等待核准 |
| 「重置 Demo」 | 有破壞本地 demo data 的 admin endpoint | 區分「清空這個畫面」與「清除後端所有 demo records」；資料庫重置不是 setState |
| 發票失敗後重試 | 有專用 invoice retry | 只在 `availableActions.retryInvoice` 為 true 時顯示；重試後輪詢，不重送整個 task |
| settlement 回應不確定 | 僅已有 tx hash 時可 reconcile | 看 `availableActions.reconcilePayment`；沒有 hash 的狀態需保留處理，不是可直接重新付款 |

### Prompt 與展示公司的差異

現有長 prompt 寫「晨光貿易」、「青葉電子 53887711」、「超過 0.08 先問我」，目前 demo parser 不會完整理解所有資訊。它從 company profile 讀 buyer 統編及成本中心，從明確金額取最小預算；公司目標若未符合有限句型會回 `Example Co.` 並標記 `intent.usedDemoDefaultTarget=true`。

下一步建議先使用明確句型，例如「幫我買一份 晨光貿易 的信用報告，預算 0.08 USDC，要開統編發票。」公司名稱／統編由 Settings 讀取與更新，統編需要通過八碼 checksum。若產品需要保留自然語言的審批門檻、申請人與截止時間，應擴充 request schema／workflow，而不是只改前端文案。

### 輪詢與錯誤

1. `POST /tasks` 保存 taskId。
2. `POST /tasks/:taskId/run` 收到 202 後，以約 0.5–1 秒間隔 `GET /tasks/:taskId`。
3. 終態為 `COMPLETED / REJECTED / ACTION_REQUIRED / FAILED`。頁面卸載取消輪詢，reload 時以保存的 taskId 回復查詢。
4. Network timeout 不代表伺服器未執行；先 GET 既有 task 狀態。POST create 的回應若遺失，目前沒有 client request idempotency key，需從 task list 找回。
5. 專用 retry 接受 202 後重新輪詢。收到 409 先刷新狀態，不盲目重送。

統一錯誤 envelope：

```json
{
  "error": {
    "code": "TASK_ALREADY_RUNNING",
    "message": "Task is already running",
    "retryable": false,
    "details": null,
    "requestId": "..."
  }
}
```

HTTP error 不一定代表 task 已失敗；task 的持久化失敗另見 `task.error`。前端應保留 requestId 供除錯；不得顯示、記錄或傳遞 API secret、wallet private key、完整付款簽章。

## 前端接線建議順序

先接 Settings／health 的讀取與真實公司／supplier 資料，再接 create → run → polling → payment/delivery/invoice/anchor 證據，接著是 invoice/anchor retry 與實際事件列表。確認這些狀態後，再討論 freeze、跨 Agent 去重與人工審批三項產品擴充。合約不要求前端連錢包，現行簽章與 gas 操作由後端負責。

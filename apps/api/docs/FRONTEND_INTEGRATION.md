# Next.js 前端串接交接

本文件對照現有 `apps/web/src/components/mello-console.tsx` 與 `apps/api`。前端已接線，沿用原有視覺；資料、狀態及證據改由後端提供。

## 整合方式

保留 main 的新版採購工作區、品牌與獨立 `apps/docs`；根路徑直接進入 `/app`，不恢復舊官網或六格 Demo 控制台。`lib/core-api.ts` 統一 HTTP／錯誤與 JSON DTO，`lib/task-input.ts` 管理待確認請求的格式與精確金額轉換；`components/workspace/session.tsx` 管理登入，`shared.tsx` 提供可取消的案件輪詢，`pages.tsx` 與 `task-detail.tsx` 對應新版操作頁面。

```text
Next.js Client Component
  → 同 origin /api/v1/*（session 驗證 + allowlist Route Handler BFF）
  → apps/api 的 Express /api/v1/*
  → PostgreSQL + durable worker + Seller A/B
  → x402 facilitator / Base Sepolia（啟用時）
```

API 是持續運行的 Node.js service，與 Next.js 各自部署。BFF 先驗證 12 小時 HttpOnly、SameSite=Strict 的 HMAC session；production cookie 加 Secure。寫入須同 origin。通過後才補後端 API key，核准／凍結／設定／reconciliation 另補 admin token。所有登入使用者目前共享單一 demo 操作員權限，不是正式多租戶或職務分權系統。

Next.js server env 設定 `CORE_API_URL`、`API_ACCESS_TOKEN`、`DEMO_ADMIN_TOKEN`、`MELLO_ACCESS_CODE`、`MELLO_SESSION_SECRET` 與 `WEB_PUBLIC_URL`，見 `apps/web/.env.example`。不使用 `NEXT_PUBLIC_*` 秘密，不讓 frontend import Prisma、wallet 或 API 的 `src/shared` barrel。Railway 上 BFF 使用私有網路連 API。

## Endpoint 對照

下列路徑都加上 `/api/v1`。ID 使用後端回傳 UUID，不使用畫面上的 `PI-...` 或 `pay_mello_001` 字串代替。

| 畫面／操作 | Endpoint | 請求／回應重點 |
| --- | --- | --- |
| 初始載入公司、政策、供應商 | `GET /settings` | `{ company, policy, sellers, services }` |
| 工作區登入／登出 | `/api/session` 的 GET / POST / DELETE（不加 v1） | POST `{ code }`；登入失效回登入畫面，保留當前案件 URL |
| 儀表板／採購紀錄摘要 | `GET /dashboard/summary` | `counts, taskStatuses, purchaseStatuses, settledAmountAtomic, recentPurchases, modes` |
| 系統狀態 | `GET /demo/health` | `status, checkedAt, modes, checks`；即使 degraded 也可回 HTTP 200 |
| 開立採購任務 | `POST /tasks` | `{ prompt, requestKey?, approvalLimitAtomic?, expectedPayTo? }`；新任務 201，相同 key 與內容回 200 同一 task、`deduplicated=true`；不同內容回 409 |
| 人工核准 | `POST /tasks/:taskId/approve` | admin；只允許 APPROVAL_REQUIRED，核准綁定完整報價，202 後重新輪詢 |
| 新付款凍結 | `GET /controls`、`PUT /controls` | PUT 為 admin、body `{ paymentsFrozen: boolean }`；PostgreSQL 持久化 |
| 執行任務 | `POST /tasks/:taskId/run` | 無 body；一般 202 排入 worker，已完成案件冪等重跑可回 200，不新增付款 |
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

Invoice retry、anchor retry、payment reconciliation 亦提供 `/tasks/:taskId/...` 的別名。設定 API_ACCESS_TOKEN 後所有 API 需要 `x-mello-api-key`；production 強制要求設定。Admin 操作另需 `x-demo-admin-token`。Browser 由 BFF 補齊，不接觸這些秘密。無效 token 回 401；不存在資源回 404；重複執行中／狀態不允許通常回 409。BFF 不開放 demo reset。

## 畫面欄位對照

| 現有畫面資料 | API 來源 | 串接注意事項 |
| --- | --- | --- |
| 公司名稱、統編、成本中心 | `settings.company.legalName / businessId / defaultCostCenter` | 使用真實 profile；歷史採購／發票保留原始證據 |
| 申請人、截止時間 | 尚無對應欄位 | 不顯示虛構人名或截止時間；需另建 actor／deadline model |
| 採購需求 | `task.prompt` | prompt 3–2000 字；其他可選控制欄位見 POST /tasks |
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

## 案件狀態與終止狀態

API 沒有單一 `stage` 欄位。新版案件詳情呈現狀態標記與申請／供應商政策／付款對帳／活動紀錄分頁；下表為業務階段對照，不代表 UI 有六格進度面板。

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

## 特殊操作與安全邊界

 | 現有 Demo 操作 | 後端目前能力 | 建議下一步 |
| --- | --- | --- |
| 新申請的預算欄位 | 後端政策檢查 | 0.03 USDC 低預算會真實拒絕，不只改畫面 budget |
| 「找回原申請」 | 持久化 request key 去重 | 相同 key 必須代表同一業務請求；新 key 的相似 prompt 仍是新採購，不宣稱語意去重 |
| 政策頁「凍結新付款」 | 全域 server-side gate | 凍結拒絕新任務及尚未放行的付款；已取得 payment-release permit 的在途付款仍可能結算 |
| 付款前控制「限定收款地址」 | expectedPayTo 控制與 live terms 比對 | 不符時在 purchase／簽章前拒絕；不變更 seller registry |
| 付款前控制「人工核准門檻」 | 人工審批 API 與持久化條款 hash | 超過門檻回 ACTION_REQUIRED / APPROVAL_REQUIRED，purchase=null；案件中確認報價後核准；變更條款須再核准 |
| 返回採購清單 | 保留既有案件 | 新版沒有 Demo 重置按鈕；遠端 BFF 不代理破壞性 reset |
| 發票失敗後重試 | 有專用 invoice retry | 只在 `availableActions.retryInvoice` 為 true 時顯示；重試後輪詢，不重送整個 task |
| settlement 回應不確定 | 僅已有 tx hash 時可 reconcile | 看 `availableActions.reconcilePayment`；沒有 hash 的狀態需保留處理，不是可直接重新付款 |

### Prompt 與展示公司的差異

Demo parser 從 company profile 讀 buyer 統編及成本中心，支援現有「出貨給晨光貿易」句型；無法識別時回 `Example Co.` 並標記 `intent.usedDemoDefaultTarget=true`。明確「超過 X USDC 先問我／需要核准」由 controls 解析為審批門檻，不再錯當採購預算。其他模糊或衝突金額仍保守取最小值。

建議明確句型：「幫我買一份 晨光貿易 的信用報告，預算 0.10 USDC，要開統編發票。超過 0.03 USDC 先問我。」可走人工核准 demo。統編需要八碼 checksum；任意自然語言不是保證可理解的設定介面。

### 輪詢與錯誤

1. `POST /tasks` 保存 taskId。
2. `POST /tasks/:taskId/run` 收到 202 後，以約 0.5–1 秒間隔 `GET /tasks/:taskId`。
3. 終態為 `COMPLETED / REJECTED / ACTION_REQUIRED / FAILED`。頁面卸載取消輪詢，reload 時以保存的 taskId 回復查詢。
4. Network timeout 不代表伺服器未執行；先 GET 既有 task。前端在 localStorage 保存 pending request key，POST create 回應遺失時以相同 key 恢復，不產生第二筆付款。
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

## 後續討論

以上流程已接線；後續產品化需補多租戶與職務分權、SSO／持久化登入限流、正式發票 adapter，以及跨 Agent 共用業務 key 的協議。合約保留根目錄 contracts/，不要求前端連錢包，簽章與 gas 操作由後端負責。

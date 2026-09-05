# Bazaar 採購 Demo：啟用前檢查與時間基線

檢查日期：2026-09-05 至 2026-09-06（Asia/Taipei）。初始採樣 09-05 22:15；
新錢包離線驗證 23:01、發票重試 23:50 完成；線上換址與恢復付款於
09-06 00:07 查驗完成。各段保留當時狀態，不代表先前阻擋仍未解除。

使用者已選定 Bazaar → Mello Registry → Enterprise Policy → 內部採購授權
→ x402 → Base Sepolia → Demo 報告／Mock 發票 → 對帳與稽核的流程。
本文件是啟用前檢查，不是新路徑已驗收完成的證明。

## 線上狀態基線（22:15）

- 既有 Railway mello / production 服務部署皆為 SUCCESS；API、資料庫維持私有。
- 公開 Seller A／B 都出現在 Mello 的 CDP Bazaar discovery，完整 binding 相符。
- 兩個服務仍為 UNREVIEWED，SERVICE_DISCOVERY_MODE 仍為 local_demo。
- payment=x402、anchor=onchain、agent=demo、invoice=mock；不允許 off-chain
  authorization fallback，Mock 發票首次失敗仍啟用。
- 10 個既有任務均已結案，6 筆採購完成；沒有在途任務，付款凍結為 false。
- Buyer 餘額 0.41 Test USDC；本次沒有建立採購、付款、簽章、認證或新部署。

## 舊收款地址的證據缺口與原因

Registry 的人工範圍審核要求 ENDPOINT_CONTROL 與 PAYMENT_WALLET_CONTROL；
Seller B 另需 DEMO_INVOICE_INTEGRATION。不能把「有收過測試款」等同於
「已證明能控制收款錢包」，也不能把 Demo 發票介接當成正式發票資格。

| 服務 | 現有收款地址 | 查驗結果 |
| --- | --- | --- |
| Seller A | 0x7C17F92a2686d2ee708F711e961675b8fB4Bd2C0 | 目前 CDP 專案 getAccount 回傳 404 |
| Seller B | 0xc7f80159aEe4fEe2b4C53FfC068B0AB123a5eB36 | 目前 CDP 專案 getAccount 回傳 404 |

後續回查 12:14 的原始建立紀錄，確認當時在本地直接呼叫
`privateKeyToAccount(generatePrivateKey()).address` 產生兩個 Seller 地址，
但只保存地址，沒有保存 Seller 私鑰。Buyer 與 Operator 的私鑰則有保存且
地址比對成功。這是先前建立步驟的疏漏，不是使用者漏放 keystore。
目前沒有找到 Seller 私鑰復原材料；22:37 的唯讀 RPC 查驗顯示，舊地址
分別有 0.04、0.55 Test USDC，合計 0.59 Test USDC 目前無法取回。

因此尚未簽發認證，也未切換 Bazaar 採購，避免在證據不足時標成 VERIFIED。
現有端點、收款人、政策、歷史案件與付款 hash 均未更動。

## 新 Seller 錢包已建立（22:59–23:01）

使用者另行核准的範圍只有重建並保存兩個本地 Seller 測試錢包；不是變更
線上收款地址或新增付款的授權。本次沒有呼叫 RPC／CDP、改部署或更換 .env。

| Seller | 新地址 | 離線控制權檢查 |
| --- | --- | --- |
| A | 0xeD6C588900675849e43DFabd12Fad227F21a5E8E | 私鑰磁碟讀回、備份比對、簽名及地址復原通過 |
| B | 0x9e82d7Af834AaCC4777cAf6b00b4104cb661c5a8 | 私鑰磁碟讀回、備份比對、簽名及地址復原通過 |

保存根目錄為 `/home/kuoba123/.local/share/mello/wallets/base-sepolia`，在
兩個專案工作區之外，不會隨 Git 或專案部署上傳。

- 主檔：`seller-a.wallet.json`、`seller-b.wallet.json`。
- 本機副本：`backups/` 內的同名檔；它不是異機或離線備份。
- 非付款用的 EIP-191 控制權證明：`proofs/` 內各 Seller 的 control-proof JSON。
- 不含私鑰的索引：`sellers.public.json`。
- 專用目錄 0700、所有檔案 0600，owner 為目前使用者；金鑰是受檔案權限
  保護的明文 JSON，不是密碼加密 keystore，不保證防護同一帳號遭入侵。

先排他寫入、fsync、不可覆蓋地發布，再由磁碟讀回金鑰完成離線簽名與地址
復原；公開報告不輸出私鑰、助記詞或簽章。控制權證明明示僅驗證持有私鑰，
不是付款、登入或商家身分認證，不能直接把 Registry 標成 VERIFIED。

離線防護測試 8 項通過。實際建立後另以禁用 fetch 的程序重跑，確認 A／B
都為 reused，兩把金鑰、備份、證明及公開索引的位元組均未改變。

本地工具為 integration 工作區內的 `.railway/rebuild-seller-wallets.mjs`；
該路徑由 Git 忽略。再次執行只驗證／復用，不覆蓋、不靜默更換已發布地址。
若強制終止留下 `.setup.lock` 或發布途中留下暫存硬連結，工具會拒絕繼續；
須人工核對沒有執行中的程序及檔案身分後處理，不能直接刪除金鑰或重建。

使用者後續已核准採用新地址及更新 Seller／Registry；付款仍須另行確認。
切換前發現新案件尚未結案，實際切換狀態如下；尚未跑新路徑驗收。

## 收款地址切換準備與暫停原因（23:25–23:32）

本機已新增預設關閉的 `db:rotate-seller-wallets`，接在 API `db:prepare`
之後；只有 `MELLO_ROTATE_SELLER_WALLETS=true` 才執行。部署前需要明確提供
`SELLER_A/B_PREVIOUS_PAY_TO`、`SELLER_A/B_PAY_TO`、`SELLER_A/B_URL`。

- 固定核對既有 A/B service/seller、POST 公開端點、0.04/0.05 Test USDC、
  Base Sepolia 官方 USDC，以及發票能力未變。
- 同一短交易內檢查付款凍結、在途任務／採購／工作及 Seller settlement，
  整批驗證後才更新 Seller 收款地址，追加 audit；不改歷史案件、發票或認證。
- 重跑已套用的同一批地址不重複更新或追加事件；意外地址／額度／網路則拒絕。
- 修正歷史採購 API 的 `selectedService.payToAddress`，改用 Purchase 已保存
  的地址快照；Registry 查詢仍回當前地址。前端視覺及發票 JSON 不變。

線上唯讀查驗發現，基線已由 10 個任務／6 筆採購增加為 18 個任務／10 筆
採購：9 筆採購完成，另有 4 個 CREATED 申請及下列 ACTION_REQUIRED 案件。

- Purchase：`4dda0a76-550b-4bfc-8385-4d181446c5d0`。
- Task：`bbd806c1-2862-4958-ac5f-50b3db9be208`。
- 付款 SETTLED，transaction
  `0x7ffb33f670a082d688a226ed1d147623035ad983cb624b1ca5aec7f134bf2267`。
- 發票 FAILED_RETRYABLE、attemptCount=1；lastError 明示 Mock 首次失敗。
- `retryInvoice=true`；本次沒有代為重試，也沒有提交任何新付款。

不可先變更收款地址再假設此案能正常重試：現行 invoice preflight 與最終
reconciliation 仍核對即時 Seller 地址；舊付款與新 Registry 地址不同會觸發
對帳保護。發票重試不會重送 USDC 付款，但成功後可能送出 FINALIZE，消耗
Operator 的 Base Sepolia Test ETH gas，需要明確協調後才執行。

依 Railway 部署前查驗及資料庫鎖定檢查，這次沒有設定線上變數、部署服務、
修改 Registry、凍結付款、取消／重設申請或簽發認證；線上仍使用舊收款地址。
Bazaar 新地址索引尚未驗證；原索引付款授權不可重用。

本機完整 API 單元測試及三組相關資料庫整合測試通過，另通過 typecheck、
ESLint。整合測試只使用 loopback 專用 Postgres，錢包／CDP 金鑰不傳入測試。

## 已核准的發票重試完成（23:50）

使用者明確核准只重試上述已付款案件的發票及 FINALIZE，包含測試網 gas，
不授權新增 USDC 付款。執行前記錄付款／授權／交付證據摘要及買方餘額，
暫停新付款；只送出一次 `/purchases/:id/retry-invoice`，再獨立查驗 RPC receipt。

- Purchase 已為 COMPLETED；發票 ISSUED_DEMO、attemptCount=2、lastError=null。
- 對帳 MATCHED；FINALIZE CONFIRMED。
- 原付款 hash、10 筆採購的付款／授權／交付證據均未變；Buyer 仍有
  0.21 Test USDC。四個未執行申請沒有執行、取消或刪除。
- FINALIZE transaction：
  `0xbca092636f04596dd040a736e7e2b834c00680ac0edfd0b0e0216c47d99c076b`。
- RPC 驗證交易 from 為 Operator、to 為既有 Audit Registry、value=0、receipt
  成功；gasUsed=127244。L2 費用 763464000000 wei，RPC 回報 L1 費用
  12397386434 wei，合計 **0.000000775861386434 Test ETH**。

換址檢查新增嚴格限定的未使用草稿例外：僅允許沒有 Purchase、沒有執行／
候選／錯誤紀錄且沒有固定收款人、核准或付款許可的 CREATED 申請；初始
request identity 與 approval limit 可以保留。先取得 workflow queue exclusive
lock，再依序取得 A/B verification 與 payment gate lock；在途工作、付款及
Seller settlement 仍拒絕。整合測試確認草稿、API read models 與歷史證據不變。

本機程式 commit `4f0d112`（分支 `codex/seller-wallet-rotation`），尚未推送或
合併至 GitHub。390 項 API 單元測試、33 項相關資料庫整合測試通過，typecheck
及 ESLint 通過；部署素材由此 commit 的 git archive 建立，不含 .env、.railway
或任何 Seller 私鑰。

## 線上換址與恢復付款完成（09-06 00:07）

Railway project `58411a4f-2dde-47c7-8eb0-ca6566cdc3f7`、production environment
`8110aa67-4c8f-4608-bb6d-8a8c24a17f0c`：

| 服務 | 本次部署 ID | 查驗結果 |
| --- | --- | --- |
| Seller A | `14b80574-4116-4314-a248-8495ff95e45b` | SUCCESS；舊部署 REMOVED |
| Seller B | `f18702bd-de63-48c3-b990-ea5c8d48fb35` | SUCCESS；舊部署 REMOVED |
| API | `84c15b3c-ae54-4968-a485-86430755de58` | SUCCESS；舊 API REMOVED |

兩個公開端點的 402 與 Registry 均回新地址：

- A：`0xeD6C588900675849e43DFabd12Fad227F21a5E8E`，40000 atomic Test USDC。
- B：`0x9e82d7Af834AaCC4777cAf6b00b4104cb661c5a8`，50000 atomic Test USDC。

第一次 API 部署 `870ec16f-3418-4040-b8cd-c4546c4a19e9` 在 pre-deploy 被擋下：
控制稽核顯示付款凍結於 23:53:30 被解除，而換址要求仍保持凍結；當時 Registry
未改、舊 API 仍在服務。告知使用者並恢復凍結後，重新部署同一份程式成功，
沒有移除或放寬此安全條件。

Registry 的兩筆 SERVICE_BINDING_UPDATED 於 00:04:48 原子提交，operation
為 APPROVED_SELLER_WALLET_ROTATION，且 automaticCertification=false、
historicalPurchasesChanged=false；沒有重複事件。換址後比對 10 筆採購的
付款、授權、交付、發票、對帳與 anchor 摘要、四個草稿及公司／政策均未變。
歷史 Purchase 的頂層與 selectedService 收款地址仍是原快照。

`MELLO_ROTATE_SELLER_WALLETS=false` 已讀回確認（skip-deploys，供下一次
pre-deploy 使用）；完成一致性檢查後恢復 paymentsFrozen=false，健康檢查 ok。
Web／Docs／Postgres、合約與 Buyer／Operator 金鑰沒有因這次換址重建。

Bazaar 免費 `/validate`：A/B 均 valid=true、simulation.outcome=accepted。
但 00:05 的完整 binding 搜尋仍是舊地址各 1 筆、新地址各 0 筆，
partialResults=false。`index.active=true` 僅表示既有資源已索引，不能解讀成
新收款地址已刷新。依 [CDP 官方流程](https://docs.cdp.coinbase.com/x402/seller/get-discovered)，
成功結算的付費呼叫會觸發索引；本次沒有做新的索引付款。

因此 Registry 仍 UNREVIEWED、discoveryMode 仍 local_demo，不宣稱 Bazaar
新路徑已驗收。下一步若重做索引：A 0.04 + B 0.05 = **0.09 Test USDC**，
須另行確認新地址及支出；既有付款授權不能重用。商家範圍認證及單次完整
Bazaar 採購驗收仍待後續執行，未對前端視覺做變更。

## 「已取得發票」事件的解讀

`ISSUED_DEMO` 是成功取得 Mock 測試發票，不是付款或開票失敗；`MOCK` 說明
不是正式統一發票。`attempt: 2`、`previousStatus: FAILED_RETRYABLE` 表示
之前模擬失敗、第二次成功。成功交易會清除 Invoice.lastError，再寫入
INVOICE_ISSUED，previousStatus 仍保留作為歷史稽核證據。

目前 API 的 `MOCK_INVOICE_FAIL_ONCE=true`，對每筆採購第一次開票刻意失敗，
因此完成案件常見這種紀錄。前端把 ISSUED_DEMO 與 FAILED_RETRYABLE 共用
warning 色，容易造成誤讀；本次只診斷，不改發票設定、事件內容或 UI。

## 歷史採購耗時基線（不是新 Bazaar 路徑實測）

從既有線上 task timeline 讀取 6 筆完成案件，起點為最後一次 runStartedAt，
終點為 completedAt。有人工核准的案件，起點在核准後；不含核准前等待、填寫
申請或講解時間。總時間包含當時測試操作的發票重試等待。

| Purchase ID | 最後一次執行至完成（秒） | 發票失敗至重試開始（秒） |
| --- | ---: | ---: |
| effdbdad-a8f1-4aa1-b31e-e919ec9c792b | 4.666 | 1.059 |
| c9eee34b-b170-44d0-b008-482984816d8f | 7.646 | 2.072 |
| aad84faa-93bc-4020-ad39-573a0de26256 | 5.861 | 1.825 |
| ab4f3272-319a-44a4-96a4-e7acf667f948 | 6.939 | 1.407 |
| a237503e-862a-47d2-b48e-e380e3eb498c | 5.006 | 0.857 |
| e4c775a1-f541-4f1b-b9bf-745e00e79edb | 7.268 | 1.676 |

- 本次單次唯讀 /registry/discovery 請求約 0.853 秒；不是效能分位數或 SLA。
- 上述採購使用 local_demo discovery，且早於目前公開 Seller rollout，不能直接
  相加後宣稱完整 Bazaar 路徑已有實測結果。
- 同期讀取最近一案的兩筆成功 anchor RPC receipts：合計
  0.000001987508384585 Test ETH（L2 execution 加 RPC 提供的 L1 fee）。
  僅供歷史成本參考，不是下一筆 gas 的保證或支出上限。

## 展示時間暫估

建議完整解說版預留 **3–5 分鐘**，涵蓋申請、A／B 價格與發票條件比較、
Mello 認證／政策原因、授權與付款證據、發票重試、對帳，以及一個不付款的
預算拒絕案例。這是展示排程估計，不是新路徑的系統執行實測。

取得控制權證據後，才完成相應範圍認證、切換 Bazaar 並確認無本地 fallback。
新增端到端驗收預計只購買 Seller B 一次（0.05 Test USDC），另有自有稽核合約
AUTHORIZE／FINALIZE 的測試網 gas；付款前再次確認目標及金額。先前 0.09
Test USDC 的索引付款授權已用完，不可重用。

完整驗收時應另外量測：

1. 送出採購至 Bazaar 發現、認證與政策檢查完成。
2. 實際 402 條款檢查與 AUTHORIZE 上鏈確認。
3. 付款釋出至鏈上付款及報告交付確認。
4. 發票首次失敗、人工操作等待，以及只重試發票的執行時間。
5. 對帳 MATCHED 至 FINALIZE 確認與前端顯示完成。

保留每階段時間、discoveryEvidence、唯一付款交易及兩筆 anchor 證據後，
再提供新路徑的實測時間與建議展示長度。

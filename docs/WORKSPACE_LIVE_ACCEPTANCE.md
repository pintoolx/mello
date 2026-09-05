# 新版工作區部署與 Base Sepolia 實測 — 2026-09-05

已將 PR #2 合併後的企業採購工作區重新部署，保留既有視覺與 PostgreSQL 資料。這是新版 UI 的實際線上驗收，與 [舊版控制台證據](DEMO_ACCEPTANCE.md) 分開保存。

- 主系統：[Railway 工作區](https://web-production-158a1.up.railway.app/app)；沿用私有存取碼，不在文件公開。
- 獨立文件站：[Mello Docs](https://docs-production-8a88.up.railway.app)。無 API、資料庫、session 或錢包秘密，不與主系統交叉導流。
- 部署程式碼：`438c4abb482eca2f2b7737ac5f65f0b990cb18a6`；後續提交只新增／更新驗收文件，不改 runtime。
- [完整機器可讀證據](evidence/base-sepolia-workspace-2026-09-05.json)：部署 IDs、合約建立、付款與存證 hashes、最終餘額與測試結果。

## 實際合約與付款

新合約：[0x4cf30aee920ef8fcb103f442406a33da93e093ce](https://sepolia.basescan.org/address/0x4cf30aee920ef8fcb103f442406a33da93e093ce)。[部署交易](https://sepolia.basescan.org/tx/0x8b172141096bf2b952803d780081a0335584567e9655296942e3e4324e1206da) 在 block `46415089` 成功；RPC 獨立確認 chain ID `84532`、runtime bytecode 與測試 build 完全相同、operator/admin roles 正確。這不是 dry-run，也不是本地 Anvil。

| 案例 | Purchase ID | 實際支出 | 結算交易 |
| --- | --- | --- | --- |
| 建立草稿、送出採購、發票重試 | `aad84faa-93bc-4020-ad39-573a0de26256` | 0.05 Test USDC | [交易 1](https://sepolia.basescan.org/tx/0xff38e2c4805c5a5b5c0fd84d9ee5575ff4fe4fdae412438f0ec4dcf78140296d) |
| 0.03 門檻暫停、人工核准 0.05 報價、發票重試 | `c9eee34b-b170-44d0-b008-482984816d8f` | 0.05 Test USDC | [交易 2](https://sepolia.basescan.org/tx/0x5407fd7fc269d817239ecaab75c51ee747553d9d4c4ee0c029b9a0ed612cdf42) |

只讀驗證器逐筆讀取真實 RPC 收據：官方 Base Sepolia Test USDC 合約各有一次 buyer → 選定 Seller 的 `50000` atomic Transfer。兩筆採購各有 AUTHORIZE 與 FINALIZE，共四筆成功鏈上存證，目標都是新合約；`getPurchase` 均為 `FINALIZED`。Buyer、Seller、代幣、金額、mandate／policy／付款授權／settlement／交付／發票／對帳雜湊皆與後端紀錄相符。驗證器不簽名、不重试付款。

Buyer Test USDC 從 **0.65 → 0.55**，本次正好支出 **0.10 Test USDC**。Operator nonce 從 17 → 22（部署 1 筆＋存證 4 筆），無 pending 交易；總計耗用 `0.000010438020273704` Test ETH，餘額 `0.000061506227877224`。稽核合約 Test USDC 餘額仍為 0，不代收款。

## 部署與資料保留

API、Seller A、Seller B、Web、Docs 的本次指定 deployment IDs 均核對為 `SUCCESS`，不以 upload 成功當成上線成功。API 與 Sellers 維持 private networking；只有 Web、Docs 有公開 domain。

切換前先凍結新付款並確認所有舊任務均已結案，只更新 API 的 registry 地址。既有 Postgres deployment 與 volume 沒有更動；三筆舊採購仍在 DB，舊合約仍可讀到 `FINALIZED`。驗收後共 9 任務、5 筆完成採購；新增兩筆拒絕案件沒有建立採購或付款，**付款凍結已恢復為 false**，完整 dependency health 為 `ok`。

## 驗收結果

| 項目 | 本次結果 |
| --- | --- |
| API 單元測試 | 308 通過 |
| Web request key／金額／輪詢單元測試 | 6 通過 |
| Foundry 合約測試 | 24 通過 |
| 三個 workspace lint／typecheck | 通過 |
| Docs standalone Docker build + 本機 HTTP health | 通過 |
| 本地 mock 新版瀏覽器流程 | 10 組通過 |
| Railway 新版 live 瀏覽器流程 | 10 組通過，0 page errors |
| 375／768／1280 px | 主系統與六個文件頁無水平溢出；人工檢查桌機對帳與手機核准截圖 |
| 秘密實值比對 | 239 個 Git 檔案、12 個線上頁面、16 個 client chunks 無命中 |
| Session | Secure / HttpOnly / Strict、匿名拒絕、CSRF、偽造／過期／超長期限拒絕、登出與重新登入恢復案件通過 |

Live 流程另外覆蓋：草稿不付款、發票重試保留原 purchase/payment/hash、request-key 重放不重付、不同內容回傳 409、付款凍結持久化、建立回應遺失後找回原單、低預算拒絕、錯收款地址拒絕、人工核准前不建立付款。Live journal 已完成，不能直接重跑產生新支出。

完整瀏覽器報告與截圖保存在 `/tmp/mello-workspace-live/`；暫存檔可能被系統清理，必要的公開鏈上證據已另存本 repo。重現方式與當次支出批准要求見 [部署說明](RAILWAY.md#explicitly-approved-live-acceptance)。

## 真實測試網與 Demo 邊界

付款模式為 `x402`、存證為 `onchain`，`DEMO_ALLOW_OFFCHAIN_AUTH=false`；Agent 為 `demo`、信用報告是示範資料、發票為 `mock / ISSUED_DEMO`。`MOCK_INVOICE_FAIL_ONCE=true` 刻意展示發票失敗後只重試開票，不重複付款。

鏈上存證證明這組資料雜湊被記錄，**不代表報告經正式徵信，也不代表發票具財政部認證或正式效力**。目前仍是單公司共享存取碼的測試網 MVP，尚非多租戶、正式財務分权或 mainnet 產品。

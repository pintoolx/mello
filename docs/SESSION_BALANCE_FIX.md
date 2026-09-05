# 工作區切頁與餘額修正（2026-09-06）

本輪只變更 Web；服務／供應商重新命名仍在討論，沒有修改 Registry、
服務認證、付款設定、既有採購或後端部署。

## 切頁認證

原本 `/app` 與 `/app/[...path]` 的 page 都建立 `MelloConsole`，其內含
`SessionGate`，跨 page 切換因此重新掛載登入檢查並顯示認證畫面。
現在 `SessionGate` 放在共同的 `/app/layout.tsx`，路由切換保留登入狀態；
各頁資料仍會重新讀取。沒有用 localStorage 偽造登入，也沒有更動
HttpOnly cookie、Origin 驗證或 API 401 失效處理。

本機 `apps/web/scripts/session-navigation.py` 使用隔離伺服器及測試 session：
375／768／1280 px、六個導覽頁、上一頁／下一頁的額外 session GET 與
認證畫面閃回均為 0；重整、新分頁、登出及清除 cookie 後的真實 401
行為通過。12 個單元測試、typecheck、lint 及 production build 通過。

## 餘額與補充測試 USDC

- 設定頁 `Credit` 改為「餘額」，保留原本鏈上金額查詢與六位精度。
- `Top up` 移除 Mock 標籤，但仍如實提示按鈕未接線、不會發送交易。
- 餘額區標示 Base Sepolia 測試網；不把測試資產當成主網資產。
- 操作者另以官方 CDP faucet 單次補充 1 Test USDC，並非由按鈕觸發。

2026-09-06 02:30:39（Asia/Taipei）已查驗交易成功：

- Buyer：`0xb2CeD43A1b2f80Cc2ae487a7e7927b9000FADe02`，與 live health 相同。
- 官方 USDC：`0x036CbD53842c5426634e7929541eC2318f3dCF7e`，chain 84532。
- [Faucet 交易](https://sepolia.basescan.org/tx/0x2012054e334a7161eb1714b2ccb227d81e4bb061c5fcfd299b7696351df99669)，block 46432374。
- 唯一對 Buyer 的 USDC Transfer 為 1,000,000 atomic，該 receipt 無 Buyer 扣款。
- 餘額由 0.12 → 1.12 Test USDC，RPC 與 live `/demo/health` 一致。
- 獨立覆核時已有 31 confirmations。未進行採購、付款或合約寫入。

以 0.05 Test USDC 單價計，餘額可支付 22 次服務費；不包含合約 operator gas，
也不是任何後續採購的自動付款授權。Faucet 使用持久化提交 marker、固定
idempotency key 及一次 HTTP 呼叫，沒有付款簽章或自動重試。

## Web 發布

基於目前已合併的 `9b3eda1`，只上傳此工作樹的 Web 修正至 Railway Web
服務。Deployment `d6b8f803-b865-49c5-8db5-112bf954a498` 已 SUCCESS，
前一個 Web deployment 已 REMOVED；本輪沒有更新環境變數或推送 GitHub。
線上瀏覽器驗收結果另記於本段下方，不能只以部署 SUCCESS 代替功能驗收。

第一輪線上驗收於 02:37 開始，6 組檢查全部通過：三種寬度六頁往返與
瀏覽歷史操作無登入閃回、無額外 session GET；餘額顯示 1.12，Top up
不帶 Mock 且沒有發送業務請求；重整／登出與既有資料快照一致。
證據位於 ignored `.railway/session-balance-live-20260906/20260905T183736.016145Z/`。

## 追加：自動更新取代手動刷新

使用者另要求移除各頁「重新讀取／重新整理」。一般列表、付款、發票、政策、
稽核、案件詳情、設定及讀取錯誤畫面不再提供一般刷新按鈕。

- 一般資料成功讀取後每 15 秒更新；昂貴的 health／鏈上餘額檢查每 60 秒。
- 處理中案件仍使用約 1.2 秒的快速狀態讀取，保留送出操作後的 revision 防護。
- 視窗重新取得焦點、分頁恢復可見或網路恢復時立即讀取；隱藏／離線暫停排程。
- 同一資源不並行請求；操作後需要刷新時，最多排一個後續 GET。
- 讀取失敗保留上次資料並退避重試，最長間隔 120 秒；401 不重試，回到登入。
- 一般背景更新不清空畫面或未儲存表單；切換路徑／卸載會取消舊請求。
- 登入環境讀取失敗或尚未配置時自動重查；正常登入不因切頁再做 session GET。

以上只會讀取，沒有自動重新執行採購、付款、開票、探索服務或儲存表單。
錯誤提示會說明自動重試讀取；業務操作本身的明確確認／重試仍保留。

追加修正的 20 個單元測試、lint、typecheck 與 production build 均通過。
`apps/web/scripts/resource-refresh.py` 在隔離的本機伺服器以瀏覽器時間控制驗證：
15 秒讀取會呈現新資料、health 為 60 秒、隱藏／離線 120 秒沒有額外請求、
恢復連線立即讀取、focus storm 不造成重疊請求、503 後保留舊資料並自動恢復。
另驗證登入 GET 暫時失敗／尚未配置會自行恢復，正常登入後沒有額外 session GET；
設定頁未儲存的草稿保留，沒有任何自動 POST 或 PUT。

設定表單仍保留進頁時的編輯快照，避免背景 GET 改寫輸入內容；公司側欄資訊
會自動更新。表單本身要重新進頁才載入其他使用者的變更，沒有在本輪新增
跨使用者的表單合併或衝突解決機制。

追加修正已部署至 Web：`436b87b1-422b-48a5-8b7d-d5908ed558e4`，
2026-09-06 02:52:55 確認 SUCCESS，前版 `d6b8f803` 已 REMOVED。
API 仍為 `7249e8a8-d4fe-477a-9a4a-b319eeb4d78f`，未變更任何環境變數。

第二輪第一趟線上 QA 在 768 px 的餘額檢查遇到 `InvalidOperation`：
腳本把 `aria-busy=false` 誤當成已取得可解析的餘額。當下的 browser health
回應沒有留存，因此不能由此斷言 RPC 故障來源。獨立的 768 px 唯讀重查
已確認 UI 1.12、browser health 200、chain／wallet 均正常，沒有業務寫入。
QA 改成等精確數值及非 loading 狀態穩定 500 ms，最多容許一次 60 秒的
health 自動更新；仍保留 atomic `1120000`、登入與完整業務快照的精確檢查。
原失敗報告保留於 ignored `20260905T185203.763002Z/report.json`，不覆寫。

接著 `20260905T185537.571559Z/report.json` 的完整重跑捕捉到 health HTTP 200，
但 `baseRpc`／`buyerWallet` 檢查實際退化且無可用餘額。程式檢查發現跨 root／
catch-all route 仍會重建 `Workspace`，連帶重啟 settings、controls 與 health
三組查詢；一次 health 本身又會探測多個鏈上與外部服務。不能僅靠放寬 QA
等待解決這個額外查詢問題，也不能由退化摘要直接斷言為 RPC 限流。

因此追加將整個共用 `MelloConsole` 移入 `/app/layout.tsx` 的 `SessionGate`，
兩個 route page 只提供空路由 slot。共用查詢跨頁保留，內容區仍以 pathname
作為 key，因此個別頁面資料照常重新讀取；登出／401 仍卸載工作區及所有排程。

此共用殼修正的隔離瀏覽器測試亦通過：375／768／1280 px 六頁導覽與上一頁／
下一頁，不含正常定時更新的 route-induced session／settings／controls／health
新增 GET 均為 0；回列表及重新登入仍讀取新資料。登出與 401 後各推進
120 秒均無共用 GET。20 個單元測試、lint、typecheck、production build 再次通過。

最終共用殼補修 Web deployment 為 `6f5f5b71-5383-46d8-a1b2-2095c7946931`，
2026-09-06 03:06:05 確認 SUCCESS，前版 `436b87b1` 已 REMOVED。
本輪仍僅部署 Web，不修改後端服務、環境變數或 GitHub 分支。

最終線上 QA 於 03:06 開始，8 組檢查全部通過：375／768／1280 px 六頁
往返與瀏覽歷史操作，session 閃回／額外 session GET／額外 health GET 均為 0。
每組導覽的 protected GET 為 10（前版第一組為 52），個別頁仍正常取資料。
一般刷新按鈕全部不存在；同頁靜置 18 秒與 focus 都觀測到成功的自動 GET，
沒有額外登入檢查。三種尺寸餘額均精確為 1.12 Test USDC；Top up 只顯示
未開放提示，沒有業務請求。重整、登出、未登入 GET 401 均通過。

25 筆任務、10 筆採購及付款控制的完整 canonical 快照，導覽前後與重整後
完全一致；0 業務寫入、0 browser page errors。完整報告與遮蔽存取碼的截圖
位於 ignored `.railway/session-balance-live-20260906/20260905T190619.627462Z/`。

## PR 同步至最新 main

上述為手動 Web 發布階段的證據，當時尚未提交 GitHub。使用者後續明確同意
建立 PR 並於 CI 通過後合併；此 PR 另以最新 `main` 的 `a25f469` 為基底，
保留 `77afecb`／`a25f469` 的新版側欄、公司識別、獨立供應商頁及合併的
「付款與憑證」頁，沒有還原這兩筆既有改版。

合併時保留本輪持久化 SessionGate／Workspace、自動 GET 更新及餘額文案；
新供應商頁的一般刷新按鈕也移除。瀏覽器回歸腳本改用 records／vendors 導覽
及設定頁的公司識別欄位，原三種尺寸、未存草稿、401／登出及零業務寫入
檢查仍保留。前文的線上截圖對應先前手動部署，不是這次整合版的線上證據。

Railway 唯讀檢查顯示所有應用服務的 source.repo 均為 null；GitHub workflow
只做隔離 mock CI，未配置部署步驟，因此本次 push／merge 不會自行發布整合版。
本次 PR 不執行額外部署、充值、採購或資料庫變更。

整合後兩套本機瀏覽器回歸在 375／768／1280 px 均通過：新版六導航與側欄
收合跨頁保持、無一般刷新按鈕、無導覽觸發的 session／共用 GET、登出與
401 清理、15 秒／60 秒自動更新、公司識別更新且不覆蓋未存草稿，0 業務寫入。
另已重新執行 Web 的 20 個單元測試、lint、typecheck 與 production build，全部通過。

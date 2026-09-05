# 公司與發票設定

登入主系統後，從側邊導覽開啟「設定」：`/app/settings`。

- 公司基本資訊：法定名稱、統一編號、財務 Email、預設成本中心、聯絡人、電話及地址。
- 開立發票資訊：抬頭與統編沿用公司資料；可另填發票收件 Email 與地址，留白則分別沿用財務 Email 和公司地址。
- 餘額：顯示查詢到的 USDC 餘額，標示 Base Sepolia 測試網。Top up 按鈕不附 Mock 字樣；目前只提示「加值功能尚未開放，本次未發送交易」，不修改餘額或送出加值請求。

表單提供儲存、取消、未儲存提示及儲存失敗回饋。資料取自 PostgreSQL，透過既有 `PUT /api/v1/company` 一次保存所有公司與發票欄位。Next.js 代理沿用登入、同源寫入檢查及伺服器端 admin token；憑證不送到瀏覽器。舊 API 客戶端省略新增欄位時，保留原有值。

餘額取自 `GET /api/v1/demo/health`。僅在 x402 模式、Base Sepolia 網路確認及買方錢包查詢成功時顯示餘額；模擬模式、查詢失敗或資料缺漏顯示 `— USDC`，不以假零代替。金額使用原子單位字串換算，保留 USDC 的六位精度。操作者另行透過官方 faucet 補充測試 USDC，與尚未接線的 Top up 按鈕是不同操作；收到鏈上確認才算充值成功。

新採購建立時會保存公司發票資料快照，開立、重試及對帳使用同一份資料；之後修改公司名稱、統編或收件資訊不會改變歷史發票。案件的「付款與對帳」頁面可查看當時的抬頭與收件資料。歷史採購沒有快照時，不用現今公司資料回填。

目前發票仍為測試介接，不是正式統一發票，也不實際寄送 Email。統編依[財政部新制檢核規則](https://www.fia.gov.tw/singlehtml/3?cntId=c4d9cff38c8642ef8872774ee9987283)檢查格式與檢查碼，並不等於查驗公司登記。

## 更新既有環境

Migration `20260906010000_company_invoice_settings` 新增五個公司欄位及 nullable 採購發票快照，不回填歷史資料。

```bash
npm run db:generate --workspace @mello/api
npm run db:migrate
```

Railway 沿用既有 API pre-deploy `db:prepare`，先套用 migration 再啟動新版本。無須重新執行會覆寫公司資料的 Demo seed。

## 驗證

```bash
npm run lint
npm run typecheck
npm test
npm run build
# 依 README 使用獨立且已遷移的本機測試資料庫：
npm run test:integration --workspace @mello/api -- src/http/settings.integration.test.ts src/modules/purchases/invoice-retry.integration.test.ts
```

整合測試涵蓋設定讀寫、保留省略欄位、無效資料不部分寫入，以及修改公司資訊後發票重試仍使用原快照且不重付。

瀏覽器驗證涵蓋實際 API 儲存與重載、取消、背景讀取不清除草稿、Mock Top up 無寫入請求、登入／同源限制，以及 1440 px 與 390 px 無水平溢出。以下截圖來自隔離本機資料庫的測試公司，Credit 在 mock 環境顯示不可用：

[桌面設定頁](screenshots/settings-desktop.png) · [手機設定頁](screenshots/settings-mobile.png) · [Credit 區塊](screenshots/settings-credit.png)

# Bazaar 公開 Seller rollout — 2026-09-05

使用者已同意準備合併與公開 Seller 部署；索引付款需另列目標與金額後確認，
本輪不得執行付款。實作範圍見 [Bazaar 交接](BAZAAR_IMPLEMENTATION.md)。

## 部署前基線

- GitHub：pintoolx/mello，main 起點 2f82f9841ef452cc62e73d9580df508bf806eabf。
- Railway：既有 mello project，production；不新增專案或重建資料庫。
- Web、Docs、API、Seller A／B 與 Postgres 皆為 SUCCESS。Source 未綁 GitHub，
  合併程式碼不會自動切換線上服務，採指定 commit 的手動 deployment。
- 10 個既有任務已為 COMPLETED／REJECTED，6 筆採購全部 COMPLETED。
- Buyer 有 0.50 Test USDC；API 仍為 x402／onchain／demo agent／mock invoice。
- 原付款凍結為 false；部署切換期間可短暫凍結，確認無在途案件後更新 endpoint，
  健康與資料一致再恢復原狀。歷史採購與付款 hash 不變更。
- API 及 Postgres 維持私有；僅 Seller A／B 新增公開 HTTPS，Web／Docs 網址不變。

## 分階段

1. PR 經 CI 通過後合併；不繞過失敗檢查或改變 repository visibility。
2. 公開 Seller 啟用 Bazaar metadata、固定 Demo schema、基本流量／並行限制。
3. API migrate 使用既有 db:prepare，不 seed、不重新部署合約；同步 registry 的
   endpoint，但不自動簽發商家認證、不修改企業 policy。
4. 只做健康、402、schema、CDP validate 與目錄查詢；不送 PAYMENT-SIGNATURE。
5. 前端唯讀驗證：原有案件、付款證據、Demo 發票保留；服務維持未審核。
6. 取得索引付款批准之前，API discovery mode 保持 local_demo，明確顯示尚未
   啟用 Bazaar 採購；不把未收錄服務繞過 Bazaar gate。

## 待確認的索引付款草案

| 目標 | 收款地址 | 每次 Test USDC |
| --- | --- | --- |
| Seller A：信用報告，無發票 | 0x7C17F92a2686d2ee708F711e961675b8fB4Bd2C0 | 0.04 |
| Seller B：信用報告，Demo 發票介接 | 0xc7f80159aEe4fEe2b4C53FfC068B0AB123a5eB36 | 0.05 |

網路 Base Sepolia（eip155:84532），資產為
0x036CbD53842c5426634e7929541eC2318f3dCF7e 的 Test USDC（6 decimals）。
提案上限為兩次、合計 0.09 Test USDC；不是現在的付款授權。完整公開 endpoint
須在部署成功與 402／CDP validation 完成後補入，讓使用者確認。

索引動作應有獨立的 idempotency／交易紀錄，不呼叫一般採購的重跑入口，
不新增合約部署／operator anchor 交易。每個目標至多一次，條款或收款人變更就停止。
未確定結算時先核對既有交易，不能換 payment identifier 盲目重送。

CDP 的公開 validation 不需 API key，也不會完成付款；成功 validation 不等於
已收錄。成功 settled paid call 才會觸發索引，仍須再用目錄結果驗證。
見 [CDP 官方刊登流程](https://docs.cdp.coinbase.com/x402/seller/get-discovered)。

## 部署結果

待本輪指定 deployment IDs 與無付款驗證完成後補入；目前本文件為 rollout 計畫，
不得用它宣稱 Seller 已公開、已認證或已被 Bazaar 收錄。

# Bazaar 公開 Seller rollout — 2026-09-05

本文保留部署與後續索引付款兩階段紀錄。部署階段沒有付款；使用者在確認
Seller A 0.04、Seller B 0.05 Test USDC、各一次、合計上限 0.09 後另行回覆
「好」，付款已依該授權完成。實作範圍見 [Bazaar 交接](BAZAAR_IMPLEMENTATION.md)。

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

既有 Railway 未設定 SSH key；本次不新增帳戶登入金鑰、不公開 API 或 DB。
API 的 db:prepare 加入預設跳過的 db:sync-public-sellers。只有部署當次明確設定
MELLO_SYNC_PUBLIC_SELLER_BINDINGS=true 才執行：檢查付款已凍結、無在途任務／
工作／不確定付款，在同一短 transaction 更新兩個已知 private endpoint，保留
價格、policy、認證及歷史採購。其他舊網址一律拒絕。成功後把開關設回 false，
不自動觸發額外部署；未來正常 db:prepare 不做服務資料同步。

## 索引付款目標與限額

| 目標 | 收款地址 | 每次 Test USDC |
| --- | --- | --- |
| Seller A：信用報告，無發票 | 0x7C17F92a2686d2ee708F711e961675b8fB4Bd2C0 | 0.04 |
| Seller B：信用報告，Demo 發票介接 | 0xc7f80159aEe4fEe2b4C53FfC068B0AB123a5eB36 | 0.05 |

網路 Base Sepolia（eip155:84532），資產為
0x036CbD53842c5426634e7929541eC2318f3dCF7e 的 Test USDC（6 decimals）。
原提案上限為兩次、合計 0.09 Test USDC；使用者後續已明確核准，執行結果見下方。
此授權已用完，不得當成重複付款許可。已驗證的付款目標：

- Seller A：POST https://seller-a-production.up.railway.app/v1/credit-report
- Seller B：POST https://seller-b-production.up.railway.app/v1/credit-report

使用既有 Buyer 0xb2CeD43A1b2f80Cc2ae487a7e7927b9000FADe02，各至多一次。
Seller A 的索引 onboarding 不是企業採購核准；原 policy 的發票要求不變。

索引動作應有獨立的 idempotency／交易紀錄，不呼叫一般採購的重跑入口，
不新增合約部署／operator anchor 交易。每個目標至多一次，條款或收款人變更就停止。
未確定結算時先核對既有交易，不能換 payment identifier 盲目重送。

CDP 的公開 validation 不需 API key，也不會完成付款；成功 validation 不等於
已收錄。成功 settled paid call 才會觸發索引，仍須再用目錄結果驗證。
見 [CDP 官方刊登流程](https://docs.cdp.coinbase.com/x402/seller/get-discovered)。

## 部署結果

2026-09-05 20:27（Asia/Taipei）完成部署與線上唯讀驗證。

- [PR #5](https://github.com/pintoolx/mello/pull/5) 已合併，發布程式碼為
  03ff11acb283af05511e917121548f4d8839ab57。
- [PR CI](https://github.com/pintoolx/mello/actions/runs/33965634140) 通過 lint、
  typecheck、unit、17 項 registry integration 及 build。
- 從該 commit 的 git archive 上傳，僅包含 tracked source；不包含本地環境秘密。
- 依 Railway skill 核對每個指定 deployment ID 的 SUCCESS，不以 detach 上傳
  成功代替上線成功；依 Postgres skill 以短交易、固定鎖順序完成網址同步。

| 服務 | Deployment ID | 結果 |
| --- | --- | --- |
| Seller A | 76cefa9a-9c74-4381-b6f3-64590cb5b2e5 | SUCCESS |
| Seller B | b9684bf0-9162-4e21-838e-fb759eac6d04 | SUCCESS |
| API（私有） | ef993cb0-03e9-46ed-bca7-7b345dd91dab | SUCCESS |
| Web | 9eebb120-945c-42f1-85f9-898da74683b1 | SUCCESS |

Web 維持 https://web-production-158a1.up.railway.app/app；Docs 與 Postgres
沒有重部署，資料 volume 維持 READY。API 沒有公開 domain，未增加 SSH key。

兩個公開 Seller 的 /health 皆為 ok、bazaarEnabled=true；未帶付款簽章的
POST 回傳 402。x402 v2 的 resource URL、POST、network、USDC、amount、payTo
及 Demo input/output metadata 全部符合預期；CDP 免費 validate 皆回傳
valid=true、simulation.outcome=accepted，index=null。沒有付款或索引提交。

兩個 registry endpoint 已原子更新為上述公開網址；沒有 seed 或認證寫入。
兩者仍為 UNREVIEWED，API SERVICE_DISCOVERY_MODE=local_demo；企業 policy v1、
公司資料與價格不變。MELLO_SYNC_PUBLIC_SELLER_BINDINGS 已設回 false，未另外
觸發部署；此變數只由下一次 pre-deploy script 讀取，不影響執行中的 API。

新付款於 20:21:56 暫時凍結，20:26:34 恢復原 false。前後皆為 10 個任務、
6 筆完成採購；比對全部既有付款 hash 與付款／交付／發票／對帳／anchor 資料
digest 一致。Buyer 仍有 500000 atomic（0.50 Test USDC）；operator 原生幣
餘額及既有合約地址不變。沒有新增採購、付款、發票重試或合約交易。

依 webapp-testing skill 完成 5 項線上唯讀檢查：登入與筆數、Bazaar 真實查詢、
既有付款證據、375／768／1280 px 畫面、登出與寫入隔離。無 page error 或被
攔截的寫入。查詢取得 1 筆外部候選，不符合任一已登錄完整 binding；Seller
A／B 的 listed 皆為 false，畫面明確顯示尚未啟用 Bazaar 採購。

本地 API unit 362、Web unit 6、DB integration 52（13 files）通過。Anvil
full-stack 6 案例因現有 stack 不符 onchain preflight 而未執行，不計入通過數。

完整執行證據保留在本地 /tmp/mello-bazaar-public-rollout/：
deployments.json、public-probes.json、baseline.json、frozen-check.json、
after.json、browser-report.json 與響應式截圖。此目錄不提交 secrets 或 session。

上述為 20:27 部署階段的結果，當時尚未取得付款批准。後續執行紀錄如下。

## 已批准的索引付款執行結果

2026-09-05 20:46（Asia/Taipei）完成兩筆獨立 onboarding；只呼叫已公開的
Seller endpoint，沒有透過一般採購重跑、人工核准或補發票入口。

| 目標 | Test USDC | Base Sepolia 交易 | 區塊 |
| --- | ---: | --- | ---: |
| Seller A | 0.04 | [0x6c9e4097…66ec1ed](https://sepolia.basescan.org/tx/0x6c9e40970886ee28a8fa5927f11f7e48d5e7353189f13d29910fa933e66ec1ed) | 46422046 |
| Seller B | 0.05 | [0x2489bec9…0b35914](https://sepolia.basescan.org/tx/0x2489bec99a4117c8061a1d5b6be77bbc388c0bc5dad168b4a9d4bef770b35914) | 46422049 |

每個目標只送出一次付款請求，合計 90000 atomic（0.09 Test USDC）。兩者皆為
HTTP 200、x402 success=true，已收到 isDemo=true 的信用報告。直接查驗鏈上
receipt success、兩個確認、唯一的 USDC Transfer（from／to／amount）以及該
ERC-3009 nonce 的 AuthorizationUsed 與 authorizationState=true。

Buyer 餘額 500000 → 410000 atomic（0.50 → 0.41）；Seller A 0 → 40000，
Seller B 500000 → 550000。沒有 Buyer 原生幣交易，也沒有 operator／合約交易。

執行前再次查驗公開 402 條款及餘額。固定付款識別碼：

- mello_bazaar_20260905_approved_seller_a_once
- mello_bazaar_20260905_approved_seller_b_once

限制網路、Token、收款人、金額、EIP-712 domain 與 300 秒內授權；不允許
Permit2／額外簽署、redirect、付款重試或替代服務。每個不可逆步驟前以 wx、
0600 權限與 fsync 落地標記，既有 batch／submission 會拒絕再次送出；不保存
私鑰、原始授權簽章或 session。相關離線防護測試 8 項通過。

### Bazaar 收錄查驗

20:51 的 CDP 唯讀查驗結果：

- /validate：兩者 valid=true、index.active=true；lastCrawledAt 分別為
  2026-09-05T12:46:20.905Z 與 2026-09-05T12:46:26.864Z。
- /discovery/merchant?payTo=...：兩個收款地址各回傳 1 筆，完整 endpoint、
  x402 v2、POST、network、asset、payTo、amount 與核准內容一致。
- /discovery/resources：也已查到兩個已刊登的完整資源。
- /discovery/search：以完整網址＋付款條件、網域，或 Mello 查詢仍暫未回傳。
  這與 merchant／resources 目錄的結果有差異；不能宣稱搜尋端或目前的 Mello
  search-based discovery 已就緒，也不以此理由追加付款。

20:55:29／20:55:30 的後續唯讀 /discovery/search 查驗已分別回傳完整目標，
兩者 matchedCount=1、partialResults=false；搜尋端現已可見，期間沒有重付。
20:57:47 的線上 Mello /registry/discovery 取得 3 筆候選，A／B 的 listed
皆為 true，唯一未通過原因為 VERIFICATION_UNREVIEWED，沒有本地 fallback。

因此目前可以確認「鏈上付款成功、CDP 商家／資源目錄與搜尋皆已收錄、Mello
唯讀 discovery 找到兩個服務」，但不能宣稱「Mello 已啟用 Bazaar 採購」。
SERVICE_DISCOVERY_MODE 仍為 local_demo，兩個商家仍為 UNREVIEWED；後續須
人工範圍審核，再另行批准啟用與端到端採購驗收。原 policy 的發票要求保持不變。

付款後唯讀比對仍為 10 個任務、6 筆採購，原有付款／交付／發票／對帳／anchor
資料 digest 一致，公司、policy、operator 餘額、合約及付款凍結狀態皆不變。
本輪未部署程式碼、未改畫面、未建立採購或發票。

本地執行工具與不可覆寫紀錄：.railway/bazaar-index-once.mjs、
.railway/bazaar-index-once.test.mjs、.railway/bazaar-indexing-approved-20260905/。
付款後資料比對：/tmp/mello-bazaar-public-rollout/after-indexing.json。
這些執行檔與 journal 保留在既有 integration 工作區，不提交環境秘密或授權簽章。
此次 0.09 Test USDC 授權已完全使用，後續僅可重跑唯讀 catalog／merchant／
validate-index 檢查，不可重新執行 pay。

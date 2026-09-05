# Railway + Base Sepolia acceptance — 2026-09-05

本文件記錄 `6ca7b16` / `96e6383` 舊版控制台的既有部署與鏈上驗收。之後 PR #2 與新版 main 工作區／獨立文件站的衝突整合是另一次本地驗證，未因此重新部署 Railway 或再次支出測試網資金。

已保留現有前端視覺，將控制台接上實際 API、PostgreSQL、x402 與新部署的稽核合約。

- [線上操作台](https://web-production-158a1.up.railway.app/app)
- [Railway 專案](https://railway.com/project/58411a4f-2dde-47c7-8eb0-ca6566cdc3f7)
- [後端 PR #1（已合併）](https://github.com/pintoolx/mello/pull/1)，merge commit `70a5bf7b9904676de05ae554651e9144d2cec272`
- [端到端整合 PR #2](https://github.com/pintoolx/mello/pull/2)

登入碼是本地 ignored `.env.railway` 的 MELLO_ACCESS_CODE，由操作者私下提供，不提交 Git、不出現在 browser bundle。此站是受存取碼保護的單公司 demo 操作台，不是多租戶財務權限系統。

## 驗證結果

| 驗證 | 結果 |
| --- | --- |
| API unit tests | 308 passed / 39 files |
| PostgreSQL + Anvil integration | 41 passed / 12 files |
| Foundry | 24 passed，含 fuzz |
| API / Web typecheck、lint、Docker build | 通過 |
| 本地完整 Playwright | 16 checks，3 purchases |
| Railway 公開 HTTPS 完整 Playwright | 16 checks，3 purchases，無 page errors |
| 額外線上 session 檢查 | 偽造、過期、過長效期 cookie 拒絕；錯誤登入碼拒絕；跨 origin 登入拒絕；BFF 不開放 DB reset |
| Browser bundle 秘密掃描 | 7 個公開 JS chunks 與 HTML 未含實際部署秘密 |
| 獨立 Base Sepolia RPC 核對 | 3 筆正確 Test USDC Transfer、6 筆成功 anchor、3 筆 FINALIZED 與所有證據 hashes 一致 |

完整瀏覽器流程：登入 → 採購 → invoice fail-once → 重試且 settlement hash 不變 → 完成；reload 同一採購；request-key 重播不增加付款；凍結持久化且後端拒絕新任務；低預算與 payTo 不符皆在付款前拒絕；0.03 USDC 門檻先等待核准再付款；三筆採購完成；375 / 768 / 1280 px 無水平溢出；登出後 API 拒絕存取。

完整流程執行於 `6ca7b16`。之後 `96e6383` 僅移除重複的 USDC 文案；不再次付款，以既有三筆採購進行唯讀 layout / session / evidence 回歸。

## 實際測試網交易

Chain ID = 84532。新 registry 為 [0x260758a7e8f4a998dc7aa8794938e72a2a4c6d4a](https://sepolia.basescan.org/address/0x260758a7e8f4a998dc7aa8794938e72a2a4c6d4a)，[部署交易](https://sepolia.basescan.org/tx/0x9f88df5ca4f3a998ff6fe6bdbe578ae6721f52cfd89c8f2d50cdf9d6aec7ea31) receipt success、block 46411103、4381-byte runtime code。

| 採購 | Settlement | Test USDC | Registry |
| --- | --- | --- | --- |
| e4c775a1-f541-4f1b-b9bf-745e00e79edb | [交易 1](https://sepolia.basescan.org/tx/0x4281cdb417678152d75d23c62d9c61e25f8a2775512cf2df3c9a887551683b63) | 0.05 | FINALIZED |
| a237503e-862a-47d2-b48e-e380e3eb498c | [交易 2](https://sepolia.basescan.org/tx/0x9f546be8637f893ac819a57fcc2314a793cc7ba7efd20679851bafa4ffc43237) | 0.05 | FINALIZED |
| ab4f3272-319a-44a4-96a4-e7acf667f948 | [交易 3](https://sepolia.basescan.org/tx/0xe808f00736a1e3158b2ddccb42799ee7e02b1630be4a030360f6e8f2cc5ba5ee) | 0.05 | FINALIZED |

機器可讀證據（包含六筆 anchor hashes）見 [Base Sepolia proof](evidence/base-sepolia-2026-09-05.json)。每筆比對 USDC token、buyer、recipient、amount、settlement hash、authorization hash、delivery hash、invoice hash 與 reconciliation hash，並核對合約事件。

驗收合計支出 0.15 Test USDC，buyer 餘額為 0.65 Test USDC；operator 餘額約 0.00007194 測試 ETH；registry Test USDC 餘額為 0。Operator 角色已核對。以上為驗收當下餘額，不保證後續操作後不變。付款已解除凍結，DB 保留三筆完成與兩筆拒絕的採購任務供繼續測試。

## 部署識別

所有列出的 deployment ID 均須在交付前讀回 SUCCESS；API / Sellers 私有網路，只有 Web 有 public domain。

| Service | Deployment ID |
| --- | --- |
| api | d18a8072-a6b0-4b35-b8d5-3aee23ea30f9 |
| web | d7c801be-bb25-426a-822f-4496ba2aae65 |
| seller-a | 4266a86a-07e6-4e83-acd0-b83bfc33c5ea |
| seller-b | becc65c0-4258-46eb-a009-4a882f221389 |
| Postgres | 81e65891-64d0-4b3c-94aa-38c7aa4e8c41 |

初次部署發現 migration 成功但 seed 未执行，已改成單一 npm db:prepare 指令並在 Railway 實際確認初始化成功；重部署保留既有公司與政策。前端也會將未初始化狀態顯示成可恢復錯誤。第一次瀏覽器嘗試發生在未初始化時，沒有建立採購／付款；上述三筆來自修正後的完整驗收。

本機 artifacts：`/tmp/mello-e2e-railway-verified/report.json` 與 completed-375 / 768 / 1280.png；最後文案調整後的唯讀回歸在 `/tmp/mello-e2e-railway-final-layout/`。暫存目錄可能被系統清理，永久鏈上證據另存於本文件與 JSON。

## 限制

付款與錨定是真實 Base Sepolia 操作，不是主網。意圖解析為 demo parser、信用報告為 demo seller 資料、發票為 ISSUED_DEMO（不具正式統一發票效力）。保留單一 demo 操作員權限；正式上線前仍需職務分權、SSO／持久化限流、正式信用資料與發票供應商。凍結不撤回已取得放行許可的在途付款；重複下單保證依共用 request key，不是任意相似 prompt 的語意去重。

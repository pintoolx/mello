# 新版工作區整合驗收 — 2026-09-05

PR #2 以 `main@6cbeea9` 的採購主系統與獨立 `apps/docs` 為準，整合原 `codex/e2e-railway@12f10d9` 的後端與付款安全控制。保留新版導覽、清單、案件分頁、品牌與元件樣式；不恢復舊六格 Demo 操作台或嵌入影片。

## 合併後能力

- 私有存取碼登入、HttpOnly session、同源寫入檢查及 allowlist BFF；API／管理 Token 只在伺服器端使用。
- 建立申請先保存、不付款；建立回應遺失後，以原 request key 找回案件。
- 人工核准顯示服務、金額、收款地址、網路與代幣；政策頁的付款凍結由後端持久化與強制執行。
- 發票／歸檔重試與既有付款核對；核准後短暫回到 CREATED 時持續等待 worker，不提早停止更新。
- `contracts/` 維持獨立；信用報告與發票仍明示 Demo。文件站不依賴 API 或 session，不與主系統交叉導流。

## 驗證

| 項目 | 結果 |
| --- | --- |
| API 單元測試 | 308 / 39 files 通過 |
| Web 金額、pending request、輪詢單元測試 | 6 通過 |
| PostgreSQL + 本地 Anvil 整合測試 | 41 / 12 files 通過 |
| 三個 workspace 的 typecheck / lint / build | 通過 |
| API / Web Docker builds | 通過，保留獨立服務 runtime |
| Production Web 唯讀驗證 | 登入、Secure / HttpOnly / Strict cookie、BFF 查詢、登出通過 |
| 新版 Python Playwright | 10 組檢查，無 page errors |
| 原 main visual QA（補上登入） | 88 項檢查通過 |
| Production dependency audit | 0 vulnerabilities |
| 實際秘密比對掃描 | Git 檔案及 Web client chunks 無命中 |

Playwright 使用隔離 PostgreSQL 與本地 Sellers，`payment=mock`、`anchor=mock`、`invoice=mock`、`agent=demo`。成功驗收流程保留兩筆完成採購；另驗證低預算、收款地址不符、凍結阻擋、request-key 衝突、回應遺失後恢復、session 失效後返回原案件。所有工作區頁與六個文件頁均檢查 375 / 768 / 1280 px；原 main QA 另驗證桌機／手機與文件選單。

瀏覽器測試曾找出「核准後 CREATED 過渡狀態停止輪詢」問題；修正後補入確定性的單元測試並重跑完整流程通過。Mock 測試建立的歷史案件不刪除，不把模擬 hash 當成真實鏈上交易。

本機 artifacts：`/tmp/mello-workspace-merge/report.json`、同目錄截圖，以及 `/tmp/mello-visual-qa/report.json`。暫存檔可能被系統清理，驗收結論由本文件保留。

本次只整合、驗證與合併程式碼，未執行 Railway 重部署、合約部署或測試網支出。既有 Base Sepolia 交易證據屬先前部署，見 [歷史驗收](DEMO_ACCEPTANCE.md)，不能當成本次新版前端的 live 驗收。

後續另經批准執行新版工作區重部署、新合約與真實 Base Sepolia 測試，結果獨立記錄於 [新版 live 驗收](WORKSPACE_LIVE_ACCEPTANCE.md)，不覆蓋本次合併階段的歷史紀錄。

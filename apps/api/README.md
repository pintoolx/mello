# Mello API workspace

這個目錄保留給後端實作，不包含假 API 或預設框架。

後端夥伴開始時，請在此建立自己的 `package.json`，套件名稱使用 `@mello/api`。根目錄已設定 npm workspaces，建立後即可從 repository 根目錄執行：

```bash
npm install
npm run dev --workspace @mello/api
```

## 協作邊界

- 後端程式、migration、測試與服務端環境變數範例放在 `apps/api`。
- 不要把真實密鑰 commit 進 Git；只提交 `.env.example`。
- `apps/web` 是已驗收的完整視覺 Demo。若 API 串接需要改畫面，請在同一個 PR 明確列出影響的狀態與頁面。
- 根目錄 `package-lock.json` 是共用 lockfile；安裝後端 dependency 時一併提交它。

# Mello visual MVP

Mello 是台灣企業的 Agent Purchase-to-Pay 控制層。這個版本只做黑客松現場使用的視覺與可點互動，不含真實付款、後端資料庫或正式電子發票。

## Run

```bash
npm install
npm run dev
```

- 官網：`http://localhost:3000/`
- 操作台：`http://localhost:3000/app`

## Demo 點擊順序

1. 在 Task Composer 點「執行採購任務」。
2. 畫面依序亮起比較、Policy ALLOW、付款、Sandbox Invoice 與 MATCHED。
3. 點「模擬財務 Agent 重複下單」，展示 `DUPLICATE_PURCHASE`。
4. 可用「測試 0.03 預算」與「測試 payTo 不符」展示拒絕狀態。
5. 「凍結所有新付款」只切換前端狀態。

所有付款與發票皆明確標示為 `SIMULATED` / `SANDBOX` / `TEST INVOICE`。

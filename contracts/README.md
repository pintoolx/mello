# MelloAuditRegistry

合約只保存採購授權、完成或失敗證據的雜湊，不保管 USDC，也不執行 x402 settlement。保留獨立的根目錄 `contracts/`，方便使用 Foundry 編譯、測試、部署；不需要額外的 Node.js server 或 npm workspace。

- `src/`：Solidity registry
- `test/`：權限、狀態轉換與 ERC-3009 replay 測試
- `script/`：部署
- `abi/MelloAuditRegistry.json`：checked-in ABI，API 的 `src/contracts-client` 直接引用
- `foundry.toml`：編譯器、optimizer 與 Base Sepolia RPC alias

在 repo 根目錄執行 `npx --yes npm@11.19.1 ci` 安裝 OpenZeppelin（版本要求見 root README），再執行：

```bash
npm run contract:test
npm run contract:compile --workspace @mello/api
npm run contract:deploy:base-sepolia --workspace @mello/api
```

部署命令從 `apps/api/.env` 載入 `BASE_SEPOLIA_RPC_URL` 與 `CONTRACT_OPERATOR_PRIVATE_KEY`。local deploy script 的預設 RPC 是 `http://127.0.0.1:8545`；用其他 port 時，透過 API 的 `scripts/run-forge.ts` 傳入對應 `--rpc-url`。

ABI 修改時，在 `contracts/` 執行 `forge inspect MelloAuditRegistry abi` 並同步更新 `abi/MelloAuditRegistry.json`，與合約 source 一起 review。API 執行不需要 Foundry，但部署 artifact 必須包含該 ABI。

部署者取得 admin 與 operator 權限。前端只顯示合約地址、交易 hash、confirm 狀態與 explorer link，付款與 anchor 的私鑰仍在 API。換 repo 或搬動目錄不需要重新部署已存在的合約。

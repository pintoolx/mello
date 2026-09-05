// Read-only verification. Never signs, creates tasks, retries, or submits payments.
// Load WEB_PUBLIC_URL, MELLO_ACCESS_CODE and BASE_SEPOLIA_RPC_URL into the process
// environment privately, then pass the workspace-e2e.py --live report path.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createPublicClient, erc20Abi, http, keccak256, parseEventLogs, stringToHex } from "viem";

const report = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(report.ok, true);
assert.equal(report.live, true);
assert.equal(report.purchases.length, 2);
assert.equal(new Set(report.purchases.map((item) => item.purchaseId)).size, 2);
assert.equal(new Set(report.purchases.map((item) => item.paymentHash)).size, 2);
const origin = process.env.WEB_PUBLIC_URL;
assert.equal(new URL(origin).protocol, "https:");
assert.ok(process.env.MELLO_ACCESS_CODE);
const rpc = process.env.BASE_SEPOLIA_RPC_URL;
assert.ok(rpc);
const client = createPublicClient({ transport: http(rpc) });
assert.equal(await client.getChainId(), 84532);
const registry = report.registry;
assert.match(registry, /^0x[0-9a-fA-F]{40}$/);
assert.ok((await client.getCode({ address: registry }))?.length > 2);
const abi = JSON.parse(readFileSync(new URL("../../../contracts/abi/MelloAuditRegistry.json", import.meta.url), "utf8"));
const token = "0x036CbD53842c5426634e7929541eC2318f3dCF7e";
assert.equal(await client.readContract({ address: token, abi: erc20Abi, functionName: "balanceOf", args: [registry] }), 0n);
const login = await fetch(origin + "/api/session", {
  method: "POST", headers: { "content-type": "application/json", origin },
  body: JSON.stringify({ code: process.env.MELLO_ACCESS_CODE }),
});
assert.equal(login.status, 200);
const cookie = login.headers.get("set-cookie").split(";")[0];
const proofs = [];
for (const item of report.purchases) {
  const response = await fetch(origin + "/api/v1/purchases/" + item.purchaseId, { headers: { cookie } });
  assert.equal(response.status, 200);
  const purchase = await response.json();
  assert.equal(purchase.status, "COMPLETED");
  assert.equal(purchase.network, "eip155:84532");
  assert.equal(purchase.token.address.toLowerCase(), token.toLowerCase());
  assert.equal(purchase.modes.payment, "x402");
  assert.equal(purchase.modes.anchor, "onchain");
  assert.equal(purchase.modes.offchainAuthorizationFallbackEnabled, false);
  assert.equal(purchase.payment.status, "SETTLED");
  assert.equal(purchase.payment.transactionHash, item.paymentHash);
  assert.equal(purchase.invoice.status, "ISSUED_DEMO");
  assert.equal(purchase.reconciliation.status, "MATCHED");
  assert.equal(purchase.expectedAmountAtomic, "50000");
  assert.equal(purchase.actualAmountAtomic, "50000");
  const receipt = await client.getTransactionReceipt({ hash: item.paymentHash });
  assert.equal(receipt.status, "success");
  const transfers = parseEventLogs({ abi: erc20Abi, eventName: "Transfer", logs: receipt.logs.filter((log) => log.address.toLowerCase() === token.toLowerCase()) });
  const outgoing = transfers.filter((log) => log.args.from.toLowerCase() === purchase.buyerAddress.toLowerCase());
  assert.equal(outgoing.length, 1, "Exactly one buyer USDC transfer in this settlement");
  assert.equal(outgoing[0].args.to.toLowerCase(), purchase.payToAddress.toLowerCase());
  assert.equal(outgoing[0].args.value, 50000n);
  const purchaseKey = keccak256(stringToHex(item.purchaseId));
  const record = await client.readContract({ address: registry, abi, functionName: "getPurchase", args: [purchaseKey] });
  assert.equal(Number(record.status), 2, "Registry must be FINALIZED");
  assert.equal(record.actualAmount, 50000n);
  assert.equal(record.maxAmount, 50000n);
  for (const [field, expected] of Object.entries({
    settlementTxHash: item.paymentHash, paymentAuthorizationHash: purchase.paymentAuthorizationHash,
    mandateHash: purchase.mandateHash, policyHash: purchase.policyHash,
    receiptHash: purchase.delivery.responseHash, invoiceHash: purchase.invoice.canonicalHash,
    reconciliationHash: purchase.reconciliation.canonicalHash,
    buyer: purchase.buyerAddress, seller: purchase.payToAddress, token,
  })) assert.equal(record[field].toLowerCase(), expected.toLowerCase(), field);
  const anchors = [];
  for (const kind of ["AUTHORIZE", "FINALIZE"]) {
    const matches = purchase.anchors.filter((anchor) => anchor.kind === kind);
    assert.equal(matches.length, 1);
    const anchor = matches[0];
    assert.equal(anchor.status, "CONFIRMED");
    const anchored = await client.getTransactionReceipt({ hash: anchor.transactionHash });
    assert.equal(anchored.status, "success");
    assert.equal(anchored.to.toLowerCase(), registry.toLowerCase());
    const eventName = kind === "AUTHORIZE" ? "PurchaseAuthorized" : "PurchaseFinalized";
    const events = parseEventLogs({ abi, eventName, logs: anchored.logs.filter((log) => log.address.toLowerCase() === registry.toLowerCase()) });
    assert.equal(events.filter((event) => event.args.purchaseId === purchaseKey).length, 1);
    anchors.push({ kind, transactionHash: anchor.transactionHash, blockNumber: anchored.blockNumber.toString(), receiptStatus: anchored.status });
  }
  proofs.push({ taskId: item.taskId, purchaseId: item.purchaseId, settlementHash: item.paymentHash,
    settlementBlock: receipt.blockNumber.toString(), usdcAtomic: "50000", matchingTransferCount: 1,
    buyer: purchase.buyerAddress, seller: purchase.payToAddress, registryStatus: "FINALIZED",
    allEvidenceHashesMatch: true, anchors });
}
const logout = await fetch(origin + "/api/session", { method: "DELETE", headers: { cookie, origin } });
assert.equal(logout.status, 200);
console.log(JSON.stringify({ verifiedAt: new Date().toISOString(), chainId: 84532, registry,
  token, totalTestUsdcAtomic: "100000", registryTestUsdcAtomic: "0", ok: true, proofs }, null, 2));

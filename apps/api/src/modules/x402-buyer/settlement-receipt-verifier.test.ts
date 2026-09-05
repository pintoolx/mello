import {
  encodeAbiParameters,
  encodeEventTopics,
  erc20Abi,
  type Address,
  type Hex,
} from "viem";
import { describe, expect, it, vi } from "vitest";
import {
  Erc20SettlementReceiptVerifier,
  type SettlementReceipt,
  type SettlementReceiptLog,
} from "./settlement-receipt-verifier.js";

const transactionHash = `0x${"aa".repeat(32)}` as Hex;
const token = "0x1111111111111111111111111111111111111111" as Address;
const payer = "0x2222222222222222222222222222222222222222" as Address;
const payee = "0x3333333333333333333333333333333333333333" as Address;

function transferLog(
  from: Address,
  to: Address,
  value: bigint,
  address: Address = token,
): SettlementReceiptLog {
  return {
    address,
    topics: encodeEventTopics({
      abi: erc20Abi,
      eventName: "Transfer",
      args: { from, to },
    }) as [Hex, ...Hex[]],
    data: encodeAbiParameters([{ type: "uint256" }], [value]),
  };
}

function receipt(
  logs: readonly SettlementReceiptLog[],
  status: SettlementReceipt["status"] = "success",
): SettlementReceipt {
  return { status, logs };
}

function expectedInput() {
  return {
    transactionHash,
    tokenAddress: token,
    payerAddress: payer,
    payeeAddress: payee,
    amountAtomic: "50000",
  } as const;
}

describe("Erc20SettlementReceiptVerifier", () => {
  it("accepts a successful receipt with exactly the approved USDC transfer", async () => {
    const waitForReceipt = vi.fn(async () =>
      receipt([transferLog(payer, payee, 50_000n)]),
    );

    await expect(
      new Erc20SettlementReceiptVerifier(waitForReceipt).verify(expectedInput()),
    ).resolves.toBeUndefined();
    expect(waitForReceipt).toHaveBeenCalledWith(transactionHash);
  });

  it("rejects a reverted transaction", async () => {
    const verifier = new Erc20SettlementReceiptVerifier(async () => receipt([], "reverted"));

    await expect(verifier.verify(expectedInput())).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
      message: expect.stringMatching(/reverted/u),
    });
  });

  it.each([
    ["wrong token", transferLog(payer, payee, 50_000n, "0x4444444444444444444444444444444444444444")],
    ["wrong payer", transferLog("0x5555555555555555555555555555555555555555", payee, 50_000n)],
    ["wrong payee", transferLog(payer, "0x6666666666666666666666666666666666666666", 50_000n)],
    ["wrong amount", transferLog(payer, payee, 49_999n)],
  ])("rejects an otherwise successful receipt with %s", async (_label, log) => {
    const verifier = new Erc20SettlementReceiptVerifier(async () => receipt([log]));

    await expect(verifier.verify(expectedInput())).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
    });
  });

  it("rejects duplicate matching transfers even when one has the approved amount", async () => {
    const verifier = new Erc20SettlementReceiptVerifier(async () =>
      receipt([
        transferLog(payer, payee, 50_000n),
        transferLog(payer, payee, 1n),
      ]),
    );

    await expect(verifier.verify(expectedInput())).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
    });
  });

  it("marks receipt lookup failures as retryable without manufacturing evidence", async () => {
    const verifier = new Erc20SettlementReceiptVerifier(async () => {
      throw new Error("RPC timeout after 20000ms");
    });

    await expect(verifier.verify(expectedInput())).rejects.toMatchObject({
      code: "X402_PAYMENT_FAILED",
      retryable: true,
      message: "Settlement receipt could not be confirmed",
    });
  });
});

import { MelloError } from "@mello/shared";
import {
  decodeEventLog,
  erc20Abi,
  getAddress,
  type Address,
  type Hex,
} from "viem";

export interface SettlementReceiptLog {
  address: Address;
  data: Hex;
  topics: [] | [signature: Hex, ...args: Hex[]];
}

export interface SettlementReceipt {
  status: "success" | "reverted";
  logs: readonly SettlementReceiptLog[];
}

export interface SettlementReceiptVerificationInput {
  transactionHash: Hex;
  tokenAddress: Address;
  payerAddress: Address;
  payeeAddress: Address;
  amountAtomic: string;
}

export interface SettlementReceiptVerifier {
  verify(input: SettlementReceiptVerificationInput): Promise<void>;
}

export type WaitForSettlementReceipt = (
  transactionHash: Hex,
) => Promise<SettlementReceipt>;

/**
 * Verifies the economic result of an x402 settlement independently of the
 * resource server's PAYMENT-RESPONSE header.
 */
export class Erc20SettlementReceiptVerifier implements SettlementReceiptVerifier {
  constructor(private readonly waitForReceipt: WaitForSettlementReceipt) {}

  async verify(input: SettlementReceiptVerificationInput): Promise<void> {
    let receipt: SettlementReceipt;
    try {
      receipt = await this.waitForReceipt(input.transactionHash);
    } catch {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Settlement receipt could not be confirmed",
        { retryable: true },
      );
    }

    if (receipt.status !== "success") {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Settlement transaction reverted on Base Sepolia",
      );
    }

    const tokenAddress = getAddress(input.tokenAddress);
    const payerAddress = getAddress(input.payerAddress);
    const payeeAddress = getAddress(input.payeeAddress);
    const expectedAmount = BigInt(input.amountAtomic);
    const matchingTransfers: bigint[] = [];

    for (const log of receipt.logs) {
      if (getAddress(log.address) !== tokenAddress) continue;
      try {
        const decoded = decodeEventLog({
          abi: erc20Abi,
          eventName: "Transfer",
          data: log.data,
          topics: log.topics,
          strict: true,
        });
        if (
          getAddress(decoded.args.from) === payerAddress &&
          getAddress(decoded.args.to) === payeeAddress
        ) {
          matchingTransfers.push(decoded.args.value);
        }
      } catch {
        // Other USDC events and malformed logs are not settlement evidence.
      }
    }

    if (
      matchingTransfers.length !== 1 ||
      matchingTransfers[0] !== expectedAmount
    ) {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Settlement receipt does not contain exactly one approved USDC transfer",
        {
          details: {
            transactionHash: input.transactionHash,
            expectedAmountAtomic: input.amountAtomic,
            matchingTransferAmounts: matchingTransfers.map(String),
          },
        },
      );
    }
  }
}

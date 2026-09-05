import auditRegistryAbiJson from "../../../../contracts/abi/MelloAuditRegistry.json" with {
  type: "json",
};
import { hashCanonicalJson } from "@mello/shared";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  stringToHex,
  type Abi,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";

export const melloAuditRegistryAbi = auditRegistryAbiJson as Abi;

export interface AnchorTransactionResult {
  transactionHash: Hex;
  blockNumber: bigint;
  /** Runtime chain id observed from the RPC that returned the receipt. */
  chainId?: number | undefined;
}

export interface AnchorSubmissionOptions {
  /**
   * Runs immediately after eth_sendRawTransaction returns a hash and before
   * receipt polling starts. Workflows use this awaited hook to durably record
   * SUBMITTED/hash, which makes receipt timeouts safe to reconcile.
   */
  onSubmitted?: ((transactionHash: Hex) => Promise<void>) | undefined;
}

export type AuditPurchaseStatus = "NONE" | "AUTHORIZED" | "FINALIZED" | "FAILED";

export interface AuditPurchaseState {
  status: AuditPurchaseStatus;
  paymentAuthorizationHash: Hex;
}

export class AnchorTransactionRevertedError extends Error {
  readonly transactionHash: Hex;

  constructor(transactionHash: Hex) {
    super(`Contract transaction reverted: ${transactionHash}`);
    this.name = "AnchorTransactionRevertedError";
    this.transactionHash = transactionHash;
  }
}

export class AnchorSubmissionPersistenceError extends Error {
  readonly transactionHash: Hex;

  constructor(transactionHash: Hex, cause: unknown) {
    super(
      cause instanceof Error
        ? `Anchor was submitted but its hash could not be persisted: ${cause.message}`
        : "Anchor was submitted but its hash could not be persisted",
      { cause },
    );
    this.name = "AnchorSubmissionPersistenceError";
    this.transactionHash = transactionHash;
  }
}

export interface AuthorizePurchaseInput {
  purchaseId: string;
  buyer: Address;
  seller: Address;
  token: Address;
  maxAmount: bigint;
  expiresAt: bigint;
  mandateHash: Hex;
  policyHash: Hex;
  paymentAuthorizationHash: Hex;
}

export interface FinalizePurchaseInput {
  purchaseId: string;
  actualAmount: bigint;
  settlementTxHash: Hex;
  receiptHash: Hex;
  invoiceHash: Hex;
  reconciliationHash: Hex;
}

export interface AuditAnchorClient {
  readonly mode: "onchain" | "mock" | "disabled";
  authorizePurchase(
    input: AuthorizePurchaseInput,
    options?: AnchorSubmissionOptions,
  ): Promise<AnchorTransactionResult>;
  finalizePurchase(
    input: FinalizePurchaseInput,
    options?: AnchorSubmissionOptions,
  ): Promise<AnchorTransactionResult>;
  markFailed(
    purchaseId: string,
    reasonHash: Hex,
    options?: AnchorSubmissionOptions,
  ): Promise<AnchorTransactionResult>;
  reconcileTransaction(transactionHash: Hex): Promise<AnchorTransactionResult>;
  getPurchaseState(purchaseId: string): Promise<AuditPurchaseState>;
  hasContractCode(): Promise<boolean>;
}

export function purchaseIdOnchain(purchaseId: string): Hex {
  return keccak256(stringToHex(purchaseId));
}

export interface OnchainAuditAnchorClientConfig {
  rpcUrl: string;
  privateKey: Hex;
  contractAddress: Address;
}

export class OnchainAuditAnchorClient implements AuditAnchorClient {
  readonly mode = "onchain" as const;
  private readonly account;
  private readonly publicClient;
  private readonly walletClient;

  constructor(private readonly config: OnchainAuditAnchorClientConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    const transport = http(config.rpcUrl, { timeout: 20_000, retryCount: 2 });
    this.publicClient = createPublicClient({ chain: baseSepolia, transport });
    this.walletClient = createWalletClient({
      account: this.account,
      chain: baseSepolia,
      transport,
    });
  }

  async authorizePurchase(
    input: AuthorizePurchaseInput,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const hash = await this.walletClient.writeContract({
      address: this.config.contractAddress,
      abi: melloAuditRegistryAbi,
      functionName: "authorizePurchase",
      args: [
        purchaseIdOnchain(input.purchaseId),
        input.buyer,
        input.seller,
        input.token,
        input.maxAmount,
        input.expiresAt,
        input.mandateHash,
        input.policyHash,
        input.paymentAuthorizationHash,
      ],
    });
    await this.notifySubmitted(hash, options);
    return this.waitForReceipt(hash);
  }

  async finalizePurchase(
    input: FinalizePurchaseInput,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const hash = await this.walletClient.writeContract({
      address: this.config.contractAddress,
      abi: melloAuditRegistryAbi,
      functionName: "finalizePurchase",
      args: [
        purchaseIdOnchain(input.purchaseId),
        input.actualAmount,
        input.settlementTxHash,
        input.receiptHash,
        input.invoiceHash,
        input.reconciliationHash,
      ],
    });
    await this.notifySubmitted(hash, options);
    return this.waitForReceipt(hash);
  }

  async markFailed(
    purchaseId: string,
    reasonHash: Hex,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const hash = await this.walletClient.writeContract({
      address: this.config.contractAddress,
      abi: melloAuditRegistryAbi,
      functionName: "markFailed",
      args: [purchaseIdOnchain(purchaseId), reasonHash],
    });
    await this.notifySubmitted(hash, options);
    return this.waitForReceipt(hash);
  }

  reconcileTransaction(transactionHash: Hex): Promise<AnchorTransactionResult> {
    return this.waitForReceipt(transactionHash);
  }

  async getPurchaseState(purchaseId: string): Promise<AuditPurchaseState> {
    const raw = await this.publicClient.readContract({
      address: this.config.contractAddress,
      abi: melloAuditRegistryAbi,
      functionName: "getPurchase",
      args: [purchaseIdOnchain(purchaseId)],
    });
    const record = raw as
      | readonly unknown[]
      | { status?: unknown; paymentAuthorizationHash?: unknown };
    const statusValue = Array.isArray(record)
      ? record[6]
      : (record as { status?: unknown }).status;
    const paymentAuthorizationHash = Array.isArray(record)
      ? record[9]
      : (record as { paymentAuthorizationHash?: unknown }).paymentAuthorizationHash;
    const statuses: readonly AuditPurchaseStatus[] = [
      "NONE",
      "AUTHORIZED",
      "FINALIZED",
      "FAILED",
    ];
    const status = statuses[Number(statusValue)];
    if (!status || typeof paymentAuthorizationHash !== "string") {
      throw new Error("Audit registry returned an invalid purchase record");
    }
    return { status, paymentAuthorizationHash: paymentAuthorizationHash as Hex };
  }

  async hasContractCode(): Promise<boolean> {
    const code = await this.publicClient.getCode({ address: this.config.contractAddress });
    return code !== undefined && code !== "0x";
  }

  private async waitForReceipt(hash: Hex): Promise<AnchorTransactionResult> {
    const [receipt, chainId] = await Promise.all([
      this.publicClient.waitForTransactionReceipt({
        hash,
        confirmations: 1,
        timeout: 20_000,
      }),
      this.publicClient.getChainId(),
    ]);
    if (receipt.status !== "success") throw new AnchorTransactionRevertedError(hash);
    if (chainId !== baseSepolia.id) {
      throw new Error(
        `Audit anchor receipt came from chain ${chainId}; expected Base Sepolia ${baseSepolia.id}`,
      );
    }
    return { transactionHash: hash, blockNumber: receipt.blockNumber, chainId };
  }

  private async notifySubmitted(hash: Hex, options: AnchorSubmissionOptions): Promise<void> {
    try {
      await options.onSubmitted?.(hash);
    } catch (error: unknown) {
      throw new AnchorSubmissionPersistenceError(hash, error);
    }
  }
}

export class MockAuditAnchorClient implements AuditAnchorClient {
  readonly mode = "mock" as const;
  private block = 1n;
  private readonly receipts = new Map<Hex, AnchorTransactionResult>();
  private readonly purchases = new Map<string, AuditPurchaseState>();

  async authorizePurchase(
    input: AuthorizePurchaseInput,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const result = this.result("authorize", input);
    this.purchases.set(input.purchaseId, {
      status: "AUTHORIZED",
      paymentAuthorizationHash: input.paymentAuthorizationHash,
    });
    await this.notifySubmitted(result.transactionHash, options);
    return result;
  }

  async finalizePurchase(
    input: FinalizePurchaseInput,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const result = this.result("finalize", input);
    const existing = this.purchases.get(input.purchaseId);
    this.purchases.set(input.purchaseId, {
      status: "FINALIZED",
      paymentAuthorizationHash: existing?.paymentAuthorizationHash ?? zeroHash(),
    });
    await this.notifySubmitted(result.transactionHash, options);
    return result;
  }

  async markFailed(
    purchaseId: string,
    reasonHash: Hex,
    options: AnchorSubmissionOptions = {},
  ): Promise<AnchorTransactionResult> {
    const result = this.result("fail", { purchaseId, reasonHash });
    const existing = this.purchases.get(purchaseId);
    this.purchases.set(purchaseId, {
      status: "FAILED",
      paymentAuthorizationHash: existing?.paymentAuthorizationHash ?? zeroHash(),
    });
    await this.notifySubmitted(result.transactionHash, options);
    return result;
  }

  async reconcileTransaction(transactionHash: Hex): Promise<AnchorTransactionResult> {
    const result = this.receipts.get(transactionHash);
    if (!result) throw new Error(`Mock anchor transaction not found: ${transactionHash}`);
    return result;
  }

  async getPurchaseState(purchaseId: string): Promise<AuditPurchaseState> {
    return this.purchases.get(purchaseId) ?? {
      status: "NONE",
      paymentAuthorizationHash: zeroHash(),
    };
  }

  async hasContractCode(): Promise<boolean> {
    return true;
  }

  private result(kind: string, value: unknown): AnchorTransactionResult {
    const blockNumber = this.block;
    this.block += 1n;
    const result = {
      transactionHash: hashCanonicalJson({
        schemaVersion: "mock-anchor-1",
        kind,
        value: serializeBigInts(value),
        blockNumber: blockNumber.toString(),
      }),
      blockNumber,
    };
    this.receipts.set(result.transactionHash, result);
    return result;
  }

  private async notifySubmitted(hash: Hex, options: AnchorSubmissionOptions): Promise<void> {
    try {
      await options.onSubmitted?.(hash);
    } catch (error: unknown) {
      throw new AnchorSubmissionPersistenceError(hash, error);
    }
  }
}

export class DisabledAuditAnchorClient implements AuditAnchorClient {
  readonly mode = "disabled" as const;

  authorizePurchase(): Promise<AnchorTransactionResult> {
    return Promise.reject(new Error("Contract anchoring is disabled"));
  }

  finalizePurchase(): Promise<AnchorTransactionResult> {
    return Promise.reject(new Error("Contract anchoring is disabled"));
  }

  markFailed(): Promise<AnchorTransactionResult> {
    return Promise.reject(new Error("Contract anchoring is disabled"));
  }

  reconcileTransaction(): Promise<AnchorTransactionResult> {
    return Promise.reject(new Error("Contract anchoring is disabled"));
  }

  getPurchaseState(): Promise<AuditPurchaseState> {
    return Promise.reject(new Error("Contract anchoring is disabled"));
  }

  async hasContractCode(): Promise<boolean> {
    return false;
  }
}

function zeroHash(): Hex {
  return `0x${"0".repeat(64)}` as Hex;
}

function serializeBigInts(value: unknown): unknown {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(serializeBigInts);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, serializeBigInts(item)]),
    );
  }
  return value;
}

import {
  MELLO_NETWORK,
  MelloError,
} from "@mello/shared";
import {
  TW_EINVOICE_EXTENSION_KEY,
  TwEinvoiceDeclarationSchema,
  TwEinvoiceSettlementMetadataSchema,
} from "@mello/tw-einvoice-extension";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type {
  PaymentPayload,
  PaymentRequired,
  PaymentRequirements,
  SettleResponse,
} from "@x402/core/types";
import { ExactEvmScheme } from "@x402/evm/exact/client";
import {
  appendPaymentIdentifierToExtensions,
  extractPaymentIdentifier,
  isPaymentIdentifierRequired,
} from "@x402/extensions/payment-identifier";
import { wrapFetchWithPayment } from "@x402/fetch";
import {
  createPublicClient,
  erc20Abi,
  getAddress,
  http,
  type Address,
  type Hex,
} from "viem";
import { baseSepolia } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { z } from "zod";
import {
  assertAuthorizationUsable,
  authorizationEvidenceHash,
  recordSignedAuthorization,
  validatePaymentTerms,
} from "./authorization.js";
import type {
  PaymentProvider,
  PaymentSettlement,
  PaymentSubmissionHooks,
  PendingSettlementEvidence,
  PreparePaymentInput,
  PreparedPayment,
  SettlementVerificationEvidence,
  ValidatedPaymentTerms,
} from "./payment-provider.js";
import {
  PaymentSettlementReportSchema,
  PendingSettlementVerificationError,
  SettledPaymentDeliveryError,
  assertAuthorizationTimeoutWithinPolicy,
} from "./payment-provider.js";
import {
  Erc20SettlementReceiptVerifier,
  type SettlementReceiptVerifier,
} from "./settlement-receipt-verifier.js";

const ExactAuthorizationPayloadSchema = z
  .object({
    signature: z.string().regex(/^0x[a-fA-F0-9]{130}$/),
    authorization: z
      .object({
        from: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        to: z.string().regex(/^0x[a-fA-F0-9]{40}$/),
        value: z.string().regex(/^\d+$/),
        validAfter: z.string().regex(/^\d+$/),
        validBefore: z.string().regex(/^\d+$/),
        nonce: z.string().regex(/^0x[a-fA-F0-9]{64}$/),
      })
      .strict(),
  })
  .passthrough();

interface Deferred<T> {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

interface SignedPayloadState {
  paymentPayload: PaymentPayload;
  authorization: ReturnType<typeof recordSignedAuthorization>;
}

export interface X402PaymentProviderConfig {
  privateKey: Hex;
  rpcUrl: string;
  fetchImplementation?: typeof globalThis.fetch;
  readTokenBalance?: (token: Address, owner: Address) => Promise<bigint>;
  settlementReceiptVerifier?: SettlementReceiptVerifier;
  readChainId?: (() => Promise<number>) | undefined;
  nowSeconds?: () => bigint;
  requestTimeoutMs?: number;
  retryDelayMs?: (failedAttempt: number) => number;
}

function createRetryingFetch(
  fetchImplementation: typeof globalThis.fetch,
  timeoutMs: number,
  retryDelayMs: (failedAttempt: number) => number,
): typeof globalThis.fetch {
  return async (input, init) => {
    const template = new Request(input, init);
    let lastError: unknown;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      if (template.signal.aborted) throw template.signal.reason;
      try {
        return await fetchImplementation(template.clone(), {
          signal: AbortSignal.any([template.signal, AbortSignal.timeout(timeoutMs)]),
        });
      } catch (error: unknown) {
        lastError = error;
        if (template.signal.aborted || attempt === 3) throw error;
        await new Promise<void>((resolve) => {
          globalThis.setTimeout(resolve, retryDelayMs(attempt));
        });
      }
    }
    throw lastError;
  };
}

function validateLiveRequirementStructure(
  input: PreparePaymentInput,
  requirements: PaymentRequirements,
  nowSeconds: bigint,
): ValidatedPaymentTerms {
  if (requirements.scheme !== "exact") {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      `Seller offered unsupported x402 scheme: ${requirements.scheme}`,
    );
  }
  const transferMethod = requirements.extra?.["assetTransferMethod"];
  if (transferMethod !== "eip3009") {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller did not offer the required ERC-3009 transfer method",
    );
  }
  assertAuthorizationTimeoutWithinPolicy(
    input,
    requirements.maxTimeoutSeconds,
    nowSeconds,
  );
  if (
    !/^0x[a-fA-F0-9]{40}$/u.test(requirements.asset) ||
    !/^0x[a-fA-F0-9]{40}$/u.test(requirements.payTo) ||
    !/^\d+$/u.test(requirements.amount) ||
    BigInt(requirements.amount) <= 0n ||
    requirements.network.length === 0
  ) {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller returned malformed x402 payment terms",
    );
  }
  if (
    requirements.extra?.["name"] !== "USDC" ||
    requirements.extra?.["version"] !== "2" ||
    requirements.extra?.["assetDecimals"] !== 6
  ) {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller ERC-3009 asset must be 6-decimal USDC version 2",
    );
  }
  const facilitator = requirements.extra?.["facilitator"];
  if (facilitator !== undefined && typeof facilitator !== "string") {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller facilitator declaration is invalid",
    );
  }
  return {
    scheme: "exact",
    network: requirements.network,
    tokenAddress: requirements.asset as `0x${string}`,
    tokenSymbol: "USDC",
    tokenDecimals: 6,
    payToAddress: requirements.payTo as `0x${string}`,
    amountAtomic: requirements.amount,
    transferMethod: "eip3009",
    facilitatorUrl: typeof facilitator === "string" ? facilitator.replace(/\/$/u, "") : null,
  };
}

function validateInvoiceDeclaration(
  input: PreparePaymentInput,
  paymentRequired: PaymentRequired,
): void {
  if (!input.requiresTwInvoice && input.sellerId !== "seller-b") return;
  const declaration = TwEinvoiceDeclarationSchema.safeParse(
    paymentRequired.extensions?.[TW_EINVOICE_EXTENSION_KEY],
  );
  if (!declaration.success || declaration.data.sellerProfileId !== input.sellerId) {
    throw new MelloError(
      "X402_REQUIREMENTS_INVALID",
      "Seller tw-einvoice declaration does not match the approved registry profile",
    );
  }
}

function validateInvoiceSettlement(input: PreparePaymentInput, response: SettleResponse): void {
  if (!input.requiresTwInvoice && input.sellerId !== "seller-b") return;
  const raw =
    response.extensions?.[TW_EINVOICE_EXTENSION_KEY] ??
    response.extensionResponses?.[TW_EINVOICE_EXTENSION_KEY];
  const metadata = TwEinvoiceSettlementMetadataSchema.safeParse(raw);
  if (!metadata.success || metadata.data.sellerProfileId !== input.sellerId) {
    throw new MelloError(
      "X402_PAYMENT_FAILED",
      "Settled response omitted the approved tw-einvoice metadata",
    );
  }
}

function toMelloPaymentError(error: unknown): MelloError {
  if (error instanceof MelloError) return error;
  return new MelloError(
    "X402_PAYMENT_FAILED",
    "x402 request failed",
    { retryable: true },
  );
}

/**
 * Real x402 buyer. The wrapped fetch begins negotiation immediately, then an
 * awaited SDK hook pauses after signing and before the PAYMENT-SIGNATURE retry.
 * `submit()` is the only operation that releases that gate.
 */
export class X402PaymentProvider implements PaymentProvider {
  readonly mode = "x402" as const;
  private readonly account;
  private readonly fetchImplementation: typeof globalThis.fetch;
  private readonly readTokenBalance: (token: Address, owner: Address) => Promise<bigint>;
  private readonly settlementReceiptVerifier: SettlementReceiptVerifier;
  private readonly readVerifiedChainId: () => Promise<number | undefined>;
  private readonly nowSeconds: () => bigint;

  constructor(config: X402PaymentProviderConfig) {
    this.account = privateKeyToAccount(config.privateKey);
    this.fetchImplementation = createRetryingFetch(
      config.fetchImplementation ?? globalThis.fetch,
      config.requestTimeoutMs ?? 30_000,
      config.retryDelayMs ?? ((failedAttempt) => 250 * 2 ** (failedAttempt - 1)),
    );
    this.nowSeconds =
      config.nowSeconds ?? (() => BigInt(Math.floor(Date.now() / 1_000)));
    const publicClient = createPublicClient({
      chain: baseSepolia,
      transport: http(config.rpcUrl, { timeout: 20_000, retryCount: 2 }),
    });
    if (config.readTokenBalance) {
      this.readTokenBalance = config.readTokenBalance;
    } else {
      this.readTokenBalance = async (token, owner) =>
        publicClient.readContract({
          address: token,
          abi: erc20Abi,
          functionName: "balanceOf",
          args: [owner],
        });
    }
    this.settlementReceiptVerifier =
      config.settlementReceiptVerifier ??
      new Erc20SettlementReceiptVerifier(async (transactionHash) =>
        publicClient.waitForTransactionReceipt({
          hash: transactionHash,
          confirmations: 1,
          timeout: 20_000,
          retryCount: 2,
          checkReplacement: false,
        }),
      );
    this.readVerifiedChainId = config.readChainId
      ? config.readChainId
      : config.settlementReceiptVerifier
        ? async () => undefined
        : () => publicClient.getChainId();
  }

  async getAddress(): Promise<`0x${string}`> {
    return this.account.address;
  }

  async verifySettlement(
    evidence: PendingSettlementEvidence,
  ): Promise<SettlementVerificationEvidence> {
    if (evidence.network !== MELLO_NETWORK) {
      throw new MelloError("X402_PAYMENT_FAILED", "Candidate settlement network is unsupported");
    }
    await this.settlementReceiptVerifier.verify({
      transactionHash: evidence.transactionHash,
      tokenAddress: getAddress(evidence.tokenAddress),
      payerAddress: getAddress(evidence.payerAddress),
      payeeAddress: getAddress(evidence.payeeAddress),
      amountAtomic: evidence.amountAtomic,
    });
    const verifiedChainId = await this.readVerifiedChainId();
    if (verifiedChainId !== baseSepolia.id) {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Settlement receipt was not verified on Base Sepolia",
      );
    }
    return { verifiedChainId };
  }

  async prepare(input: PreparePaymentInput): Promise<PreparedPayment> {
    if (input.network !== MELLO_NETWORK) {
      throw new MelloError("X402_REQUIREMENTS_INVALID", "Only Base Sepolia is supported");
    }
    if (getAddress(input.payerAddress) !== getAddress(this.account.address)) {
      throw new MelloError(
        "ERC3009_TERMS_MISMATCH",
        "Workflow payer does not match the configured buyer wallet",
      );
    }

    let balance: bigint;
    try {
      balance = await this.readTokenBalance(
        getAddress(input.tokenAddress),
        getAddress(this.account.address),
      );
    } catch (error: unknown) {
      throw toMelloPaymentError(error);
    }
    if (balance < BigInt(input.amountAtomic)) {
      throw new MelloError(
        "WALLET_INSUFFICIENT_FUNDS",
        "Buyer wallet has insufficient test USDC",
        {
          statusCode: 409,
          details: {
            address: this.account.address,
            requiredAtomic: input.amountAtomic,
            availableAtomic: balance.toString(),
          },
        },
      );
    }

    const signedPayloadReady = deferred<SignedPayloadState>();
    const paymentRelease = deferred<void>();
    let originalPaymentRequired: PaymentRequired | undefined;
    let validatedTerms: ValidatedPaymentTerms | undefined;
    let hookFailure: MelloError | undefined;

    const client = new x402Client().register(
      MELLO_NETWORK,
      new ExactEvmScheme(this.account),
    );
    client.onBeforePaymentCreation(async ({ paymentRequired, selectedRequirements }) => {
      try {
        originalPaymentRequired = structuredClone(paymentRequired);
        if (paymentRequired.x402Version !== 2) {
          throw new MelloError("X402_REQUIREMENTS_INVALID", "Seller must use x402 v2");
        }
        validatedTerms = validateLiveRequirementStructure(
          input,
          selectedRequirements,
          this.nowSeconds(),
        );
        validateInvoiceDeclaration(input, paymentRequired);
        const identifierDeclaration = paymentRequired.extensions?.["payment-identifier"];
        if (!isPaymentIdentifierRequired(identifierDeclaration)) {
          throw new MelloError(
            "X402_REQUIREMENTS_INVALID",
            "Seller must require the payment-identifier extension",
          );
        }
        const extensions = paymentRequired.extensions ?? {};
        appendPaymentIdentifierToExtensions(extensions, input.paymentId);
        paymentRequired.extensions = extensions;
        await input.onLivePaymentTerms?.(validatedTerms);
        // A provider remains fail-closed even when a caller omits or
        // accidentally weakens its policy callback.
        validatePaymentTerms(
          {
            network: input.network,
            tokenAddress: input.tokenAddress,
            from: input.payerAddress,
            to: input.payToAddress,
            value: input.amountAtomic,
          },
          {
            network: validatedTerms.network,
            tokenAddress: validatedTerms.tokenAddress,
            from: input.payerAddress,
            to: validatedTerms.payToAddress,
            value: validatedTerms.amountAtomic,
          },
        );
        if (
          input.expectedFacilitatorUrl &&
          validatedTerms.facilitatorUrl !==
            input.expectedFacilitatorUrl.replace(/\/$/u, "")
        ) {
          throw new MelloError(
            "X402_REQUIREMENTS_INVALID",
            "Seller facilitator declaration does not match the approved configuration",
          );
        }
      } catch (error: unknown) {
        hookFailure = toMelloPaymentError(error);
        signedPayloadReady.reject(hookFailure);
        throw hookFailure;
      }
    });
    client.onAfterPaymentCreation(async ({ paymentPayload, selectedRequirements }) => {
      try {
        validatedTerms = validateLiveRequirementStructure(
          input,
          selectedRequirements,
          this.nowSeconds(),
        );
        const extensionPaymentId = extractPaymentIdentifier(paymentPayload);
        if (extensionPaymentId !== input.paymentId) {
          throw new MelloError(
            "X402_REQUIREMENTS_INVALID",
            "Signed payload is missing the approved payment identifier",
          );
        }
        const exact = ExactAuthorizationPayloadSchema.parse(paymentPayload.payload);
        validatePaymentTerms(
          {
            network: input.network,
            tokenAddress: input.tokenAddress,
            from: input.payerAddress,
            to: input.payToAddress,
            value: input.amountAtomic,
          },
          {
            network: selectedRequirements.network,
            tokenAddress: selectedRequirements.asset as `0x${string}`,
            from: exact.authorization.from as `0x${string}`,
            to: exact.authorization.to as `0x${string}`,
            value: exact.authorization.value,
          },
        );
        const authorization = recordSignedAuthorization({
          purchaseId: input.purchaseId,
          paymentId: extensionPaymentId,
          network: input.network,
          tokenAddress: input.tokenAddress,
          from: exact.authorization.from as `0x${string}`,
          to: exact.authorization.to as `0x${string}`,
          value: exact.authorization.value,
          validAfter: exact.authorization.validAfter,
          validBefore: exact.authorization.validBefore,
          nonce: exact.authorization.nonce as `0x${string}`,
          signature: exact.signature as `0x${string}`,
          eip712Name: String(selectedRequirements.extra["name"]),
          eip712Version: String(selectedRequirements.extra["version"]),
        });
        if (
          authorization.validBefore >
            this.nowSeconds() + BigInt(input.authorizationTtlSeconds) ||
          authorization.validBefore > input.maximumValidBefore
        ) {
          throw new MelloError(
            "X402_REQUIREMENTS_INVALID",
            "Signed authorization is valid beyond the approved TTL or purchase mandate",
          );
        }
        assertAuthorizationUsable(authorization, this.nowSeconds());
        signedPayloadReady.resolve({ paymentPayload, authorization });
        await paymentRelease.promise;
      } catch (error: unknown) {
        hookFailure = toMelloPaymentError(error);
        signedPayloadReady.reject(hookFailure);
        throw hookFailure;
      }
    });

    const httpClient = new x402HTTPClient(client);
    const paidFetch = wrapFetchWithPayment(this.fetchImplementation, client);
    const requestPromise = paidFetch(input.endpoint, {
      method: "POST",
      redirect: "error",
      headers: {
        "content-type": "application/json",
        "x-mello-task-id": input.taskId,
        ...(input.requestId ? { "x-request-id": input.requestId } : {}),
      },
      body: JSON.stringify({
        targetCompanyName: input.targetCompanyName,
        purchaseContextToken: input.purchaseContextToken,
      }),
    });
    void requestPromise.then(
      () => {
        signedPayloadReady.reject(
          new MelloError(
            "X402_REQUIREMENTS_INVALID",
            "Seller returned without creating an x402 payment authorization",
          ),
        );
      },
      (error: unknown) => signedPayloadReady.reject(hookFailure ?? toMelloPaymentError(error)),
    );
    // Prevent a rejected transport from becoming an unhandled promise while the
    // workflow is persisting and anchoring the authorization evidence.
    void requestPromise.catch(() => undefined);

    const { authorization } = await signedPayloadReady.promise;
    if (!originalPaymentRequired || !validatedTerms) {
      throw new MelloError("X402_REQUIREMENTS_INVALID", "PAYMENT-REQUIRED was not captured");
    }
    const authorizationHash = authorizationEvidenceHash(authorization);
    let submitted = false;
    let cancelled = false;

    return {
      authorization,
      authorizationHash,
      paymentRequired: originalPaymentRequired,
      validatedTerms,
      cancel: (reason = "Paid request cancelled before submission") => {
        if (submitted || cancelled) return;
        cancelled = true;
        paymentRelease.reject(new MelloError("CONTRACT_ANCHOR_FAILED", reason));
      },
      submit: async (hooks: PaymentSubmissionHooks = {}): Promise<PaymentSettlement> => {
        if (submitted || cancelled) {
          throw new MelloError(
            "X402_PAYMENT_FAILED",
            submitted ? "Payment was already submitted" : "Payment was cancelled",
            { statusCode: 409 },
          );
        }
        assertAuthorizationUsable(authorization, this.nowSeconds());
        try {
          await hooks.onBeforePaidRequest?.();
        } catch (error: unknown) {
          cancelled = true;
          paymentRelease.reject(error);
          throw error;
        }
        submitted = true;
        paymentRelease.resolve();
        await hooks.onPaidRequestReleased?.();

        let response: Response;
        try {
          response = await requestPromise;
        } catch (error: unknown) {
          throw toMelloPaymentError(error);
        }
        const parsed = await httpClient.processResponse(response);
        const settlement = parsed.header;
        if (
          response.status < 200 ||
          response.status >= 300 ||
          parsed.paymentStatus !== "settled" ||
          !settlement ||
          !("success" in settlement) ||
          !settlement.success
        ) {
          throw new MelloError(
            "X402_PAYMENT_FAILED",
            "Seller did not return a successful x402 settlement",
            {
              retryable: true,
              details: { status: response.status, paymentStatus: parsed.paymentStatus },
            },
          );
        }
        if (settlement.network !== input.network) {
          throw new MelloError("X402_PAYMENT_FAILED", "Settlement network mismatch");
        }
        if (!/^0x[a-fA-F0-9]{64}$/.test(settlement.transaction)) {
          throw new MelloError("X402_PAYMENT_FAILED", "Settlement transaction hash is invalid");
        }
        const transactionHash = settlement.transaction as `0x${string}`;
        const settledPayment = {
          paymentId: input.paymentId,
          transactionHash,
          payerAddress: input.payerAddress,
          payeeAddress: input.payToAddress,
          amountAtomic: input.amountAtomic,
          network: input.network,
          tokenAddress: input.tokenAddress,
          paymentResponse: settlement,
        };
        let report: PaymentSettlement["report"] | undefined;
        let deliveryError: MelloError | undefined;
        try {
          validateInvoiceSettlement(input, settlement);
          const parsedReport = PaymentSettlementReportSchema.safeParse(parsed.body);
          if (!parsedReport.success) {
            throw new MelloError(
              "SERVICE_DELIVERY_FAILED",
              "Seller returned an invalid credit report after payment settled",
              { details: parsedReport.error.issues },
            );
          }
          if (
            parsedReport.data.targetCompanyName !== input.targetCompanyName ||
            parsedReport.data.provider !== input.sellerId
          ) {
            throw new MelloError(
              "SERVICE_DELIVERY_FAILED",
              "Seller report does not match the request",
            );
          }
          report = parsedReport.data;
        } catch (error: unknown) {
          deliveryError =
            error instanceof MelloError
              ? error
              : new MelloError(
                  "SERVICE_DELIVERY_FAILED",
                  "Seller delivery could not be validated after settlement",
                );
        }
        let verifiedChainId: number | undefined;
        try {
          await this.settlementReceiptVerifier.verify({
            transactionHash,
            tokenAddress: getAddress(input.tokenAddress),
            payerAddress: getAddress(input.payerAddress),
            payeeAddress: getAddress(input.payToAddress),
            amountAtomic: input.amountAtomic,
          });
          verifiedChainId = await this.readVerifiedChainId();
          if (verifiedChainId !== baseSepolia.id) {
            throw new MelloError(
              "X402_PAYMENT_FAILED",
              "Settlement receipt was not verified on Base Sepolia",
            );
          }
        } catch (error: unknown) {
          throw new PendingSettlementVerificationError(
            "Seller reported settlement, but its Base Sepolia receipt is not yet verified",
            report ? { ...settledPayment, report } : settledPayment,
            error,
          );
        }
        const verifiedSettlement = {
          ...settledPayment,
          ...(verifiedChainId === undefined ? {} : { verifiedChainId }),
        };
        if (deliveryError || !report) {
          const normalized =
            deliveryError ??
            new MelloError(
              "SERVICE_DELIVERY_FAILED",
              "Seller delivery could not be validated after settlement",
            );
          throw new SettledPaymentDeliveryError(
            normalized.code === "X402_PAYMENT_FAILED"
              ? "X402_PAYMENT_FAILED"
              : "SERVICE_DELIVERY_FAILED",
            normalized.message,
            verifiedSettlement,
            { retryable: normalized.retryable, details: normalized.details },
          );
        }
        return { ...verifiedSettlement, report };
      },
    };
  }
}

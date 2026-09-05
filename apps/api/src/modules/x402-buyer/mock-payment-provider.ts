import { randomBytes } from "node:crypto";
import {
  authorizationEvidenceHash,
  buildAuthorizationRecord,
  validatePaymentTerms,
} from "./authorization.js";
import type {
  PaymentProvider,
  PaymentSettlement,
  PaymentSubmissionHooks,
  PreparePaymentInput,
  PreparedPayment,
  ValidatedPaymentTerms,
} from "./payment-provider.js";
import { PaymentSettlementReportSchema, reportMatchesRequest, reportRequestBody } from "./payment-provider.js";
import { assertAuthorizationTimeoutWithinPolicy } from "./payment-provider.js";
import {
  MelloError,
  hashCanonicalJson,
} from "@mello/shared";
import {
  TW_EINVOICE_EXTENSION_KEY,
  TwEinvoiceDeclarationSchema,
  TwEinvoiceSettlementMetadataSchema,
} from "@mello/tw-einvoice-extension";
import {
  decodePaymentRequiredHeader,
  decodePaymentResponseHeader,
} from "@x402/core/http";
import { isPaymentIdentifierRequired } from "@x402/extensions/payment-identifier";

export class MockPaymentProvider implements PaymentProvider {
  readonly mode = "mock" as const;

  constructor(
    private readonly payerAddress: `0x${string}` =
      "0x9999999999999999999999999999999999999999",
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImplementation: typeof globalThis.fetch = globalThis.fetch,
  ) {}

  async getAddress(): Promise<`0x${string}`> {
    return this.payerAddress;
  }

  async prepare(input: PreparePaymentInput): Promise<PreparedPayment> {
    const requestBody = JSON.stringify(reportRequestBody(input));
    let unpaidResponse: Response;
    try {
      unpaidResponse = await this.fetchImplementation(input.endpoint, {
        method: "POST",
        redirect: "error",
        headers: {
          "content-type": "application/json",
          "x-mello-task-id": input.taskId,
          ...(input.requestId ? { "x-request-id": input.requestId } : {}),
        },
        body: requestBody,
      });
    } catch {
      throw new MelloError(
        "X402_PAYMENT_FAILED",
        "Mock seller is unreachable",
        { retryable: true },
      );
    }
    const paymentRequiredHeader = unpaidResponse.headers.get("payment-required");
    if (unpaidResponse.status !== 402 || !paymentRequiredHeader) {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller did not return a valid PAYMENT-REQUIRED response",
      );
    }
    const paymentRequired = decodePaymentRequiredHeader(paymentRequiredHeader);
    if (paymentRequired.x402Version !== 2) {
      throw new MelloError("X402_REQUIREMENTS_INVALID", "Mock seller must use x402 v2");
    }
    const requirements = paymentRequired.accepts.find(
      (candidate) => candidate.scheme === "exact",
    );
    if (!requirements) {
      throw new MelloError("X402_REQUIREMENTS_INVALID", "Mock seller omitted exact payment terms");
    }
    if (requirements.extra?.["assetTransferMethod"] !== "eip3009") {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller authorization terms exceed the approved ERC-3009 policy",
      );
    }
    if (
      requirements.extra?.["name"] !== "USDC" ||
      requirements.extra?.["version"] !== "2" ||
      requirements.extra?.["assetDecimals"] !== 6
    ) {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller asset must be 6-decimal USDC version 2",
      );
    }
    const facilitator = requirements.extra?.["facilitator"];
    if (facilitator !== undefined && typeof facilitator !== "string") {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller facilitator declaration is invalid",
      );
    }
    const validatedTerms: ValidatedPaymentTerms = {
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
    const nowSeconds = BigInt(Math.floor(this.now().getTime() / 1_000));
    assertAuthorizationTimeoutWithinPolicy(
      input,
      requirements.maxTimeoutSeconds,
      nowSeconds,
    );
    if (!isPaymentIdentifierRequired(paymentRequired.extensions?.["payment-identifier"])) {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller must require payment-identifier",
      );
    }
    if (input.requiresTwInvoice || input.sellerId === "seller-b") {
      const declaration = TwEinvoiceDeclarationSchema.safeParse(
        paymentRequired.extensions?.[TW_EINVOICE_EXTENSION_KEY],
      );
      if (!declaration.success || declaration.data.sellerProfileId !== input.sellerId) {
        throw new MelloError(
          "X402_REQUIREMENTS_INVALID",
          "Mock seller tw-einvoice declaration does not match the registry",
        );
      }
    }

    await input.onLivePaymentTerms?.(validatedTerms);
    // Preserve a provider-level fail-closed guard for callers that do not
    // supply the workflow's pre-signing policy callback.
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
      validatedTerms.facilitatorUrl !== input.expectedFacilitatorUrl.replace(/\/$/u, "")
    ) {
      throw new MelloError(
        "X402_REQUIREMENTS_INVALID",
        "Mock seller facilitator declaration does not match the approved configuration",
      );
    }

    const authorization = buildAuthorizationRecord({
      purchaseId: input.purchaseId,
      paymentId: input.paymentId,
      network: input.network,
      tokenAddress: input.tokenAddress,
      from: input.payerAddress,
      to: input.payToAddress,
      value: input.amountAtomic,
      ttlSeconds: requirements.maxTimeoutSeconds,
      nowSeconds,
      eip712Name: String(requirements.extra?.["name"] ?? "USDC"),
      eip712Version: String(requirements.extra?.["version"] ?? "2"),
      // A retry keeps paymentId for seller idempotency but must represent a
      // genuinely new ERC-3009 authorization. Never derive its nonce only from
      // stable purchase identifiers.
      nonce: `0x${randomBytes(32).toString("hex")}`,
    });
    const authorizationHash = authorizationEvidenceHash(authorization);
    let cancelled = false;
    let submitted = false;

    return {
      authorization,
      authorizationHash,
      paymentRequired,
      validatedTerms,
      cancel: () => {
        if (!submitted) cancelled = true;
      },
      submit: async (hooks: PaymentSubmissionHooks = {}): Promise<PaymentSettlement> => {
        if (cancelled || submitted) {
          throw new MelloError(
            "X402_PAYMENT_FAILED",
            cancelled ? "Mock payment was cancelled" : "Mock payment was already submitted",
            { statusCode: 409 },
          );
        }
        await hooks.onBeforePaidRequest?.();
        submitted = true;
        const paidResponsePromise = this.fetchImplementation(input.endpoint, {
          method: "POST",
          redirect: "error",
          headers: {
            "content-type": "application/json",
            "x-mello-mock-payment": "settled",
            "x-mello-payment-id": input.paymentId,
            "x-mello-task-id": input.taskId,
            ...(input.requestId ? { "x-request-id": input.requestId } : {}),
          },
          body: requestBody,
        });
        void paidResponsePromise.catch(() => undefined);
        await hooks.onPaidRequestReleased?.();
        const paidResponse = await paidResponsePromise;
        const paymentResponseHeader = paidResponse.headers.get("payment-response");
        if (!paidResponse.ok || !paymentResponseHeader) {
          throw new MelloError(
            "X402_PAYMENT_FAILED",
            `Mock seller settlement failed with HTTP ${paidResponse.status}`,
            { retryable: paidResponse.status >= 500 },
          );
        }
        const paymentResponse = decodePaymentResponseHeader(paymentResponseHeader);
        if (!paymentResponse.success || paymentResponse.network !== input.network) {
          throw new MelloError("X402_PAYMENT_FAILED", "Mock settlement response is invalid");
        }
        if (input.requiresTwInvoice || input.sellerId === "seller-b") {
          const invoiceMetadata = TwEinvoiceSettlementMetadataSchema.safeParse(
            paymentResponse.extensions?.[TW_EINVOICE_EXTENSION_KEY],
          );
          if (!invoiceMetadata.success || invoiceMetadata.data.sellerProfileId !== input.sellerId) {
            throw new MelloError(
              "X402_PAYMENT_FAILED",
              "Mock settlement omitted tw-einvoice metadata",
            );
          }
        }
        const report = PaymentSettlementReportSchema.parse(await paidResponse.json());
        if (!reportMatchesRequest(report, input)) {
          throw new MelloError("SERVICE_DELIVERY_FAILED", "Mock seller report mismatch");
        }
        const transactionHash = hashCanonicalJson({
          schemaVersion: "mock-settlement-2",
          purchaseId: input.purchaseId,
          paymentId: input.paymentId,
          authorizationHash,
          sellerTransaction: paymentResponse.transaction,
        });
        return {
          paymentId: input.paymentId,
          transactionHash,
          payerAddress: input.payerAddress,
          payeeAddress: input.payToAddress,
          amountAtomic: input.amountAtomic,
          network: input.network,
          tokenAddress: input.tokenAddress,
          paymentResponse,
          report,
        };
      },
    };
  }
}

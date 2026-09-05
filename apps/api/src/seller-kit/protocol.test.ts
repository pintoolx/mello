import { encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload } from "@x402/core/types";
import {
  appendPaymentIdentifierToExtensions,
  declarePaymentIdentifierExtension,
  PAYMENT_IDENTIFIER,
} from "@x402/extensions/payment-identifier";
import { describe, expect, it } from "vitest";
import { extractRequiredPaymentIdentifier } from "./protocol.js";

function paymentPayload(): PaymentPayload {
  return {
    x402Version: 2,
    resource: {
      url: "http://localhost:4012/v1/credit-report",
      description: "Mello Seller B demo credit report",
      mimeType: "application/json",
    },
    accepted: {
      scheme: "exact",
      network: "eip155:84532",
      asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
      amount: "50000",
      payTo: "0x3333333333333333333333333333333333333333",
      maxTimeoutSeconds: 300,
      extra: {
        name: "USDC",
        version: "2",
        assetTransferMethod: "eip3009",
      },
    },
    payload: { signature: "0xdemo" },
  };
}

describe("x402 payment identifier extraction", () => {
  it("accepts a valid required payment-identifier echo", () => {
    const payload = paymentPayload();
    const extensions = {
      [PAYMENT_IDENTIFIER]: declarePaymentIdentifierExtension(true),
    };
    appendPaymentIdentifierToExtensions(extensions, "pay_protocol_test_000001");
    payload.extensions = extensions;

    expect(
      extractRequiredPaymentIdentifier(encodePaymentSignatureHeader(payload)),
    ).toMatchObject({
      ok: true,
      paymentId: "pay_protocol_test_000001",
    });
  });

  it("rejects malformed signatures and missing identifiers before settlement", () => {
    expect(extractRequiredPaymentIdentifier("not-base64-json")).toEqual({
      ok: false,
      code: "INVALID_PAYMENT_SIGNATURE",
    });
    expect(
      extractRequiredPaymentIdentifier(
        encodePaymentSignatureHeader(paymentPayload()),
      ),
    ).toEqual({
      ok: false,
      code: "PAYMENT_IDENTIFIER_REQUIRED",
    });
  });
});

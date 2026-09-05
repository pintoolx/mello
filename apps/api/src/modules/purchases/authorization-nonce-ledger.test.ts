import type { PrismaClient } from "@mello/db";
import { describe, expect, it, vi } from "vitest";
import {
  isAuthorizationNonceReuseError,
  withAuthorizationNonceReservation,
} from "./authorization-nonce-ledger.js";

const PURCHASE_ID = "00000000-0000-4000-8000-000000000010";
const PAYMENT_ID = "payment_nonce_ledger_0001";
const NOW = new Date("2030-01-01T00:00:00.000Z");
const nonce = (character: string): string => `0x${character.repeat(64)}`;

function uniqueNonceError(): Error & {
  code: string;
  meta: { modelName: string; target: string[] };
} {
  return Object.assign(new Error("unique constraint"), {
    code: "P2002",
    meta: {
      modelName: "PaymentAuthorizationNonce",
      target: ["nonce"],
    },
  });
}

describe("authorization nonce ledger", () => {
  it("preserves A and B and rejects A replay before overwriting current evidence", async () => {
    const history = new Set<string>();
    let currentNonce: string | null = null;
    const transaction = {
      paymentAuthorizationNonce: {
        create: vi.fn(async ({ data }: { data: { nonce: string } }) => {
          if (history.has(data.nonce)) throw uniqueNonceError();
          history.add(data.nonce);
          return data;
        }),
      },
    };
    const prisma = {
      $transaction: vi.fn(
        async (
          operation: (client: typeof transaction) => Promise<unknown>,
        ): Promise<unknown> => operation(transaction),
      ),
    } as unknown as PrismaClient;
    const persist = (nextNonce: string, typedDataHash: string) =>
      withAuthorizationNonceReservation(
        prisma,
        {
          purchaseId: PURCHASE_ID,
          paymentId: PAYMENT_ID,
          nonce: nextNonce,
          typedDataHash,
          createdAt: NOW,
        },
        async (_client, normalizedNonce) => {
          currentNonce = normalizedNonce;
        },
      );

    await persist(nonce("A"), nonce("1"));
    await persist(nonce("b"), nonce("2"));
    await expect(persist(nonce("a"), nonce("3"))).rejects.toMatchObject({
      code: "ERC3009_NONCE_REUSED",
      statusCode: 409,
      retryable: false,
    });

    expect([...history]).toEqual([nonce("a"), nonce("b")]);
    expect(currentNonce).toBe(nonce("b"));
  });

  it("only maps the nonce-ledger unique violation", () => {
    expect(isAuthorizationNonceReuseError(uniqueNonceError())).toBe(true);
    expect(
      isAuthorizationNonceReuseError(
        Object.assign(new Error("other unique"), {
          code: "P2002",
          meta: { modelName: "Purchase", target: ["paymentId"] },
        }),
      ),
    ).toBe(false);
    expect(isAuthorizationNonceReuseError(new Error("network"))).toBe(false);
  });
});

import { randomBytes } from "node:crypto";
import type { Erc3009AuthorizationRecord } from "@mello/shared";
import {
  Erc3009AuthorizationRecordSchema,
  MELLO_CHAIN_ID,
  MELLO_NETWORK,
  MelloError,
  hashCanonicalJson,
} from "@mello/shared";
import { hashTypedData, keccak256, type Hex } from "viem";

const TRANSFER_WITH_AUTHORIZATION_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export interface ApprovedPaymentTerms {
  network: string;
  tokenAddress: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
}

export interface AuthorizationBuildInput extends ApprovedPaymentTerms {
  purchaseId: string;
  paymentId: string;
  ttlSeconds: number;
  nowSeconds?: bigint;
  nonce?: `0x${string}`;
  eip712Name?: string;
  eip712Version?: string;
}

export interface SignedAuthorizationInput extends ApprovedPaymentTerms {
  purchaseId: string;
  paymentId: string;
  validAfter: string;
  validBefore: string;
  nonce: `0x${string}`;
  signature: `0x${string}`;
  eip712Name: string;
  eip712Version: string;
}

function typedDataHashForAuthorization(input: {
  tokenAddress: `0x${string}`;
  from: `0x${string}`;
  to: `0x${string}`;
  value: string;
  validAfter: bigint;
  validBefore: bigint;
  nonce: `0x${string}`;
  eip712Name: string;
  eip712Version: string;
}): `0x${string}` {
  return hashTypedData({
    domain: {
      name: input.eip712Name,
      version: input.eip712Version,
      chainId: MELLO_CHAIN_ID,
      verifyingContract: input.tokenAddress,
    },
    primaryType: "TransferWithAuthorization",
    types: TRANSFER_WITH_AUTHORIZATION_TYPES,
    message: {
      from: input.from,
      to: input.to,
      value: BigInt(input.value),
      validAfter: input.validAfter,
      validBefore: input.validBefore,
      nonce: input.nonce,
    },
  });
}

export function validatePaymentTerms(
  approved: ApprovedPaymentTerms,
  offered: ApprovedPaymentTerms,
): void {
  const mismatches: string[] = [];
  if (approved.network !== offered.network) mismatches.push("network");
  if (approved.tokenAddress.toLowerCase() !== offered.tokenAddress.toLowerCase()) {
    mismatches.push("token");
  }
  if (approved.from.toLowerCase() !== offered.from.toLowerCase()) mismatches.push("from");
  if (approved.to.toLowerCase() !== offered.to.toLowerCase()) mismatches.push("to");
  if (approved.value !== offered.value) mismatches.push("value");
  if (mismatches.length > 0) {
    throw new MelloError(
      "ERC3009_TERMS_MISMATCH",
      `Payment authorization differs from approved terms: ${mismatches.join(", ")}`,
      { details: { mismatches } },
    );
  }
}

export function buildAuthorizationRecord({
  purchaseId,
  paymentId,
  network,
  tokenAddress,
  from,
  to,
  value,
  ttlSeconds,
  nowSeconds = BigInt(Math.floor(Date.now() / 1_000)),
  nonce = `0x${randomBytes(32).toString("hex")}`,
  eip712Name = "USD Coin",
  eip712Version = "2",
}: AuthorizationBuildInput): Erc3009AuthorizationRecord {
  if (ttlSeconds < 30) throw new Error("ERC-3009 authorization TTL must be at least 30 seconds");
  if (network !== MELLO_NETWORK) {
    throw new MelloError("ERC3009_TERMS_MISMATCH", "Unsupported ERC-3009 network", {
      details: { network },
    });
  }
  const validAfter = nowSeconds - 1n;
  const validBefore = nowSeconds + BigInt(ttlSeconds);
  const eip712Domain = {
    name: eip712Name,
    version: eip712Version,
    chainId: MELLO_CHAIN_ID,
    verifyingContract: tokenAddress,
  } as const;
  const typedDataHash = typedDataHashForAuthorization({
    tokenAddress,
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    eip712Name,
    eip712Version,
  });

  return Erc3009AuthorizationRecordSchema.parse({
    purchaseId,
    paymentId,
    tokenAddress,
    from,
    to,
    value,
    validAfter,
    validBefore,
    nonce,
    eip712Domain,
    typedDataHash,
    status: "CREATED",
  });
}

/**
 * Converts the SDK-created exact/EIP-3009 payload into durable evidence while
 * deliberately retaining only a hash of the short-lived signature.
 */
export function recordSignedAuthorization(
  input: SignedAuthorizationInput,
): Erc3009AuthorizationRecord {
  if (input.network !== MELLO_NETWORK) {
    throw new MelloError("ERC3009_TERMS_MISMATCH", "Unsupported ERC-3009 network", {
      details: { network: input.network },
    });
  }
  if (!/^0x[a-fA-F0-9]{130}$/.test(input.signature)) {
    throw new MelloError("X402_REQUIREMENTS_INVALID", "Invalid ERC-3009 signature");
  }
  const validAfter = BigInt(input.validAfter);
  const validBefore = BigInt(input.validBefore);
  if (validAfter < 0n || validBefore <= validAfter) {
    throw new MelloError("X402_REQUIREMENTS_INVALID", "Invalid ERC-3009 validity window");
  }
  const typedDataHash = typedDataHashForAuthorization({
    tokenAddress: input.tokenAddress,
    from: input.from,
    to: input.to,
    value: input.value,
    validAfter,
    validBefore,
    nonce: input.nonce,
    eip712Name: input.eip712Name,
    eip712Version: input.eip712Version,
  });

  return Erc3009AuthorizationRecordSchema.parse({
    purchaseId: input.purchaseId,
    paymentId: input.paymentId,
    tokenAddress: input.tokenAddress,
    from: input.from,
    to: input.to,
    value: input.value,
    validAfter,
    validBefore,
    nonce: input.nonce,
    eip712Domain: {
      name: input.eip712Name,
      version: input.eip712Version,
      chainId: MELLO_CHAIN_ID,
      verifyingContract: input.tokenAddress,
    },
    typedDataHash,
    signatureHash: keccak256(input.signature as Hex),
    status: "SIGNED",
  });
}

export function authorizationEvidenceHash(
  authorization: Erc3009AuthorizationRecord,
): `0x${string}` {
  return hashCanonicalJson({
    schemaVersion: "1",
    purchaseId: authorization.purchaseId,
    paymentId: authorization.paymentId,
    standard: "ERC3009",
    scheme: "exact",
    network: authorization.eip712Domain.chainId,
    tokenAddress: authorization.tokenAddress,
    from: authorization.from,
    to: authorization.to,
    value: authorization.value,
    validAfter: authorization.validAfter.toString(),
    validBefore: authorization.validBefore.toString(),
    nonce: authorization.nonce,
    typedDataHash: authorization.typedDataHash,
    signatureHash: authorization.signatureHash ?? null,
  });
}

export function assertAuthorizationUsable(
  authorization: Erc3009AuthorizationRecord,
  nowSeconds = BigInt(Math.floor(Date.now() / 1_000)),
): void {
  if (authorization.status === "SETTLED") {
    throw new MelloError("ERC3009_NONCE_REUSED", "ERC-3009 nonce was already settled", {
      statusCode: 409,
    });
  }
  if (nowSeconds >= authorization.validBefore) {
    throw new MelloError("ERC3009_AUTH_EXPIRED", "ERC-3009 authorization expired", {
      statusCode: 409,
    });
  }
}

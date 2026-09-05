import { isIP } from "node:net";
import { hashCanonicalJson, type ServiceRecord } from "@mello/shared";
import { z } from "zod";

export const VerificationScopeSchema = z.enum([
  "ENDPOINT_CONTROL", "PAYMENT_WALLET_CONTROL", "DEMO_INVOICE_INTEGRATION",
]);
export const VerifyServiceSchema = z.object({
  expectedBindingHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  scopes: z.array(VerificationScopeSchema).min(2).max(3)
    .refine((values) => new Set(values).size === values.length, "Duplicate review scopes"),
  // Internal review-ticket reference, never raw credentials or uploaded evidence.
  evidenceRef: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{2,199}$/),
  expiresAt: z.iso.datetime(),
}).strict();
export type VerifyServiceInput = z.infer<typeof VerifyServiceSchema>;

export const UpdateServiceBindingSchema = z.object({
  expectedBindingHash: z.string().regex(/^0x[0-9a-f]{64}$/),
  endpoint: z.string().max(2048).refine(isPublicServiceEndpoint, "Requires a canonical public HTTPS endpoint"),
  priceAtomic: z.string().regex(/^[1-9]\d{0,77}$/),
}).strict();

export interface VerificationRecord {
  revision: number;
  status: string;
  bindingHash: string;
  scopes: unknown;
  reviewedAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
}

// Only reviewed public HTTPS route identities are eligible for Bazaar. Queries,
// credentials, fragments, IP literals and local/internal names are not identities.
// The registry reviewer must verify domain ownership and public DNS/egress too.
export function isPublicServiceEndpoint(endpoint: string): boolean {
  try {
    const url = new URL(endpoint);
    return url.protocol === "https:" && !url.username && !url.password &&
      !url.search && !url.hash && (!url.port || url.port === "443") &&
      !isIP(url.hostname.replace(/^\[|\]$/g, "")) && url.hostname.includes(".") &&
      !/(?:^|\.)(?:localhost|local|internal|test|invalid|home|lan|onion)\.?$/i.test(url.hostname) &&
      !url.hostname.endsWith(".") && url.href === endpoint;
  } catch { return false; }
}

export function serviceBinding(service: ServiceRecord) {
  return {
    schemaVersion: "mello-service-binding/1",
    sellerId: service.sellerId,
    sellerLegalName: service.sellerLegalName,
    sellerBusinessId: service.sellerBusinessId,
    serviceId: service.id,
    category: service.category,
    endpoint: service.endpoint,
    method: service.method,
    payTo: service.payToAddress.toLowerCase(),
    network: service.network,
    asset: service.tokenAddress.toLowerCase(),
    tokenDecimals: service.tokenDecimals,
    scheme: "exact",
    invoiceCapability: service.invoiceCapability,
    invoiceProvider: service.invoiceProvider,
    supportsTwInvoice: service.supportsTwInvoice,
  };
}

export function serviceBindingHash(service: ServiceRecord): string {
  return hashCanonicalJson(serviceBinding(service));
}

export function verificationSummary(
  service: ServiceRecord, record: VerificationRecord | null | undefined, now = new Date(),
) {
  const bindingHash = serviceBindingHash(service);
  let status = "UNREVIEWED";
  if (record) {
    if (record.status === "REVOKED" || record.revokedAt) status = "REVOKED";
    else if (record.status !== "VERIFIED") status = "UNREVIEWED";
    else if (record.expiresAt <= now || record.reviewedAt > now) status = "EXPIRED";
    else if (record.bindingHash !== bindingHash) status = "BINDING_CHANGED";
    else if (!isPublicServiceEndpoint(service.endpoint)) status = "INVALID_ENDPOINT";
    else {
      const scopes = z.array(VerificationScopeSchema).safeParse(record.scopes);
      status = scopes.success && scopes.data.includes("ENDPOINT_CONTROL") &&
        scopes.data.includes("PAYMENT_WALLET_CONTROL") &&
        (!service.supportsTwInvoice || scopes.data.includes("DEMO_INVOICE_INTEGRATION"))
        ? "VERIFIED" : "SCOPE_INCOMPLETE";
    }
  }
  return {
    status, bindingHash, revision: record?.revision ?? null,
    scopes: record?.scopes ?? [],
    reviewedAt: record?.reviewedAt.toISOString() ?? null,
    expiresAt: record?.expiresAt.toISOString() ?? null,
    revokedAt: record?.revokedAt?.toISOString() ?? null,
    certificationLevel: "MANUAL_SCOPED_REVIEW" as const,
  };
}

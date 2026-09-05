import type { Prisma, PrismaClient } from "@mello/db";
import { getMarketService, hashCanonicalJson, MelloError, SERVICE_CATEGORIES, serviceDiscoveryQuery, ServiceRecordSchema, type ServiceCategory, type ServiceRecord } from "@mello/shared";
import { appendAuditEvent } from "../audit/index.js";
import { type BazaarDiscovery, type BazaarResource, type BazaarResult } from "./bazaar-client.js";
import { isPublicServiceEndpoint, serviceBindingHash, verificationSummary, type VerifyServiceInput, type VerificationRecord } from "./verification.js";

export function normalizeRegistryService(service: {
  id: string;
  sellerId: string;
  category: string;
  seller: { legalName: string; businessId: string | null; payToAddress: string; invoiceCapability: string; invoiceProvider: string; status: string };
  active: boolean;
}) {
  const normalized = ServiceRecordSchema.parse({
    ...service, sellerLegalName: service.seller.legalName,
    sellerBusinessId: service.seller.businessId, payToAddress: service.seller.payToAddress,
    invoiceCapability: service.seller.invoiceCapability, invoiceProvider: service.seller.invoiceProvider,
    active: service.active && service.seller.status === "ACTIVE",
  });
  const product = getMarketService(normalized.id);
  return product?.sellerId === normalized.sellerId && product.category === normalized.category ? {
    ...normalized, displayName: product.displayName, sellerDisplayName: product.sellerDisplayName, description: product.description,
  } : normalized;
}

export function matchingBazaarResource(service: ServiceRecord, resource: BazaarResource): boolean {
  return resource.resource === service.endpoint && resource.extensions.bazaar.info.input.method === service.method &&
    advertisesServiceInput(service, resource) &&
    resource.accepts.some((offer) => offer.scheme === "exact" && offer.network === service.network &&
      offer.asset.toLowerCase() === service.tokenAddress.toLowerCase() &&
      offer.payTo.toLowerCase() === service.payToAddress.toLowerCase() &&
      BigInt(offer.amount) === BigInt(service.priceAtomic));
}

function object(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function advertisesServiceInput(service: ServiceRecord, resource: BazaarResource): boolean {
  if (service.category === "credit_report") return true;
  const schema = object(resource.extensions.bazaar.schema);
  const input = object(object(schema["properties"])["input"]);
  const body = object(object(input["properties"])["body"]);
  const alternatives = body["oneOf"];
  if (!Array.isArray(alternatives) || alternatives.length > 16) return false;
  return alternatives.some((value: unknown) => {
    const branch = object(value);
    const properties = object(branch["properties"]);
    const query = object(properties["serviceQuery"]);
    const required = branch["required"];
    return branch["type"] === "object" && Array.isArray(required) &&
      ["serviceId", "serviceCategory", "serviceQuery"].every((name) => required.includes(name)) &&
      object(properties["serviceId"])["const"] === service.id &&
      object(properties["serviceCategory"])["const"] === service.category &&
      query["type"] === "string" && typeof query["minLength"] === "number" && query["minLength"] >= 1 &&
      typeof query["maxLength"] === "number" && query["maxLength"] <= 200;
  });
}

export interface DiscoveryEvidence {
  source: "cdp_bazaar" | "local_registry";
  fetchedAt: string;
  partialResults: boolean;
  resource: string;
  resourceHash: string;
  serviceId: string;
  bindingHash: string;
  verificationRevision: number | null;
  verificationExpiresAt: string | null;
  requiresCertification?: boolean;
  amountAtomic: string;
}

export function assessDiscovery(
  service: ServiceRecord, verification: VerificationRecord | null | undefined,
  result: BazaarResult, now = new Date(), requiresCertification = true,
) {
  const review = verificationSummary(service, verification, now);
  const resource = result.resources.find((item) => matchingBazaarResource(service, item));
  const reasons: string[] = [];
  if (requiresCertification && review.status !== "VERIFIED") reasons.push(`VERIFICATION_${review.status}`);
  if (!service.active) reasons.push("SERVICE_INACTIVE");
  if (!resource) reasons.push("BAZAAR_SERVICE_NOT_FOUND_OR_CHANGED");
  const evidence: DiscoveryEvidence | null = reasons.length === 0 && resource ? {
    source: "cdp_bazaar", fetchedAt: result.fetchedAt, partialResults: result.partialResults,
    resource: resource.resource, resourceHash: hashCanonicalJson(resource), serviceId: service.id,
    bindingHash: review.bindingHash, verificationRevision: verification?.revision ?? null,
    verificationExpiresAt: verification?.expiresAt.toISOString() ?? null, amountAtomic: service.priceAtomic,
    requiresCertification,
  } : null;
  return { serviceId: service.id, verification: review, listed: Boolean(resource), reasonCodes: reasons, evidence };
}

export class ServiceRegistry {
  constructor(private readonly prisma: PrismaClient, private readonly bazaar: BazaarDiscovery, private readonly now = () => new Date()) {}

  async records(category?: ServiceCategory) {
    return this.prisma.service.findMany({
      where: { category: category ?? { in: [...SERVICE_CATEGORIES] } }, orderBy: { id: "asc" }, include: { seller: true, verification: true },
    });
  }

  async list(category?: ServiceCategory) {
    const records = await this.records(category);
    return records.map((record) => {
      const service = normalizeRegistryService(record);
      return { ...service, verification: verificationSummary(service, record.verification, this.now()) };
    }).filter((service) => service.active);
  }

  async discover(requiresCertification = true, category?: ServiceCategory) {
    // Discovery is the candidate source; local rows only provide identity/trust.
    // Never send the purchase prompt or target company to this public catalog.
    const result = await this.bazaar.search({ query: serviceDiscoveryQuery(category) });
    const records = await this.records(category);
    const services = records.map(normalizeRegistryService);
    const assessments = services.map((service, index) => assessDiscovery(service, records[index]?.verification, result, this.now(), requiresCertification));
    return {
      source: result.source, fetchedAt: result.fetchedAt, partialResults: result.partialResults,
      discoveredResourceCount: result.resources.length, rejectedResourceCount: result.rejectedResourceCount,
      unregisteredResourceCount: result.resources.filter((resource) => !services.some((service) => matchingBazaarResource(service, resource))).length,
      services, assessments,
    };
  }

  async discoverLocal(requiresCertification: boolean, category?: ServiceCategory) {
    const records = await this.records(category);
    const services = records.map(normalizeRegistryService);
    const fetchedAt = this.now().toISOString();
    const assessments = services.map((service, index) => {
      const verification = verificationSummary(service, records[index]?.verification, this.now());
      const reasonCodes: string[] = [];
      if (!service.active) reasonCodes.push("SERVICE_INACTIVE");
      if (requiresCertification && verification.status !== "VERIFIED") reasonCodes.push(`VERIFICATION_${verification.status}`);
      const evidence: DiscoveryEvidence | null = reasonCodes.length ? null : {
        source: "local_registry", fetchedAt, partialResults: false, resource: service.endpoint,
        resourceHash: hashCanonicalJson(service), serviceId: service.id, bindingHash: verification.bindingHash,
        verificationRevision: verification.revision, verificationExpiresAt: verification.expiresAt,
        amountAtomic: service.priceAtomic, requiresCertification,
      };
      return { serviceId: service.id, verification, listed: service.active, reasonCodes, evidence };
    });
    return { source: "local_registry" as const, fetchedAt, partialResults: false,
      discoveredResourceCount: services.length, rejectedResourceCount: 0, unregisteredResourceCount: 0,
      services, assessments };
  }

  async verify(serviceId: string, input: VerifyServiceInput, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${serviceId}`}, 0)) IS NULL AS acquired`;
      const record = await tx.service.findUnique({ where: { id: serviceId }, include: { seller: true, verification: true } });
      if (!record) throw new MelloError("NOT_FOUND", "Service not found", { statusCode: 404 });
      const service = normalizeRegistryService(record);
      const bindingHash = serviceBindingHash(service);
      if (bindingHash !== input.expectedBindingHash) throw new MelloError("SERVICE_BINDING_CHANGED", "服務資料已變更，請重新核對認證範圍。", { statusCode: 409 });
      const reviewedAt = this.now();
      const expiresAt = new Date(input.expiresAt);
      if (!service.active || !isPublicServiceEndpoint(service.endpoint) || expiresAt <= reviewedAt ||
        expiresAt.getTime() - reviewedAt.getTime() > 90 * 86400_000 ||
        !input.scopes.includes("ENDPOINT_CONTROL") || !input.scopes.includes("PAYMENT_WALLET_CONTROL") ||
        (service.supportsTwInvoice && !input.scopes.includes("DEMO_INVOICE_INTEGRATION"))) {
        throw new MelloError("VALIDATION_ERROR", "認證需要有效公開 HTTPS 服務、網域及收款控制權審核；期限為未來 90 天內，Demo 發票另需介接測試。", { statusCode: 400 });
      }
      const data = {
        status: "VERIFIED", bindingHash, scopes: input.scopes, evidenceRef: input.evidenceRef,
        reviewedBy: "demo-admin", reviewedAt, expiresAt, revokedAt: null, revokeReason: null,
      };
      const review = await tx.serviceVerification.upsert({
        where: { serviceId }, create: { serviceId, ...data },
        update: { ...data, revision: { increment: 1 } },
      });
      await appendAuditEvent(tx, {
        aggregateType: "SERVICE", aggregateId: serviceId, sellerId: service.sellerId, actorType: "ADMIN",
        eventType: "SERVICE_VERIFIED", requestId,
        payload: { ...data, revision: review.revision, previousRevision: record.verification?.revision ?? null, legalInvoiceCertified: false, enterpriseApprovalGranted: false },
      });
      return verificationSummary(service, review, reviewedAt);
    });
  }

  async updateBinding(serviceId: string, input: { expectedBindingHash: string; endpoint: string; priceAtomic: string }, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${serviceId}`}, 0)) IS NULL AS acquired`;
      const previous = await tx.service.findUnique({ where: { id: serviceId }, include: { seller: true } });
      if (!previous) throw new MelloError("NOT_FOUND", "Service not found", { statusCode: 404 });
      if (serviceBindingHash(normalizeRegistryService(previous)) !== input.expectedBindingHash) {
        throw new MelloError("SERVICE_BINDING_CHANGED", "服務已被更新，請重新讀取後再提交。", { statusCode: 409 });
      }
      const updated = await tx.service.update({ where: { id: serviceId },
        data: { endpoint: input.endpoint, priceAtomic: input.priceAtomic }, include: { seller: true, verification: true },
      });
      const service = normalizeRegistryService(updated);
      const verification = verificationSummary(service, updated.verification, this.now());
      await appendAuditEvent(tx, { aggregateType: "SERVICE", aggregateId: serviceId, actorType: "ADMIN",
        eventType: "SERVICE_BINDING_UPDATED", requestId, payload: {
          previousBindingHash: input.expectedBindingHash, bindingHash: verification.bindingHash,
          previousPriceAtomic: previous.priceAtomic, priceAtomic: service.priceAtomic,
          verificationStatus: verification.status, autoApproved: false,
        },
      });
      return { ...service, verification };
    });
  }

  async revoke(serviceId: string, reason: string, requestId?: string) {
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:verification:${serviceId}`}, 0)) IS NULL AS acquired`;
      const previous = await tx.serviceVerification.findUnique({ where: { serviceId } });
      if (!previous) throw new MelloError("NOT_FOUND", "Service verification not found", { statusCode: 404 });
      const review = await tx.serviceVerification.update({ where: { serviceId }, data: {
        status: "REVOKED", revokedAt: this.now(), revokeReason: reason, revision: { increment: 1 },
      } });
      await appendAuditEvent(tx, {
        aggregateType: "SERVICE", aggregateId: serviceId, actorType: "ADMIN", eventType: "SERVICE_VERIFICATION_REVOKED", requestId,
        payload: { revision: review.revision, previousRevision: previous.revision, reason },
      });
      return { serviceId, status: review.status, revision: review.revision, revokedAt: review.revokedAt };
    });
  }

  private async assertCurrentBinding(client: Prisma.TransactionClient, serviceId: string, evidence: DiscoveryEvidence) {
    const record = await client.service.findUnique({ where: { id: serviceId }, include: { seller: true, verification: true } });
    if (!record) throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "認證服務已不存在。", { statusCode: 409 });
    const service = normalizeRegistryService(record);
    const review = verificationSummary(service, record.verification, this.now());
    const requiresCertification = evidence.requiresCertification !== false;
    if ((requiresCertification && review.status !== "VERIFIED") || !service.active) throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "服務認證已失效或已停用；未釋出付款。", { statusCode: 409 });
    if (evidence.serviceId !== serviceId || evidence.bindingHash !== review.bindingHash ||
      (requiresCertification && evidence.verificationRevision !== review.revision) || evidence.resource !== service.endpoint ||
      BigInt(evidence.amountAtomic) !== BigInt(service.priceAtomic)) {
      throw new MelloError("SERVICE_BINDING_CHANGED", "服務、報價或認證版本已變更；請重新建立採購。", { statusCode: 409 });
    }
    return service;
  }

  async assertPurchasable(serviceId: string, evidence: DiscoveryEvidence): Promise<void> {
    const service = await this.assertCurrentBinding(this.prisma, serviceId, evidence);
    if (evidence.source === "local_registry") return;
    // Recheck through the same category search as discovery; endpoint-only
    // results may still contain an older input schema for the same resource.
    const result = await this.bazaar.search({
      query: serviceDiscoveryQuery(service.category),
      endpoint: service.endpoint,
      payTo: service.payToAddress,
    });
    if (!result.resources.some((resource) => matchingBazaarResource(service, resource))) {
      throw new MelloError("BAZAAR_SERVICE_NOT_FOUND", "Bazaar 已找不到原核准服務或付款條件已變更；未釋出付款。", { statusCode: 409 });
    }
    // A review can expire or be revoked while the network request is in flight.
    await this.assertCurrentBinding(this.prisma, serviceId, evidence);
  }

  private purchaseEvidence(value: unknown, required: boolean): DiscoveryEvidence | null {
    const raw = value as Partial<DiscoveryEvidence> | null;
    if (raw?.source !== "cdp_bazaar" && raw?.source !== "local_registry") {
      if (required) throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "舊案件沒有 Bazaar 認證證據，不能在 Bazaar 模式補付款。", { statusCode: 409 });
      return null;
    }
    if (required && raw.source !== "cdp_bazaar") {
      throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "此案件沒有 Bazaar 探索證據，請重新建立採購。", { statusCode: 409 });
    }
    if (typeof raw.resource !== "string" || typeof raw.bindingHash !== "string" || typeof raw.amountAtomic !== "string" ||
      !/^\d{1,78}$/.test(raw.amountAtomic) ||
      (raw.requiresCertification !== false && typeof raw.verificationRevision !== "number")) {
      throw new MelloError("SERVICE_VERIFICATION_REQUIRED", "Bazaar 認證證據不完整。", { statusCode: 409 });
    }
    return raw as DiscoveryEvidence;
  }

  async assertPurchase(purchaseId: string, required: boolean) {
    const purchase = await this.prisma.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
    const evidence = this.purchaseEvidence(purchase.discoveryEvidence, required);
    if (evidence) await this.assertPurchasable(purchase.serviceId, evidence);
  }

  // The local review check and payment-release permit share a short transaction.
  // Revocation before this cutoff wins; a granted permit is already in flight.
  // External discovery and the paid HTTP request must remain outside this lock.
  async withPurchaseRelease(purchaseId: string, required: boolean,
    grant: (tx: Prisma.TransactionClient) => Promise<void>, requestId?: string) {
    await this.prisma.$transaction(async (tx) => {
      const purchase = await tx.purchase.findUniqueOrThrow({ where: { id: purchaseId } });
      const evidence = this.purchaseEvidence(purchase.discoveryEvidence, required);
      if (evidence) {
        await tx.$queryRaw`SELECT pg_advisory_xact_lock_shared(hashtextextended(${`mello:verification:${purchase.serviceId}`}, 0)) IS NULL AS acquired`;
        await this.assertCurrentBinding(tx, purchase.serviceId, evidence);
        await appendAuditEvent(tx, {
          aggregateType: "PURCHASE", aggregateId: purchaseId, purchaseId, taskId: purchase.taskId, requestId,
          eventType: evidence.requiresCertification === false ? "SERVICE_BINDING_RELEASE_CHECKED" : "SERVICE_VERIFICATION_RELEASE_CHECKED", stage: "PAYING",
          payload: { bindingHash: evidence.bindingHash, verificationRevision: evidence.verificationRevision,
            boundary: "PAYMENT_RELEASE_PERMIT", inFlightPaymentsAreNotCancelled: true },
        });
      }
      await grant(tx);
    });
  }
}

import { BASE_SEPOLIA_USDC, MELLO_NETWORK, MelloError } from "@mello/shared";
import { z } from "zod";

export const CDP_BAZAAR_SEARCH = "https://api.cdp.coinbase.com/platform/v2/x402/discovery/search";
const Address = z.string().regex(/^0x[0-9a-fA-F]{40}$/);
export const BazaarResourceSchema = z.object({
  resource: z.string().max(2048).url(),
  type: z.literal("http"),
  x402Version: z.literal(2),
  accepts: z.array(z.object({
    scheme: z.string().max(32), network: z.string().max(64),
    amount: z.string().regex(/^\d{1,78}$/), payTo: Address, asset: Address,
  })).min(1).max(20),
  extensions: z.object({
    bazaar: z.object({
      info: z.object({ input: z.object({ type: z.literal("http"), method: z.string().max(10), body: z.unknown().optional() }) }),
      schema: z.unknown().optional(),
    }),
  }),
});
export type BazaarResource = z.infer<typeof BazaarResourceSchema>;
export interface BazaarResult {
  source: "cdp_bazaar";
  fetchedAt: string;
  partialResults: boolean;
  rejectedResourceCount: number;
  resources: BazaarResource[];
}
export interface BazaarSearch {
  // Queries are service categories, not customer prompts, tax IDs or company names.
  query?: string;
  endpoint?: string;
  payTo?: string;
}
export interface BazaarDiscovery { search(input: BazaarSearch): Promise<BazaarResult> }

const Envelope = z.object({
  x402Version: z.union([z.literal(1), z.literal(2)]),
  resources: z.array(z.unknown()).max(20),
  partialResults: z.boolean(),
});
const MAX_BYTES = 512 * 1024;

export class CdpBazaarClient implements BazaarDiscovery {
  constructor(private readonly options: { fetch?: typeof fetch; timeoutMs?: number; now?: () => Date } = {}) {}

  async search(input: BazaarSearch): Promise<BazaarResult> {
    const url = new URL(CDP_BAZAAR_SEARCH);
    url.searchParams.set("network", MELLO_NETWORK);
    url.searchParams.set("asset", BASE_SEPOLIA_USDC);
    url.searchParams.set("scheme", "exact");
    url.searchParams.set("limit", "20");
    if (input.query) url.searchParams.set("query", input.query.slice(0, 400));
    if (input.endpoint) url.searchParams.set("urlSubstring", input.endpoint);
    if (input.payTo) url.searchParams.set("payTo", input.payTo);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.options.timeoutMs ?? 5000);
    try {
      // No CDP auth, wallet, cookies, customer data, remote skills, or redirects.
      const response = await (this.options.fetch ?? globalThis.fetch)(url, {
        headers: { accept: "application/json" }, redirect: "error", cache: "no-store",
        signal: controller.signal,
      });
      if (!response.ok || !response.body) {
        await response.body?.cancel();
        throw new MelloError("BAZAAR_UNAVAILABLE", "Bazaar 暫時無法查詢；未切換至本地服務。", { statusCode: 503, retryable: true });
      }
      if (!response.headers.get("content-type")?.includes("application/json") ||
        Number(response.headers.get("content-length")) > MAX_BYTES) {
        await response.body.cancel();
        throw new MelloError("BAZAAR_RESULT_INVALID", "Bazaar 回應格式或大小不符合限制。", { statusCode: 502 });
      }
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let size = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          size += value.byteLength;
          if (size > MAX_BYTES) throw new MelloError("BAZAAR_RESULT_INVALID", "Bazaar 回應超過大小限制。", { statusCode: 502 });
          chunks.push(value);
        }
      } finally { await reader.cancel(); reader.releaseLock(); }
      let body: unknown;
      try { body = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { throw new MelloError("BAZAAR_RESULT_INVALID", "Bazaar 回應不是有效 JSON。", { statusCode: 502 }); }
      const envelope = Envelope.safeParse(body);
      if (!envelope.success) throw new MelloError("BAZAAR_RESULT_INVALID", "Bazaar 回應結構不符合預期。", { statusCode: 502 });
      const parsed = envelope.data.resources.map((value) => BazaarResourceSchema.safeParse(value));
      return {
        source: "cdp_bazaar", fetchedAt: (this.options.now?.() ?? new Date()).toISOString(),
        partialResults: envelope.data.partialResults,
        rejectedResourceCount: parsed.filter((value) => !value.success).length,
        resources: parsed.flatMap((value) => value.success ? [value.data] : []),
      };
    } catch (error) {
      if (error instanceof MelloError) throw error;
      // Never propagate upstream bodies, URLs or transport errors into the audit.
      throw new MelloError("BAZAAR_UNAVAILABLE", "Bazaar 查詢失敗或逾時；未付款，也未使用本地替代來源。", { statusCode: 503, retryable: true });
    } finally { clearTimeout(timer); }
  }
}

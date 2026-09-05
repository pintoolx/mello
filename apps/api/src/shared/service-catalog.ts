import { z } from "zod";

export const MARKET_SERVICE_CATEGORIES = [
  "stock_analysis", "macro_analysis", "crypto_market", "futures_analysis",
] as const;
export const SERVICE_CATEGORIES = [...MARKET_SERVICE_CATEGORIES, "credit_report"] as const;
export const ServiceCategorySchema = z.enum(SERVICE_CATEGORIES);
export const MarketServiceCategorySchema = z.enum(MARKET_SERVICE_CATEGORIES);
export type ServiceCategory = z.infer<typeof ServiceCategorySchema>;
export type MarketServiceCategory = z.infer<typeof MarketServiceCategorySchema>;

// These are Demo product identities, not claims of legal identity or certification.
// Keep the legacy credit-report IDs intact for historical purchases and retries.
export const MARKET_SERVICE_CATALOG = [
  {
    id: "stock-analysis", category: "stock_analysis", displayName: "個股分析",
    sellerId: "seller-a", sellerDisplayName: "會飛分析師", sourceId: "credit-report-a",
    priceAtomic: "40000", supportsTwInvoice: false,
    description: "個股基本面、估值與風險觀察的 Demo 分析；可補充股票代號，不需指定企業。",
    bazaarQuery: "stock analysis",
  },
  {
    id: "macro-analysis", category: "macro_analysis", displayName: "總經分析",
    sellerId: "seller-b", sellerDisplayName: "mello資本", sourceId: "credit-report-b",
    priceAtomic: "50000", supportsTwInvoice: true,
    description: "景氣、通膨與利率情境的 Demo 分析；可補充市場或觀察期間。",
    bazaarQuery: "macroeconomic analysis",
  },
  {
    id: "crypto-market", category: "crypto_market", displayName: "加密市場資訊",
    sellerId: "seller-b", sellerDisplayName: "mello資本", sourceId: "credit-report-b",
    priceAtomic: "50000", supportsTwInvoice: true,
    description: "加密資產市場、流動性與事件風險的 Demo 資訊；可補充幣種或主題。",
    bazaarQuery: "crypto market information",
  },
  {
    id: "futures-analysis", category: "futures_analysis", displayName: "期貨分析",
    sellerId: "seller-a", sellerDisplayName: "會飛分析師", sourceId: "credit-report-a",
    priceAtomic: "40000", supportsTwInvoice: false,
    description: "期貨合約、基差與槓桿風險的 Demo 分析；可補充商品或合約月份。",
    bazaarQuery: "futures analysis",
  },
] as const;

export function isMarketServiceCategory(category: unknown): category is MarketServiceCategory {
  return typeof category === "string" && MARKET_SERVICE_CATEGORIES.some((value) => value === category);
}

export function getMarketService(serviceId: string) {
  return MARKET_SERVICE_CATALOG.find((service) => service.id === serviceId);
}

export function getMarketServiceForCategory(category: string) {
  return MARKET_SERVICE_CATALOG.find((service) => service.category === category);
}

// Only these fixed public terms may be sent to Bazaar; never the private request.
export function serviceDiscoveryQuery(category?: ServiceCategory): string {
  if (category === "credit_report") return "credit report";
  return category ? getMarketServiceForCategory(category)!.bazaarQuery : "market analysis";
}

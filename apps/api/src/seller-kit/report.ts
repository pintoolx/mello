import { createHash } from "node:crypto";
import { z } from "zod";
import { getMarketService, MarketServiceCategorySchema } from "@mello/shared";
import type {
  CreditReport,
  CreditReportRequest,
  LegacyCreditReport,
  MarketReport,
  MarketReportRequest,
  PaymentMode,
} from "./types.js";

const LegacyRequestSchema = z
  .object({
    targetCompanyName: z.string().trim().min(1).max(200),
    purchaseContextToken: z.string().trim().min(16).max(4_096),
  })
  .strict();

const MarketRequestFields = {
  serviceId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  serviceCategory: MarketServiceCategorySchema,
  serviceQuery: z.string().trim().min(1).max(200),
};
export const MarketReportRequestSchema = z.object({
  ...MarketRequestFields,
  purchaseContextToken: LegacyRequestSchema.shape.purchaseContextToken.optional(),
}).strict();

export const CreditReportRequestSchema = z.union([
  LegacyRequestSchema,
  MarketReportRequestSchema.extend({ purchaseContextToken: LegacyRequestSchema.shape.purchaseContextToken }),
]);
export const PublicCreditReportRequestSchema = z.union([
  LegacyRequestSchema.extend({ purchaseContextToken: LegacyRequestSchema.shape.purchaseContextToken.optional() }),
  MarketReportRequestSchema,
]);

export function sellerSupportsReportRequest(sellerId: string, input: CreditReportRequest): boolean {
  if (!("serviceId" in input)) return true;
  const offering = getMarketService(input.serviceId);
  return offering?.sellerId === sellerId && offering.category === input.serviceCategory;
}

export const CreditReportSchema = z
  .object({
    reportId: z.string().regex(/^rpt_[a-f0-9]{20}$/),
    provider: z.string().min(1),
    targetCompanyName: z.string().min(1),
    riskScore: z.number().int().min(0).max(100),
    riskLevel: z.enum(["LOW", "MEDIUM", "HIGH"]),
    summary: z.literal("Demo credit report only"),
    generatedAt: z.iso.datetime(),
    paymentMode: z.enum(["mock", "x402"]),
    isDemo: z.literal(true),
  })
  .strict();

export const MarketReportSchema = z.object({
  reportVersion: z.literal("market-v1"),
  reportId: z.string().regex(/^rpt_[a-f0-9]{20}$/),
  provider: z.string().min(1),
  ...MarketRequestFields,
  title: z.string().min(1).max(200),
  summary: z.string().min(1).max(2000),
  sections: z.array(z.object({
    title: z.string().min(1).max(100),
    points: z.array(z.string().min(1).max(1000)).min(1).max(8),
  }).strict()).min(1).max(8),
  generatedAt: z.iso.datetime(),
  paymentMode: z.enum(["mock", "x402"]),
  isDemo: z.literal(true),
  disclaimer: z.literal("模擬研究內容，非即時市場資料，亦非投資建議。"),
}).strict();

function riskLevel(score: number): LegacyCreditReport["riskLevel"] {
  if (score < 34) return "LOW";
  if (score < 80) return "MEDIUM";
  return "HIGH";
}

export function createDeterministicCreditReport(
  sellerId: string,
  input: CreditReportRequest,
  paymentMode: PaymentMode,
  generatedAt: Date,
): CreditReport {
  if ("serviceId" in input) return createDeterministicMarketReport(sellerId, input, paymentMode, generatedAt);
  const digest = createHash("sha256")
    .update(`${sellerId}\u0000${input.targetCompanyName.trim().toLowerCase()}`)
    .digest("hex");
  const score = Number.parseInt(digest.slice(0, 8), 16) % 101;

  return CreditReportSchema.parse({
    reportId: `rpt_${digest.slice(0, 20)}`,
    provider: sellerId,
    targetCompanyName: input.targetCompanyName.trim(),
    riskScore: score,
    riskLevel: riskLevel(score),
    summary: "Demo credit report only",
    generatedAt: generatedAt.toISOString(),
    paymentMode,
    isDemo: true,
  });
}

const MARKET_CONTENT: Record<MarketReportRequest["serviceCategory"], { title: string; summary: string; points: string[] }> = {
  stock_analysis: {
    title: "個股分析", summary: "以營運、估值與風險三個面向示範個股研究流程；未引用即時股價或真實財務數據。",
    points: ["營運觀察：比較產品組合、營收來源與產業競爭。", "估值觀察：示範本益比與現金流的比較架構，不提供虛構目標價。", "風險觀察：留意需求變化、集中度與財報更新。"],
  },
  macro_analysis: {
    title: "總經分析", summary: "以成長、通膨與政策三個面向示範總體經濟情境研究；內容為預設 Demo 範例。",
    points: ["景氣觀察：以需求、就業及製造活動建立追蹤清單。", "政策觀察：比較利率路徑與流動性的可能影響。", "情境觀察：列出基準、上行與下行情境，不宣稱真實預測。"],
  },
  crypto_market: {
    title: "加密市場資訊", summary: "示範加密資產市場的資訊整理方法；未連接即時行情、交易所或鏈上資料來源。",
    points: ["行情觀察：整理波動、成交量與市場深度的研究方向。", "鏈上觀察：區分網路活動、資金流向及資料覆蓋限制。", "風險觀察：留意託管、智能合約與市場流動性風險。"],
  },
  futures_analysis: {
    title: "期貨分析", summary: "示範期貨合約、期限結構與風險資訊的分析流程；不含即時報價或交易訊號。",
    points: ["合約觀察：核對標的、到期日與交易規格。", "期限觀察：說明基差及轉倉成本的比較架構。", "風險觀察：辨識槓桿、保證金及結算風險，不提供交易指令。"],
  },
};

export function createDeterministicMarketReport(sellerId: string, input: MarketReportRequest,
  paymentMode: PaymentMode, generatedAt: Date): MarketReport {
  const content = MARKET_CONTENT[input.serviceCategory];
  const digest = createHash("sha256").update(JSON.stringify({
    reportVersion: "market-v1", sellerId, serviceId: input.serviceId,
    serviceCategory: input.serviceCategory, serviceQuery: input.serviceQuery.trim(),
  })).digest("hex");
  return MarketReportSchema.parse({
    reportVersion: "market-v1", reportId: `rpt_${digest.slice(0, 20)}`, provider: sellerId,
    serviceId: input.serviceId, serviceCategory: input.serviceCategory, serviceQuery: input.serviceQuery.trim(),
    title: content.title, summary: content.summary,
    sections: [{ title: "研究重點（Demo）", points: content.points }],
    generatedAt: generatedAt.toISOString(), paymentMode, isDemo: true,
    disclaimer: "模擬研究內容，非即時市場資料，亦非投資建議。",
  });
}

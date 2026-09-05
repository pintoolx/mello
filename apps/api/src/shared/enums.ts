import { z } from "zod";

export const TaskStatusSchema = z.enum([
  "CREATED",
  "PARSING",
  "DISCOVERING",
  "EVALUATING",
  "REJECTED",
  "AUTH_ANCHOR_PENDING",
  "PAYING",
  "DELIVERING",
  "INVOICING",
  "RECONCILING",
  "FINAL_ANCHOR_PENDING",
  "COMPLETED",
  "ACTION_REQUIRED",
  "FAILED",
]);
export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const PurchaseStatusSchema = z.enum([
  "CREATED",
  "AUTH_ANCHOR_PENDING",
  "AUTHORIZED",
  "PAYING",
  "SETTLED",
  "DELIVERED",
  "INVOICING",
  "RECONCILING",
  "FINAL_ANCHOR_PENDING",
  "COMPLETED",
  "ACTION_REQUIRED",
  "FAILED",
]);
export type PurchaseStatus = z.infer<typeof PurchaseStatusSchema>;

export const PaymentStatusSchema = z.enum([
  "NOT_STARTED",
  "AUTHORIZED",
  "SETTLEMENT_PENDING",
  "SETTLED",
  "FAILED",
]);
export type PaymentStatus = z.infer<typeof PaymentStatusSchema>;

export const PaymentAuthorizationStatusSchema = z.enum([
  "CREATED",
  "SIGNED",
  "SUBMITTED",
  "SETTLED",
  "EXPIRED",
  "REJECTED",
]);
export type PaymentAuthorizationStatus = z.infer<
  typeof PaymentAuthorizationStatusSchema
>;

export const DeliveryStatusSchema = z.enum([
  "PENDING",
  "DELIVERED",
  "FAILED",
]);
export type DeliveryStatus = z.infer<typeof DeliveryStatusSchema>;

export const InvoiceStatusSchema = z.enum([
  "NOT_REQUIRED",
  "PENDING",
  "ISSUED_DEMO",
  "ISSUED_STAGE",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
]);
export type InvoiceStatus = z.infer<typeof InvoiceStatusSchema>;

export const ReconciliationStatusSchema = z.enum([
  "PENDING",
  "MATCHED",
  "MISMATCH",
]);
export type ReconciliationStatus = z.infer<typeof ReconciliationStatusSchema>;

export const AnchorStatusSchema = z.enum([
  "NOT_STARTED",
  "PENDING",
  "SUBMITTED",
  "CONFIRMED",
  "FAILED_RETRYABLE",
]);
export type AnchorStatus = z.infer<typeof AnchorStatusSchema>;

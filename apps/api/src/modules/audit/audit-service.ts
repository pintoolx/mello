import type { Prisma, PrismaClient } from "@mello/db";

export interface AuditContext {
  requestId?: string | undefined;
  taskId?: string | undefined;
  purchaseId?: string | undefined;
  paymentId?: string | undefined;
  sellerId?: string | undefined;
  stage?: string | undefined;
}

export interface AppendAuditEventInput extends AuditContext {
  aggregateType: "TASK" | "PURCHASE" | "PAYMENT" | "INVOICE" | "ANCHOR";
  aggregateId: string;
  eventType: string;
  actorType?: "SYSTEM" | "USER";
  payload: unknown;
}

function jsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      typeof item === "bigint" ? item.toString() : item,
    ),
  ) as Prisma.InputJsonValue;
}

export async function appendAuditEvent(
  client: PrismaClient | Prisma.TransactionClient,
  input: AppendAuditEventInput,
): Promise<void> {
  await client.auditEvent.create({
    data: {
      aggregateType: input.aggregateType,
      aggregateId: input.aggregateId,
      eventType: input.eventType,
      actorType: input.actorType ?? "SYSTEM",
      payload: jsonValue(input.payload),
      requestId: input.requestId ?? null,
      taskId: input.taskId ?? null,
      purchaseId: input.purchaseId ?? null,
      paymentId: input.paymentId ?? null,
      sellerId: input.sellerId ?? null,
      stage: input.stage ?? null,
    },
  });
}

export { jsonValue };

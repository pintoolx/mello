import { createHash } from "node:crypto";
import type { Prisma, PrismaClient } from "@mello/db";
import { MelloError } from "@mello/shared";
import { z } from "zod";

export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024;
export const ATTACHMENT_UPLOAD_JSON_BYTES = 3 * 1024 * 1024;
export const MAX_ATTACHMENTS_PER_DRAFT = 3;
export const MAX_UNCLAIMED_ATTACHMENTS = 100;
export const MAX_STORED_ATTACHMENTS = 1000;
export const MAX_STORED_ATTACHMENT_BYTES = 100 * 1024 * 1024;
export const UNCLAIMED_ATTACHMENT_TTL_MS = 24 * 60 * 60 * 1000;

const MEDIA_TYPES: Record<string, string> = {
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  txt: "text/plain",
  md: "text/markdown",
};
export const UploadAttachmentSchema = z.object({
  requestKey: z.uuid(), clientFileId: z.uuid(),
  fileName: z.string().trim().min(1).max(180).refine((value) =>
    !/[\\/]/u.test(value) && ![...value].some((character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127),
  "File names cannot contain path separators or control characters"),
  mediaType: z.enum(["application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "text/plain", "text/markdown"]),
  sizeBytes: z.number().int().min(1).max(MAX_ATTACHMENT_BYTES),
  contentBase64: z.string().min(4).max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4),
}).strict().superRefine((input, context) => {
  const extension = input.fileName.split(".").pop()?.toLowerCase();
  if (!input.fileName.includes(".") || !extension || MEDIA_TYPES[extension] !== input.mediaType) {
    context.addIssue({ code: "custom", path: ["mediaType"], message: "Only PDF, DOCX, TXT and MD files with the matching media type are supported" });
  }
});
export type UploadAttachmentInput = z.infer<typeof UploadAttachmentSchema>;

export const ATTACHMENT_METADATA_SELECT = {
  id: true, fileName: true, mediaType: true, sizeBytes: true, sha256: true, createdAt: true,
} satisfies Prisma.TaskAttachmentSelect;
type MetadataRow = Prisma.TaskAttachmentGetPayload<{ select: typeof ATTACHMENT_METADATA_SELECT }>;
export type AttachmentMetadata = Omit<MetadataRow, "createdAt"> & { createdAt: string };

function metadata(row: MetadataRow): AttachmentMetadata {
  return { id: row.id, fileName: row.fileName, mediaType: row.mediaType,
    sizeBytes: row.sizeBytes, sha256: row.sha256, createdAt: row.createdAt.toISOString() };
}

export function decodeAttachment(input: unknown) {
  const parsed = UploadAttachmentSchema.parse(input);
  // Buffer.from is permissive; require the canonical alphabet and padding too.
  if (parsed.contentBase64.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(parsed.contentBase64)) {
    throw new MelloError("VALIDATION_ERROR", "Attachment content is not canonical base64");
  }
  const content = Buffer.from(parsed.contentBase64, "base64");
  if (content.length !== parsed.sizeBytes || content.toString("base64") !== parsed.contentBase64) {
    throw new MelloError("VALIDATION_ERROR", "Attachment size or base64 encoding does not match its content");
  }
  // No document sniffing, parsing, extraction or model call happens here.
  return { ...parsed, content, sha256: createHash("sha256").update(content).digest("hex") };
}

async function lockDraft(tx: Prisma.TransactionClient, requestKey: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mello:attachments-draft:${requestKey}`}, 0)) IS NULL AS acquired`;
}

function unavailableAttachment(): never {
  throw new MelloError("NOT_FOUND", "Attachment was not found for this draft or task", { statusCode: 404 });
}

/** Called inside the same transaction that creates Task + TaskControl. */
export async function linkTaskAttachments(tx: Prisma.TransactionClient, input: {
  taskId: string; requestKey: string; attachmentIds: string[];
}, now = new Date()): Promise<void> {
  if (!input.attachmentIds.length) return;
  const parsed = z.object({ taskId: z.uuid(), requestKey: z.uuid(), attachmentIds: z.array(z.uuid()).min(1).max(MAX_ATTACHMENTS_PER_DRAFT) }).parse(input);
  if (new Set(parsed.attachmentIds).size !== parsed.attachmentIds.length) throw new MelloError("VALIDATION_ERROR", "Attachment IDs must be unique");
  await lockDraft(tx, parsed.requestKey);
  const control = await tx.taskControl.findUnique({ where: { taskId: parsed.taskId }, select: { requestKey: true } });
  if (control?.requestKey !== parsed.requestKey) unavailableAttachment();
  const rows = await tx.taskAttachment.findMany({
    where: { id: { in: parsed.attachmentIds }, requestKey: parsed.requestKey },
    select: { id: true, taskId: true, expiresAt: true },
  });
  if (rows.length !== parsed.attachmentIds.length || rows.some((row) => row.taskId !== null && row.taskId !== parsed.taskId)) unavailableAttachment();
  if (rows.some((row) => row.taskId === null && row.expiresAt <= now)) {
    throw new MelloError("ATTACHMENT_EXPIRED", "Unsubmitted attachments expire after 24 hours; upload again with a new draft request key", { statusCode: 409 });
  }
  const unclaimed = rows.filter((row) => row.taskId === null).map((row) => row.id);
  const linked = await tx.taskAttachment.count({ where: { taskId: parsed.taskId } });
  if (linked + unclaimed.length > MAX_ATTACHMENTS_PER_DRAFT) throw new MelloError("ATTACHMENT_LIMIT_EXCEEDED", "A task can contain at most three attachments");
  if (unclaimed.length) {
    const changed = await tx.taskAttachment.updateMany({ where: {
      id: { in: unclaimed }, requestKey: parsed.requestKey, taskId: null, expiresAt: { gt: now },
    }, data: { taskId: parsed.taskId } });
    if (changed.count !== unclaimed.length) throw new MelloError("IDEMPOTENCY_CONFLICT", "Attachment ownership changed; no task was submitted", { statusCode: 409 });
  }
}

export class TaskAttachmentService {
  constructor(private readonly prisma: PrismaClient, private readonly now: () => Date = () => new Date()) {}

  async upload(input: unknown): Promise<{ metadata: AttachmentMetadata; deduplicated: boolean }> {
    const decoded = decodeAttachment(input);
    const now = this.now();
    return this.prisma.$transaction(async (tx) => {
      // Quota calculation + creation serialize together. No file/network/LLM I/O
      // inside this short transaction, and no automatic destructive cleanup.
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${"mello:attachments-quota"}, 0)) IS NULL AS acquired`;
      await lockDraft(tx, decoded.requestKey);
      const previous = await tx.taskAttachment.findUnique({
        where: { requestKey_clientFileId: { requestKey: decoded.requestKey, clientFileId: decoded.clientFileId } },
        select: { ...ATTACHMENT_METADATA_SELECT, taskId: true, expiresAt: true },
      });
      if (previous) {
        if (previous.sha256 !== decoded.sha256 || previous.fileName !== decoded.fileName ||
          previous.mediaType !== decoded.mediaType || previous.sizeBytes !== decoded.sizeBytes) {
          throw new MelloError("IDEMPOTENCY_CONFLICT", "The same attachment ID cannot be reused for different content or metadata", { statusCode: 409 });
        }
        if (previous.taskId === null && previous.expiresAt <= now) {
          throw new MelloError("ATTACHMENT_EXPIRED", "Unsubmitted attachments expire after 24 hours; start a new draft to upload again", { statusCode: 409 });
        }
        return { metadata: metadata(previous), deduplicated: true };
      }
      if (await tx.taskControl.findUnique({ where: { requestKey: decoded.requestKey }, select: { taskId: true } })) {
        throw new MelloError("IDEMPOTENCY_CONFLICT", "This draft was already submitted; attachments cannot be added afterwards", { statusCode: 409 });
      }
      if (await tx.taskAttachment.count({ where: { requestKey: decoded.requestKey } }) >= MAX_ATTACHMENTS_PER_DRAFT) {
        throw new MelloError("ATTACHMENT_LIMIT_EXCEEDED", "A draft can contain at most three uploaded attachments");
      }
      const usage = await tx.taskAttachment.aggregate({ _sum: { sizeBytes: true }, _count: true });
      const unclaimed = await tx.taskAttachment.count({ where: { taskId: null } });
      if ((usage._sum.sizeBytes ?? 0) + decoded.sizeBytes > MAX_STORED_ATTACHMENT_BYTES ||
        usage._count >= MAX_STORED_ATTACHMENTS || unclaimed >= MAX_UNCLAIMED_ATTACHMENTS) {
        throw new MelloError("ATTACHMENT_QUOTA_EXCEEDED", "Demo attachment storage is full; an administrator must review stored files before more uploads", { statusCode: 429 });
      }
      const created = await tx.taskAttachment.create({ data: {
        requestKey: decoded.requestKey, clientFileId: decoded.clientFileId,
        fileName: decoded.fileName, mediaType: decoded.mediaType, sizeBytes: decoded.sizeBytes,
        sha256: decoded.sha256, content: decoded.content, createdAt: now,
        expiresAt: new Date(now.getTime() + UNCLAIMED_ATTACHMENT_TTL_MS),
      }, select: ATTACHMENT_METADATA_SELECT });
      return { metadata: metadata(created), deduplicated: false };
    }, { maxWait: 5000, timeout: 10000 });
  }

  async list(taskId: string): Promise<AttachmentMetadata[]> {
    if (!(await this.prisma.task.findUnique({ where: { id: taskId }, select: { id: true } }))) unavailableAttachment();
    return (await this.prisma.taskAttachment.findMany({ where: { taskId },
      select: ATTACHMENT_METADATA_SELECT, orderBy: { createdAt: "asc" } })).map(metadata);
  }

  async download(taskId: string, id: string): Promise<AttachmentMetadata & { contentBase64: string }> {
    const row = await this.prisma.taskAttachment.findFirst({ where: { id, taskId }, select: { ...ATTACHMENT_METADATA_SELECT, content: true } });
    if (!row) unavailableAttachment();
    const content = Buffer.from(row.content);
    if (content.length !== row.sizeBytes || createHash("sha256").update(content).digest("hex") !== row.sha256) {
      throw new MelloError("INTERNAL_ERROR", "Stored attachment integrity check failed", { statusCode: 500 });
    }
    return { ...metadata(row), contentBase64: content.toString("base64") };
  }
}

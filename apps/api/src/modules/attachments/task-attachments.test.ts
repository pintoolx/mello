import { randomUUID } from "node:crypto";
import type { PrismaClient } from "@mello/db";
import { describe, expect, it, vi } from "vitest";
import { decodeAttachment, MAX_ATTACHMENT_BYTES, MAX_STORED_ATTACHMENT_BYTES, MAX_STORED_ATTACHMENTS, MAX_UNCLAIMED_ATTACHMENTS, TaskAttachmentService } from "./task-attachments.js";

function input(content = Buffer.from("Saved without document parsing")) {
  return { requestKey: randomUUID(), clientFileId: randomUUID(), fileName: "說明.md", mediaType: "text/markdown",
    sizeBytes: content.length, contentBase64: content.toString("base64") };
}

describe("opaque attachment validation", () => {
  it("keeps exact bytes and emits a lowercase SHA-256 digest without parsing document content", () => {
    const content = Buffer.from([0, 255, 13, 10, 65]);
    const decoded = decodeAttachment({ ...input(content), fileName: "saved.pdf", mediaType: "application/pdf" });
    expect(decoded.content).toEqual(content);
    expect(decoded.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(decoded).not.toHaveProperty("extractedText");
  });
  it("accepts an exactly 2 MiB payload without recursive base64-regex overflow", () => {
    expect(decodeAttachment(input(Buffer.alloc(MAX_ATTACHMENT_BYTES, 97))).content.length).toBe(MAX_ATTACHMENT_BYTES);
  });
  it.each(["../secret.txt", "folder\\secret.txt", "invalid\u0000.md", "bad\u007f.md", `${"a".repeat(180)}.md`, "upload.exe"])("rejects unsafe or unsupported names: %s", (fileName) => {
    expect(() => decodeAttachment({ ...input(), fileName })).toThrow();
  });
  it.each([
    { mediaType: "text/html" }, { mediaType: "application/pdf" }, { sizeBytes: 0 }, { sizeBytes: MAX_ATTACHMENT_BYTES + 1 },
    { contentBase64: "Z g==" }, { contentBase64: "Zh==", sizeBytes: 1 }, { contentBase64: "Zg=", sizeBytes: 1 },
    { contentBase64: "Zg==", sizeBytes: 2 }, { contentBase64: "data:text/plain;base64,Zg==" },
  ])("rejects inconsistent size, MIME or base64: %j", (change) => {
    expect(() => decodeAttachment({ ...input(), ...change })).toThrow();
  });
});

describe("bounded storage quota", () => {
  it("refuses to download corrupted bytes instead of silently returning content with the old checksum", async () => {
    const original = decodeAttachment(input(Buffer.from("a")));
    const client = { taskAttachment: { findFirst: vi.fn(async () => ({
      id: randomUUID(), fileName: original.fileName, mediaType: original.mediaType,
      sizeBytes: 1, sha256: original.sha256, createdAt: new Date(), content: Buffer.from("b"),
    })) } } as unknown as PrismaClient;
    await expect(new TaskAttachmentService(client).download(randomUUID(), randomUUID())).rejects.toMatchObject({
      code: "INTERNAL_ERROR", message: "Stored attachment integrity check failed", statusCode: 500,
    });
  });
  it.each([
    { bytes: MAX_STORED_ATTACHMENT_BYTES, total: 1, unclaimed: 0 },
    { bytes: 1, total: MAX_STORED_ATTACHMENTS, unclaimed: 0 },
    { bytes: 1, total: 1, unclaimed: MAX_UNCLAIMED_ATTACHMENTS },
  ])("refuses extra storage at the quota without deleting data: %j", async (usage) => {
    const create = vi.fn();
    const tx = { $queryRaw: vi.fn(async () => []),
      taskControl: { findUnique: vi.fn(async () => null) },
      taskAttachment: { findUnique: vi.fn(async () => null),
        count: vi.fn().mockResolvedValueOnce(0).mockResolvedValueOnce(usage.unclaimed),
        aggregate: vi.fn(async () => ({ _sum: { sizeBytes: usage.bytes }, _count: usage.total })), create },
    };
    const client = { $transaction: async (operation: (transaction: typeof tx) => Promise<unknown>) => operation(tx) } as unknown as PrismaClient;
    await expect(new TaskAttachmentService(client).upload(input())).rejects.toMatchObject({ code: "ATTACHMENT_QUOTA_EXCEEDED", statusCode: 429 });
    expect(create).not.toHaveBeenCalled();
  });
});

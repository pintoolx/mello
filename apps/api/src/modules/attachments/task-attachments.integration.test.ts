import { createHash, randomUUID } from "node:crypto";
import { prisma } from "@mello/db";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { linkTaskAttachments, TaskAttachmentService, UNCLAIMED_ATTACHMENT_TTL_MS } from "./task-attachments.js";

const requestKeys: string[] = [];
const taskIds: string[] = [];
function newKey() { const key = randomUUID(); requestKeys.push(key); return key; }
function uploadInput(requestKey = newKey(), content = Buffer.from("Attachment bytes are not parsed")) {
  return { requestKey, clientFileId: randomUUID(), fileName: "備註.md", mediaType: "text/markdown",
    sizeBytes: content.length, contentBase64: content.toString("base64") };
}
async function claim(requestKey: string, attachmentIds: string[], now?: Date) {
  return prisma.$transaction(async (tx) => {
    const task = await tx.task.create({ data: { prompt: "Service search with stored-only attachment", control: {
      create: { requestKey, requestHash: `0x${"1".repeat(64)}` },
    } } });
    await linkTaskAttachments(tx, { taskId: task.id, requestKey, attachmentIds }, now);
    taskIds.push(task.id);
    return task;
  });
}

describe.sequential("durable opaque task attachments", () => {
  afterEach(async () => {
    await prisma.task.deleteMany({ where: { id: { in: taskIds.splice(0) } } });
    await prisma.taskAttachment.deleteMany({ where: { requestKey: { in: requestKeys.splice(0) } } });
  });
  afterAll(async () => prisma.$disconnect());

  it("stores identical concurrent uploads exactly once and preserves bytes across service recreation", async () => {
    const input = uploadInput();
    const firstService = new TaskAttachmentService(prisma);
    const results = await Promise.all([firstService.upload(input), firstService.upload(input)]);
    expect(results.map((result) => result.deduplicated).sort()).toEqual([false, true]);
    expect(results[0]!.metadata).toEqual(results[1]!.metadata);
    expect(await prisma.taskAttachment.count({ where: { requestKey: input.requestKey } })).toBe(1);
    const task = await claim(input.requestKey, [results[0]!.metadata.id]);
    const restartedService = new TaskAttachmentService(prisma);
    expect(await restartedService.list(task.id)).toEqual([results[0]!.metadata]);
    expect(await restartedService.download(task.id, results[0]!.metadata.id)).toEqual({ ...results[0]!.metadata, contentBase64: input.contentBase64 });
    expect(results[0]!.metadata.sha256).toBe(createHash("sha256").update(Buffer.from(input.contentBase64, "base64")).digest("hex"));
    expect(await prisma.auditEvent.count({ where: { taskId: task.id } })).toBe(0);
  });

  it("rejects different bytes or metadata under the same client identity without overwriting", async () => {
    const service = new TaskAttachmentService(prisma);
    const input = uploadInput(newKey(), Buffer.from("a"));
    const uploaded = await service.upload(input);
    await expect(service.upload({ ...input, contentBase64: "Yg==" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT", statusCode: 409 });
    await expect(service.upload({ ...input, fileName: "changed.md" })).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    const row = await prisma.taskAttachment.findUniqueOrThrow({ where: { id: uploaded.metadata.id } });
    expect(Buffer.from(row.content).toString("base64")).toBe(input.contentBase64);
    expect(row.fileName).toBe(input.fileName);
  });

  it("enforces three files per draft even under concurrent uploads", async () => {
    const service = new TaskAttachmentService(prisma);
    const requestKey = newKey();
    const results = await Promise.allSettled(Array.from({ length: 4 }, () => service.upload(uploadInput(requestKey))));
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(3);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { code: "ATTACHMENT_LIMIT_EXCEEDED" } });
    expect(await prisma.taskAttachment.count({ where: { requestKey } })).toBe(3);
  });

  it("rolls back task creation when an attachment belongs to another draft, is missing, or duplicated", async () => {
    const service = new TaskAttachmentService(prisma);
    const owner = uploadInput();
    const uploaded = await service.upload(owner);
    const otherRequestKey = newKey();
    await expect(claim(otherRequestKey, [uploaded.metadata.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(claim(owner.requestKey, [randomUUID()])).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(claim(owner.requestKey, [uploaded.metadata.id, uploaded.metadata.id])).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await prisma.taskControl.count({ where: { requestKey: { in: [owner.requestKey, otherRequestKey] } } })).toBe(0);
    expect((await prisma.taskAttachment.findUniqueOrThrow({ where: { id: uploaded.metadata.id } })).taskId).toBeNull();
  });

  it("expires only unclaimed drafts; claimed attachments remain readable and replayable afterwards", async () => {
    let now = new Date("2026-09-06T00:00:00Z");
    const service = new TaskAttachmentService(prisma, () => now);
    const submitted = uploadInput();
    const abandoned = uploadInput();
    const attached = await service.upload(submitted);
    const unattached = await service.upload(abandoned);
    const task = await claim(submitted.requestKey, [attached.metadata.id], now);
    now = new Date(now.getTime() + UNCLAIMED_ATTACHMENT_TTL_MS + 1);
    await expect(service.upload(abandoned)).rejects.toMatchObject({ code: "ATTACHMENT_EXPIRED", statusCode: 409 });
    await expect(claim(abandoned.requestKey, [unattached.metadata.id], now)).rejects.toMatchObject({ code: "ATTACHMENT_EXPIRED" });
    expect((await service.upload(submitted)).deduplicated).toBe(true);
    expect((await service.download(task.id, attached.metadata.id)).contentBase64).toBe(submitted.contentBase64);
    await prisma.$transaction((tx) => linkTaskAttachments(tx, { taskId: task.id, requestKey: submitted.requestKey, attachmentIds: [attached.metadata.id] }, now));
    expect(await prisma.taskControl.findUnique({ where: { requestKey: abandoned.requestKey } })).toBeNull();
  });

  it("does not allow attachment additions after task submission or a different task's download path", async () => {
    const service = new TaskAttachmentService(prisma);
    const input = uploadInput();
    const uploaded = await service.upload(input);
    const task = await claim(input.requestKey, [uploaded.metadata.id]);
    await expect(service.upload(uploadInput(input.requestKey))).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    await expect(service.download(randomUUID(), uploaded.metadata.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.download(task.id, randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(service.list(randomUUID())).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await service.list(task.id))[0]).not.toHaveProperty("content");
    expect((await service.list(task.id))[0]).not.toHaveProperty("requestKey");
  });

  it("treats request-key spelling identically to TaskControl, without UUID case aliasing", async () => {
    const requestKey = newKey();
    const upper = requestKey.toUpperCase();
    requestKeys.push(upper);
    const service = new TaskAttachmentService(prisma);
    const uploaded = await service.upload(uploadInput(requestKey));
    await expect(claim(upper, [uploaded.metadata.id])).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await prisma.taskAttachment.findUniqueOrThrow({ where: { id: uploaded.metadata.id } })).taskId).toBeNull();
  });
});

import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import supertest from "supertest";
import { describe, expect, it, vi } from "vitest";
import { MelloError } from "@mello/shared";
import { createApp } from "../../app.js";
import { loadConfig } from "../../config.js";
import type { CoreApiDependencies } from "../../http/contracts.js";
import { decodeAttachment, type TaskAttachmentService } from "./task-attachments.js";

const API_KEY = "attachment-tests-only-api-access-token-0001";
const taskId = randomUUID();
const id = randomUUID();
const metadata = { id, fileName: "test.md", mediaType: "text/markdown", sizeBytes: 1, sha256: "a".repeat(64), createdAt: "2026-09-06T00:00:00.000Z" };
function fixture(authenticated = true) {
  const attachments = {
    upload: vi.fn(async (value: unknown) => { decodeAttachment(value); return { metadata, deduplicated: false }; }),
    list: vi.fn(async () => [metadata]),
    download: vi.fn(async () => ({ ...metadata, contentBase64: "YQ==" })),
  };
  const logger = { info: vi.fn(), error: vi.fn() } as unknown as Logger;
  const config = loadConfig({ NODE_ENV: "test", DATABASE_URL: "postgresql://mello:mello@localhost:5432/mello_test",
    ...(authenticated ? { API_ACCESS_TOKEN: API_KEY } : {}) });
  return { attachments, logger, app: createApp({ config, attachments: attachments as unknown as TaskAttachmentService, logger } as CoreApiDependencies) };
}
function body(bytes = 1) {
  return { requestKey: randomUUID(), clientFileId: randomUUID(), fileName: "test.md", mediaType: "text/markdown",
    sizeBytes: bytes, contentBase64: Buffer.alloc(bytes, 97).toString("base64") };
}

describe("authenticated bounded attachment HTTP routes", () => {
  it("authenticates upload before parsing even a malformed body", async () => {
    const { app, attachments } = fixture();
    await supertest(app).post("/api/v1/attachments").set("content-type", "application/json").send("not-json").expect(401);
    expect(attachments.upload).not.toHaveBeenCalled();
  });
  it("fails closed when attachment authentication is unconfigured", async () => {
    const { app, attachments } = fixture(false);
    await supertest(app).post("/api/v1/attachments").send(body()).expect(503);
    await supertest(app).get(`/api/v1/tasks/${taskId}/attachments`).expect(503);
    expect(attachments.upload).not.toHaveBeenCalled();
  });
  it("allows only upload to exceed 64 KB and emits metadata, not bytes or identity keys", async () => {
    const { app } = fixture();
    const response = await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).send(body(80 * 1024)).expect(201);
    expect(response.body).toEqual(metadata);
    expect(response.headers["cache-control"]).toBe("private, no-store");
    await supertest(app).post("/api/v1/tasks").set("x-mello-api-key", API_KEY).send({ prompt: "a".repeat(80 * 1024) }).expect(413);
  });
  it("limits upload JSON to 3 MiB and does not call the store on parser failures", async () => {
    const { app, attachments } = fixture();
    const response = await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).send({ padding: "a".repeat(3 * 1024 * 1024) }).expect(413);
    expect(response.body.error.message).toContain("3 MiB");
    await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).set("content-type", "text/plain").send("text").expect(415);
    expect(attachments.upload).not.toHaveBeenCalled();
  });
  it("protects listing and download and binds both UUID route identifiers", async () => {
    const { app, attachments } = fixture();
    await supertest(app).get(`/api/v1/tasks/${taskId}/attachments`).expect(401);
    await supertest(app).get(`/api/v1/tasks/${taskId}/attachments/${id}`).expect(401);
    expect(attachments.list).not.toHaveBeenCalled();
    expect(attachments.download).not.toHaveBeenCalled();
    const listed = await supertest(app).get(`/api/v1/tasks/${taskId}/attachments`).set("x-mello-api-key", API_KEY).expect(200);
    expect(listed.body).toEqual({ attachments: [metadata] });
    const downloaded = await supertest(app).get(`/api/v1/tasks/${taskId}/attachments/${id}`).set("x-mello-api-key", API_KEY).expect(200);
    expect(downloaded.body.contentBase64).toBe("YQ==");
    expect(attachments.download).toHaveBeenCalledExactlyOnceWith(taskId, id);
    expect(downloaded.headers["x-content-type-options"]).toBe("nosniff");
    await supertest(app).get(`/api/v1/tasks/${taskId}/attachments/not-uuid`).set("x-mello-api-key", API_KEY).expect(400);
  });
  it("returns idempotent uploads as 200 and preserves safe conflict/expiry errors", async () => {
    const { app, attachments } = fixture();
    attachments.upload.mockResolvedValueOnce({ metadata, deduplicated: true });
    await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).send(body()).expect(200);
    attachments.upload.mockRejectedValueOnce(new MelloError("ATTACHMENT_EXPIRED", "Attachment expired", { statusCode: 409 }));
    const response = await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).send(body()).expect(409);
    expect(response.body.error.code).toBe("ATTACHMENT_EXPIRED");
  });
  it("does not emit raw storage errors that might contain attempted file bytes", async () => {
    const { app, attachments, logger } = fixture();
    attachments.upload.mockRejectedValueOnce(new Error("DB attempted confidential-file-bytes"));
    const response = await supertest(app).post("/api/v1/attachments").set("x-mello-api-key", API_KEY).send(body()).expect(503);
    expect(JSON.stringify(response.body)).not.toContain("confidential-file-bytes");
    expect(logger.error).not.toHaveBeenCalled();
  });
});

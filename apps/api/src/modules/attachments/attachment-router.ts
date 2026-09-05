import { timingSafeEqual } from "node:crypto";
import express, { Router, type RequestHandler } from "express";
import { MelloError } from "@mello/shared";
import { z } from "zod";
import type { CoreApiDependencies } from "../../http/contracts.js";
import { ATTACHMENT_UPLOAD_JSON_BYTES } from "./task-attachments.js";

async function storageResult<T>(operation: () => Promise<T>): Promise<T> {
  try { return await operation(); }
  catch (error) {
    if (error instanceof MelloError || error instanceof z.ZodError) throw error;
    // Database error formatting can include attempted byte values. Never send
    // those errors to the generic HTTP logger or expose them to the client.
    throw new MelloError("INTERNAL_ERROR", "Attachment storage is temporarily unavailable", { statusCode: 503, retryable: true });
  }
}

/** A configured private API token is mandatory even in local/demo mode. */
export function createAttachmentRouter(dependencies: CoreApiDependencies): Router {
  const router = Router();
  const authenticate: RequestHandler = (request, response, next) => {
    response.set({ "Cache-Control": "private, no-store", "X-Content-Type-Options": "nosniff" });
    const expected = dependencies.config.API_ACCESS_TOKEN;
    if (!expected) return next(new MelloError("INTERNAL_ERROR", "Authenticated attachment storage is not configured", { statusCode: 503 }));
    const supplied = request.get("x-mello-api-key") ?? "";
    if (Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) {
      return next(new MelloError("VALIDATION_ERROR", "Authenticated API access is required", { statusCode: 401 }));
    }
    if (!dependencies.attachments) return next(new MelloError("INTERNAL_ERROR", "Attachment storage is unavailable", { statusCode: 503 }));
    next();
  };
  const jsonParser = express.json({ limit: ATTACHMENT_UPLOAD_JSON_BYTES, inflate: false });
  const uploadParser: RequestHandler = (request, response, next) => {
    if (!request.is("application/json")) return next(new MelloError("VALIDATION_ERROR", "Attachment uploads require application/json", { statusCode: 415 }));
    jsonParser(request, response, (error?: unknown) => {
      if (!error) return next();
      const status = typeof error === "object" && error !== null && "status" in error ? error.status : undefined;
      next(new MelloError("VALIDATION_ERROR", status === 413 ? "Attachment upload JSON exceeds the 3 MiB limit" : "Attachment upload must contain uncompressed valid JSON", { statusCode: status === 413 ? 413 : status === 415 ? 415 : 400 }));
    });
  };
  router.post("/attachments", authenticate, uploadParser, async (request, response) => {
    const result = await storageResult(() => dependencies.attachments!.upload(request.body));
    response.status(result.deduplicated ? 200 : 201).json(result.metadata);
  });
  router.get("/tasks/:taskId/attachments", authenticate, async (request, response) => {
    const { taskId } = z.object({ taskId: z.uuid() }).parse(request.params);
    response.json({ attachments: await storageResult(() => dependencies.attachments!.list(taskId)) });
  });
  router.get("/tasks/:taskId/attachments/:id", authenticate, async (request, response) => {
    const { taskId, id } = z.object({ taskId: z.uuid(), id: z.uuid() }).parse(request.params);
    response.json(await storageResult(() => dependencies.attachments!.download(taskId, id)));
  });
  return router;
}

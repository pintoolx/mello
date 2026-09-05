import { randomUUID } from "node:crypto";
import cors from "cors";
import express, { type Express, type RequestHandler } from "express";
import type { CoreApiDependencies } from "./http/contracts.js";
import {
  createApiRouter,
  createErrorHandler,
  createNotFoundHandler,
} from "./routes/api-routes.js";

const REQUEST_ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

function requestContext(dependencies: CoreApiDependencies): RequestHandler {
  return (request, response, next) => {
    const supplied = request.header("x-request-id");
    const requestId = supplied && REQUEST_ID_PATTERN.test(supplied) ? supplied : randomUUID();
    const startedAt = performance.now();
    response.locals["requestId"] = requestId;
    response.setHeader("x-request-id", requestId);
    response.once("finish", () => {
      dependencies.logger.info(
        {
          requestId,
          method: request.method,
          path: request.path,
          statusCode: response.statusCode,
          durationMs: Math.round((performance.now() - startedAt) * 100) / 100,
          stage: "HTTP",
        },
        "API request completed",
      );
    });
    next();
  };
}

export function createApp(dependencies: CoreApiDependencies): Express {
  const app = express();
  app.disable("x-powered-by");
  app.use(
    cors({
      origin: dependencies.config.WEB_ORIGIN,
      methods: ["GET", "POST", "PUT", "OPTIONS"],
      allowedHeaders: ["content-type", "x-request-id", "x-demo-admin-token"],
      exposedHeaders: ["x-request-id"],
    }),
  );
  app.use(requestContext(dependencies));
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/v1", createApiRouter(dependencies));
  app.use(createNotFoundHandler());
  app.use(createErrorHandler(dependencies));
  return app;
}

import "dotenv/config";
import { prisma } from "@mello/db";
import { createApp } from "./app.js";
import { createCoreApiDependencies } from "./bootstrap.js";
import { loadConfig } from "./config.js";
import { logger } from "./logger.js";

const config = loadConfig();
const dependencies = createCoreApiDependencies({ config });
const app = createApp(dependencies);
const server = app.listen(config.CORE_API_PORT, config.CORE_API_HOST, () => {
  dependencies.workflowJobPoller.start();
  logger.info(
    {
      port: config.CORE_API_PORT,
      host: config.CORE_API_HOST,
      modes: {
        agent: config.AGENT_MODE,
        payment: config.PAYMENT_MODE,
        invoice: config.INVOICE_PROVIDER,
        anchor: config.CONTRACT_ANCHOR_MODE,
      },
    },
    "Mello Core API started",
  );
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, "Shutting down Mello Core API");
  const closeResult = new Promise<Error | undefined>((resolve) => {
    server.close((error) => resolve(error));
  });
  try {
    await dependencies.workflowJobPoller.stop();
    const error = await closeResult;
    if (error) logger.error({ err: error }, "HTTP server shutdown failed");
    await prisma.$disconnect();
    process.exitCode = error ? 1 : 0;
  } catch (error: unknown) {
    logger.error({ err: error }, "Core API shutdown failed");
    process.exitCode = 1;
  }
}

process.once("SIGINT", () => {
  void shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  void shutdown("SIGTERM");
});

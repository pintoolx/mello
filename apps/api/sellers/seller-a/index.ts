import {
  createSellerApplication,
  createSellerServiceLogger,
} from "@mello/seller-kit";
import { readSellerAConfig } from "./app.js";

const config = readSellerAConfig();
const logger = createSellerServiceLogger(config.sellerId);
const { app } = createSellerApplication(config, { logger });

app.listen(config.port, config.bindHost ?? "127.0.0.1", () => {
  logger.info(
    { sellerId: config.sellerId, stage: "STARTUP" },
    "Seller service listening",
    {
      bindHost: config.bindHost ?? "127.0.0.1",
      port: config.port,
      publicUrl: config.publicUrl,
      paymentMode: config.paymentMode,
    },
  );
});

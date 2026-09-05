import { fileURLToPath } from "node:url";

export const resolve = {
  alias: Object.fromEntries(
    ["shared", "db", "seller-kit", "tw-einvoice-extension", "contracts-client"].map(
      (name) => [
        `@mello/${name}`,
        fileURLToPath(new URL(`./src/${name}/index.ts`, import.meta.url)),
      ],
    ),
  ),
};

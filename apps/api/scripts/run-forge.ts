import { spawn } from "node:child_process";
import { assertBaseSepoliaDeployTarget } from "./forge-safety.js";

const forgeArguments = process.argv.slice(2);
if (forgeArguments.length === 0) {
  throw new Error("A Forge subcommand is required");
}

const rpcUrlIndex = forgeArguments.indexOf("--rpc-url");
const isBaseSepoliaBroadcast =
  forgeArguments.includes("--broadcast") &&
  rpcUrlIndex >= 0 &&
  forgeArguments[rpcUrlIndex + 1] === "base_sepolia";
if (isBaseSepoliaBroadcast) {
  await assertBaseSepoliaDeployTarget(
    process.env["BASE_SEPOLIA_RPC_URL"] ?? "https://sepolia.base.org",
  );
}

const exitCode = await new Promise<number>((resolve, reject) => {
  const child = spawn("forge", forgeArguments, {
    env: process.env,
    shell: false,
    stdio: "inherit",
  });
  child.once("error", (error) => {
    reject(
      new Error(
        `Could not start Forge. Install Foundry and ensure forge is on PATH: ${error.message}`,
      ),
    );
  });
  child.once("exit", (code, signal) => {
    if (signal) {
      reject(new Error(`Forge terminated from signal ${signal}`));
      return;
    }
    resolve(code ?? 1);
  });
});

process.exitCode = exitCode;

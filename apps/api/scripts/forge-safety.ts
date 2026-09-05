import { isIP } from "node:net";
import { MELLO_CHAIN_ID } from "@mello/shared";

interface JsonRpcChainIdResponse {
  result?: unknown;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, "")
    .replace(/\.$/u, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.split(".")[0] === "127")
  );
}

export async function assertBaseSepoliaDeployTarget(
  rpcUrl: string,
  fetchImplementation: typeof fetch = fetch,
): Promise<void> {
  const url = new URL(rpcUrl);
  if (isLoopbackHostname(url.hostname)) {
    throw new Error("Base Sepolia deployment refuses a loopback RPC URL");
  }
  let response: Response;
  try {
    response = await fetchImplementation(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "eth_chainId",
        params: [],
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("Base Sepolia deployment RPC preflight failed");
  }
  if (!response.ok) {
    throw new Error("Base Sepolia deployment RPC preflight failed");
  }
  const body = (await response.json()) as JsonRpcChainIdResponse;
  const chainId =
    typeof body.result === "string" && /^0x[0-9a-f]+$/iu.test(body.result)
      ? Number.parseInt(body.result.slice(2), 16)
      : Number.NaN;
  if (chainId !== MELLO_CHAIN_ID) {
    throw new Error(
      `Deployment RPC returned chain ${Number.isFinite(chainId) ? chainId : "unknown"}; expected Base Sepolia ${MELLO_CHAIN_ID}`,
    );
  }
}

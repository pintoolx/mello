import { generateJwt } from "@coinbase/cdp-sdk/auth";
import { HTTPFacilitatorClient } from "@x402/core/server";

export const CDP_FACILITATOR_URL =
  "https://api.cdp.coinbase.com/platform/v2/x402" as const;

export interface CdpFacilitatorEnvironment {
  readonly CDP_API_KEY_ID?: string;
  readonly CDP_API_KEY_SECRET?: string;
}

export interface CreateFacilitatorClientOptions {
  readonly env?: CdpFacilitatorEnvironment;
  readonly jwtGenerator?: typeof generateJwt;
  readonly timeoutMs?: number;
}

interface CdpFacilitatorCredentials {
  readonly apiKeyId: string;
  readonly apiKeySecret: string;
}

type FacilitatorAuthHeaders = Readonly<{
  verify: Readonly<Record<string, string>>;
  settle: Readonly<Record<string, string>>;
  supported: Readonly<Record<string, string>>;
}>;

const CDP_FACILITATOR_HOST = "api.cdp.coinbase.com";
const CDP_FACILITATOR_PATH = "/platform/v2/x402";

function isCdpFacilitatorUrl(value: string): boolean {
  const url = new URL(value);
  return (
    url.protocol === "https:" &&
    url.hostname === CDP_FACILITATOR_HOST &&
    url.port === "" &&
    url.username === "" &&
    url.password === "" &&
    url.pathname.replace(/\/+$/u, "") === CDP_FACILITATOR_PATH &&
    url.search === "" &&
    url.hash === ""
  );
}

function readCdpCredentials(
  env: CdpFacilitatorEnvironment,
): CdpFacilitatorCredentials {
  const missing: string[] = [];
  if (!env.CDP_API_KEY_ID?.trim()) missing.push("CDP_API_KEY_ID");
  if (!env.CDP_API_KEY_SECRET?.trim()) missing.push("CDP_API_KEY_SECRET");
  if (missing.length > 0) {
    throw new Error(
      `CDP facilitator requires ${missing.join(", ")}; set the missing environment variable${missing.length === 1 ? "" : "s"}`,
    );
  }
  return {
    apiKeyId: env.CDP_API_KEY_ID as string,
    apiKeySecret: env.CDP_API_KEY_SECRET as string,
  };
}

export function createCdpFacilitatorAuthHeaders(
  credentials: CdpFacilitatorCredentials,
  jwtGenerator: typeof generateJwt = generateJwt,
): () => Promise<FacilitatorAuthHeaders> {
  const authorization = async (
    requestMethod: "GET" | "POST",
    requestPath: string,
  ): Promise<Readonly<Record<string, string>>> => ({
    Authorization: `Bearer ${await jwtGenerator({
      apiKeyId: credentials.apiKeyId,
      apiKeySecret: credentials.apiKeySecret,
      requestMethod,
      requestHost: CDP_FACILITATOR_HOST,
      requestPath,
    })}`,
  });

  return async () => {
    const [verify, settle, supported] = await Promise.all([
      authorization("POST", `${CDP_FACILITATOR_PATH}/verify`),
      authorization("POST", `${CDP_FACILITATOR_PATH}/settle`),
      authorization("GET", `${CDP_FACILITATOR_PATH}/supported`),
    ]);
    return { verify, settle, supported };
  };
}

export function createFacilitatorClient(
  facilitatorUrl: string,
  options: CreateFacilitatorClientOptions = {},
): HTTPFacilitatorClient {
  const config: ConstructorParameters<typeof HTTPFacilitatorClient>[0] = {
    url: facilitatorUrl,
    timeoutMs: options.timeoutMs ?? 30_000,
  };

  if (isCdpFacilitatorUrl(facilitatorUrl)) {
    const credentials = readCdpCredentials(options.env ?? process.env);
    config.createAuthHeaders = createCdpFacilitatorAuthHeaders(
      credentials,
      options.jwtGenerator,
    );
  }

  return new HTTPFacilitatorClient(config);
}

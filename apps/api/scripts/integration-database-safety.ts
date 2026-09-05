import { isIP } from "node:net";

export interface IntegrationDatabaseSafetyInput {
  databaseUrl: string | undefined;
  databaseApproved: string | undefined;
}

const SAFE_LOCAL_DATABASE_NAME =
  /^(?:mello|mello[_-](?:test|local|dev|integration)|(?:test|local|dev|integration)[_-]mello)$/iu;

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return (
    normalized === "localhost" ||
    normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.split(".")[0] === "127")
  );
}

function databaseName(url: URL): string {
  try {
    return decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    return "";
  }
}

/**
 * Database integration tests write fixtures and temporarily mutate seeded rows.
 * They may only target loopback PostgreSQL. The documented `mello` database and
 * clearly named local/test variants are accepted without a persistent override.
 */
export function assertSafeIntegrationDatabase(
  input: IntegrationDatabaseSafetyInput,
): void {
  if (!input.databaseUrl) {
    throw new Error("Integration database safety requires DATABASE_URL");
  }

  let url: URL;
  try {
    url = new URL(input.databaseUrl);
  } catch {
    throw new Error("Integration database safety requires a valid DATABASE_URL");
  }
  if (
    (url.protocol !== "postgresql:" && url.protocol !== "postgres:") ||
    !isLoopbackHostname(url.hostname)
  ) {
    throw new Error(
      "Integration database safety refuses every non-loopback DATABASE_URL",
    );
  }

  const name = databaseName(url);
  if (
    !SAFE_LOCAL_DATABASE_NAME.test(name) &&
    input.databaseApproved !== "true"
  ) {
    throw new Error(
      "Integration database safety requires database mello, a clearly named local/test database, or MELLO_INTEGRATION_DATABASE_APPROVED=true",
    );
  }
}

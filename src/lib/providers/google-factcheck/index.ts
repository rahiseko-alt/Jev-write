import { GoogleFactCheckClient, GoogleFactCheckOptions } from "./types";
import { HTTPGoogleFactCheckClient } from "./client";
import { MockGoogleFactCheckClient } from "./mock";

export * from "./types";
export * from "./client";
export * from "./mock";

/**
 * Returns an HTTPGoogleFactCheckClient if GOOGLE_FACTCHECK_API_KEY is available,
 * otherwise falls back to MockGoogleFactCheckClient.
 */
/**
 * A stand-in is something you ask for, never something you are given quietly.
 * Without a credential the real adapter reports that it could not look
 * anything up, and the claim goes on as unverified (ADR-0003).
 */
function wantsStandIn(flag: string): boolean {
  return process.env.NODE_ENV === "test" || process.env[flag] === "true";
}

export function getGoogleFactCheckClient(options: GoogleFactCheckOptions = {}): GoogleFactCheckClient {
  const apiKey =
    options.apiKey ||
    process.env.GOOGLE_FACTCHECK_API_KEY ||
    process.env.factcheck ||
    process.env.GOOGLE_FACT_CHECK_API_KEY;
  // An explicitly supplied credential always means the real service.
  if (!options.apiKey && wantsStandIn("USE_MOCK_FACTCHECK")) {
    return new MockGoogleFactCheckClient();
  }
  return new HTTPGoogleFactCheckClient(apiKey ? { ...options, apiKey } : options);
}

export const getFactCheckClient = getGoogleFactCheckClient;

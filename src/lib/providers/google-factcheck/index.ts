import { GoogleFactCheckClient, GoogleFactCheckOptions } from "./types";
import { HTTPGoogleFactCheckClient } from "./client";

export * from "./types";
export * from "./client";

/**
 * Returns an HTTPGoogleFactCheckClient if GOOGLE_FACTCHECK_API_KEY is available,
 * Without a key it reports the lookup it could not make.
 */
export function getGoogleFactCheckClient(options: GoogleFactCheckOptions = {}): GoogleFactCheckClient {
  const apiKey =
    options.apiKey ||
    process.env.GOOGLE_FACTCHECK_API_KEY ||
    process.env.factcheck ||
    process.env.GOOGLE_FACT_CHECK_API_KEY;
  return new HTTPGoogleFactCheckClient(apiKey ? { ...options, apiKey } : options);
}

export const getFactCheckClient = getGoogleFactCheckClient;

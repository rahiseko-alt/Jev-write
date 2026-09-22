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
export function getGoogleFactCheckClient(options: GoogleFactCheckOptions = {}): GoogleFactCheckClient {
  const apiKey = options.apiKey || process.env.GOOGLE_FACTCHECK_API_KEY || process.env.factcheck;
  if (apiKey && apiKey.trim().length > 0) {
    return new HTTPGoogleFactCheckClient({ ...options, apiKey });
  }
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Google FactCheck API key is required in production. Set GOOGLE_FACTCHECK_API_KEY or factcheck.');
  }
  return new MockGoogleFactCheckClient();
}

export const getFactCheckClient = getGoogleFactCheckClient;

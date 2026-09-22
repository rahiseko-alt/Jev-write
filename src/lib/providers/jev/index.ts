import { JEVClient } from "./types";
import { HTTPJEVClient, JEVClientOptions } from "./client";
import { MockJEVClient } from "./mock";

export * from "./types";
export * from "./client";
export * from "./mock";

/**
 * Returns an HTTPJEVClient connecting to TypeSafe AI Jev (System One)
 * if JEV_API_KEY or TYPESAFE_API_KEY is configured.
 * Defaults endpoint to https://api.typesafe.ai/v1/systemone.
 * Falls back to MockJEVClient only if no key is provided.
 */
export function getJEVClient(options: JEVClientOptions = {}): JEVClient {
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : process.env.JEV_API_KEY || process.env.TYPESAFE_API_KEY;

  if (apiKey && apiKey.trim().length > 0) {
    return new HTTPJEVClient(options);
  }

  const apiUrl = options.apiUrl !== undefined ? options.apiUrl : process.env.JEV_API_URL;
  if (apiUrl && apiUrl.trim().length > 0) {
    return new HTTPJEVClient(options);
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error('JEV_API_KEY is required in production.');
  }
  return new MockJEVClient();
}

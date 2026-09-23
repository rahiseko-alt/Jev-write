import { JEVClient } from "./types";
import { HTTPJEVClient, JEVClientOptions } from "./client";

export * from "./types";
export * from "./client";

/**
 * Returns an HTTPJEVClient connecting to TypeSafe AI Jev (System One)
 * if JEV_API_KEY or TYPESAFE_API_KEY is configured.
 * Defaults endpoint to https://api.typesafe.ai/v1/systemone.
 * Without a key it reports that, rather than judging with a stand-in.
 */
export function getJEVClient(options: JEVClientOptions = {}): JEVClient {
  const apiKey =
    options.apiKey !== undefined
      ? options.apiKey
      : process.env.JEV_API_KEY ||
        process.env.TYPESAFE_API_KEY ||
        process.env.jev ||
        process.env.typesafe;

  if (apiKey && apiKey.trim().length > 0) {
    return new HTTPJEVClient(options);
  }

  const apiUrl =
    options.apiUrl !== undefined
      ? options.apiUrl
      : process.env.JEV_API_URL || process.env.TYPESAFE_API_URL;
  if (apiUrl && apiUrl.trim().length > 0) {
    return new HTTPJEVClient(options);
  }

  throw new Error("JEVの鍵が設定されていません（JEV_API_KEY / TYPESAFE_API_KEY）。");
}

import { JEVClient } from "./types";
import { HTTPJEVClient, JEVClientOptions } from "./client";
import { MockJEVClient } from "./mock";

export * from "./types";
export * from "./client";
export * from "./mock";

/**
 * Returns an HTTPJEVClient if JEV_API_URL is configured,
 * otherwise returns a MockJEVClient for local testing and CI.
 */
export function getJEVClient(options: JEVClientOptions = {}): JEVClient {
  const apiUrl = options.apiUrl !== undefined ? options.apiUrl : process.env.JEV_API_URL;
  if (apiUrl && apiUrl.trim().length > 0) {
    return new HTTPJEVClient(options);
  }
  return new MockJEVClient();
}

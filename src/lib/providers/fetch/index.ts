import { FetchProvider } from "./types";
import { HTTPFetchProvider, HTTPFetchProviderOptions } from "./fetcher";

export * from "./types";
export * from "./fetcher";

/**
 * Returns an HTTPFetchProvider. There is no stand-in: canned prose must never
 * stand in for a page nobody fetched.
 */
export function getFetchProvider(
  options: HTTPFetchProviderOptions = {}
): FetchProvider {
  return new HTTPFetchProvider(options);
}

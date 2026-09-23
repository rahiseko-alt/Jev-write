import { FetchProvider } from "./types";
import { HTTPFetchProvider, HTTPFetchProviderOptions } from "./fetcher";
import { MockFetchProvider } from "./mock";

export * from "./types";
export * from "./fetcher";
export * from "./mock";

/**
 * Returns an HTTPFetchProvider. The stand-in is returned only where it was
 * asked for (useMock, USE_MOCK_FETCH, or a test run): canned prose must never
 * stand in for a page nobody fetched.
 */
export function getFetchProvider(
  options: HTTPFetchProviderOptions = {},
  useMock = false
): FetchProvider {
  if (
    useMock ||
    process.env.USE_MOCK_FETCH === "true" ||
    process.env.NODE_ENV === "test"
  ) {
    return new MockFetchProvider();
  }
  return new HTTPFetchProvider(options);
}

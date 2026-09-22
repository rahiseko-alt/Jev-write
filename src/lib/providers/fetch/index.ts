import { FetchProvider } from "./types";
import { HTTPFetchProvider, HTTPFetchProviderOptions } from "./fetcher";
import { MockFetchProvider } from "./mock";

export * from "./types";
export * from "./fetcher";
export * from "./mock";

/**
 * Returns an HTTPFetchProvider unless forced or mock is requested.
 * When useMock is true, returns MockFetchProvider.
 */
export function getFetchProvider(
  options: HTTPFetchProviderOptions = {},
  useMock = false
): FetchProvider {
  if (useMock || process.env.USE_MOCK_FETCH === "true") {
    return new MockFetchProvider();
  }
  return new HTTPFetchProvider(options);
}

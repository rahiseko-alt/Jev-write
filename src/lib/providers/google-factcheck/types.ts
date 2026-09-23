import type { CallLimit } from "../call-limit";

export interface ClaimReviewPublisher {
  name?: string;
  site?: string;
}

export interface ClaimReview {
  publisher: ClaimReviewPublisher;
  url: string;
  title?: string;
  reviewDate?: string;
  textualRating: string;
  languageCode?: string;
}

export interface GoogleFactCheckClaim {
  text: string;
  claim?: string; // alias for text
  claimant?: string;
  claimDate?: string;
  claimReview?: ClaimReview[];
}

export interface FactCheckSearchResult {
  claims?: GoogleFactCheckClaim[];
  nextPageToken?: string;
}

export type RatingVerdict = "supports" | "contradicts" | "mixed" | "insufficient";

export interface GoogleFactCheckOptions {
  apiKey?: string;
  languageCode?: string;
  timeoutMs?: number;
}

/**
 * `limit` carries the signal of the fact-check stage's cut-off (ADR-0021):
 * the lookup ends there at the latest, and is then not counted as failing.
 */
export interface GoogleFactCheckClient {
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  searchClaims(
    query: string,
    languageCode?: string,
    limit?: CallLimit
  ): Promise<FactCheckSearchResult>;
  search(query: string, languageCode?: string, limit?: CallLimit): Promise<GoogleFactCheckClaim[]>;
}

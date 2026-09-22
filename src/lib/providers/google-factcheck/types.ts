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

export interface GoogleFactCheckClient {
  searchClaims(query: string, languageCode?: string): Promise<FactCheckSearchResult>;
  search(query: string, languageCode?: string): Promise<GoogleFactCheckClaim[]>;
}

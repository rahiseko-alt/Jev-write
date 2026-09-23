import { Claim } from "@/types";

export interface LLMProvider {
  extractClaims(text: string): Promise<Claim[]>;
  generateSearchQueries(claim: Claim): Promise<string[]>;
  /**
   * The queries that gather the reference pages for a whole text, written
   * once instead of per claim.
   */
  generateDocumentQueries?(text: string): Promise<string[]>;
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  /** How many times a busy service (429/529) was asked the same thing again. */
  retryCount?: number;
}

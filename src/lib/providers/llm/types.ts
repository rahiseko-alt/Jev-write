import { Claim } from "@/types";

export interface LLMProvider {
  extractClaims(text: string): Promise<Claim[]>;
  /**
   * For every claim, the 1–2 queries that ask what would settle it, primary
   * source first (ADR-0015). One generation for all claims, keyed by claim id.
   */
  generateClaimQueries?(claims: Claim[]): Promise<Map<string, string[]>>;
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

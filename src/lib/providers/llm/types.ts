import { Claim, ExtractionTrace } from "@/types";
import type { CallLimit } from "../call-limit";
import type { ClaimQueryPlan, DocumentQueryPlan } from "./search-queries";

/**
 * Every call takes an optional limit: the signal of its stage's cut-off
 * (ADR-0021). Aborted, the call stops, retries and waits included, and it
 * is not counted as the service's failure.
 */
export interface LLMProvider {
  extractClaims(text: string, limit?: CallLimit): Promise<Claim[]>;
  /**
   * What the last extraction made of every sentence (ADR-0020): claims, set
   * aside with a reason, or missing from the answer.
   */
  lastExtraction?: ExtractionTrace;
  /**
   * For every claim, its searches as the generation wrote them: what it is
   * about, the kind of fact, what it says (kept out of the queries) and 1–2
   * queries, primary source first (ADR-0015, ADR-0019). One generation for
   * all claims, keyed by claim id. A plain list is queries with no content named.
   */
  generateClaimQueries?(
    claims: Claim[],
    limit?: CallLimit
  ): Promise<Map<string, ClaimQueryPlan | string[]>>;
  /**
   * The searches that gather the reference pages for a whole text, written
   * once instead of per claim, as the generation wrote them (ADR-0019). A
   * plain string is a query with no content named.
   */
  generateDocumentQueries?(
    text: string,
    limit?: CallLimit
  ): Promise<Array<DocumentQueryPlan | string>>;
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  /** How many times a busy service (429/529) was asked the same thing again. */
  retryCount?: number;
}

import {
  FactCheckSearchResult,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
  GoogleFactCheckOptions,
} from "./types";
import { recordFailure } from "../diagnostics";
import { CallLimit, attemptSignal, stoppedByCaller } from "../call-limit";

/**
 * The Google Fact Check Tools adapter.
 *
 * A lookup that failed is a lookup that failed. Nothing here answers with a
 * review nobody published: without a credential, or when the API cannot be
 * reached, the caller is told, and the claim goes on as unverified.
 */
export class HTTPGoogleFactCheckClient implements GoogleFactCheckClient {
  /** What went wrong with the real service during this run, for the reader. */
  failureCount = 0;
  lastError?: string;
  private apiKey: string;
  private defaultLanguage: string;
  private timeoutMs: number;

  constructor(options: GoogleFactCheckOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.GOOGLE_FACTCHECK_API_KEY ||
      process.env.factcheck ||
      "";
    this.defaultLanguage = options.languageCode || "ja";
    this.timeoutMs = options.timeoutMs || 10000;
  }

  async searchClaims(
    query: string,
    languageCode?: string,
    limit?: CallLimit
  ): Promise<FactCheckSearchResult> {
    if (!this.apiKey) {
      const missing = new Error(
        "Google Fact Check API key is not configured (GOOGLE_FACTCHECK_API_KEY)."
      );
      recordFailure(this, missing);
      throw missing;
    }

    const trimmedQuery = query.trim();
    if (!trimmedQuery) {
      return { claims: [] };
    }

    const lang = languageCode || this.defaultLanguage;
    const url = new URL("https://factchecktools.googleapis.com/v1alpha1/claims:search");
    url.searchParams.set("query", trimmedQuery);
    url.searchParams.set("languageCode", lang);
    url.searchParams.set("key", this.apiKey);

    // Its own time limit, or the fact-check stage's cut-off, whichever comes first (ADR-0021).
    const attempt = attemptSignal(this.timeoutMs, limit?.signal);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: attempt.signal,
      });

      if (!response.ok) {
        if (response.status === 404) {
          return { claims: [] };
        }
        const errorText = await response.text().catch(() => "");
        throw new Error(`Google Fact Check API error (${response.status} ${response.statusText}): ${errorText}`);
      }

      const data = (await response.json()) as FactCheckSearchResult;
      const claims = (data.claims || []).map((c) => ({
        ...c,
        claim: c.claim || c.text,
      }));

      return {
        claims,
        nextPageToken: data.nextPageToken,
      };
    } catch (err) {
      // Stopped at the stage's cut-off, the lookup did not fail (ADR-0021).
      if (!stoppedByCaller(limit)) recordFailure(this, err);
      throw err;
    } finally {
      attempt.release();
    }
  }

  async search(
    query: string,
    languageCode?: string,
    limit?: CallLimit
  ): Promise<GoogleFactCheckClaim[]> {
    const res = await this.searchClaims(query, languageCode, limit);
    return res.claims || [];
  }
}

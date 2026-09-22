import {
  FactCheckSearchResult,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
  GoogleFactCheckOptions,
} from "./types";

export class HTTPGoogleFactCheckClient implements GoogleFactCheckClient {
  private apiKey: string;
  private defaultLanguage: string;
  private timeoutMs: number;

  constructor(options: GoogleFactCheckOptions = {}) {
    this.apiKey = options.apiKey || process.env.GOOGLE_FACTCHECK_API_KEY || "";
    this.defaultLanguage = options.languageCode || "ja";
    this.timeoutMs = options.timeoutMs || 10000;
  }

  async searchClaims(query: string, languageCode?: string): Promise<FactCheckSearchResult> {
    if (!this.apiKey) {
      throw new Error("Google Fact Check API key is missing. Set GOOGLE_FACTCHECK_API_KEY in environment or constructor.");
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

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url.toString(), {
        method: "GET",
        headers: {
          Accept: "application/json",
        },
        signal: controller.signal,
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
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`Google Fact Check API request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, languageCode?: string): Promise<GoogleFactCheckClaim[]> {
    const res = await this.searchClaims(query, languageCode);
    return res.claims || [];
  }
}

import {
  FactCheckSearchResult,
  GoogleFactCheckClaim,
  GoogleFactCheckClient,
  GoogleFactCheckOptions,
} from "./types";
import { MockGoogleFactCheckClient } from "./mock";

export class HTTPGoogleFactCheckClient implements GoogleFactCheckClient {
  private apiKey: string;
  private defaultLanguage: string;
  private timeoutMs: number;
  private fallback: MockGoogleFactCheckClient;

  constructor(options: GoogleFactCheckOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.GOOGLE_FACTCHECK_API_KEY ||
      process.env.factcheck ||
      "";
    this.defaultLanguage = options.languageCode || "ja";
    this.timeoutMs = options.timeoutMs || 10000;
    this.fallback = new MockGoogleFactCheckClient();
  }

  async searchClaims(query: string, languageCode?: string): Promise<FactCheckSearchResult> {
    if (!this.apiKey) {
      return await this.fallback.searchClaims(query, languageCode);
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

      if (claims.length === 0) {
        return await this.fallback.searchClaims(query, languageCode);
      }

      return {
        claims,
        nextPageToken: data.nextPageToken,
      };
    } catch (err) {
      console.warn("Google Fact Check search failed, falling back to mock:", err);
      return await this.fallback.searchClaims(query, languageCode);
    } finally {
      clearTimeout(timer);
    }
  }

  async search(query: string, languageCode?: string): Promise<GoogleFactCheckClaim[]> {
    const res = await this.searchClaims(query, languageCode);
    return res.claims || [];
  }
}

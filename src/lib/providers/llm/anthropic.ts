import { Claim, Importance } from "@/types";
import { LLMProvider } from "./types";
import { recordFailure, recordRetry } from "../diagnostics";
import { sendWithRetry } from "../retry";
import {
  CLAIM_QUERY_SYSTEM_PROMPT,
  DOCUMENT_QUERY_SYSTEM_PROMPT,
  buildClaimQueryUserPrompt,
  buildDocumentQueryUserPrompt,
  readClaimQueries,
} from "./search-queries";

export interface AnthropicLLMOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

export class AnthropicLLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;
  /** What went wrong with the real service during this run, for the reader. */
  failureCount = 0;
  lastError?: string;
  /** How many times a busy Anthropic (429/529) was asked the same thing again. */
  retryCount = 0;

  constructor(options: AnthropicLLMOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_API_KEY ||
      "";
    // Pinned to Sonnet on the user's order: no option or environment variable
    // may switch the run to a costlier model.
    this.model = "claude-sonnet-5";
    this.maxTokens = Number(
      options.maxTokens || process.env.ANTHROPIC_MAX_TOKENS || 16384
    );
    this.baseUrl = (
      options.baseUrl ||
      process.env.ANTHROPIC_BASE_URL ||
      "https://api.anthropic.com/v1"
    ).replace(/\/$/, "");
  }

  private async callMessages(
    systemPrompt: string,
    userPrompt: string
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error(
        "Anthropic API key is missing. Set ANTHROPIC_API_KEY or CLAUDE_API_KEY in environment."
      );
    }

    const body: Record<string, any> = {
      model: this.model,
      max_tokens: this.maxTokens,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };

    // 429 (rate_limit_error) and 529 (overloaded_error) mean "busy", not
    // "wrong": the same request goes to Anthropic again. Still busy after the
    // last try, the error below reports it as before.
    const response = await sendWithRetry(
      () =>
        fetch(`${this.baseUrl}/messages`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            "x-api-key": this.apiKey,
            "anthropic-version": "2023-06-01",
          },
          body: JSON.stringify(body),
        }),
      { retryStatuses: [429, 529], onRetry: () => recordRetry(this) }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic API error (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    const data = await response.json();

    // An answer cut off at the length limit is not an answer: parsed as JSON
    // it fails somewhere in the middle, which reads like a syntax error
    // rather than what it is.
    if (data.stop_reason === "max_tokens") {
      throw new Error(
        `Anthropic の応答が長さ上限（max_tokens=${this.maxTokens}）で打ち切られました。文章を短くするか ANTHROPIC_MAX_TOKENS を上げてください。`
      );
    }

    const textBlock = data.content?.find((c: any) => c.type === "text");
    return textBlock?.text || "";
  }

  /** Reads the answer as JSON, and says which step's answer it could not read. */
  private parseJson(raw: string, step: string): any {
    const cleaned = this.cleanJson(raw);
    try {
      return JSON.parse(cleaned);
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      throw new Error(
        `${step}の応答をJSONとして読み取れませんでした（${reason}）。応答の長さ: ${cleaned.length}文字。`
      );
    }
  }

  private cleanJson(raw: string): string {
    const trimmed = raw.trim();
    if (trimmed.startsWith("```")) {
      return trimmed
        .replace(/^```(?:json)?\s*/i, "")
        .replace(/\s*```$/, "")
        .trim();
    }
    return trimmed;
  }

  async extractClaims(text: string): Promise<Claim[]> {
    try {
      const systemPrompt = `You are an expert fact-checking claim extractor.
Break down the provided text into atomic, objectively verifiable factual claims.
Avoid opinions, impressions, rhetoric, and broad paragraphs. Focus strictly on atomic factual assertions.
Write every field in the same language as the text. Never translate.

Return ONLY a valid JSON object with this exact structure, nothing else:
{
  "claims": [
    {
      "id": "claim-1",
      "originalText": "exact sentence or phrase in text",
      "normalizedText": "canonical, unambiguous statement of fact",
      "subject": "main entity or subject",
      "predicate": "action or property",
      "object": "target or value",
      "numbers": ["extracted numbers or amounts"],
      "dates": ["extracted dates or timeframes"],
      "entities": ["named entities, products, organizations"],
      "importance": "critical" | "high" | "normal" | "low",
      "factCheckRequired": true
    }
  ]
}`;

      const rawContent = await this.callMessages(systemPrompt, text);
      const parsed = this.parseJson(rawContent, "主張の抽出");
      const rawClaims = Array.isArray(parsed) ? parsed : parsed.claims || [];

      return rawClaims.map((item: any, index: number): Claim => {
        const id = item.id || `claim-${Date.now()}-${index + 1}`;
        const validImportance: Importance[] = ["critical", "high", "normal", "low"];
        const importance: Importance = validImportance.includes(item.importance)
          ? item.importance
          : "normal";

        return {
          id,
          originalText: String(item.originalText || ""),
          normalizedText: String(item.normalizedText || item.originalText || ""),
          subject: item.subject ? String(item.subject) : undefined,
          predicate: item.predicate ? String(item.predicate) : undefined,
          object: item.object ? String(item.object) : undefined,
          numbers: Array.isArray(item.numbers) ? item.numbers.map(String) : [],
          dates: Array.isArray(item.dates) ? item.dates.map(String) : [],
          entities: Array.isArray(item.entities) ? item.entities.map(String) : [],
          importance,
          factCheckRequired:
            typeof item.factCheckRequired === "boolean"
              ? item.factCheckRequired
              : true,
        };
      });
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }

  async generateClaimQueries(claims: Claim[]): Promise<Map<string, string[]>> {
    if (claims.length === 0) return new Map();
    try {
      const rawContent = await this.callMessages(
        CLAIM_QUERY_SYSTEM_PROMPT,
        buildClaimQueryUserPrompt(claims)
      );
      return readClaimQueries(this.parseJson(rawContent, "検索の問いの作成"), claims);
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }

  async generateDocumentQueries(text: string): Promise<string[]> {
    try {
      const rawContent = await this.callMessages(
        DOCUMENT_QUERY_SYSTEM_PROMPT,
        buildDocumentQueryUserPrompt(text)
      );
      const parsed = this.parseJson(rawContent, "資料を集める検索クエリの作成");

      if (Array.isArray(parsed)) return parsed.map(String);
      if (Array.isArray(parsed.queries)) return parsed.queries.map(String);
      return [];
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }


}

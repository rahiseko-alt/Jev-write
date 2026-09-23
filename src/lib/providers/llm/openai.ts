import { Claim, Importance } from "@/types";
import { LLMProvider } from "./types";
import { recordFailure } from "../diagnostics";
import {
  DOCUMENT_QUERY_SYSTEM_PROMPT,
  SEARCH_QUERY_SYSTEM_PROMPT,
  buildDocumentQueryUserPrompt,
  buildSearchQueryUserPrompt,
} from "./search-queries";

const DEFAULT_RETRY_MS = 1000;
const MAX_RETRY_MS = 20000;

function retryAfterMs(header?: string | null): number {
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return DEFAULT_RETRY_MS;
  return Math.min(seconds * 1000, MAX_RETRY_MS);
}

export interface OpenAILLMOptions {
  apiKey?: string;
  model?: string;
  maxTokens?: number;
  baseUrl?: string;
}

/** Reads an answer as JSON, and says which step's answer it could not read. */
function parseJson(raw: string, step: string): any {
  try {
    return JSON.parse(raw);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `${step}の応答をJSONとして読み取れませんでした（${reason}）。応答の長さ: ${raw.length}文字。`
    );
  }
}

export class OpenAILLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private maxTokens: number;
  /** What went wrong with the real service during this run, for the reader. */
  failureCount = 0;
  lastError?: string;

  constructor(options: OpenAILLMOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = options.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.maxTokens = Number(options.maxTokens || process.env.OPENAI_MAX_TOKENS || 16384);
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  }

  /** Whether any call in this run was answered by the mock instead. */

  private async callChatCompletion(
    messages: Array<{ role: string; content: string }>,
    jsonMode = false,
    retryOn429 = true
  ): Promise<string> {
    if (!this.apiKey) {
      throw new Error("OpenAI API key is missing. Set OPENAI_API_KEY in environment or constructor.");
    }

    const body: Record<string, any> = {
      model: this.model,
      messages,
      temperature: 0.1,
      max_tokens: this.maxTokens,
    };

    if (jsonMode) {
      body.response_format = { type: "json_object" };
    }

    const response = await fetch(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");

      // A rate limit slows this request down. It says nothing about the next
      // one, and nothing about anyone else's.
      if (response.status === 429 && retryOn429) {
        const wait = retryAfterMs(response.headers?.get?.("retry-after"));
        await new Promise((resolve) => setTimeout(resolve, wait));
        return this.callChatCompletion(messages, jsonMode, false);
      }

      throw new Error(`OpenAI API error (${response.status} ${response.statusText}): ${errorText}`);
    }

    const data = await response.json();

    // An answer cut off at the length limit is not an answer.
    if (data.choices?.[0]?.finish_reason === "length") {
      throw new Error(
        "OpenAI の応答が長さ上限で打ち切られました。文章を短くするか OPENAI_MAX_TOKENS を上げてください。"
      );
    }

    return data.choices?.[0]?.message?.content || "";
  }

  async extractClaims(text: string): Promise<Claim[]> {
    try {
      const systemPrompt = `You are an expert fact-checking claim extractor.
Break down the provided text into atomic, objectively verifiable factual claims.
Avoid opinions, impressions, rhetoric, and broad paragraphs. Focus strictly on atomic factual assertions.
Write every field in the same language as the text. Never translate.

Return a JSON object with this exact structure:
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
      "factCheckRequired": true | false
    }
  ]
}`;

      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: text },
        ],
        true
      );

      const parsed = parseJson(rawContent, "主張の抽出");
      const rawClaims = Array.isArray(parsed) ? parsed : parsed.claims || [];

      return rawClaims.map((item: any, index: number): Claim => {
        const id = item.id || `claim-${Date.now()}-${index + 1}`;
        const validImportance: Importance[] = ["critical", "high", "normal", "low"];
        const importance: Importance = validImportance.includes(item.importance) ? item.importance : "normal";

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
          factCheckRequired: typeof item.factCheckRequired === "boolean" ? item.factCheckRequired : true,
        };
      });
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }

  async generateSearchQueries(claim: Claim): Promise<string[]> {
    try {
      const systemPrompt = SEARCH_QUERY_SYSTEM_PROMPT;
      const userPrompt = buildSearchQueryUserPrompt(claim);

      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        true
      );

      const parsed = parseJson(rawContent, "検索クエリの作成");
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.map(String);
      }
      return [claim.normalizedText];
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }

  async generateDocumentQueries(text: string): Promise<string[]> {
    try {
      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: DOCUMENT_QUERY_SYSTEM_PROMPT },
          { role: "user", content: buildDocumentQueryUserPrompt(text) },
        ],
        true
      );
      const parsed = parseJson(rawContent, "資料を集める検索クエリの作成");

      if (Array.isArray(parsed)) return parsed.map(String);
      if (Array.isArray(parsed.queries)) return parsed.queries.map(String);
      return [];
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }


}

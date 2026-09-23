import { Claim } from "@/types";
import { LLMProvider } from "./types";
import { recordFailure, recordRetry } from "../diagnostics";
import { sendWithRetry } from "../retry";
import { CLAIM_EXTRACTION_SYSTEM_PROMPT, readExtractedClaims } from "./claim-extraction";
import {
  CLAIM_QUERY_SYSTEM_PROMPT,
  DOCUMENT_QUERY_SYSTEM_PROMPT,
  buildClaimQueryUserPrompt,
  buildDocumentQueryUserPrompt,
  readClaimQueries,
} from "./search-queries";

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
  /** How many times a rate-limited OpenAI (429) was asked the same thing again. */
  retryCount = 0;

  constructor(options: OpenAILLMOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = options.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.maxTokens = Number(options.maxTokens || process.env.OPENAI_MAX_TOKENS || 16384);
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
  }

  private async callChatCompletion(
    messages: Array<{ role: string; content: string }>,
    jsonMode = false
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

    // A rate limit slows this request down: the same request goes to OpenAI
    // again. It says nothing about the next one, and nothing about anyone
    // else's. Still limited after the last try, the error below reports it.
    const response = await sendWithRetry(
      () =>
        fetch(`${this.baseUrl}/chat/completions`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
        }),
      { retryStatuses: [429], onRetry: () => recordRetry(this) }
    );

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
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
      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: CLAIM_EXTRACTION_SYSTEM_PROMPT },
          { role: "user", content: text },
        ],
        true
      );
      return readExtractedClaims(parseJson(rawContent, "主張の抽出"));
    } catch (err) {
      recordFailure(this, err);
      throw err;
    }
  }

  async generateClaimQueries(claims: Claim[]): Promise<Map<string, string[]>> {
    if (claims.length === 0) return new Map();
    try {
      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: CLAIM_QUERY_SYSTEM_PROMPT },
          { role: "user", content: buildClaimQueryUserPrompt(claims) },
        ],
        true
      );
      return readClaimQueries(parseJson(rawContent, "検索の問いの作成"), claims);
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

import { Claim, Importance } from "@/types";
import { LLMProvider, RewriteInput, SurgicalFixInput } from "./types";
import { MockLLMProvider } from "./mock";

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
  baseUrl?: string;
}

export class OpenAILLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fallback: MockLLMProvider;

  constructor(options: OpenAILLMOptions = {}) {
    this.apiKey = options.apiKey || process.env.OPENAI_API_KEY || "";
    this.model = options.model || process.env.OPENAI_MODEL || "gpt-4o-mini";
    this.baseUrl = (options.baseUrl || process.env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/$/, "");
    this.fallback = new MockLLMProvider();
  }

  /** Whether any call in this run was answered by the mock instead. */
  servedByFallback = false;

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
    return data.choices?.[0]?.message?.content || "";
  }

  async extractClaims(text: string): Promise<Claim[]> {
    try {
      const systemPrompt = `You are an expert fact-checking claim extractor.
Break down the provided text into atomic, objectively verifiable factual claims.
Avoid opinions, impressions, rhetoric, and broad paragraphs. Focus strictly on atomic factual assertions.

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

      const parsed = JSON.parse(rawContent);
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
      console.warn("OpenAI extractClaims failed, falling back to mock LLM:", err);
      this.servedByFallback = true;
      return await this.fallback.extractClaims(text);
    }
  }

  async generateSearchQueries(claim: Claim): Promise<string[]> {
    try {
      const systemPrompt = `Generate 2 to 4 concise, effective search engine queries to verify or debunk the given factual claim.
Target official sources, news databases, or encyclopedia entries.
Return a JSON object: { "queries": ["query 1", "query 2", ...] }`;

      const userPrompt = `Claim: ${claim.normalizedText}
Subject: ${claim.subject || "N/A"}
Numbers: ${claim.numbers?.join(", ") || "N/A"}
Dates: ${claim.dates?.join(", ") || "N/A"}
Entities: ${claim.entities?.join(", ") || "N/A"}`;

      const rawContent = await this.callChatCompletion(
        [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt },
        ],
        true
      );

      const parsed = JSON.parse(rawContent);
      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.map(String);
      }
      return [claim.normalizedText];
    } catch (err) {
      console.warn("OpenAI generateSearchQueries failed, falling back to mock LLM:", err);
      this.servedByFallback = true;
      return await this.fallback.generateSearchQueries(claim);
    }
  }

  async rewrite(input: RewriteInput): Promise<string> {
    try {
      const { originalText, plan } = input;

      const instructions = [
        "You are a professional editor performing precise text quality assurance.",
        "Rewrite the provided text strictly adhering to the following rules:",
        "1. Factual Corrections: Apply ALL fact ledger corrections. Replace contradicted claims with their correctedClaim.",
        "2. Style Fixes: Remove or revise all identified AI-tells / style issues according to their repair instructions.",
        "3. Invariant Preservation: You MUST PRESERVE all immutable facts, protected quotes, and protected names without modification.",
        "4. Natural Flow: Ensure smooth, professional prose while retaining original intent and tone.",
        "5. No Hallucinations: Do NOT introduce any new unverified factual claims.",
        "Return ONLY the rewritten prose without meta-commentary, markdown wrapping, or explanations.",
      ].join("\n");

      const planJson = JSON.stringify(
        {
          corrections: plan.corrections.map((c) => ({
            original: c.originalClaim,
            verdict: c.verdict,
            correctedClaim: c.correctedClaim,
            reason: c.correctionReason,
            lockedFacts: c.lockedFacts,
          })),
          styleIssues: plan.styleIssues.map((s) => ({
            ruleId: s.ruleId,
            targetText: s.targetText,
            repairInstruction: s.repairInstruction,
          })),
          immutableFacts: plan.immutableFacts,
          protectedQuotes: plan.protectedQuotes,
          protectedNames: plan.protectedNames,
        },
        null,
        2
      );

      const userPrompt = `Rewrite Plan:\n${planJson}\n\nOriginal Text:\n${originalText}`;

      return await this.callChatCompletion([
        { role: "system", content: instructions },
        { role: "user", content: userPrompt },
      ]);
    } catch (err) {
      console.warn("OpenAI rewrite failed, falling back to mock LLM:", err);
      this.servedByFallback = true;
      return await this.fallback.rewrite(input);
    }
  }

  async surgicalFix(input: SurgicalFixInput): Promise<string> {
    // A capability this adapter does not implement, not a service that failed:
    // the local repair restores the reader's own figure, inventing nothing.
    return await this.fallback.surgicalFix(input);
  }
}

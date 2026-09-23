import { Claim, Importance } from "@/types";
import { LLMProvider, RewriteInput, SurgicalFixInput } from "./types";
import { MockLLMProvider } from "./mock";

export interface AnthropicLLMOptions {
  apiKey?: string;
  model?: string;
  baseUrl?: string;
}

export class AnthropicLLMProvider implements LLMProvider {
  private apiKey: string;
  private model: string;
  private baseUrl: string;
  private fallback: MockLLMProvider;

  /** Whether any call in this run was answered by the mock instead. */
  servedByFallback = false;

  constructor(options: AnthropicLLMOptions = {}) {
    this.apiKey =
      options.apiKey ||
      process.env.ANTHROPIC_API_KEY ||
      process.env.CLAUDE_API_KEY ||
      "";
    this.model =
      options.model ||
      process.env.ANTHROPIC_MODEL ||
      "claude-3-5-sonnet-20241022";
    this.baseUrl = (
      options.baseUrl ||
      process.env.ANTHROPIC_BASE_URL ||
      "https://api.anthropic.com/v1"
    ).replace(/\/$/, "");
    this.fallback = new MockLLMProvider();
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
      max_tokens: 4096,
      temperature: 0.1,
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    };

    const response = await fetch(`${this.baseUrl}/messages`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "");
      throw new Error(
        `Anthropic API error (${response.status} ${response.statusText}): ${errorText}`
      );
    }

    const data = await response.json();
    const textBlock = data.content?.find((c: any) => c.type === "text");
    return textBlock?.text || "";
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
      const cleaned = this.cleanJson(rawContent);
      const parsed = JSON.parse(cleaned);
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
      console.warn("Anthropic extractClaims failed, falling back to mock LLM:", err);
      this.servedByFallback = true;
      return await this.fallback.extractClaims(text);
    }
  }

  async generateSearchQueries(claim: Claim): Promise<string[]> {
    try {
      const systemPrompt = `Generate 2 to 4 concise, effective search engine queries to verify or debunk the given factual claim.
Target official sources, news databases, or encyclopedia entries.
Return ONLY a valid JSON object: { "queries": ["query 1", "query 2", ...] }`;

      const userPrompt = `Claim: ${claim.normalizedText}
Subject: ${claim.subject || "N/A"}
Numbers: ${claim.numbers?.join(", ") || "N/A"}
Dates: ${claim.dates?.join(", ") || "N/A"}
Entities: ${claim.entities?.join(", ") || "N/A"}`;

      const rawContent = await this.callMessages(systemPrompt, userPrompt);
      const cleaned = this.cleanJson(rawContent);
      const parsed = JSON.parse(cleaned);

      if (Array.isArray(parsed)) {
        return parsed.map(String);
      }
      if (Array.isArray(parsed.queries)) {
        return parsed.queries.map(String);
      }
      return [claim.normalizedText];
    } catch (err) {
      console.warn("Anthropic generateSearchQueries failed, falling back to mock LLM:", err);
      this.servedByFallback = true;
      return await this.fallback.generateSearchQueries(claim);
    }
  }

  async rewrite(input: RewriteInput): Promise<string> {
    try {
      const { originalText, plan } = input;

      const instructions = [
        "You are a professional Japanese editor performing precise text quality assurance and fact revision.",
        "Rewrite the provided text strictly adhering to the following 5 principles:",
        "1. Factual Corrections: Apply ALL fact ledger corrections. Replace contradicted claims with their correctedClaim accurately.",
        "2. Style Fixes: Remove or revise all identified AI-tells and style issues according to their repair instructions.",
        "3. Invariant Preservation: You MUST PRESERVE all immutable facts, verified figures, and proper nouns.",
        "4. Natural Flow: Ensure smooth, natural Japanese prose retaining original author intent and tone.",
        "5. No Hallucinations: Do NOT introduce unverified new facts or numbers.",
        "Return ONLY the rewritten Japanese article without meta-commentary, markdown wrapping, or explanations.",
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

      const result = await this.callMessages(instructions, userPrompt);
      return result.trim();
    } catch (err) {
      console.warn("Anthropic rewrite failed, falling back to mock LLM:", err);
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

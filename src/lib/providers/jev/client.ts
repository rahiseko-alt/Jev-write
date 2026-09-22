import {
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVBatchRuleItemResult,
  JEVBatchRulesRequest,
  JEVBatchRulesResult,
  JEVClient,
  JEVDeltaMeaningParams,
  JEVDeltaMeaningResult,
} from "./types";

export interface JEVClientOptions {
  apiUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

export class HTTPJEVClient implements JEVClient {
  private apiUrl: string;
  private apiKey: string;
  private timeoutMs: number;

  constructor(options: JEVClientOptions = {}) {
    this.apiUrl = (options.apiUrl || process.env.JEV_API_URL || "").replace(/\/$/, "");
    this.apiKey = options.apiKey || process.env.JEV_API_KEY || "";
    this.timeoutMs = options.timeoutMs || 15000;
  }

  private async request<T>(endpoint: string, body: any): Promise<T> {
    if (!this.apiUrl) {
      throw new Error("JEV API URL is missing. Configure JEV_API_URL in environment or constructor.");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
      };
      if (this.apiKey) {
        headers["Authorization"] = `Bearer ${this.apiKey}`;
        headers["X-API-Key"] = this.apiKey;
      }

      const response = await fetch(`${this.apiUrl}${endpoint}`, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(`JEV request to ${endpoint} failed (${response.status} ${response.statusText}): ${errorText}`);
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`JEV request to ${endpoint} timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  async evaluateAtomicJudgment(req: JEVAtomicJudgmentRequest): Promise<JEVAtomicJudgmentResult> {
    const raw = await this.request<any>("/api/v1/atomic-judgment", req);
    const choice = raw.choice || raw.match || raw.relation;
    return {
      choice,
      match: raw.match || choice,
      relation: raw.relation || choice,
      verdict: raw.verdict || (choice as any),
      ratingMeaning: raw.ratingMeaning,
      noul: typeof raw.noul === "boolean" ? raw.noul : undefined,
      confidence: typeof raw.confidence === "number" ? raw.confidence : 0.9,
      explanation: raw.explanation,
    };
  }

  async evaluateBatchRules(
    reqOrText: JEVBatchRulesRequest | string,
    maybeRules?: any[]
  ): Promise<any> {
    let text = "";
    let questions: Array<{ id: string; question: string }> = [];
    const isStyleRulesArrayCall = typeof reqOrText === "string" && Array.isArray(maybeRules);

    if (isStyleRulesArrayCall) {
      text = reqOrText;
      questions = (maybeRules || []).map((r) => ({
        id: r.id,
        question: r.jevQuestion || r.question || r.description || r.name,
      }));
    } else {
      const req = reqOrText as JEVBatchRulesRequest;
      text = req.text;
      questions = req.questions || [];
    }

    const raw = await this.request<JEVBatchRulesResult>("/api/v1/batch-rules", { text, questions });
    const results = raw.results || {};

    if (isStyleRulesArrayCall) {
      const arrayResult = questions.map((q) => {
        const item = results[q.id] || { detected: false, confidence: 0.9 };
        return {
          ruleId: q.id,
          detected: item.detected,
          confidence: item.confidence,
          explanation: item.explanation,
          targetText: item.targetText || item.targetSnippet,
        };
      });
      (arrayResult as any).results = results;
      return arrayResult;
    }

    return raw;
  }

  async evaluateDeltaMeaningChange(
    originalClaimOrParams: string | JEVDeltaMeaningParams,
    revisedText?: string,
    allowedChanges?: string[]
  ): Promise<JEVDeltaMeaningResult> {
    let payload: any;
    if (typeof originalClaimOrParams === "object") {
      payload = originalClaimOrParams;
    } else {
      payload = {
        originalClaim: originalClaimOrParams,
        revisedText,
        allowedChanges,
      };
    }

    try {
      const raw = await this.request<any>("/api/v1/delta-check", payload);
      const hasUnauthorized = Boolean(raw.hasUnauthorizedChange ?? raw.unauthorizedChangeDetected);
      return {
        hasUnauthorizedChange: hasUnauthorized,
        unauthorizedChangeDetected: hasUnauthorized,
        unauthorizedChanges: Array.isArray(raw.unauthorizedChanges) ? raw.unauthorizedChanges : [],
        explanation: raw.explanation,
      };
    } catch (err) {
      const orig = payload.originalText || payload.originalClaim || "";
      const rev = payload.revisedText || "";
      const allowed = payload.authorizedChanges || payload.allowedChanges || [];

      const atomicResult = await this.evaluateAtomicJudgment({
        state: {
          originalClaim: orig,
          revisedText: rev,
          allowedChanges: allowed,
        },
        question: "Does the revised text introduce unauthorized semantic changes?",
        mode: "noul",
      });

      const hasChange = Boolean(atomicResult.noul);
      return {
        hasUnauthorizedChange: hasChange,
        unauthorizedChangeDetected: hasChange,
        unauthorizedChanges: hasChange
          ? [{ segment: rev, reason: atomicResult.explanation || "Unauthorized change detected" }]
          : [],
        explanation: atomicResult.explanation || "Evaluated via atomic judgment fallback",
      };
    }
  }
}

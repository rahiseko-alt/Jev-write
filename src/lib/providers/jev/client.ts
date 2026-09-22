import {
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVBatchRulesRequest,
  JEVBatchRulesResult,
  JEVClient,
  JEVDeltaMeaningParams,
  JEVDeltaMeaningResult,
} from "./types";

import { MockJEVClient } from "./mock";

export interface JEVClientOptions {
  apiUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
}

/**
 * Official TypeSafe AI Jev (System One) Client
 * Connects directly to POST https://api.typesafe.ai/v1/systemone
 * Evaluates atomic judgments, parallel choice/noul questions over state.
 */
export class HTTPJEVClient implements JEVClient {
  private apiUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private fallback: MockJEVClient;

  constructor(options: JEVClientOptions = {}) {
    // Default directly to TypeSafe AI's official System One endpoint
    this.apiUrl =
      options.apiUrl ||
      process.env.JEV_API_URL ||
      process.env.TYPESAFE_API_URL ||
      "https://api.typesafe.ai/v1/systemone";
    this.apiKey =
      options.apiKey ||
      process.env.JEV_API_KEY ||
      process.env.TYPESAFE_API_KEY ||
      "";
    this.timeoutMs = options.timeoutMs || 15000;
    this.fallback = new MockJEVClient();
  }

  /**
   * Send a systemone request to TypeSafe AI Jev
   */
  private async callSystemOne(state: any, questions: Record<string, any>): Promise<any> {
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

      // If apiUrl is a base URL without /systemone, append /v1/systemone
      let targetUrl = this.apiUrl;
      if (!targetUrl.includes("/systemone") && !targetUrl.endsWith("/atomic-judgment")) {
        targetUrl = targetUrl.replace(/\/$/, "") + "/v1/systemone";
      }

      const statePayload = typeof state === "string" ? state : JSON.stringify(state);

      const response = await fetch(targetUrl, {
        method: "POST",
        headers,
        body: JSON.stringify({
          model: 'jev-latest',
          state: statePayload,
          questions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new Error(
          `TypeSafe AI Jev request failed (${response.status} ${response.statusText}): ${errorText}`
        );
      }

      return await response.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`TypeSafe AI Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Evaluates a single atomic judgment (Choice or Noul) on state
   */
  async evaluateAtomicJudgment(req: JEVAtomicJudgmentRequest): Promise<JEVAtomicJudgmentResult> {
    try {
      const qType = req.mode === "noul" ? "noul" : "choice";
      const questionsPayload: Record<string, any> = {
        q1: {
          type: qType,
          instructions: req.instructions,
          ...(qType === "choice" ? { criteria: req.criteria || ["supports", "contradicts", "says_nothing", "ambiguous"] } : {}),
        },
      };

      const data = await this.callSystemOne(req.state, questionsPayload);
      const resultItem = data?.answers?.q1 || data?.results?.q1 || data?.q1 || data;

      const value = resultItem?.value || resultItem?.choice || resultItem?.selected;
      let noulVal: number | undefined;
      if (typeof resultItem?.noul === "number") {
        noulVal = resultItem.noul;
      } else if (typeof resultItem?.noul === "boolean") {
        noulVal = resultItem.noul ? 1 : 0;
      } else if (typeof value === "boolean") {
        noulVal = value ? 1 : 0;
      }
      const confidence = typeof resultItem?.confidence === "number" ? resultItem.confidence : 0.95;

      return {
        choice: typeof value === "string" ? value : undefined,
        match: typeof value === "string" ? value : undefined,
        relation: typeof value === "string" ? value : undefined,
        verdict: typeof value === "string" ? (value as any) : undefined,
        noul: noulVal,
        confidence,
        explanation: resultItem?.explanation,
      };
    } catch (err) {
      console.warn("HTTPJEVClient evaluateAtomicJudgment failed, using fallback:", err);
      return await this.fallback.evaluateAtomicJudgment(req);
    }
  }

  /**
   * Evaluates multiple style rules simultaneously in parallel on the same state
   */
  async evaluateBatchRules(
    reqOrText: JEVBatchRulesRequest | string,
    maybeRules?: any[]
  ): Promise<any> {
    let text = "";
    let rulesList: Array<{ id: string; question: string }> = [];
    const isStyleRulesArrayCall = typeof reqOrText === "string" && Array.isArray(maybeRules);

    if (isStyleRulesArrayCall) {
      text = reqOrText;
      rulesList = (maybeRules || []).map((r) => ({
        id: r.id,
        question: r.jevQuestion || r.question || r.description || r.name,
      }));
    } else {
      const req = reqOrText as JEVBatchRulesRequest;
      text = req.text;
      rulesList = req.questions || [];
    }

    // Convert each rule question into a Noul (true/false) or Choice question for Jev
    const questionsPayload: Record<string, any> = {};
    for (const r of rulesList) {
      questionsPayload[r.id] = {
        type: "noul",
        instructions: `${r.question} (文章中にこの表現や特徴が明確に存在するか？)`,
      };
    }

    try {
      const data = await this.callSystemOne(text, questionsPayload);
      const resultsMap = data?.answers || data?.results || data || {};

      const formattedResults: Record<string, any> = {};
      for (const r of rulesList) {
        const item = resultsMap[r.id] || {};
        const noulValue = typeof item.noul === "number" ? item.noul : item.noul === true ? 1 : 0;
        const detected = item.value === true || noulValue > 0.5 || item.detected === true;
        const confidence = typeof item.confidence === "number" ? item.confidence : 0.9;
        formattedResults[r.id] = {
          detected,
          confidence,
          explanation: item.explanation,
          targetSnippet: item.targetSnippet || item.targetText,
        };
      }

      if (isStyleRulesArrayCall) {
        const arrayResult = rulesList.map((q) => {
          const item = formattedResults[q.id];
          return {
            ruleId: q.id,
            detected: item.detected,
            confidence: item.confidence,
            explanation: item.explanation,
            targetText: item.targetSnippet,
          };
        });
        (arrayResult as any).results = formattedResults;
        return arrayResult;
      }

      return { results: formattedResults };
    } catch (err) {
      console.warn("HTTPJEVClient evaluateBatchRules failed, using fallback:", err);
      return await this.fallback.evaluateBatchRules(reqOrText, maybeRules);
    }
  }

  /**
   * Verifies if revised text introduces unauthorized factual mutations
   */
  async evaluateDeltaMeaningChange(
    originalClaimOrParams: string | JEVDeltaMeaningParams,
    revisedText?: string,
    allowedChanges?: string[]
  ): Promise<JEVDeltaMeaningResult> {
    let orig = "";
    let rev = "";
    let allowed: string[] = [];

    if (typeof originalClaimOrParams === "object") {
      orig = originalClaimOrParams.originalText || originalClaimOrParams.originalClaim || "";
      rev = originalClaimOrParams.revisedText || "";
      allowed = originalClaimOrParams.authorizedChanges || originalClaimOrParams.allowedChanges || [];
    } else {
      orig = originalClaimOrParams;
      rev = revisedText || "";
      allowed = allowedChanges || [];
    }

    const state = {
      originalClaim: orig,
      revisedText: rev,
      permittedChanges: allowed,
    };

    const atomicResult = await this.evaluateAtomicJudgment({
      state,
      instructions: "修正後の文章は、許可された変更（permittedChanges）以外に意味上の新しい事実変更や数値の改変を行っているか？",
      mode: "noul",
    });

    const hasUnauthorized = (atomicResult.noul ?? 0) > 0.5;
    return {
      hasUnauthorizedChange: hasUnauthorized,
      unauthorizedChangeDetected: hasUnauthorized,
      unauthorizedChanges: hasUnauthorized
        ? [{ segment: rev, reason: atomicResult.explanation || "未許可の事実変更を検出しました" }]
        : [],
      explanation: atomicResult.explanation,
      authorized: !hasUnauthorized,
      reason: hasUnauthorized ? (atomicResult.explanation || "未許可の事実変更を検出しました") : undefined,
    };
  }
}

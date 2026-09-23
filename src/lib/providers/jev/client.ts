import {
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVBatchRulesRequest,
  JEVBatchRulesResult,
  JEVClient,
  JEVDeltaMeaningParams,
  JEVDeltaMeaningResult,
} from "./types";
import { recordFailure } from "../diagnostics";


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
/**
 * Choice names as the API takes them: a mapping of name to description, where
 * a name with no description stands on its own.
 */
function asCriteria(criteria: string[] | Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(criteria)) return criteria;
  return Object.fromEntries(criteria.map((name) => [name, null]));
}

export class HTTPJEVClient implements JEVClient {
  /** What went wrong with the real service during this run, for the reader. */
  failureCount = 0;
  lastError?: string;
  private apiUrl: string;
  private apiKey: string;
  private timeoutMs: number;

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
      if (!this.apiKey) {
        throw new Error(
          "JEV API key is not configured (JEV_API_KEY / TYPESAFE_API_KEY)."
        );
      }
      headers["Authorization"] = `Bearer ${this.apiKey}`;

      // If apiUrl is a base URL without /systemone, append /v1/systemone
      let targetUrl = this.apiUrl;
      if (!targetUrl.includes("/systemone") && !targetUrl.endsWith("/atomic-judgment")) {
        targetUrl = targetUrl.replace(/\/$/, "") + "/v1/systemone";
      }

      // The API takes the state as a string, an object or an array; it is sent
      // as written rather than flattened into a string.
      const statePayload = state;

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
    const isNoul = req.mode === "noul";
    const questionsPayload: Record<string, unknown> = {
      q1: isNoul
        ? { type: "noul", instructions: req.instructions }
        : {
            type: "choice",
            instructions: req.instructions,
            // The API takes the choices as a mapping of name to description.
            // A choice with no description is read by its name alone.
            criteria: asCriteria(
              req.criteria || ["supports", "contradicts", "says_nothing", "ambiguous"]
            ),
          },
    };

    try {
      const data = await this.callSystemOne(req.state, questionsPayload);
      const answer = data?.answers?.q1;

      if (!answer) {
        throw new Error("JEV returned no answer for the question that was asked.");
      }

      if (answer.type === "noul" || typeof answer.noul === "number") {
        const noul = Number(answer.noul);
        return {
          noul,
          // A yes/no answer carries no confidence of its own: how sure it is
          // is how far from undecided it landed.
          confidence: noul >= 0.5 ? noul : 1 - noul,
        };
      }

      const choice = typeof answer.choice === "string" ? answer.choice : undefined;
      return {
        choice,
        match: choice,
        relation: choice,
        verdict: choice as JEVAtomicJudgmentResult["verdict"],
        confidence: typeof answer.confidence === "number" ? answer.confidence : 0,
      };
    } catch (err) {
      recordFailure(this, err);
      throw err;
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
      const answers = data?.answers || {};

      const formattedResults: Record<string, any> = {};
      for (const r of rulesList) {
        const item = answers[r.id] || {};
        const noulValue = typeof item.noul === "number" ? item.noul : 0;
        formattedResults[r.id] = {
          detected: noulValue > 0.5,
          confidence: noulValue >= 0.5 ? noulValue : 1 - noulValue,
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
      recordFailure(this, err);
      throw err;
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

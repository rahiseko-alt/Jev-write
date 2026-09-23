import { RatingVerdict } from "../google-factcheck/types";

export type JEVChoice =
  | "same"
  | "close_but_different"
  | "different"
  | "supports"
  | "contradicts"
  | "says_nothing"
  | "ambiguous";

export interface JEVAtomicJudgmentRequest {
  state?: Record<string, any>;
  instructions?: string;
  criteria?: string[];
  mode?: "choice" | "noul";
  type?: string;
  claim?: any;
  candidateText?: string;
  evidenceText?: string;
  [key: string]: any;
}

export interface JEVAtomicJudgmentResult {
  choice?: string;
  match?: string;
  relation?: string;
  verdict?: RatingVerdict;
  ratingMeaning?: string;
  noul?: number;
  confidence: number;
  explanation?: string;
}

export interface JEVBatchRulesRequest {
  text: string;
  questions: { id: string; question: string }[];
}

export interface JEVBatchRuleItemResult {
  ruleId?: string;
  detected: boolean;
  confidence: number;
  explanation?: string;
  targetSnippet?: string;
  targetText?: string;
}

export interface JEVBatchRulesResult {
  results: Record<string, JEVBatchRuleItemResult>;
}

export interface JEVDeltaMeaningParams {
  originalText?: string;
  revisedText?: string;
  authorizedChanges?: string[];
  originalClaim?: string;
  allowedChanges?: string[];
}

export interface JEVUnauthorizedChange {
  segment: string;
  reason: string;
  expectedFact?: string;
}

export interface JEVDeltaMeaningResult {
  hasUnauthorizedChange: boolean;
  unauthorizedChangeDetected: boolean;
  unauthorizedChanges: JEVUnauthorizedChange[];
  explanation?: string;
  authorized: boolean;
  reason?: string;
}

export interface JEVClient {
  /** True when this client answered with a stand-in rather than the real service. */
  servedByFallback?: boolean;
  evaluateAtomicJudgment(req: JEVAtomicJudgmentRequest): Promise<JEVAtomicJudgmentResult>;
  evaluateBatchRules(req: JEVBatchRulesRequest): Promise<JEVBatchRulesResult>;
  evaluateBatchRules(text: string, rules: any[]): Promise<any>;
  evaluateDeltaMeaningChange(
    originalClaimOrParams: string | JEVDeltaMeaningParams,
    revisedText?: string,
    allowedChanges?: string[]
  ): Promise<JEVDeltaMeaningResult>;
}

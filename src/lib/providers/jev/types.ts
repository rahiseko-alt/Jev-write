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

/**
 * What a question says. The API takes a string, or structure: an object that
 * holds the question in one field and the data it refers to in the others
 * (docs.typesafe.ai/primitives/advanced, "Structured instructions").
 */
export type JEVInstructions = string | Record<string, unknown> | unknown[];

/**
 * A question, in the shapes the API takes (see ADR-0007: the spec is JEV's,
 * https://api.typesafe.ai/openapi.json).
 */
export type JEVQuestion =
  | {
      type: "noul";
      instructions: JEVInstructions;
      /** What a yes and a no mean (NoulCriteria). */
      criteria?: { true?: JEVInstructions; false?: JEVInstructions };
    }
  | {
      type: "choice";
      instructions: string;
      /** Choice name to a description of when it applies. */
      criteria: Record<string, string>;
    }
  | {
      type: "score";
      instructions: string;
      /** Ordered descriptions of the levels; position is the score. */
      criteria: string[];
    };

/** An answer, as the API returns it. The numbers are kept, not collapsed. */
export type JEVAnswer =
  | { type: "noul"; noul: number }
  | {
      type: "choice";
      choice: string;
      confidence: number;
      probabilities: Record<string, number>;
    }
  | {
      type: "score";
      score: number;
      confidence: number;
      legend: unknown;
      probabilities: number[];
    };

export interface JEVClient {
  /**
   * Ask JEV several questions about one state, in one request.
   *
   * Questions are answered in parallel and named, so asking more of them
   * costs little beyond their tokens. Nothing here reduces the answers: the
   * caller receives the probabilities and confidence as they came.
   */
  ask?(
    state: unknown,
    questions: Record<string, JEVQuestion>
  ): Promise<Record<string, JEVAnswer>>;
  /** How many calls to the real service failed during this run. */
  failureCount?: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  /** How many times a busy JEV (429/5xx) was asked the same thing again. */
  retryCount?: number;
  evaluateAtomicJudgment(req: JEVAtomicJudgmentRequest): Promise<JEVAtomicJudgmentResult>;
}

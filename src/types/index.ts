import type { ConfidenceBand } from "@/lib/jev/bands";

// Domain Types for Document QA System (Jev-write)

export type Importance = "critical" | "high" | "normal" | "low";

export type Claim = {
  id: string;
  originalText: string;
  normalizedText: string;
  subject?: string;
  predicate?: string;
  object?: string;
  numbers?: string[];
  dates?: string[];
  entities?: string[];
  importance: Importance;
  factCheckRequired: boolean;
};

export type SourceType =
  | "primary"
  | "official"
  | "research"
  | "secondary"
  | "ugc"
  | "unknown";

export type Evidence = {
  id: string;
  claimId: string;
  sourceUrl: string;
  sourceTitle: string;
  publisher?: string;
  publishedAt?: string;
  excerpt: string;
  sourceType: SourceType;
  /**
   * How sure JEV was of the relation this Evidence stands for, on its own
   * scale of 0 to 1. Kept as given: the number is the point (ADR-0007).
   */
  confidence?: number;
  /** Which way this Evidence went: JEV's own choice for it. */
  relation?: "supports" | "contradicts";
};

export type ClaimVerdict =
  | "SUPPORTED"
  | "CONTRADICTED"
  | "MIXED"
  | "INSUFFICIENT";

export type StyleSeverity = "low" | "medium" | "high";

export type StyleRule = {
  id: string;
  name: string;
  description: string;
  jevQuestion: string;
  severity: StyleSeverity;
  repairInstruction: string;
  enabled: boolean;
};

export type StyleIssue = {
  ruleId: string;
  ruleName?: string;
  detected: boolean;
  confidence: number;
  severity: string;
  targetText?: string;
  repairInstruction: string;
};

export type ClaimResult = {
  claim: Claim;
  verdict: ClaimVerdict;
  reason?: string;
  evidence: Evidence[];
  confidence?: number;
  /**
   * True when a lookup for this claim could not be made at all — the service
   * was unreachable or unconfigured. Different from a lookup that ran and
   * found nothing, and the reader is told which happened.
   */
  lookupFailed?: boolean;
  /** Where this claim's evidence went: what was found, and what was dropped. */
  evidenceTrace?: EvidenceTrace;
  /**
   * Which of ADR-0008's three bands `confidence` falls in. Carried so the
   * screen can show the band beside the number rather than instead of it.
   */
  band?: ConfidenceBand;
  /**
   * JEV's reading of whether this claim holds together with the rest of the
   * article and the sources that were read. Asked in the same request as the
   * relations, and kept even when no source could be used — a claim nobody
   * published a figure for still gets a number here.
   */
  consistency?: {
    /** JEV's probability that the claim is true, 0 to 1. */
    probabilityTrue: number;
    /** How concentrated that answer was. */
    confidence: number;
  };
};

/**
 * The trail of one claim's search for evidence.
 *
 * "Nothing found" has several causes that look identical on screen: nobody
 * writes about it, the pages found were about something else, the pages could
 * not be read, or they were read and said nothing about the claim. This keeps
 * them apart, so a miss can be traced to where it happened rather than guessed at.
 */
export type EvidenceTrace = {
  /** What was actually asked of the search. */
  query: string;
  /** How many pages the search returned. */
  found: number;
  /** No longer used: JEV decides relevance within its own answer. */
  offSubject: number;
  /** How many could not be read (fetch failed, or the page was empty). */
  unreadable: number;
  /** How many were read and judged to say nothing about the claim. */
  saidNothing: number;
  /** How many gave a relation JEV was too unsure of to act on. */
  weak: number;
  /** How many became Evidence. */
  used: number;
};

export type StageTiming = {
  stage: string;
  durationMs: number;
};

export type AnalysisResult = {
  originalText: string;
  revisedText: string;
  summary: {
    claimsChecked: number;
    supported: number;
    contradicted: number;
    mixed: number;
    insufficient: number;
    styleIssuesFixed: number;
  };
  claims: ClaimResult[];
  styleIssues: StyleIssue[];
  sources: Evidence[];
  timings: StageTiming[];
  /**
   * True when the Delta Check found the rewrite had changed something it was
   * not authorised to change. The change itself is repaired or taken back;
   * the reader is told it happened.
   */
  unauthorizedChangeDetected?: boolean;
  /**
   * True when the rewrite was taken back wholesale because it could not be
   * made safe — as opposed to a change put right where it stood.
   */
  revisionRolledBack?: boolean;
  /**
   * What each outside service did during this run. A run that found nothing
   * because every check ran and found nothing, and a run that found nothing
   * because a service never answered, look identical without this.
   */
  providerStatuses?: ProviderStatus[];
};

export type ProviderStatus = {
  /** What this service does, in the reader's words. */
  service: string;
  /** How many calls to it failed during this run. */
  failureCount: number;
  /** The first failure's message, with anything credential-shaped removed. */
  lastError?: string;
  /** How many times a busy service (429/529) was asked the same thing again. */
  retryCount?: number;
};

export type JobStatus =
  | "QUEUED"
  | "ANALYZING"
  | "FACTCHECK_DATABASE"
  | "WEB_SEARCH"
  | "STYLE_ANALYSIS"
  | "REWRITING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED";

export type JobProgressEvent = {
  jobId: string;
  status: JobStatus;
  progressPercent: number;
  currentMessage: string;
  claimsCount?: number;
  factHits?: number;
  styleIssuesCount?: number;
  timestamp: string;
};

export type AnalyzeRequest = {
  text: string;
  mode: "standard";
  language?: string;
};

export type Job = {
  id: string;
  text: string;
  status: JobStatus;
  progressPercent: number;
  currentMessage: string;
  claimsCount?: number;
  factHits?: number;
  styleIssuesCount?: number;
  result?: AnalysisResult;
  error?: string;
  createdAt: number;
  updatedAt: number;
};

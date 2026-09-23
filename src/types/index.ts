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
};

export type ClaimVerdict =
  | "SUPPORTED"
  | "CONTRADICTED"
  | "MIXED"
  | "INSUFFICIENT";

export type FactLedgerItem = {
  claimId: string;
  originalClaim: string;
  verdict: ClaimVerdict;
  correctedClaim?: string;
  correctionReason?: string;
  lockedFacts: string[];
  evidenceIds: string[];
  confidence: number;
};

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

export type RewritePlan = {
  corrections: FactLedgerItem[];
  styleIssues: StyleIssue[];
  immutableFacts: string[];
  protectedQuotes: string[];
  protectedNames: string[];
};

export type ClaimResult = {
  claim: Claim;
  verdict: ClaimVerdict;
  correctedClaim?: string;
  reason?: string;
  evidence: Evidence[];
  confidence?: number;
  /**
   * True when a lookup for this claim could not be made at all — the service
   * was unreachable or unconfigured. Different from a lookup that ran and
   * found nothing, and the reader is told which happened.
   */
  lookupFailed?: boolean;
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
   * True when some part of this run was answered by a stub rather than the
   * configured provider. The reader is told, rather than shown a result that
   * looks like a full check.
   */
  servedByFallback?: boolean;
  /**
   * True when the Delta Check found the rewrite had changed something it was
   * not authorised to change. The change itself is repaired or taken back;
   * the reader is told it happened.
   */
  unauthorizedChangeDetected?: boolean;
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

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
  /**
   * The 信頼度: JEV's probability, as returned, that the sentence as written
   * is backed by the sources it was given (ADR-0011). Absent when no answer
   * came back — nothing is filled in.
   */
  confidence?: number;
  /**
   * True when a lookup for this claim could not be made at all — the service
   * was unreachable or unconfigured. Different from a lookup that ran and
   * found nothing, and the reader is told which happened.
   */
  lookupFailed?: boolean;
  /** Where this claim's evidence went: what was found, and what was dropped. */
  evidenceTrace?: EvidenceTrace;
};

/**
 * A search the generation wrote against the rules (ADR-0019), kept on the
 * record as it was written instead of being dropped without a word.
 */
export type QueryViolation = {
  /** The query exactly as the generation wrote it. */
  query: string;
  /**
   * The rules it broke: it was the claim's own sentence, it held a figure
   * under scrutiny (#31), or it held what the claim says (its content).
   */
  broke: Array<"sentence" | "figure" | "content">;
  /** The figures and content words taken out of it. */
  removed: string[];
  /** What of it was searched once those were out; absent when nothing was. */
  searched?: string;
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
  /**
   * The searches written for this claim — its own and the article's — that
   * broke the rules (ADR-0019), as written, with what was searched instead.
   */
  queryViolations?: QueryViolation[];
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
  /**
   * How many candidates were left out before JEV judged them (ADR-0016 had a
   * cap here). Since ADR-0022 no cap stands before JEV: every candidate is
   * put to it, so this is 0 unless a candidate could not be put to JEV at all
   * (larger than its input limit). Counted so none is dropped without saying so.
   */
  overCap?: number;
  /** How many independent origins (a site, or sites carrying the same text) the Evidence came from. */
  origins?: number;
  /**
   * What the relevance question asked about for this claim (ADR-0022): the
   * aspect ② named for it, 「what it is about」の「kind of fact」. Absent when
   * ② named none and extraction named no subject.
   */
  aspect?: string;
  /**
   * The claim's candidate sections (ADR-0022): how many there were, how many
   * JEV judged, and how many it judged related (at or above the line).
   */
  sections?: { candidates: number; judged: number; related: number };
  /**
   * The candidates whose relevance JEV never judged for this claim because
   * the time ran out (ADR-0021): the reason, how many sections, and the
   * pages holding them in the order they were due to be judged. Absent when
   * every candidate was judged.
   */
  unjudged?: UnjudgedCandidates;
  /**
   * The candidates whose relevance could not be judged because JEV failed to
   * answer the request, after its retries (ADR-0022): the failure, how many
   * sections, and the pages holding them in the order they were due. Kept
   * apart from `unjudged` (時間切れ): a service's failure is not the clock's
   * (ADR-0006). Absent when there was none.
   */
  unanswered?: UnjudgedCandidates;
};

/** Sections of candidate pages left unjudged for one reason (ADR-0021, ADR-0022). */
export type UnjudgedCandidates = {
  /** Why, in the reader's words: 時間切れ, or JEV's failure. */
  reason: string;
  /** How many sections were left unjudged. */
  sections: number;
  /** The pages holding them, in the order they were due to be judged. */
  urls: string[];
};

/**
 * How long one stage of the run took, for observability only (ADR-0021).
 * Stages overlap (the article's queries are written while the claims are
 * extracted), so `durationMs` is the time the stage had work in flight.
 */
export type StageTiming = {
  stage: string;
  durationMs: number;
  /** When the stage first started and last ended, in ms from the request's start. */
  startMs?: number;
  endMs?: number;
  /** The stage's cut-off, in ms from the request's start. */
  cutoffMs?: number;
  /** Calls to outside services the stage started. */
  calls?: number;
  /** Of those, the requests sent to JEV. */
  jevCalls?: number;
  /** Calls not started because the stage's cut-off had come (時間切れ). */
  notStarted?: number;
  /** Calls still running at the stage's cut-off, and stopped there (時間切れ). */
  stopped?: number;
};

/** One stage whose cut-off left work undone (ADR-0021). */
export type StageCut = {
  stage: string;
  /** Calls not started because the cut-off had come. */
  notStarted: number;
  /** Calls still running at the cut-off, and stopped. */
  stopped: number;
  /** The cut-off, in ms from the request's start. */
  cutoffMs: number;
};

/**
 * What the run's time budget left undone (ADR-0021). The result is still
 * returned, with what was done: the reader is told it is partial.
 */
export type CutShort = {
  /** Why, in the reader's words: 時間切れ. */
  reason: string;
  /** The stages whose cut-off left work undone, in run order. */
  stages: StageCut[];
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
  /**
   * How the article was taken apart into claims (ADR-0020): every sentence
   * the code cut, and what became of it. Absent when no extraction ran.
   */
  extraction?: ExtractionTrace;
  /**
   * Present when the time budget cut the run short (ADR-0021): which stages
   * left work undone. The result holds what was done by then.
   */
  cutShort?: CutShort;
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

/**
 * The record of one claim extraction (ADR-0020). The code cuts the article
 * into sentences and checks that the answer accounts for every one of them:
 * as claims, or as set aside with a reason. A sentence the answer left out is
 * listed as missing, never dropped without a word.
 */
export type ExtractionTrace = {
  /** Every sentence the code cut the article into, in reading order. */
  sentences: SentenceTrace[];
  /** Lines taken as headings: shown to the generation as context, never judged. */
  headings: string[];
  /** The ids of the sentences the answer did not account for. */
  missing: string[];
  /** What in the answer did not fit the fixed format, and what was done about it. */
  notes: string[];
};

export type SentenceTrace = {
  /** s1, s2, … as the code numbered it. */
  id: string;
  /** The sentence as cut from the article. */
  text: string;
  /** Claims were taken from it, it was set aside, or the answer said nothing of it. */
  outcome: "claims" | "excluded" | "missing";
  /** The claims taken from it, in order. Empty unless the outcome is "claims". */
  claimIds: string[];
  /** Why it holds no fact, as a fixed kind (opinion, advice, …). Only when set aside. */
  excluded?: string;
  /** The answer's own reason for setting it aside. */
  reason?: string;
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

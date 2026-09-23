import {
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVClient,
  JEVDeltaMeaningParams,
  JEVDeltaMeaningResult,
  JEVAnswer,
  JEVQuestion,
} from "./types";
import { recordFailure, recordRetry } from "../diagnostics";
import { sendWithRetry } from "../retry";

/**
 * The statuses that mean "busy, ask again": 429 (over the rate limit) and
 * the 5xx family, 529 Overloaded among them. JEV's own reference says to
 * retry 429 and 529 with backoff (docs.typesafe.ai/api, "Handling rate
 * limits"), and its SDKs retry 408, 429 and 500–599 by default. The same
 * request is sent again, the same way Anthropic's is (retry.ts: 2s, 4s, 8s,
 * or the wait retry-after asks for; at most three times). Any other status
 * is an answer about the request itself and is not sent again.
 */
export const JEV_RETRY_STATUSES: number[] = [
  429,
  ...Array.from({ length: 100 }, (_, i) => 500 + i),
];

/**
 * How many requests one run keeps in flight at JEV at once (ADR-0018). The
 * others wait their turn in the order they were made. JEV's limits are
 * 1,200 requests a minute and 250,000 tokens a second (docs.typesafe.ai/
 * models); the official cookbooks keep 4 (classifying_rag_passages, "keep
 * the pool small: the public endpoint rate-limits") and 12 (rerank_typesafe)
 * in flight. A request that is told to wait (429) keeps its place while it
 * waits, so a busy JEV slows the run down rather than being asked harder.
 */
export const JEV_MAX_CONCURRENT_REQUESTS = 8;

export interface JEVClientOptions {
  apiUrl?: string;
  apiKey?: string;
  /** The time one attempt may take, reply included. */
  timeoutMs?: number;
  /** How many requests may be in flight at once. */
  maxConcurrent?: number;
}

/** One attempt's outcome: what retry.ts needs to decide, and the reply itself. */
type Attempt = {
  ok: boolean;
  status: number;
  statusText: string;
  headers?: { get?: (name: string) => string | null } | null;
  data?: unknown;
  errorText?: string;
};

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
  /** How many times a busy JEV (429/5xx) was asked the same thing again. */
  retryCount = 0;
  private apiUrl: string;
  private apiKey: string;
  private timeoutMs: number;
  private maxConcurrent: number;
  /** Requests in flight now, and the ones waiting for a turn, first come first served. */
  private inFlight = 0;
  private waiting: (() => void)[] = [];

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
    this.maxConcurrent = Math.max(1, Math.floor(options.maxConcurrent ?? JEV_MAX_CONCURRENT_REQUESTS));
  }

  /**
   * Send a systemone request to TypeSafe AI Jev: when a turn is free, and
   * again (retry.ts) while JEV answers that it is busy. Still busy after the
   * last try, the failure is reported as the failure it is.
   */
  private async callSystemOne(state: any, questions: Record<string, any>): Promise<any> {
    if (!this.apiKey) {
      throw new Error(
        "JEV API key is not configured (JEV_API_KEY / TYPESAFE_API_KEY)."
      );
    }

    // If apiUrl is a base URL without /systemone, append /v1/systemone
    let targetUrl = this.apiUrl;
    if (!targetUrl.includes("/systemone") && !targetUrl.endsWith("/atomic-judgment")) {
      targetUrl = targetUrl.replace(/\/$/, "") + "/v1/systemone";
    }

    // The API takes the state as a string, an object or an array; it is sent
    // as written rather than flattened into a string.
    const body = JSON.stringify({
      model: 'jev-latest',
      state,
      questions,
    });

    await this.turn();
    try {
      const response = await sendWithRetry(() => this.attempt(targetUrl, body), {
        retryStatuses: JEV_RETRY_STATUSES,
        onRetry: () => recordRetry(this),
      });

      if (!response.ok) {
        throw new Error(
          `TypeSafe AI Jev request failed (${response.status} ${response.statusText}): ${response.errorText ?? ""}`
        );
      }

      return response.data;
    } finally {
      this.done();
    }
  }

  /** One try: the request and its whole reply, within the time limit. */
  private async attempt(targetUrl: string, body: string): Promise<Attempt> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: controller.signal,
      });

      const reply = {
        ok: response.ok,
        status: response.status,
        statusText: response.statusText,
        headers: response.headers,
      };
      if (!response.ok) {
        return { ...reply, errorText: await response.text().catch(() => "") };
      }
      return { ...reply, data: await response.json() };
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`TypeSafe AI Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      clearTimeout(timer);
    }
  }

  /** Waits until fewer than `maxConcurrent` requests are in flight. */
  private turn(): Promise<void> {
    if (this.inFlight < this.maxConcurrent) {
      this.inFlight++;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  /** Hands the finished request's turn to the next one waiting, if any. */
  private done(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.inFlight--;
  }

  /**
   * Ask several questions about one state, in one request.
   *
   * The answers come back as they were given — probabilities and confidence
   * included — because that is what they are for (ADR-0007).
   */
  async ask(
    state: unknown,
    questions: Record<string, JEVQuestion>
  ): Promise<Record<string, JEVAnswer>> {
    try {
      const data = await this.callSystemOne(state, questions);
      const answers = data?.answers;

      if (!answers) {
        throw new Error("JEV returned no answers for the questions that were asked.");
      }

      return answers as Record<string, JEVAnswer>;
    } catch (err) {
      recordFailure(this, err);
      throw err;
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
   * Verifies if revised text introduces unauthorized factual mutations
   */
}

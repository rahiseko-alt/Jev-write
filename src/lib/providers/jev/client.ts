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
import { CallLimit, attemptSignal, stoppedByCaller } from "../call-limit";
import { sendWithRetry } from "../retry";

/**
 * The replies that mean "busy, ask again" (ADR-0022). JEV's API reference
 * says to retry 429 Too Many Requests and 529 Overloaded with backoff
 * (docs.typesafe.ai/api, "Handling rate limits"); its SDKs retry 408, 429 and
 * 500–599 by default (docs.typesafe.ai/sdk/javascript/api/interfaces/
 * RetryPolicy). Any other status is an answer about the request itself and is
 * not sent again. A request that got no reply in its own time (15 s), or no
 * connection, is not sent again either, as with Anthropic (retry.ts).
 */
export const JEV_RETRY_STATUSES: number[] = [
  408,
  429,
  ...Array.from({ length: 100 }, (_, i) => 500 + i),
];

/**
 * The waits before sending again when JEV names none: the SDK's defaults,
 * two retries, 500 ms doubled (RetryPolicy: maxRetries 2, backoffInitialMs
 * 500). The SDK also takes a random part off each wait; that is left out, so
 * nothing in a run depends on chance. A retry-after JEV sends is waited out
 * instead (up to 60 s, retry.ts), and every wait ends at the stage's cut-off
 * (ADR-0021).
 */
export const JEV_RETRY_BACKOFF_MS = [500, 1_000];

export interface JEVClientOptions {
  apiUrl?: string;
  apiKey?: string;
  timeoutMs?: number;
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
  /** How many times a busy JEV (429/529 and the like) was asked the same thing again. */
  retryCount = 0;
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
   * Send a systemone request to TypeSafe AI Jev, and send it again while JEV
   * answers that it is busy (JEV_RETRY_STATUSES). Each attempt ends after the
   * client's own time for one request; the whole of it, retries and waits
   * included, ends when the caller's stage runs out of time (ADR-0021).
   */
  private async callSystemOne(
    state: any,
    questions: Record<string, any>,
    limit: CallLimit = {}
  ): Promise<any> {
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

    const response = await sendWithRetry(() => this.attempt(targetUrl, body, limit), {
      retryStatuses: JEV_RETRY_STATUSES,
      backoffMs: JEV_RETRY_BACKOFF_MS,
      signal: limit.signal,
      onRetry: () => recordRetry(this),
    });

    if (!response.ok) {
      throw new Error(
        `TypeSafe AI Jev request failed (${response.status} ${response.statusText}): ${response.errorText ?? ""}`
      );
    }
    return response.data;
  }

  /** One try: the request and its whole reply, within the time for one attempt. */
  private async attempt(targetUrl: string, body: string, limit: CallLimit): Promise<Attempt> {
    const attempt = attemptSignal(this.timeoutMs, limit.signal);

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body,
        signal: attempt.signal,
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
      // The caller's time ran out: said as such, not as JEV timing out.
      if (stoppedByCaller(limit)) throw err;
      if (err instanceof Error && err.name === "AbortError") {
        throw new Error(`TypeSafe AI Jev request timed out after ${this.timeoutMs}ms`);
      }
      throw err;
    } finally {
      attempt.release();
    }
  }

  /**
   * Ask several questions about one state, in one request.
   *
   * The answers come back as they were given — probabilities and confidence
   * included — because that is what they are for (ADR-0007).
   */
  async ask(
    state: unknown,
    questions: Record<string, JEVQuestion>,
    limit?: CallLimit
  ): Promise<Record<string, JEVAnswer>> {
    try {
      const data = await this.callSystemOne(state, questions, limit);
      const answers = data?.answers;

      if (!answers) {
        throw new Error("JEV returned no answers for the questions that were asked.");
      }

      return answers as Record<string, JEVAnswer>;
    } catch (err) {
      // Stopped at its stage's cut-off, JEV did not fail (ADR-0021).
      if (!stoppedByCaller(limit)) recordFailure(this, err);
      throw err;
    }
  }

  /**
   * Evaluates a single atomic judgment (Choice or Noul) on state
   */
  async evaluateAtomicJudgment(
    req: JEVAtomicJudgmentRequest,
    limit?: CallLimit
  ): Promise<JEVAtomicJudgmentResult> {
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
      const data = await this.callSystemOne(req.state, questionsPayload, limit);
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
      // Stopped at its stage's cut-off, JEV did not fail (ADR-0021).
      if (!stoppedByCaller(limit)) recordFailure(this, err);
      throw err;
    }
  }

  /**
   * Verifies if revised text introduces unauthorized factual mutations
   */
}

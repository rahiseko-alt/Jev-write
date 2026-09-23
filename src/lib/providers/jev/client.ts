import {
  JEVAskOptions,
  JEVAtomicJudgmentRequest,
  JEVAtomicJudgmentResult,
  JEVClient,
  JEVAnswer,
  JEVQuestion,
  JEVRequestError,
} from "./types";
import { parseRetryAfter } from "../retry";


export interface JEVClientOptions {
  apiUrl?: string;
  apiKey?: string;
  /** The time one attempt may take, reply included, when the caller names none. */
  timeoutMs?: number;
}

/**
 * Choice names as the API takes them: a mapping of name to description, where
 * a name with no description stands on its own.
 */
function asCriteria(criteria: string[] | Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(criteria)) return criteria;
  return Object.fromEntries(criteria.map((name) => [name, null]));
}

/**
 * The wait a refused reply asks for, in ms: `retry-after-ms` first, then
 * `retry-after` (seconds or a date), as JEV's own SDKs read them
 * (docs.typesafe.ai/sdk/javascript/api/interfaces/RetryPolicy).
 */
function retryAfterOf(headers?: { get?: (name: string) => string | null } | null): number | undefined {
  const inMs = Number(headers?.get?.("retry-after-ms"));
  if (headers?.get?.("retry-after-ms") && Number.isFinite(inMs) && inMs >= 0) return inMs;
  return parseRetryAfter(headers?.get?.("retry-after"));
}

/**
 * Official TypeSafe AI Jev (System One) Client
 * Connects directly to POST https://api.typesafe.ai/v1/systemone
 * Evaluates atomic judgments, parallel choice/noul questions over state.
 *
 * One call is one attempt. When JEV refuses (429 over the rate limit, 529
 * overloaded, other 5xx), the error carries the status and the wait the
 * reply asked for, and the caller decides whether there is time to send it
 * again (the dispatcher, ADR-0021). That caller also records the failure, so
 * a refusal that was retried and then answered is not counted as one.
 */
export class HTTPJEVClient implements JEVClient {
  /** What went wrong with the real service during this run, for the reader. */
  failureCount = 0;
  lastError?: string;
  /** How many times a busy JEV (429/5xx) was sent the same request again. */
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
   * Send a systemone request to TypeSafe AI Jev: one attempt, within
   * `timeoutMs`.
   */
  private async callSystemOne(
    state: any,
    questions: Record<string, any>,
    timeoutMs: number = this.timeoutMs
  ): Promise<any> {
    if (!this.apiKey) {
      throw new JEVRequestError("JEV API key is not configured (JEV_API_KEY / TYPESAFE_API_KEY).");
    }

    // If apiUrl is a base URL without /systemone, append /v1/systemone
    let targetUrl = this.apiUrl;
    if (!targetUrl.includes("/systemone") && !targetUrl.endsWith("/atomic-judgment")) {
      targetUrl = targetUrl.replace(/\/$/, "") + "/v1/systemone";
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));

    try {
      const response = await fetch(targetUrl, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        // The API takes the state as a string, an object or an array; it is
        // sent as written rather than flattened into a string.
        body: JSON.stringify({
          model: "jev-latest",
          state,
          questions,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "");
        throw new JEVRequestError(
          `TypeSafe AI Jev request failed (${response.status} ${response.statusText}): ${errorText}`,
          { status: response.status, retryAfterMs: retryAfterOf(response.headers) }
        );
      }

      return await response.json();
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        throw new JEVRequestError(`TypeSafe AI Jev request timed out after ${timeoutMs}ms`, {
          timedOut: true,
        });
      }
      throw err;
    } finally {
      clearTimeout(timer);
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
    options: JEVAskOptions = {}
  ): Promise<Record<string, JEVAnswer>> {
    const data = await this.callSystemOne(state, questions, options.timeoutMs);
    const answers = data?.answers;

    if (!answers) {
      throw new JEVRequestError("JEV returned no answers for the questions that were asked.");
    }

    return answers as Record<string, JEVAnswer>;
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

    const timeoutMs = typeof req.timeoutMs === "number" ? req.timeoutMs : undefined;
    const data = await this.callSystemOne(req.state, questionsPayload, timeoutMs);
    const answer = data?.answers?.q1;

    if (!answer) {
      throw new JEVRequestError("JEV returned no answer for the question that was asked.");
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
  }
}

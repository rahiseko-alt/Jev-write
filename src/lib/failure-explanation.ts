// 外部サービスが失敗したとき、書き手に「何が起きて、何をすればよいか」を日本語で伝える。
// 元の技術的な文言は捨てない。どのサービスが何と言って失敗したかは、不具合を
// 層で切り分ける手がかりであり（ADR-0006）、詳しい情報として必ず残す。

export type FailureKind =
  /** 残高不足・鍵の不備など、道具側の設定の問題。待っても押し直しても直らない。 */
  | "setup"
  /** 混雑・時間切れ・通信の途切れ。少し待てば直ることが多い。 */
  | "busy"
  /** 応答が長さ上限で打ち切られた。この部分の文章を短くすれば通る。 */
  | "too-long"
  /** 上のどれとも言い切れないもの。推測で書き手を責めない。 */
  | "unknown";

export interface FailureExplanation {
  kind: FailureKind;
  /** 書き手向けの主文。 */
  headline: string;
  /** 止まったサービス（分かるときだけ）。例: 「文章の解析（Anthropic）」 */
  service?: string;
  /** 元の技術的な文言。そのまま残す。 */
  details: string;
}

const HEADLINES: Record<FailureKind, string> = {
  setup:
    "いまは道具側の設定の問題で検査できません。文章を直す必要はありません。管理者に連絡してください。",
  busy: "一時的に混み合っています。少し待ってからもう一度お試しください。",
  "too-long":
    "この部分の文章が長く、処理が途中で打ち切られました。段落をいくつかに分けてから、もう一度お試しください。",
  unknown:
    "検査を最後まで行えませんでした。文章が原因かどうかは分かりません。もう一度試しても同じなら、下の詳しい情報を添えて管理者に連絡してください。",
};

const SERVICES: Array<[RegExp, string]> = [
  [/anthropic/i, "文章の解析（Anthropic）"],
  [/openai/i, "文章の解析（OpenAI）"],
  [/tavily/i, "ウェブ検索（Tavily）"],
  [/google fact check/i, "ファクトチェック検索（Google）"],
  [/\bjev\b|typesafe/i, "判定（JEV）"],
];

const TOO_LONG = [/max_tokens/i, /長さ上限/];

const SETUP = [
  /credit balance/i,
  /insufficient_quota/i,
  /billing/i,
  /api key/i,
  /api_key/i,
  /authentication/i,
  /permission/i,
  /unauthori[sz]ed/i,
  /forbidden/i,
  /not[ _]found_error/i,
  /model_not_found/i,
  /鍵/,
  /設定されていません/,
  /\((401|402|403)\b/,
];

const BUSY = [
  /rate.?limit/i,
  /overloaded/i,
  /timed? ?out/i,
  /timeout/i,
  /FUNCTION_INVOCATION_TIMEOUT/,
  /ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN/,
  /fetch failed/i,
  /failed to fetch/i,
  /network/i,
  /時間切れ|混み合/,
  /\((429|500|502|503|504|529)\b/,
];

const BUSY_STATUSES = new Set([408, 429, 500, 502, 503, 504, 529]);

/**
 * 失敗の文言（と、分かれば HTTP の状態番号）から、書き手向けの説明を作る。
 * 順番に意味がある: 残高不足は 429 で返ることもあるので、設定の問題を混雑より先に見る。
 */
export function explainFailure(details: string, status?: number): FailureExplanation {
  const text = details ?? "";
  const service = SERVICES.find(([pattern]) => pattern.test(text))?.[1];

  let kind: FailureKind = "unknown";
  if (TOO_LONG.some((p) => p.test(text))) kind = "too-long";
  else if (SETUP.some((p) => p.test(text))) kind = "setup";
  else if (BUSY.some((p) => p.test(text))) kind = "busy";
  else if (status !== undefined && BUSY_STATUSES.has(status)) kind = "busy";

  return { kind, headline: HEADLINES[kind], service, details: text };
}

/** 画面に出す失敗の知らせ。主文と、畳んで残す詳しい情報。 */
export interface FailureNotice {
  headline: string;
  service?: string;
  /** 元の文言。無いとき（入力の不備など、主文だけで足りるとき）は省く。 */
  details?: string;
}

/**
 * /api/analyze が失敗を返したときの知らせを作る。
 * 入力の不備（4xx で詳しい情報なし）は、サーバーが書いた日本語がそのまま主文になる。
 * それ以外は原因の種類で主文を選び、元の文言を詳しい情報に残す。
 */
export function noticeForResponse(
  status: number,
  data: { error?: string; details?: string }
): FailureNotice {
  const isInputProblem =
    status >= 400 && status < 500 && !BUSY_STATUSES.has(status) && !data.details && !!data.error;
  if (isInputProblem) return { headline: data.error! };

  const raw = [data.error, data.details].filter(Boolean).join(" / ");
  const explanation = explainFailure(raw, status);
  return {
    headline: explanation.headline,
    service: explanation.service,
    details: raw || `HTTP ${status}（サーバーから説明がありませんでした）`,
  };
}

/** 通信そのものが失敗した（応答が返らなかった）ときの知らせ。 */
export function noticeForError(err: unknown): FailureNotice {
  const raw = err instanceof Error ? err.message : String(err ?? "");
  const explanation = explainFailure(raw);
  return {
    headline: explanation.headline,
    service: explanation.service,
    details: raw || undefined,
  };
}

/** 段の名前（ADR-0021 の `result.timings` と `cutShort` の名前）を、書き手の言葉で。 */
const STAGE_NAMES: Record<string, string> = {
  extraction: "文の取り出し",
  queryGeneration: "検索の問いの作成",
  search: "ウェブ検索",
  pageFetch: "ページの取得",
  factCheck: "ファクトチェック照会",
  relevanceJudging: "資料の関連の判定（JEV）",
  supportJudging: "信頼度の判定（JEV）",
};

/**
 * 時間の上限で途中までになった結果の知らせ（ADR-0021）。途中までにならなかった結果には何も出さない。
 * 文の取り出しが終わらなかったときは、どの文も確かめていないことを主文で言う（何も印が無いことを
 * 「気になる箇所が無い」と読ませない）。それ以外は、数値の無い文が確かめきれていない文であることを言う。
 */
export function noticeForCutShort(result: {
  cutShort?: { stages: Array<{ stage: string; notStarted: number; stopped: number; cutoffMs: number }> };
}): FailureNotice | null {
  const stages = result.cutShort?.stages ?? [];
  if (stages.length === 0) return null;
  const headline = stages.some((stage) => stage.stage === "extraction")
    ? "時間内に文の取り出しが終わらなかったため、どの文もまだ確かめていません。記事が長いときは、いくつかに分けてから、もう一度お試しください。"
    : "時間の上限に近づいたため、途中までの結果をお見せしています。時間内に確かめきれなかった文は「数値なし」になっています。";
  const details = stages
    .map(
      (stage) =>
        `${STAGE_NAMES[stage.stage] ?? stage.stage}：始めなかったもの ${stage.notStarted}件・途中で止めたもの ${stage.stopped}件（開始から${Math.round(stage.cutoffMs / 1000)}秒で締め切り）`
    )
    .join("\n");
  return { headline, details };
}

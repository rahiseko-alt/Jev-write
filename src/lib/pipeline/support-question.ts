import type { JEVQuestion } from "@/lib/providers";

/**
 * The one question each sentence is asked (ADR-0011). Its answer, as JEV
 * returns it, is the 信頼度 on screen: higher means "yes, the sources back it".
 */
export const SUPPORT_QUESTION: JEVQuestion = {
  type: "noul",
  instructions: "記事の原文のこの文（claim.original）は、sources の内容で裏付けられているか。",
};

/**
 * JEV's input limits (docs.typesafe.ai/models): 64k tokens per request, and
 * 32k tokens for the state plus the single longest question. The budgets
 * below keep a margin under both, on top of an estimate that already
 * over-counts.
 */
export const STATE_TOKEN_BUDGET = 30000;
export const REQUEST_TOKEN_BUDGET = 60000;

/**
 * A deliberately high estimate of how many tokens a text costs: one and a
 * half per character outside ASCII (Japanese), one per three ASCII
 * characters. Too high only splits a request that would have fitted; too low
 * gets it refused.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 0x80) narrow++;
    else wide++;
  }
  return Math.ceil(wide * 1.5 + narrow / 3);
}

/** A page as it goes into the state. */
export type SourcePage = { title: string; url: string; text: string };

/** One entry of `sources` in one request: a whole page, or one part of a long one. */
export type SourceItem = {
  /** Which page this came from, in the order the pages were given. */
  page: number;
  source: SourcePage & { part?: string };
};

export type SupportRequest = {
  state: {
    claim: { original: string };
    article: string;
    sources: Array<SourcePage & { part?: string }>;
  };
  /** The page each entry of `state.sources` came from. */
  pages: number[];
};

/**
 * The requests that put this sentence's question to JEV, with every page's
 * full text in them.
 *
 * Normally one. Only when the pages together would go over JEV's limit are
 * they spread across more, each carrying the sentence and the whole article
 * again; a page too long to fit even on its own is cut into consecutive
 * parts, all of which are sent. Nothing is left out to make it fit
 * (ADR-0007): asking in several requests is what the limit leaves, not a
 * choice to split.
 */
export function planSupportRequests(params: {
  original: string;
  article: string;
  pages: SourcePage[];
  /** Every question that rides along with the support question, by the entry it is about. */
  questionFor?: (index: number) => JEVQuestion;
  stateBudget?: number;
  requestBudget?: number;
}): SupportRequest[] {
  const {
    original,
    article,
    pages,
    questionFor,
    stateBudget = STATE_TOKEN_BUDGET,
    requestBudget = REQUEST_TOKEN_BUDGET,
  } = params;

  const base = { claim: { original }, article, sources: [] as SupportRequest["state"]["sources"] };
  const questionCost = (index: number) =>
    questionFor ? estimateTokens(JSON.stringify(questionFor(index))) : 0;
  const supportCost = estimateTokens(JSON.stringify(SUPPORT_QUESTION));
  // The longest question: the support question, or a per-entry one.
  const longest = Math.max(supportCost, questionCost(99));
  const baseCost = estimateTokens(JSON.stringify(base));
  const room = stateBudget - baseCost - longest;

  if (room <= 0) {
    throw new Error(
      `記事が長すぎて、JEVの入力上限（状態と最長の問いで32kトークン）に収まりません（見積もり ${baseCost + longest}）。`
    );
  }

  const items: SourceItem[] = pages.flatMap((page, index) => splitPage(page, index, room));

  const requests: SupportRequest[] = [];
  let current: SourceItem[] = [];
  let used = 0;
  let asked = supportCost;

  const flush = () => {
    requests.push({
      state: { ...base, sources: current.map((item) => item.source) },
      pages: current.map((item) => item.page),
    });
    current = [];
    used = 0;
    asked = supportCost;
  };

  for (const item of items) {
    // A separator's worth on top of the item itself.
    const cost = estimateTokens(JSON.stringify(item.source)) + 1;
    const extra = questionCost(current.length);
    const fits =
      used + cost <= room && baseCost + used + cost + asked + extra <= requestBudget;
    if (!fits && current.length > 0) flush();
    current.push(item);
    used += cost;
    asked += questionCost(current.length - 1);
  }

  if (current.length > 0 || requests.length === 0) flush();
  return requests;
}

/** A page, whole if it fits in `room`, otherwise in consecutive parts that each do. */
function splitPage(page: SourcePage, index: number, room: number): SourceItem[] {
  const whole = { page: index, source: page };
  if (estimateTokens(JSON.stringify(page)) + 1 <= room) return [whole];

  const overhead = estimateTokens(JSON.stringify({ ...page, text: "", part: "999/999" })) + 1;
  // JSON escaping can double an ASCII character; count each as a wide one to be safe.
  const perPart = Math.max(1, Math.floor((room - overhead) / 1.5));
  const chars = Array.from(page.text);
  const parts: string[] = [];
  for (let at = 0; at < chars.length; at += perPart) {
    parts.push(chars.slice(at, at + perPart).join(""));
  }

  return parts.map((text, i) => ({
    page: index,
    source: { ...page, part: `${i + 1}/${parts.length}`, text },
  }));
}

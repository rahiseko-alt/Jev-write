import { Claim, QueryViolation } from "@/types";

/**
 * How the searches for evidence are written (ADR-0019, north star ②).
 *
 * A search names only what a fact is about and what kind of fact is to be
 * found out. What the text says the fact is — its values, the elements it
 * lists, its qualifiers, its conclusion — never goes in: a search made of it
 * finds the pages that say the same, right or wrong (a query listing a
 * model's stage names brought back the pages listing the same wrong name),
 * and a false figure finds nothing at all (#31).
 *
 * Both instructions are written in three parts — procedure, guidelines,
 * prohibitions — with worked examples and a fixed output: the output itself
 * cannot be fixed (no temperature on Anthropic), so the steps and the
 * examples are what hold it steady. The generation also writes down the
 * content it keeps out, so the code holds the same rule on every query
 * (checkClaimQueries, checkDocumentQueries).
 */

/** The kinds of fact a search may ask for, each with the plain words that name it. */
const KINDS = `definition (定義, 意味, 区分), composition (構成, 要素, 頭文字, 段階),
   time (時期, 開始年, 施行日, 期間), quantity (数, 規模, 金額, 割合),
   scope (範囲, 対象, 要件, 所在地), degree (程度, 効果, 順位),
   cause (原因, 理由, 影響), origin (提唱者, 発表元, 運営者)`;

/**
 * What a checker asks the web about each claim: first where the fact
 * originates (the primary source), then what could show it narrower or
 * wrong. All claims are asked for in one generation, never one call per claim.
 */
export const CLAIM_QUERY_SYSTEM_PROMPT = `You are a fact-checker. For each claim of an article, you write the web searches that would settle it.
A search made of what the claim says finds the pages that say the same thing, whether the claim is true or not; a false detail in it finds nothing.
So a query names only what the claim is about and what kind of fact is to be found out — never what the claim says that fact is.

## Procedure (do these steps in this order, for every claim)
1. About: identify what the claim is about — the thing, organisation, person, law, model or field it states a fact about —
   named as the claim names it, without anything the claim says about it.
2. Kind: identify the kind of fact the claim states about it, one of:
   ${KINDS}
3. Content: write down what the claim says that fact is — its values (numbers, dates, amounts, proportions), the elements
   it lists, its qualifiers and conditions (すべて, 必ず, だけ, 以上, 原則, 〜の場合) and its conclusion — one word or figure
   each, in the claim's own words. This is the answer the searches must find out, so none of it may appear in a query.
4. Query 1 reaches the primary source for that kind of fact about that subject: whoever proposed or defined it (提唱者, 原典),
   the ministry or agency in charge (所管官庁), the statute (法令), the original statistics (統計), or the subject's own
   site (公式サイト). Write it as about + kind + that source.
5. Query 2 looks for the limits, the exceptions and the opposing view: about + kind + a word such as 例外, 対象外, 条件, 異説, 批判.
   Write it unless the claim states nothing but a date, a figure, a place or a name.
6. Check every query against step 3. If any word or figure of the content is in it, take it out and name the kind instead.

## Guidelines (do this)
- Write in the same language as the claim. Name the subject exactly as the claim spells it.
- Build query 1 as 「<about> <kind> <source>」 and query 2 as 「<about> <kind> <limit>」.
- Name the kind by the attribute asked for (標高, 会員数, 施行日) or with the words listed for it in step 2.
- When the subject's name alone could mean something else, add its field (PDCAサイクル 品質管理).
- Put the entity in place of pronouns and vague words.
- Plain words, at most 8 words per query.

## Prohibitions (never do this)
- Never put the claim's content into a query: not its values, not the elements it lists, not its qualifiers, not its
  conclusion. They may be wrong, and a query holding them finds the pages that repeat them.
- Never use the claim's sentence, or a long stretch of it, as a query.
- Never invent an organisation's name or a domain. Name a source only when you know it exists; otherwise name the kind of
  source (所管官庁, 公式サイト, 原典).
- Never put two matters into one query: one subject and one kind of fact each.
- No quotation marks, no site: filters, no boolean operators, no question sentences.

## Example 1
Input:
id: claim-1
Claim: PDCAサイクルは、Plan（計画）、Do（実行）、Check（評価）、Act（改善）の4段階からなる。
Subject: PDCAサイクル
Figures in the claim (content: never in a query): 4段階

id: claim-2
Claim: PDCAサイクルは、デミングが提唱した。
Subject: PDCAサイクル
Figures in the claim (content: never in a query): N/A
Output:
{ "claims": [
  { "id": "claim-1", "about": "PDCAサイクル", "kind": "composition", "content": ["Plan", "計画", "Do", "実行", "Check", "評価", "Act", "改善", "4段階"], "queries": ["PDCAサイクル 品質管理 各段階 意味 提唱者", "PDCAサイクル 段階 名称 異説"] },
  { "id": "claim-2", "about": "PDCAサイクル", "kind": "origin", "content": ["デミング"], "queries": ["PDCAサイクル 提唱者 原典"] }
] }
(The stage names are what claim-1 says: a query listing them finds the pages that list the same names, right or wrong. The queries ask what the stages are and who defined them. In claim-2 the name is the content, so the query asks who proposed it; a claim that states nothing but a name gets query 1 only.)

## Example 2
Input:
id: claim-1
Claim: 2023年4月から、すべての自転車利用者にヘルメットの着用が義務づけられた。
Subject: 自転車利用者
Figures in the claim (content: never in a query): 2023年4月

id: claim-2
Claim: 自転車は、道路交通法上の軽車両にあたる。
Subject: 自転車
Figures in the claim (content: never in a query): N/A
Output:
{ "claims": [
  { "id": "claim-1", "about": "自転車 ヘルメット着用", "kind": "scope", "content": ["2023年4月", "すべて", "義務づけられた"], "queries": ["自転車 ヘルメット着用 対象 道路交通法", "自転車 ヘルメット着用 対象 例外"] },
  { "id": "claim-2", "about": "自転車", "kind": "definition", "content": ["軽車両"], "queries": ["自転車 道路交通法 区分 定義"] }
] }
(「すべて」, 「義務づけられた」 and the date are what claim-1 says; the queries ask whom the rule covers, in the statute and in its exceptions. In claim-2 the category is the content, so the query asks how the statute classifies bicycles.)

## Output (fixed format)
Return ONLY a valid JSON object with exactly one entry per claim given, using the ids given, nothing else:
{ "claims": [ { "id": "claim-1", "about": "what the claim is about", "kind": "one of the kinds in step 2", "content": ["what the claim says, one word or figure each"], "queries": ["query 1", "query 2"] } ] }`;

/**
 * Each claim as the searches are written for it: the claim, what it is about
 * and its figures. Not its other proper nouns — a proposer's or a ministry's
 * name is often exactly what the claim says, and a list of them invites them
 * into the queries. A figure that is part of the subject's own name (民法709条)
 * is what the claim is about, not what it says, so it is not listed as content.
 */
export function buildClaimQueryUserPrompt(claims: Claim[]): string {
  return claims
    .map((claim) => {
      const subjects = [matchable(claim.subject ?? "")].filter(Boolean);
      const figures = figuresOf(claim).filter((figure) => !inside(figure, subjects));
      return `id: ${claim.id}
Claim: ${claim.normalizedText || claim.originalText}
Subject: ${claim.subject || "N/A"}
Figures in the claim (content: never in a query): ${figures.join(", ") || "N/A"}`;
    })
    .join("\n\n");
}

/** How many queries one claim may search with (ADR-0015). */
export const QUERIES_PER_CLAIM = 2;

/** One claim's searches as the generation wrote them (ADR-0019). */
export type ClaimQueryPlan = {
  /** What the claim is about, as the generation named it. */
  about?: string;
  /** The kind of fact it states: definition, composition, time, quantity, scope, degree, cause or origin. */
  kind?: string;
  /** What the claim says that fact is — the answer to be found out — one word or figure each. */
  content: string[];
  /** The queries in the order written: the primary source first. */
  queries: string[];
};

/** One of the article's searches as the generation wrote it (ADR-0019). */
export type DocumentQueryPlan = {
  about?: string;
  kind?: string;
  /** What the article says of this subject and kind: never in the query. */
  content: string[];
  query: string;
};

/** The searches that keep to the rules, and the record of those that did not. */
export type CheckedQueries = {
  queries: string[];
  violations: QueryViolation[];
};

function figuresOf(claim: Claim): string[] {
  return [...(claim.numbers ?? []), ...(claim.dates ?? [])]
    .map((figure) => String(figure).trim())
    .filter(Boolean);
}

/**
 * Reads the generation's answer, keyed by claim id, as it was written. The
 * rules are held afterwards (checkClaimQueries), so that a query which broke
 * them can be put on the record rather than vanish here. A claim the answer
 * skipped gets no queries: it is still checked against the pages the
 * article's own queries found.
 */
export function readClaimQueries(parsed: unknown, claims: Claim[]): Map<string, ClaimQueryPlan> {
  const entries: any[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.claims)
      ? (parsed as any).claims
      : [];

  const byId = new Map<string, ClaimQueryPlan>();
  for (const claim of claims) {
    const entry = entries.find((item) => item && String(item.id) === claim.id);
    byId.set(claim.id, {
      about: textOf(entry?.about),
      kind: textOf(entry?.kind),
      content: listOf(entry?.content),
      queries: listOf(entry?.queries),
    });
  }
  return byId;
}

/** Reads the article's searches as written. A bare string is a query with no content named. */
export function readDocumentQueries(parsed: unknown): DocumentQueryPlan[] {
  const entries: unknown[] = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as any)?.queries)
      ? (parsed as any).queries
      : [];
  return entries.map(documentPlanOf).filter((plan) => plan.query.length > 0);
}

function documentPlanOf(entry: unknown): DocumentQueryPlan {
  if (typeof entry === "string") return { content: [], query: entry.trim() };
  const item = entry as any;
  return {
    about: textOf(item?.about),
    kind: textOf(item?.kind),
    content: listOf(item?.content),
    query: textOf(item?.query) ?? "",
  };
}

function textOf(value: unknown): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim();
  return text || undefined;
}

function listOf(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(textOf).filter((item): item is string => item !== undefined);
}

/**
 * The rules a claim's queries keep, held by code as well as asked for
 * (ADR-0019). They are fixed; nothing here is a judgement:
 *  1. the claim's own sentence is not searched;
 *  2. the claim's figures (#31) and the content the generation listed are
 *     taken out of every query — but nothing inside what the claim is about;
 *  3. a query that then asks nothing beyond the subject is not searched;
 *  4. no query twice, at most QUERIES_PER_CLAIM.
 * Every query that broke rule 1 or 2 comes back as written, with what was
 * taken out and what, if anything, was searched in its place.
 *
 * A plain list of queries is taken as queries with no content named.
 */
export function checkClaimQueries(claim: Claim, written: ClaimQueryPlan | string[]): CheckedQueries {
  const plan: ClaimQueryPlan = Array.isArray(written) ? { content: [], queries: written } : written;
  const rules: Rules = {
    sentences: [claim.originalText, claim.normalizedText]
      .map((text) => compact(text ?? ""))
      .filter(Boolean),
    figures: figuresOf(claim),
    content: termsOf(plan.content),
    subjects: [claim.subject, plan.about],
  };
  return keepToRules(
    plan.queries.map((query) => ({ query, rules })),
    QUERIES_PER_CLAIM
  );
}

/**
 * The same rules for the article's searches, each against the content the
 * generation listed for it (ADR-0019). There is no claim's sentence or
 * figure list to hold them against: the claims are not taken out yet when
 * these are written.
 */
export function checkDocumentQueries(
  written: Array<DocumentQueryPlan | string>,
  limit: number
): CheckedQueries {
  return keepToRules(
    written.map((entry) => {
      const plan: DocumentQueryPlan = typeof entry === "string" ? { content: [], query: entry } : entry;
      return {
        query: plan.query,
        rules: { sentences: [], figures: [], content: termsOf(plan.content), subjects: [plan.about] },
      };
    }),
    limit
  );
}

type Rules = {
  /** The claim's own sentences, compacted: never a search. */
  sentences: string[];
  /** The figures under scrutiny, as extraction listed them (#31). */
  figures: string[];
  /** What the text says, one term each, as the generation listed it. */
  content: string[];
  /** What the text is about: nothing inside it counts as content. */
  subjects: Array<string | undefined>;
};

function keepToRules(items: Array<{ query: string; rules: Rules }>, limit: number): CheckedQueries {
  const kept: string[] = [];
  const broken: Array<{ violation: QueryViolation; rest?: string }> = [];
  for (const { query, rules } of items) {
    const written = query.trim();
    if (!written) continue;
    const { rest, broke, removed } = checkQuery(written, rules);
    if (rest && !kept.includes(rest)) kept.push(rest);
    if (broke.length > 0) broken.push({ violation: { query: written, broke, removed }, rest });
  }

  const queries = kept.slice(0, limit);
  const violations = broken.map(({ violation, rest }) =>
    rest !== undefined && queries.includes(rest) ? { ...violation, searched: rest } : violation
  );
  return { queries, violations };
}

function checkQuery(
  query: string,
  rules: Rules
): { rest?: string; broke: QueryViolation["broke"]; removed: string[] } {
  if (rules.sentences.includes(compact(query))) return { broke: ["sentence"], removed: [] };

  const subjects = rules.subjects.map((subject) => matchable(subject ?? "")).filter(Boolean);
  const broke: QueryViolation["broke"] = [];
  const figures = takeOut(query, rules.figures, subjects);
  if (figures.removed.length > 0) broke.push("figure");
  const content = takeOut(figures.text, rules.content, subjects);
  if (content.removed.length > 0) broke.push("content");
  if (broke.length === 0) return { rest: query, broke, removed: [] };

  // What is left after the content is out is searched only if it still asks
  // something: a bare subject (an acronym, say) brings back pages about
  // whatever else carries the name.
  const rest = tidy(content.text);
  return {
    rest: asksBeyond(rest, subjects) ? rest : undefined,
    broke,
    removed: [...figures.removed, ...content.removed],
  };
}

/**
 * Takes every term out of the text, longest first. Latin words and figures
 * are matched as whole words and regardless of case ("Do" does not bite into
 * "Document"); other scripts as they stand, a single character only when it
 * is a word of its own. A term inside what the text is about is left in.
 */
function takeOut(text: string, terms: string[], subjects: string[]): { text: string; removed: string[] } {
  const ordered = [...new Set(terms.map((term) => term.normalize("NFKC").trim()).filter(Boolean))].sort(
    (a, b) => b.length - a.length
  );
  let rest = text.normalize("NFKC");
  const removed: string[] = [];
  for (const term of ordered) {
    if (inside(term, subjects)) continue;
    const pattern = patternOf(term);
    if (!pattern || rest.search(pattern) === -1) continue;
    rest = rest.replace(pattern, " ");
    removed.push(term);
  }
  return removed.length > 0 ? { text: rest, removed } : { text, removed };
}

function patternOf(term: string): RegExp | null {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (/^[\x21-\x7e]+(?: [\x21-\x7e]+)*$/.test(term)) {
    if (!/[A-Za-z0-9]/.test(term)) return null;
    return new RegExp(`(?<![A-Za-z0-9])${escaped}(?![A-Za-z0-9])`, "gi");
  }
  if ([...term].length === 1) {
    if (!/[\p{L}\p{N}]/u.test(term)) return null;
    return new RegExp(`(?<=^|\\s)${escaped}(?=\\s|$)`, "gu");
  }
  return new RegExp(escaped, "giu");
}

/** The content one term each: split at spaces and at the marks that join a list. */
function termsOf(content: string[]): string[] {
  return content
    .flatMap((item) => item.normalize("NFKC").split(/[\s、,・/&()「」『』【】\[\]"“”:;]+/))
    .map((term) => term.trim())
    .filter((term) => /[\p{L}\p{N}]/u.test(term));
}

function inside(term: string, subjects: string[]): boolean {
  const target = matchable(term);
  return target.length > 0 && subjects.some((subject) => subject.includes(target));
}

function asksBeyond(text: string, subjects: string[]): boolean {
  return text
    .split(/\s+/)
    .filter(Boolean)
    .some((word) => !inside(word, subjects));
}

/** Drops what taking terms out left behind: empty brackets, stray marks, extra spaces. */
function tidy(text: string): string {
  return text
    .replace(/[(「『【\[]\s*[)」』】\]]/g, " ")
    .split(/\s+/)
    .filter((word) => /[\p{L}\p{N}]/u.test(word))
    .join(" ");
}

function matchable(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s+/g, "");
}

function compact(text: string): string {
  return text.replace(/[\s。．.、,]/g, "");
}

/**
 * A checked article is mostly about a few subjects, so the pages that can
 * speak to it are largely the same for every sentence. These searches are
 * written once for the whole text and their pages serve every claim in it.
 */
export const DOCUMENT_QUERY_SYSTEM_PROMPT = `You write the searches that gather the reference pages for a whole article. Every sentence of the article will be checked against the pages they find.
A search made of what the article says finds the pages that say the same thing, whether the article is true or not; a false detail in it finds nothing.
So a query names only what a fact is about and what kind of fact is to be found out — never what the article says that fact is.

## Procedure (do these steps in this order)
1. About: list what the article states facts about — the things, organisations, people, laws, models and fields — named as
   the article names them, the most central first.
2. Kind: for each, identify the kinds of fact the article states about it, from:
   ${KINDS}
3. Content: for each, write down what the article says — its values (numbers, dates, amounts, proportions), the elements it
   lists, its qualifiers and conditions (すべて, 必ず, だけ, 以上, 原則, 〜の場合) and its conclusions — one word or figure each,
   in the article's own words. None of it may appear in a query.
4. Write 4 to 6 queries, one subject and one kind each. Query 1 is for the most central subject and reaches its primary source
   (提唱者, 原典, 所管官庁, 法令, 統計, 公式サイト). Give every subject a query before giving any subject a second one.
   Write each as about + kind + the primary source for it, or, where the article states a qualifier or a conclusion,
   about + kind + a word that finds the limits (例外, 対象外, 条件, 異説, 批判).
5. Check every query against step 3. If any word or figure of the content is in it, take it out and name the kind instead.

## Guidelines (do this)
- Write in the same language as the article. Name each subject exactly as the article spells it.
- Build every query as 「<about> <kind> <source>」 or 「<about> <kind> <limit>」.
- Name the kind by the attribute asked for (標高, 会員数, 施行日) or with the words listed for it in step 2.
- When a subject's name alone could mean something else, add its field.
- Plain words, at most 8 words per query.

## Prohibitions (never do this)
- Never put the article's content into a query: not its values, not the elements it lists, not its qualifiers, not its
  conclusions. They may be wrong, and a query holding them finds the pages that repeat them.
- Never use a sentence of the article, or a long stretch of one, as a query.
- Never invent an organisation's name or a domain. Name a source only when you know it exists; otherwise name the kind of
  source (所管官庁, 公式サイト, 原典).
- Never put two matters into one query: one subject and one kind of fact each.
- No quotation marks, no site: filters, no boolean operators, no question sentences.

## Example 1
Article: 日本では、2016年6月から選挙権年齢が18歳以上に引き下げられた。投票は原則として、住民票のある市区町村で行う。期日前投票は、公示日または告示日の翌日から投票日の前日まで行える。
Output:
{ "queries": [
  { "about": "選挙権年齢", "kind": "scope", "content": ["18歳以上", "引き下げられた"], "query": "選挙権年齢 要件 公職選挙法" },
  { "about": "投票場所", "kind": "scope", "content": ["原則として", "住民票のある市区町村"], "query": "選挙 投票場所 要件 例外" },
  { "about": "期日前投票", "kind": "time", "content": ["公示日", "告示日", "翌日から", "投票日の前日まで"], "query": "期日前投票 期間 総務省" },
  { "about": "選挙権年齢", "kind": "time", "content": ["2016年6月"], "query": "選挙権年齢 変更時期 総務省" }
] }
(The ages, the dates and 「原則として」 are what the article says; the queries ask what the rules are, in the statute and at the ministry in charge.)

## Example 2
Article: 富士山は、標高3776メートルの日本一高い山である。最後の噴火は、1707年の宝永噴火である。山頂は静岡県と山梨県の県境にある。
Output:
{ "queries": [
  { "about": "富士山", "kind": "quantity", "content": ["3776メートル"], "query": "富士山 標高 国土地理院" },
  { "about": "富士山 噴火", "kind": "time", "content": ["最後", "1707年", "宝永噴火"], "query": "富士山 噴火 時期 気象庁" },
  { "about": "富士山 山頂", "kind": "scope", "content": ["静岡県", "山梨県", "県境"], "query": "富士山 山頂 所在地" },
  { "about": "富士山", "kind": "degree", "content": ["日本一"], "query": "富士山 標高 順位" }
] }
(「日本一」, 「最後」, the figures, the eruption's name and the prefectures are what the article says; the queries ask the height, when it erupted, where the summit lies and how it ranks.)

## Output (fixed format)
Return ONLY a valid JSON object, nothing else:
{ "queries": [ { "about": "what the query is about", "kind": "one of the kinds in step 2", "content": ["what the article says of it, one word or figure each"], "query": "the search" } ] }`;

// The whole article goes in, never a leading slice of it: queries written from
// the first part alone leave the subjects of the rest without pages (ADR-0007).
export function buildDocumentQueryUserPrompt(text: string): string {
  return `Article:
${text}`;
}

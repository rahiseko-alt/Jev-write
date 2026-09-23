import { Claim, ExtractionTrace, Importance, SentenceTrace } from "@/types";
import { ArticleSentence, SplitArticle, splitArticle } from "@/lib/text/sentences";

/**
 * How claims are taken out of an article (ADR-0020, north star ①; replaces
 * part of ADR-0017).
 *
 * The code cuts the article into sentences and numbers them; the generation
 * never chooses or cuts a sentence. For each numbered sentence it counts the
 * facts by a fixed criterion and writes that many claims, or sets the
 * sentence aside with a reason. The code then checks that every sentence was
 * answered, that every quote is in its sentence as written, and numbers the
 * claims. Nothing is dropped without a word: a sentence the answer left out
 * is recorded as missing.
 *
 * One instruction for every provider, in three parts — procedure,
 * guidelines, prohibitions — with a fixed output and worked examples: the
 * output itself cannot be fixed (no temperature on Anthropic), so the steps
 * and the examples are what hold it steady.
 *
 * "originalText" places the ▶ beside the article and is the sentence JEV is
 * asked about. It is the whole sentence when the sentence states one fact,
 * and the stretch between the joints when it states several — never forced
 * on every claim of a sentence (#45: 11→8 findings). Claims may share a
 * sentence; none is merged or dropped for it, and a claim that lands on no
 * sentence is still shown, as 場所不明.
 */
export const CLAIM_EXTRACTION_SYSTEM_PROMPT = `You are a fact-checker. The article has already been cut into numbered sentences (s1, s2, …); lines marked (heading) are its headings.
For every numbered sentence you count the facts it states, by the fixed criteria below, and write one claim per fact.
Given the same sentence, the count and the claims must come out the same every time: apply the criteria exactly, never your own sense of how finely to split.

## Procedure (do these steps in this order, for every numbered sentence from s1 to the last, skipping none)
1. Read the sentence with the sentences and headings around it, so you know what its pronouns and omitted words refer to.
   Headings are context only: they get no entry.
2. Decide whether the sentence states a fact: something a source could confirm or contradict. A definite statement
   counts even if it may be exaggerated or wrong — that is what the check is for. If it states no fact, set it aside
   with one of these kinds; its count is 0.
   - "opinion": an evaluation or impression (〜と思う, 〜といえる, 〜は格別だ, 〜が近道だ)
   - "prediction": a forecast or a guess (〜だろう, 〜かもしれない, 〜の見込みだ)
   - "advice": a recommendation or an instruction to the reader (〜しましょう, 〜するとよい, 〜べきだ, 〜することが大切だ)
   - "hypothetical": a supposition (もし〜なら, 仮に〜としたら)
   - "question": a question put to the reader
   - "about-the-article": what the article itself does (本記事では〜を整理します)
   - "not-a-statement": a label or fragment that states nothing
3. Count its facts: count the main predicates that state a fact. Two main predicates are two facts only when both hold:
   a. they are joined as equals: in parallel (〜し、 〜て、 〜で、 〜であり、), in contrast (〜一方で、 〜のに対し、 〜が、),
      or as reason and result (〜ため、 〜ので、 〜から、 in the sense of "because");
   b. the stretch of each, read alone, names the thing it is about (the person, organisation, product, law, place or
      other entity), so each can be checked against its own source. A stretch whose subject is left out, or that names
      only a word such as 高さ, 対象者 or 期間 whose owner is named elsewhere, does not.
   Otherwise they are one fact. Everything attached to one predicate belongs to that one fact and is never counted
   apart: its subject and object and their modifiers (relative clauses such as 「2012年5月に開業した電波塔」),
   conditions (〜場合, 〜なら, 〜でも), limits and qualifiers (すべて, 必ず, だけ, 以上, 原則として), time, place,
   degree, purpose (〜するために), a list of items (A、B、Cの3つ), examples (たとえば〜), a note in brackets, and the
   source it is attributed to (〜によると, 〜とされる). A phrase that only points back to an earlier sentence
   (これを受け, そのため, このように) is not a fact of its own: it stays with the fact it opens. A sentence that joins a
   fact to an opinion, prediction or advice counts only the fact.
   When unsure whether it is one fact or two, count one. When unsure whether a definite statement states a fact,
   treat it as a fact.
4. Take each fact's "originalText" from the sentence. With one fact and nothing set aside, it is the whole sentence.
   Otherwise cut the sentence only at the joints you counted — between two facts, or between a fact and a part set
   aside — at the comma right after the joining word (〜のに対し、 〜一方で、 〜ため、 〜ので、 〜し、): the joining word
   stays at the end of the stretch before it, the comma belongs to neither, and the last stretch keeps the final 。.
   With no comma, cut right after the joining word. Each fact's "originalText" is its stretch; a stretch set aside
   gives no claim.
5. Write one claim per fact. "normalizedText" states that fact alone and can be understood without the article:
   replace pronouns and omitted subjects or objects with what the text names, and keep every qualifier, condition,
   time, quantity and scope (すべて, 必ず, だけ, 以上, 原則として, 〜の場合, 〜とされる).
6. Check: the number of claims equals the count, and if the sentence in the text is true, every claim is true.
   If a claim says more, less or something else, rewrite it until it is.

## Guidelines (do this)
- Answer every numbered sentence exactly once, in the order given, with the id it was given.
- Write every field in the same language as the text. Never translate.
- Copy "originalText" character for character from its own sentence, so that it is found in that sentence as is.
- Keep attributions and hedges as written (「〜によると」「〜とされる」「〜と言われる」).
- When the sentence can be read in more than one way and the text does not settle which, keep the sentence's own
  wording in "normalizedText", only filling in pronouns and omitted words, so the claim stays as open as the text.
- "numbers" and "dates" list the figures exactly as the text writes them.
- A sentence set aside gets its kind in "excluded" and a short reason in "reason", in the text's language.

## Prohibitions (never do this)
- Never cut, merge or renumber the sentences, and never give a heading an entry.
- Never skip a sentence: each one gets its claims, or a kind in "excluded".
- Never count a modifier, condition, limit, list item, example or attribution as a fact of its own.
- Never split a sentence into stretches that do not each name the thing they are about.
- Never drop or soften a qualifier, condition, time or quantity ("18歳以上" must not become "18歳").
- Never add a fact, number or entity the text does not state, and never correct the text.
- Never paraphrase, shorten with an ellipsis, translate or join sentences in "originalText".
- Never turn an opinion, prediction, piece of advice or hypothetical into a claim of fact.
- Never choose one reading of an ambiguous sentence.
- Never leave out a claim because another claim uses the same sentence.

## Example 1
Sentences:
(heading) ■ 東京の電波塔

s1: 東京スカイツリーは、東京都墨田区にある、2012年5月に開業した電波塔です。
s2: 東京タワーの高さが333メートルであるのに対し、東京スカイツリーの高さは634メートルです。
s3: 東京スカイツリーは開業以来多くの観光客を集め、自立式電波塔としては世界一の高さを誇ります。
s4: 展望台は、地上350メートルの天望デッキと地上450メートルの天望回廊の2つです。
s5: 展望台からの眺めは格別だといえるでしょう。
Output:
{ "sentences": [
  { "id": "s1", "facts": 1, "claims": [
    { "originalText": "東京スカイツリーは、東京都墨田区にある、2012年5月に開業した電波塔です。", "normalizedText": "東京スカイツリーは、東京都墨田区にある、2012年5月に開業した電波塔である。", "subject": "東京スカイツリー", "predicate": "電波塔である", "object": "2012年5月に開業した電波塔", "numbers": [], "dates": ["2012年5月"], "entities": ["東京スカイツリー", "東京都墨田区"], "importance": "high", "factCheckRequired": true } ] },
  { "id": "s2", "facts": 2, "claims": [
    { "originalText": "東京タワーの高さが333メートルであるのに対し", "normalizedText": "東京タワーの高さは333メートルである。", "subject": "東京タワー", "predicate": "高さ", "object": "333メートル", "numbers": ["333メートル"], "dates": [], "entities": ["東京タワー"], "importance": "high", "factCheckRequired": true },
    { "originalText": "東京スカイツリーの高さは634メートルです。", "normalizedText": "東京スカイツリーの高さは634メートルである。", "subject": "東京スカイツリー", "predicate": "高さ", "object": "634メートル", "numbers": ["634メートル"], "dates": [], "entities": ["東京スカイツリー"], "importance": "high", "factCheckRequired": true } ] },
  { "id": "s3", "facts": 1, "claims": [
    { "originalText": "東京スカイツリーは開業以来多くの観光客を集め、自立式電波塔としては世界一の高さを誇ります。", "normalizedText": "東京スカイツリーは開業以来多くの観光客を集め、自立式電波塔としては世界一の高さを誇る。", "subject": "東京スカイツリー", "predicate": "観光客を集め、世界一の高さを誇る", "object": "自立式電波塔として", "numbers": [], "dates": [], "entities": ["東京スカイツリー"], "importance": "normal", "factCheckRequired": true } ] },
  { "id": "s4", "facts": 1, "claims": [
    { "originalText": "展望台は、地上350メートルの天望デッキと地上450メートルの天望回廊の2つです。", "normalizedText": "東京スカイツリーの展望台は、地上350メートルの天望デッキと地上450メートルの天望回廊の2つである。", "subject": "東京スカイツリーの展望台", "predicate": "2つである", "object": "天望デッキと天望回廊", "numbers": ["350メートル", "450メートル", "2つ"], "dates": [], "entities": ["東京スカイツリー", "天望デッキ", "天望回廊"], "importance": "normal", "factCheckRequired": true } ] },
  { "id": "s5", "facts": 0, "excluded": "opinion", "reason": "「格別だといえるでしょう」は書き手の評価" }
] }
(s1: the place and the opening date modify 電波塔: one fact, the whole sentence. s2: two towers joined in contrast, each stretch naming its tower: two facts, cut at 「のに対し、」. s3: joined in parallel, but 「自立式電波塔としては世界一の高さを誇ります。」 leaves its subject out: one fact, the whole sentence. s4: a list under one predicate: one fact; the omitted 東京スカイツリー is named in "normalizedText" only. s5: an opinion.)

## Example 2
Sentences:
(heading) ■ 運転免許の決まり

s1: 日本では、普通自動車免許は原則として18歳以上でなければ取得できない。
s2: 免許を取った人は、その後1年間、初心者マークを必ず表示しなければならない。
s3: 高齢の運転者による事故が社会問題となったため、一定の違反歴がある75歳以上の運転者には運転技能検査が義務付けられた。
s4: この検査は2022年5月に始まり、免許の更新前に受けなければならない。
s5: 本記事では、免許の取得から更新までの流れを整理する。
s6: 更新には講習の受講が必要なので、案内が届いたら早めに予約するとよいだろう。
Output:
{ "sentences": [
  { "id": "s1", "facts": 1, "claims": [
    { "originalText": "日本では、普通自動車免許は原則として18歳以上でなければ取得できない。", "normalizedText": "日本では、普通自動車免許は原則として18歳以上でなければ取得できない。", "subject": "普通自動車免許", "predicate": "取得できる年齢", "object": "原則として18歳以上", "numbers": ["18歳以上"], "dates": [], "entities": ["普通自動車免許"], "importance": "high", "factCheckRequired": true } ] },
  { "id": "s2", "facts": 1, "claims": [
    { "originalText": "免許を取った人は、その後1年間、初心者マークを必ず表示しなければならない。", "normalizedText": "日本では、普通自動車免許を取った人は、取得後1年間、初心者マークを必ず表示しなければならない。", "subject": "普通自動車免許を取った人", "predicate": "表示しなければならない", "object": "初心者マーク", "numbers": ["1年間"], "dates": [], "entities": ["普通自動車免許", "初心者マーク"], "importance": "normal", "factCheckRequired": true } ] },
  { "id": "s3", "facts": 2, "claims": [
    { "originalText": "高齢の運転者による事故が社会問題となったため", "normalizedText": "日本では、高齢の運転者による事故が社会問題となった。", "subject": "高齢の運転者による事故", "predicate": "社会問題となった", "object": "社会問題", "numbers": [], "dates": [], "entities": [], "importance": "normal", "factCheckRequired": true },
    { "originalText": "一定の違反歴がある75歳以上の運転者には運転技能検査が義務付けられた。", "normalizedText": "日本では、一定の違反歴がある75歳以上の運転者には運転技能検査が義務付けられた。", "subject": "運転技能検査", "predicate": "義務付けられた", "object": "一定の違反歴がある75歳以上の運転者", "numbers": ["75歳以上"], "dates": [], "entities": ["運転技能検査"], "importance": "high", "factCheckRequired": true } ] },
  { "id": "s4", "facts": 1, "claims": [
    { "originalText": "この検査は2022年5月に始まり、免許の更新前に受けなければならない。", "normalizedText": "運転技能検査は2022年5月に始まり、免許の更新前に受けなければならない検査である。", "subject": "運転技能検査", "predicate": "始まり、更新前に受けなければならない", "object": "免許の更新前", "numbers": [], "dates": ["2022年5月"], "entities": ["運転技能検査"], "importance": "high", "factCheckRequired": true } ] },
  { "id": "s5", "facts": 0, "excluded": "about-the-article", "reason": "記事自体が何をするかを述べている" },
  { "id": "s6", "facts": 1, "claims": [
    { "originalText": "更新には講習の受講が必要なので", "normalizedText": "日本では、運転免許の更新には講習の受講が必要である。", "subject": "運転免許の更新", "predicate": "必要である", "object": "講習の受講", "numbers": [], "dates": [], "entities": ["運転免許"], "importance": "normal", "factCheckRequired": true } ] }
] }
(s1, s2: 「原則として」「18歳以上」「その後1年間」「必ず」 are kept, and s2's omitted 普通自動車免許 is named in "normalizedText". s3: reason and result, each stretch naming what it is about: two facts, cut at 「ため、」. s4: 「この検査」 becomes 運転技能検査, and 「免許の更新前に受けなければならない。」 leaves its subject out: one fact, the whole sentence. s5: about the article. s6: a fact joined to advice: only the fact, cut at 「ので、」.)

## Output (fixed format)
Return ONLY a valid JSON object with this exact structure, nothing else:
{
  "sentences": [
    {
      "id": "s1",
      "facts": 1,
      "claims": [
        {
          "originalText": "the whole sentence, or the stretch of it that states this fact, copied exactly",
          "normalizedText": "one fact, understandable on its own, qualifiers kept",
          "subject": "main entity or subject",
          "predicate": "action or property",
          "object": "target or value",
          "numbers": ["numbers or amounts as written"],
          "dates": ["dates or timeframes as written"],
          "entities": ["named entities, products, organizations"],
          "importance": "critical" | "high" | "normal" | "low",
          "factCheckRequired": true
        }
      ]
    },
    {
      "id": "s2",
      "facts": 0,
      "excluded": "opinion" | "prediction" | "advice" | "hypothetical" | "question" | "about-the-article" | "not-a-statement",
      "reason": "why it states no fact, in a few words"
    }
  ]
}
One entry for every numbered sentence, in the order given, with the id given. "facts" is the number of its claims;
an entry with "facts": 0 has "excluded" and "reason" instead of "claims".`;

/** The kinds a sentence may be set aside as (the procedure's step 2). */
export const EXCLUDED_KINDS = [
  "opinion",
  "prediction",
  "advice",
  "hypothetical",
  "question",
  "about-the-article",
  "not-a-statement",
] as const;

/**
 * The request: every sentence with its number, and the headings among them as
 * context, in reading order. A blank line stands where the text changes line.
 */
export function buildClaimExtractionUserPrompt(article: SplitArticle): string {
  const units = [
    ...article.headings.map((heading) => ({ line: heading.line, text: `(heading) ${heading.text}` })),
    ...article.sentences.map((sentence) => ({ line: sentence.line, text: `${sentence.id}: ${sentence.text}` })),
  ].sort((a, b) => a.line - b.line);

  const body = units
    .map((unit, i) => (i > 0 && units[i - 1].line !== unit.line ? `\n${unit.text}` : unit.text))
    .join("\n");
  return `Sentences:\n${body}`;
}

export type ExtractedClaims = {
  claims: Claim[];
  trace: ExtractionTrace;
};

const IMPORTANCE: Importance[] = ["critical", "high", "normal", "low"];

/**
 * Reads the answer against the sentences it was asked about. Every sentence
 * comes out as claims, as set aside with a reason, or as missing — and a
 * missing one is recorded, not passed over. Claims are kept even when they
 * share a sentence or their count disagrees with the answer's own "facts";
 * an "originalText" that is not in its sentence as written is replaced with
 * the whole sentence, and that is recorded too. Claims are numbered here, in
 * reading order.
 */
export function readExtractedClaims(parsed: unknown, article: SplitArticle): ExtractedClaims {
  const entries: unknown[] = Array.isArray((parsed as any)?.sentences)
    ? (parsed as any).sentences
    : Array.isArray(parsed)
      ? parsed
      : [];

  const notes: string[] = [];
  const known = new Set(article.sentences.map((sentence) => sentence.id));
  const answered = new Map<string, any>();
  for (const entry of entries) {
    const id = idOf(entry);
    if (!known.has(id)) {
      notes.push(`渡していない文の番号（${id || "番号なし"}）への答えがあった。使っていない。`);
      continue;
    }
    if (answered.has(id)) {
      notes.push(`${id}: 答えが2つあった。最初の答えを使った。`);
      continue;
    }
    answered.set(id, entry);
  }

  const claims: Claim[] = [];
  const sentences: SentenceTrace[] = [];
  const missing: string[] = [];

  for (const sentence of article.sentences) {
    const entry = answered.get(sentence.id);
    const base = { id: sentence.id, text: sentence.text };
    if (!entry) {
      missing.push(sentence.id);
      sentences.push({ ...base, outcome: "missing", claimIds: [] });
      continue;
    }

    const facts = Number(entry.facts);
    const rawClaims: unknown[] = Array.isArray(entry.claims) ? entry.claims : [];
    const taken: Claim[] = [];
    for (const item of rawClaims) {
      if (!item || typeof item !== "object") {
        notes.push(`${sentence.id}: 主張として読めない要素があった。`);
        continue;
      }
      taken.push(toClaim(item, sentence, `claim-${claims.length + taken.length + 1}`, notes));
    }

    if (taken.length > 0) {
      if (facts !== taken.length) {
        notes.push(
          `${sentence.id}: 事実の数（${String(entry.facts)}）と主張の数（${taken.length}）が合わない。主張はすべて残した。`
        );
      }
      claims.push(...taken);
      sentences.push({ ...base, outcome: "claims", claimIds: taken.map((claim) => claim.id) });
      continue;
    }

    const excluded = typeof entry.excluded === "string" ? entry.excluded.trim() : "";
    if (excluded) {
      if (facts > 0) {
        notes.push(`${sentence.id}: 事実の数は ${facts} だが主張が無く、対象外（${excluded}）とされていた。`);
      }
      if (!(EXCLUDED_KINDS as readonly string[]).includes(excluded)) {
        notes.push(`${sentence.id}: 対象外の種類「${excluded}」は決まった種類に無い。`);
      }
      const reason = typeof entry.reason === "string" ? entry.reason.trim() : "";
      sentences.push({
        ...base,
        outcome: "excluded",
        claimIds: [],
        excluded,
        ...(reason ? { reason } : {}),
      });
      continue;
    }

    missing.push(sentence.id);
    notes.push(`${sentence.id}: 主張も対象外の理由も無かった。`);
    sentences.push({ ...base, outcome: "missing", claimIds: [] });
  }

  return {
    claims,
    trace: {
      sentences,
      headings: article.headings.map((heading) => heading.text),
      missing,
      notes,
    },
  };
}

/**
 * The whole extraction but the call itself: the article cut into sentences
 * by code, one request listing them all, the answer read against them, and
 * the outcome logged. `ask` sends the two prompts and returns the answer as
 * parsed JSON. With no sentence to judge, nothing is asked.
 */
export async function extractClaimsFrom(
  text: string,
  ask: (systemPrompt: string, userPrompt: string) => Promise<unknown>
): Promise<ExtractedClaims> {
  const article = splitArticle(text);
  const answer =
    article.sentences.length > 0
      ? await ask(CLAIM_EXTRACTION_SYSTEM_PROMPT, buildClaimExtractionUserPrompt(article))
      : { sentences: [] };
  const extracted = readExtractedClaims(answer, article);
  logExtraction(extracted);
  return extracted;
}

/** The outcome in the run's log; a missing sentence and every note as a warning. */
function logExtraction({ claims, trace }: ExtractedClaims): void {
  const count = (outcome: SentenceTrace["outcome"]) =>
    trace.sentences.filter((sentence) => sentence.outcome === outcome).length;
  console.info(
    `主張の取り出し（ADR-0020）: 文 ${trace.sentences.length}（主張あり ${count("claims")}・対象外 ${count("excluded")}・欠け ${count("missing")}）、見出し ${trace.headings.length}、主張 ${claims.length} 件`
  );
  if (trace.missing.length > 0) {
    const listed = trace.sentences
      .filter((sentence) => sentence.outcome === "missing")
      .map((sentence) => `${sentence.id}「${sentence.text}」`)
      .join(" ");
    console.warn(`主張の取り出し: 答えの無い文 ${trace.missing.length} 件: ${listed}`);
  }
  for (const note of trace.notes) console.warn(`主張の取り出し: ${note}`);
}

function idOf(entry: unknown): string {
  const raw = (entry as any)?.id;
  if (raw === undefined || raw === null) return "";
  const id = String(raw).trim().toLowerCase();
  const number = /^s?0*(\d+)$/.exec(id);
  return number ? `s${number[1]}` : id;
}

function toClaim(item: any, sentence: ArticleSentence, id: string, notes: string[]): Claim {
  const quoted = typeof item.originalText === "string" ? item.originalText.trim() : "";
  let originalText = quoted;
  if (!quoted || !sentence.text.includes(quoted)) {
    notes.push(
      `${sentence.id}: originalText「${quoted}」が文の中にそのままの形で無いため、文全体に置き換えた（${id}）。`
    );
    originalText = sentence.text;
  }
  const importance: Importance = IMPORTANCE.includes(item.importance) ? item.importance : "normal";

  return {
    id,
    originalText,
    normalizedText: String(item.normalizedText || originalText),
    subject: item.subject ? String(item.subject) : undefined,
    predicate: item.predicate ? String(item.predicate) : undefined,
    object: item.object ? String(item.object) : undefined,
    numbers: Array.isArray(item.numbers) ? item.numbers.map(String) : [],
    dates: Array.isArray(item.dates) ? item.dates.map(String) : [],
    entities: Array.isArray(item.entities) ? item.entities.map(String) : [],
    importance,
    factCheckRequired: typeof item.factCheckRequired === "boolean" ? item.factCheckRequired : true,
  };
}

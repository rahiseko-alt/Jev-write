import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  EXCLUDED_KINDS,
  buildClaimExtractionUserPrompt,
  extractClaimsFrom,
  readExtractedClaims,
} from "@/lib/providers/llm/claim-extraction";
import { splitArticle } from "@/lib/text/sentences";
import { buildRevisedDocument, isUnplaced } from "@/lib/revised-document";
import type { AnalysisResult, ClaimResult } from "@/types";

/**
 * ADR-0020 (north star ①, replacing part of ADR-0017): the code cuts the
 * article into numbered sentences; for each one the generation counts the
 * facts by a fixed criterion and writes that many claims, or sets the
 * sentence aside with a reason. The code checks that every sentence came
 * back one way or the other, and records the ones that did not.
 */

const prompt = CLAIM_EXTRACTION_SYSTEM_PROMPT;

function section(heading: string): string {
  const start = prompt.indexOf(heading);
  const next = prompt.indexOf("\n## ", start + heading.length);
  return prompt.slice(start, next === -1 ? undefined : next);
}

type Shown = {
  sentences: Array<{ id: string; text: string }>;
  headings: string[];
  output: any;
};

/** The worked examples: the numbered sentences as given, and the answer. */
function examples(): Shown[] {
  return [...prompt.matchAll(/## Example \d+\nSentences:\n([\s\S]+?)\nOutput:\n([\s\S]+?\n\] \})/g)].map(
    (match) => {
      const lines = match[1].split("\n").filter((line) => line.trim() !== "");
      return {
        sentences: lines
          .filter((line) => /^s\d+: /.test(line))
          .map((line) => ({ id: line.slice(0, line.indexOf(":")), text: line.slice(line.indexOf(": ") + 2) })),
        headings: lines.filter((line) => line.startsWith("(heading) ")).map((line) => line.slice(10)),
        output: JSON.parse(match[2]),
      };
    }
  );
}

/** A split article built from given sentences, one line each, as the code would number them. */
function articleOf(texts: string[]) {
  return splitArticle(texts.join("\n"));
}

describe("主張の取り出しの指示文（ADR-0020）", () => {
  it("手順・ガイドライン・禁止事項・例示・出力形式の順に書かれている", () => {
    const order = [
      "## Procedure",
      "## Guidelines",
      "## Prohibitions",
      "## Example 1",
      "## Example 2",
      "## Output (fixed format)",
    ].map((heading) => prompt.indexOf(heading));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });

  it("手順は、文脈を読む→事実かの判定→事実の数を数える→originalText を取る→主張を書く→点検の順", () => {
    const procedure = section("## Procedure");
    const steps = [
      /1\. Read the sentence with the sentences and headings around it/,
      /2\. Decide whether the sentence states a fact/,
      /3\. Count its facts/,
      /4\. Take each fact's "originalText" from the sentence/,
      /5\. Write one claim per fact/,
      /6\. Check: the number of claims equals the count/,
    ].map((step) => procedure.search(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    // The kinds a sentence may be set aside as are the ones the code accepts.
    for (const kind of EXCLUDED_KINDS) expect(procedure).toContain(`"${kind}"`);
  });

  it("割る基準（並列・対比・理由で、各部分がそれ自体で何についてかを言える）と割らない基準を明文化している", () => {
    const procedure = section("## Procedure");
    expect(procedure).toMatch(/Two main predicates are two facts only when both hold/);
    expect(procedure).toMatch(/in parallel \(〜し、/);
    expect(procedure).toMatch(/in contrast \(〜一方で、/);
    expect(procedure).toMatch(/as reason and result \(〜ため、/);
    expect(procedure).toMatch(/names the thing it is about/);
    expect(procedure).toMatch(/Otherwise they are one fact/);
    expect(procedure).toMatch(
      /Everything attached to one predicate belongs to that one fact and is never counted\s+apart/
    );
    expect(procedure).toMatch(/When unsure whether it is one fact or two, count one/);
    // Where a split sentence is cut, and what one fact copies.
    expect(procedure).toMatch(/With one fact and nothing set aside, it is the whole sentence/);
    expect(procedure).toMatch(/cut the sentence only at the joints you counted/);
    expect(procedure).toMatch(/A stretch whose subject is left out/);
  });

  it("禁止事項に、文を切り直さない・文を飛ばさない・修飾を事実に数えない・何についてか言えない部分に割らない・限定語を落とさない・意見を混ぜない・主張を落とさない、がある", () => {
    const prohibitions = section("## Prohibitions");
    expect(prohibitions).toMatch(/Never cut, merge or renumber the sentences/);
    expect(prohibitions).toMatch(/Never skip a sentence/);
    expect(prohibitions).toMatch(/Never count a modifier, condition, limit, list item, example or attribution/);
    expect(prohibitions).toMatch(/Never split a sentence into stretches that do not each name/);
    expect(prohibitions).toMatch(/Never drop or soften a qualifier/);
    expect(prohibitions).toMatch(/Never turn an opinion, prediction, piece of advice or hypothetical/);
    expect(prohibitions).toMatch(/Never choose one reading of an ambiguous sentence/);
    expect(prohibitions).toMatch(/Never leave out a claim because another claim uses the same sentence/);
  });

  it("例示は2つ以上で、例示も手順の中の言い回しの例も、検証用の記事10本とは別の題材", () => {
    const shown = examples();
    expect(shown.length).toBeGreaterThanOrEqual(2);
    const articleTopics =
      /口コミ|AISAS|SIPS|電通|ステマ|景品表示|健康食品|機能性表示|個人情報|Cookie|SEO|Google|ふるさと納税|睡眠|労働基準|有給|インボイス|消費税|マズロー|ピグマリオン|著作権|生成AI/;
    for (const { sentences, headings, output } of shown) {
      expect(JSON.stringify({ sentences, headings, output })).not.toMatch(articleTopics);
    }
    expect(prompt).not.toMatch(articleTopics);
  });

  it("例示の出力は固定の形式どおりで、どの文にもちょうど1回、番号順に答えている", () => {
    const fields = [
      "originalText",
      "normalizedText",
      "subject",
      "predicate",
      "object",
      "numbers",
      "dates",
      "entities",
      "importance",
      "factCheckRequired",
    ];
    for (const { sentences, output } of examples()) {
      expect(output.sentences.map((entry: any) => entry.id)).toEqual(sentences.map((s) => s.id));
      output.sentences.forEach((entry: any, i: number) => {
        const sentence = sentences[i].text;
        if (entry.facts === 0) {
          expect(Object.keys(entry)).toEqual(["id", "facts", "excluded", "reason"]);
          expect(EXCLUDED_KINDS).toContain(entry.excluded);
          expect(entry.reason.length).toBeGreaterThan(0);
          return;
        }
        expect(Object.keys(entry)).toEqual(["id", "facts", "claims"]);
        expect(entry.claims).toHaveLength(entry.facts);
        for (const claim of entry.claims) {
          expect(Object.keys(claim)).toEqual(fields);
          expect(sentence).toContain(claim.originalText);
        }
      });
    }
  });

  it("例示に、割る文（各部分をつなぐと元の文に戻る）と、述語が2つでも割らない文（文全体）がある", () => {
    const entries = examples().flatMap(({ sentences, output }) =>
      output.sentences.map((entry: any, i: number) => ({ sentence: sentences[i].text, entry }))
    );

    const split = entries.filter(({ entry }) => entry.facts >= 2);
    expect(split.length).toBeGreaterThanOrEqual(2);
    for (const { sentence, entry } of split) {
      // Cut at the comma after each joining word, the comma belonging to neither.
      expect(entry.claims.map((claim: any) => claim.originalText).join("、")).toBe(sentence);
    }

    const byText = (text: string) => entries.find(({ sentence }) => sentence.startsWith(text))!;
    // Two predicates joined in parallel, but the second does not name what it is about.
    const kept = byText("東京スカイツリーは開業以来");
    expect(kept.entry.facts).toBe(1);
    expect(kept.entry.claims[0].originalText).toBe(kept.sentence);
    // A list under one predicate stays one fact.
    expect(byText("展望台は、").entry.facts).toBe(1);
    // A fact joined to advice counts the fact only.
    const mixed = byText("更新には講習");
    expect(mixed.entry.facts).toBe(1);
    expect(mixed.entry.claims[0].originalText).toBe("更新には講習の受講が必要なので");
  });

  it("例示で、限定語は言い換えにも残り、代名詞と省略は実体で補われ、意見・助言・記事の説明は主張にしていない", () => {
    const claims = examples().flatMap(({ output }) =>
      output.sentences.flatMap((entry: any) => entry.claims ?? [])
    );
    const quoting = (text: string) => claims.find((c: any) => c.originalText.includes(text));
    expect(quoting("18歳以上").normalizedText).toContain("原則として18歳以上");
    expect(quoting("初心者マーク").normalizedText).toMatch(/1年間.*必ず/);
    expect(quoting("この検査は").normalizedText).toMatch(/^運転技能検査は/);
    expect(quoting("展望台は").normalizedText).toMatch(/^東京スカイツリーの展望台/);
    for (const claim of claims) {
      expect(claim.originalText).not.toMatch(/といえるでしょう|とよいだろう|本記事では/);
    }
  });

  it("例示の答えは、コードの読み取りを通しても欠けも注記も出ない", () => {
    for (const { sentences, headings, output } of examples()) {
      const article = splitArticle([...headings, ...sentences.map((s) => s.text)].join("\n"));
      expect(article.sentences.map((s) => s.text)).toEqual(sentences.map((s) => s.text));
      const { trace } = readExtractedClaims(output, article);
      expect(trace.missing).toEqual([]);
      expect(trace.notes).toEqual([]);
    }
  });
});

describe("依頼文（番号付きの文と、文脈としての見出し）", () => {
  const text = "記事の題名\n\n■ 見出し\n一文目。二文目。\n三文目。";

  it("全文の文を番号付きで並べ、見出しは (heading) として読む順に置く", () => {
    const request = buildClaimExtractionUserPrompt(splitArticle(text));
    expect(request).toBe(
      ["Sentences:", "(heading) 記事の題名", "", "(heading) ■ 見出し", "", "s1: 一文目。", "s2: 二文目。", "", "s3: 三文目。"].join("\n")
    );
  });

  it("同じ入力なら、同じ依頼文になる", () => {
    expect(buildClaimExtractionUserPrompt(splitArticle(text))).toBe(
      buildClaimExtractionUserPrompt(splitArticle(text))
    );
  });
});

describe("答えの読み取り: 全文の文が「主張あり」か「対象外（理由つき）」で返る", () => {
  const article = articleOf([
    "会費は月額1万円で、入会金は無料です。",
    "駅から徒歩5分の場所にあります。",
    "ぜひ一度訪れてみてください。",
  ]);

  it("どの文も主張ありか対象外で返れば欠けは無く、主張は読む順に claim-1, claim-2, … と番号が付く", () => {
    const { claims, trace } = readExtractedClaims(
      {
        sentences: [
          {
            id: "s1",
            facts: 2,
            claims: [
              { originalText: "会費は月額1万円で", normalizedText: "会費は月額1万円である。" },
              { originalText: "入会金は無料です。", normalizedText: "入会金は無料である。" },
            ],
          },
          { id: "s2", facts: 1, claims: [{ originalText: "駅から徒歩5分の場所にあります。" }] },
          { id: "s3", facts: 0, excluded: "advice", reason: "読者への勧め" },
        ],
      },
      article
    );

    expect(claims.map((c) => [c.id, c.originalText])).toEqual([
      ["claim-1", "会費は月額1万円で"],
      ["claim-2", "入会金は無料です。"],
      ["claim-3", "駅から徒歩5分の場所にあります。"],
    ]);
    expect(trace.sentences.map((s) => [s.id, s.outcome, s.claimIds])).toEqual([
      ["s1", "claims", ["claim-1", "claim-2"]],
      ["s2", "claims", ["claim-3"]],
      ["s3", "excluded", []],
    ]);
    expect(trace.sentences[2]).toMatchObject({ excluded: "advice", reason: "読者への勧め" });
    expect(trace.missing).toEqual([]);
    expect(trace.notes).toEqual([]);
  });

  it("答えに無い文と、主張も対象外の理由も無い文は、欠けとして記録に出す（黙って落とさない）", () => {
    const { claims, trace } = readExtractedClaims(
      { sentences: [{ id: "s1", facts: 0 }, { id: "s3", facts: 0, excluded: "advice", reason: "勧め" }] },
      article
    );

    expect(claims).toEqual([]);
    expect(trace.missing).toEqual(["s1", "s2"]);
    expect(trace.sentences.map((s) => s.outcome)).toEqual(["missing", "missing", "excluded"]);
    expect(trace.sentences[1].text).toBe("駅から徒歩5分の場所にあります。");
    expect(trace.notes.join("\n")).toContain("s1: 主張も対象外の理由も無かった");
  });

  it("決まった形でない答え（配列でも sentences でもない）は、全文を欠けとして記録する", () => {
    const { claims, trace } = readExtractedClaims({ claims: [{ originalText: "会費は月額1万円で" }] }, article);
    expect(claims).toEqual([]);
    expect(trace.missing).toEqual(["s1", "s2", "s3"]);
  });

  it("渡していない番号・二重の答え・事実の数の食い違い・決まっていない種類は注記に残し、主張は落とさない", () => {
    const { claims, trace } = readExtractedClaims(
      {
        sentences: [
          { id: "s9", facts: 1, claims: [{ originalText: "無い文" }] },
          { id: "s1", facts: 1, claims: [{ originalText: "会費は月額1万円で" }, { originalText: "入会金は無料です。" }] },
          { id: "s1", facts: 0, excluded: "opinion", reason: "二重" },
          { id: "s2", facts: 1, claims: [{ originalText: "駅から徒歩5分の場所にあります。" }] },
          { id: "s3", facts: 0, excluded: "chatter", reason: "決まっていない種類" },
        ],
      },
      article
    );

    expect(claims.map((c) => c.originalText)).toEqual([
      "会費は月額1万円で",
      "入会金は無料です。",
      "駅から徒歩5分の場所にあります。",
    ]);
    const notes = trace.notes.join("\n");
    expect(notes).toContain("渡していない文の番号（s9）");
    expect(notes).toContain("s1: 答えが2つあった");
    expect(notes).toContain("s1: 事実の数（1）と主張の数（2）が合わない");
    expect(notes).toContain("s3: 対象外の種類「chatter」");
    expect(trace.missing).toEqual([]);
  });

  it("originalText が文の中にそのままの形で無ければ、文全体に置き換えて注記に残す", () => {
    const { claims, trace } = readExtractedClaims(
      {
        sentences: [
          {
            id: "s1",
            facts: 2,
            claims: [
              { originalText: "会費は月1万円", normalizedText: "会費は月額1万円である。" },
              { normalizedText: "入会金は無料である。" },
            ],
          },
          { id: "s2", facts: 1, claims: [{ originalText: "駅から徒歩5分" }] },
          { id: "s3", facts: 0, excluded: "advice", reason: "勧め" },
        ],
      },
      article
    );

    expect(claims.map((c) => c.originalText)).toEqual([
      "会費は月額1万円で、入会金は無料です。",
      "会費は月額1万円で、入会金は無料です。",
      "駅から徒歩5分",
    ]);
    // The paraphrase stays the claim's own.
    expect(claims[0].normalizedText).toBe("会費は月額1万円である。");
    expect(trace.notes.filter((note) => note.includes("文全体に置き換えた"))).toHaveLength(2);
  });

  it("番号の表記ゆれ（S1・01・数字）は同じ文として読む", () => {
    const { trace } = readExtractedClaims(
      [
        { id: "S1", facts: 1, claims: [{ originalText: "会費は月額1万円で" }] },
        { id: "02", facts: 1, claims: [{ originalText: "駅から徒歩5分の場所にあります。" }] },
        { id: 3, facts: 0, excluded: "advice", reason: "勧め" },
      ],
      article
    );
    expect(trace.missing).toEqual([]);
    expect(trace.notes).toEqual([]);
  });

  it("欠けた項目は既定値で補う", () => {
    const { claims } = readExtractedClaims(
      { sentences: [{ id: "s1", facts: 1, claims: [{ originalText: "会費は月額1万円で", importance: "odd" }] }] },
      article
    );
    expect(claims[0]).toMatchObject({
      id: "claim-1",
      originalText: "会費は月額1万円で",
      normalizedText: "会費は月額1万円で",
      numbers: [],
      dates: [],
      entities: [],
      importance: "normal",
      factCheckRequired: true,
    });
  });
});

describe("取り出しの流れ（コードが区切り、生成は1回だけ）", () => {
  it("文が1つも無ければ（見出しだけなら）生成を呼ばない", async () => {
    const ask = vi.fn();
    const { claims, trace } = await extractClaimsFrom("■ 見出しだけ\n■ もう一つ", ask);
    expect(ask).not.toHaveBeenCalled();
    expect(claims).toEqual([]);
    expect(trace.headings).toEqual(["■ 見出しだけ", "■ もう一つ"]);
  });

  it("欠けた文はログにも警告として出す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});
    const { trace } = await extractClaimsFrom("一文目。二文目。", async () => ({
      sentences: [{ id: "s1", facts: 1, claims: [{ originalText: "一文目。" }] }],
    }));
    expect(trace.missing).toEqual(["s2"]);
    expect(warn.mock.calls.map((call) => String(call[0])).join("\n")).toContain("s2「二文目。」");
    vi.restoreAllMocks();
  });
});

describe("#45 を繰り返さない: 1つの文から取った主張は、どれも印に乗るか場所不明として残る", () => {
  it("割った主張も、文全体に置き換えた主張も、文を共有する主張も、本文の印から落ちない", () => {
    const text = "会費は月額1万円で、入会金は無料です。駅から徒歩5分の場所にあります。";
    const { claims } = readExtractedClaims(
      {
        sentences: [
          {
            id: "s1",
            facts: 3,
            claims: [
              { originalText: "会費は月額1万円で" },
              { originalText: "入会金は無料です。" },
              { originalText: "本文に無い言い回し" },
            ],
          },
          { id: "s2", facts: 1, claims: [{ originalText: "駅から徒歩5分の場所にあります。" }] },
        ],
      },
      splitArticle(text)
    );
    const results: ClaimResult[] = claims.map((claim) => ({
      claim,
      verdict: "INSUFFICIENT",
      evidence: [],
      confidence: 0.3,
    }));
    const analysis: AnalysisResult = {
      originalText: text,
      revisedText: text,
      summary: { claimsChecked: 4, supported: 0, contradicted: 0, mixed: 0, insufficient: 4, styleIssuesFixed: 0 },
      claims: results,
      styleIssues: [],
      sources: [],
      timings: [],
    };

    const view = buildRevisedDocument({ analysis, adoption: {} });

    const marked = new Set(view.paragraphs.flatMap((p) => p.segments).flatMap((s) => s.mark?.findingIds ?? []));
    const shouldShow = view.findings.filter((f) => f.markKind !== null);
    expect(shouldShow).toHaveLength(4);
    for (const finding of shouldShow) expect(marked.has(finding.id) || isUnplaced(finding)).toBe(true);
    // The three claims of the first sentence all sit on it.
    expect(view.findings.slice(0, 3).map((f) => f.lineIndex)).toEqual([0, 0, 0]);
  });
});

describe("提供元ごとに同じ指示文と同じ依頼文を送り、記録を残す", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const text = "■ 見出し\n本文の一文目。本文の二文目。";
  const answer = JSON.stringify({
    sentences: [
      { id: "s1", facts: 1, claims: [{ originalText: "本文の一文目。", normalizedText: "本文の一文目。" }] },
      { id: "s2", facts: 0, excluded: "opinion", reason: "評価" },
    ],
  });

  it("Anthropic は system に指示文、user に番号付きの文を1回だけ送り、記録を lastExtraction に残す", async () => {
    const { AnthropicLLMProvider } = await import("@/lib/providers/llm/anthropic");
    const sent: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: answer }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const claims = await provider.extractClaims(text);

    expect(sent).toHaveLength(1);
    expect(sent[0].system).toBe(CLAIM_EXTRACTION_SYSTEM_PROMPT);
    expect(sent[0].messages).toEqual([
      { role: "user", content: buildClaimExtractionUserPrompt(splitArticle(text)) },
    ]);
    expect(sent[0]).not.toHaveProperty("temperature");
    expect(claims.map((c) => c.id)).toEqual(["claim-1"]);
    expect(provider.lastExtraction?.sentences.map((s) => s.outcome)).toEqual(["claims", "excluded"]);
    expect(provider.lastExtraction?.headings).toEqual(["■ 見出し"]);
  });

  it("OpenAI も system に同じ指示文、user に同じ依頼文を送る", async () => {
    const { OpenAILLMProvider } = await import("@/lib/providers/llm/openai");
    const sent: any[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({ choices: [{ finish_reason: "stop", message: { content: answer } }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const provider = new OpenAILLMProvider({ apiKey: "test-key" });
    const claims = await provider.extractClaims(text);

    expect(sent).toHaveLength(1);
    expect(sent[0].messages[0]).toEqual({ role: "system", content: CLAIM_EXTRACTION_SYSTEM_PROMPT });
    expect(sent[0].messages[1]).toEqual({
      role: "user",
      content: buildClaimExtractionUserPrompt(splitArticle(text)),
    });
    expect(claims.map((c) => c.id)).toEqual(["claim-1"]);
    expect(provider.lastExtraction?.missing).toEqual([]);
  });
});

describe("取り出しの記録は、実行の結果（AnalysisResult.extraction）に載る", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  it("欠けた文も含めて、どの文がどうなったかが結果に残る", async () => {
    const { AnthropicLLMProvider } = await import("@/lib/providers/llm/anthropic");
    const { runOrchestrator } = await import("@/lib/pipeline/orchestrator");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "info").mockImplementation(() => {});

    // The extraction answers for the first sentence only; every other
    // generation (the search questions) gets an empty answer.
    const extraction = JSON.stringify({
      sentences: [{ id: "s1", facts: 1, claims: [{ originalText: "会費は月額1万円です。" }] }],
    });
    globalThis.fetch = vi.fn(async (_url: string, init: any) => {
      const body = JSON.parse(init.body);
      const text = body.system === CLAIM_EXTRACTION_SYSTEM_PROMPT ? extraction : '{"queries":[],"claims":[]}';
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text }] }),
        text: async () => "",
      };
    }) as unknown as typeof fetch;

    const result = await runOrchestrator("■ 料金\n会費は月額1万円です。入会金は無料です。", {
      llm: new AnthropicLLMProvider({ apiKey: "test-key" }),
      factCheck: { searchClaims: async () => ({ claims: [] }), search: async () => [] } as any,
      search: { search: async () => ({ results: [] }) } as any,
      fetch: { fetchUrl: async (url: string) => ({ url, title: "", content: "" }) } as any,
      jev: {
        evaluateAtomicJudgment: async () => {
          throw new Error("not used");
        },
        ask: async (_state: unknown, questions: Record<string, unknown>) =>
          Object.fromEntries(Object.keys(questions).map((name) => [name, { type: "noul", noul: 0.5 }])),
      } as any,
    });

    expect(result.claims.map((c) => c.claim.originalText)).toEqual(["会費は月額1万円です。"]);
    expect(result.extraction?.headings).toEqual(["■ 料金"]);
    expect(result.extraction?.sentences.map((s) => [s.id, s.outcome])).toEqual([
      ["s1", "claims"],
      ["s2", "missing"],
    ]);
    expect(result.extraction?.missing).toEqual(["s2"]);
  });
});

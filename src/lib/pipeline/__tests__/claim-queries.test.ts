import { describe, it, expect, afterEach, vi } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { createSourcePool } from "@/lib/pipeline/source-pool";
import { AnthropicLLMProvider } from "@/lib/providers/llm/anthropic";
import { OpenAILLMProvider } from "@/lib/providers/llm/openai";
import {
  CLAIM_QUERY_SYSTEM_PROMPT,
  DOCUMENT_QUERY_SYSTEM_PROMPT,
  QUERIES_PER_CLAIM,
  buildClaimQueryUserPrompt,
  checkClaimQueries,
  checkDocumentQueries,
  readClaimQueries,
  readDocumentQueries,
} from "@/lib/providers/llm/search-queries";
import type { Claim } from "@/types";

/**
 * ADR-0015 → ADR-0019 (north star ②): every claim gets the questions that
 * would settle it as its own searches — primary source first — written for
 * all claims in one generation. A search names only what a fact is about and
 * what kind of fact is to be found out: never the claim's sentence, and
 * never what the claim says (its values, the elements it lists, its
 * qualifiers, its conclusion). A query that breaks this is not searched as
 * written, and it is kept on the record as written.
 */

function claim(id: string, over: Partial<Claim> = {}): Claim {
  return {
    id,
    originalText: `${id}の原文。`,
    normalizedText: `${id}の言い換え。`,
    subject: "フリノバ",
    entities: ["フリノバ"],
    numbers: [],
    dates: [],
    importance: "normal",
    factCheckRequired: true,
    ...over,
  };
}

function section(prompt: string, heading: string): string {
  const start = prompt.indexOf(heading);
  const next = prompt.indexOf("\n## ", start + heading.length);
  return prompt.slice(start, next === -1 ? undefined : next);
}

function inOrder(text: string, patterns: RegExp[]): boolean {
  const at = patterns.map((pattern) => text.search(pattern));
  return at.every((position) => position >= 0) && [...at].sort((a, b) => a - b).join() === at.join();
}

/** The worked examples of the claims' instruction: the claims given, and the parsed output. */
function claimExamples(): Array<{ claims: Claim[]; output: any }> {
  return [
    ...CLAIM_QUERY_SYSTEM_PROMPT.matchAll(/## Example \d+\nInput:\n([\s\S]+?)\nOutput:\n([\s\S]+?\n\] \})/g),
  ].map((match) => ({
    claims: match[1].split("\n\n").map((block) => {
      const field = (name: string) => block.match(new RegExp(`^${name}: (.*)$`, "m"))?.[1] ?? "";
      const figures = block.match(/^Figures in the claim \(content: never in a query\): (.*)$/m)?.[1] ?? "N/A";
      return claim(field("id"), {
        originalText: field("Claim"),
        normalizedText: field("Claim"),
        subject: field("Subject"),
        entities: [],
        numbers: figures === "N/A" ? [] : figures.split(", "),
      });
    }),
    output: JSON.parse(match[2]),
  }));
}

/** The worked examples of the article's instruction: the article, and the parsed output. */
function documentExamples(): Array<{ article: string; output: any }> {
  return [
    ...DOCUMENT_QUERY_SYSTEM_PROMPT.matchAll(/## Example \d+\nArticle: (.+)\nOutput:\n([\s\S]+?\n\] \})/g),
  ].map((match) => ({ article: match[1], output: JSON.parse(match[2]) }));
}

/** The subjects of the ten articles the tool is measured on: no example may borrow them. */
const ARTICLE_TOPICS =
  /口コミ|AISAS|SIPS|ステマ|景品表示|健康食品|機能性表示|個人情報|Cookie|SEO|Google|ふるさと納税|睡眠|労働基準|有給|インボイス|消費税|マズロー|ピグマリオン|著作権|生成AI/;
const KINDS = ["definition", "composition", "time", "quantity", "scope", "degree", "cause", "origin"];
/** A primary source, named by its kind or by name. */
const SOURCE = /提唱者|原典|所管官庁|法|省|庁|院|統計|公式サイト/;
/** A word that looks for the limits, the exceptions or the opposing view. */
const LIMIT = /例外|対象外|条件|異説|批判/;

describe("主張ごとの問いの指示文（ADR-0019）", () => {
  const prompt = CLAIM_QUERY_SYSTEM_PROMPT;

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

  it("手順は、対象→事実の種類→中身の書き出し→一次資料の問い→限定・例外・反対の問い→点検の順", () => {
    const procedure = section(prompt, "## Procedure");
    expect(
      inOrder(procedure, [
        /1\. About: identify what the claim is about/,
        /2\. Kind: identify the kind of fact/,
        /3\. Content: write down what the claim says/,
        /4\. Query 1 reaches the primary source/,
        /5\. Query 2 looks for the limits, the exceptions and the opposing view/,
        /6\. Check every query against step 3/,
      ])
    ).toBe(true);
    for (const kind of KINDS) expect(procedure).toContain(kind);
    for (const word of ["定義", "構成", "時期", "範囲", "程度", "原因", "提唱者"]) expect(procedure).toContain(word);
  });

  it("禁止事項に、主張の中身（値・並べた要素・限定語・結論）・主張の文・推測の機関名・1本に2つの事柄がある", () => {
    const prohibitions = section(prompt, "## Prohibitions");
    expect(prohibitions).toMatch(
      /Never put the claim's content into a query: not its values, not the elements it lists, not its qualifiers, not its\s+conclusion/
    );
    expect(prohibitions).toMatch(/Never use the claim's sentence/);
    expect(prohibitions).toMatch(/Never invent an organisation's name or a domain/);
    expect(prohibitions).toMatch(/Never put two matters into one query/);
  });

  it("全主張を1つの依頼に並べ、ID・主語・数値を添える。主語以外の固有名詞は渡さない", () => {
    const user = buildClaimQueryUserPrompt([
      claim("claim-1", { numbers: ["142人"], dates: ["2025年9月"], entities: ["フリノバ", "電通"] }),
      claim("claim-2"),
    ]);
    expect(user).toContain("id: claim-1");
    expect(user).toContain("id: claim-2");
    expect(user).toContain("Subject: フリノバ");
    expect(user).toMatch(/never in a query\): 142人, 2025年9月/);
    expect(user).not.toContain("電通");
  });

  it("主語の名前に含まれる数値（民法709条）は、中身の数値として並べない", () => {
    const user = buildClaimQueryUserPrompt([claim("claim-1", { subject: "民法709条", numbers: ["709条", "3年"] })]);
    expect(user).toMatch(/never in a query\): 3年$/m);
  });
});

describe("記事全体の検索語の指示文（ADR-0019）", () => {
  const prompt = DOCUMENT_QUERY_SYSTEM_PROMPT;

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

  it("手順は、対象→事実の種類→中身の書き出し→検索語（1本目は一次資料）→点検の順", () => {
    const procedure = section(prompt, "## Procedure");
    expect(
      inOrder(procedure, [
        /1\. About: list what the article states facts about/,
        /2\. Kind: for each, identify the kinds of fact/,
        /3\. Content: for each, write down what the article says/,
        /4\. Write 4 to 6 queries, one subject and one kind each\. Query 1 is for the most central subject and reaches its primary source/,
        /5\. Check every query against step 3/,
      ])
    ).toBe(true);
  });

  it("禁止事項は主張ごとと同じ（記事の中身・記事の文・推測の機関名・1本に2つの事柄）", () => {
    const prohibitions = section(prompt, "## Prohibitions");
    expect(prohibitions).toMatch(
      /Never put the article's content into a query: not its values, not the elements it lists, not its qualifiers, not its\s+conclusions/
    );
    expect(prohibitions).toMatch(/Never use a sentence of the article/);
    expect(prohibitions).toMatch(/Never invent an organisation's name or a domain/);
    expect(prohibitions).toMatch(/Never put two matters into one query/);
    // The old instruction was written for a facility's article only.
    expect(prompt).not.toMatch(/membership numbers|directory entries/);
  });
});

describe("例示（検証用の記事10本とは別の題材）", () => {
  it("どちらの指示文にも例示が2つ以上あり、記事10本の題材を使っていない", () => {
    const claims = claimExamples();
    const documents = documentExamples();
    expect(claims.length).toBeGreaterThanOrEqual(2);
    expect(documents.length).toBeGreaterThanOrEqual(2);
    for (const { claims: given, output } of claims) {
      expect(given.map((c) => c.normalizedText).join()).not.toMatch(ARTICLE_TOPICS);
      expect(JSON.stringify(output)).not.toMatch(ARTICLE_TOPICS);
    }
    for (const { article, output } of documents) {
      expect(article).not.toMatch(ARTICLE_TOPICS);
      expect(JSON.stringify(output)).not.toMatch(ARTICLE_TOPICS);
    }
  });

  it("主張ごとの例示: 出力は固定の形式で、どの問いにも中身が無く、コードの点検を素通りする", () => {
    for (const { claims: given, output } of claimExamples()) {
      expect(output.claims.map((entry: any) => entry.id)).toEqual(given.map((c) => c.id));
      for (const entry of output.claims) {
        expect(Object.keys(entry)).toEqual(["id", "about", "kind", "content", "queries"]);
        expect(KINDS).toContain(entry.kind);
        expect(entry.content.length).toBeGreaterThan(0);
        expect(entry.queries.length).toBeGreaterThanOrEqual(1);
        expect(entry.queries.length).toBeLessThanOrEqual(QUERIES_PER_CLAIM);
        for (const query of entry.queries) {
          expect(query.split(" ").length).toBeLessThanOrEqual(8);
          for (const word of entry.about.split(" ")) expect(query).toContain(word);
        }
        const checked = checkClaimQueries(given.find((c) => c.id === entry.id)!, entry);
        expect(checked.violations).toEqual([]);
        expect(checked.queries).toEqual(entry.queries);
      }
    }
  });

  it("主張ごとの例示: 1本目は一次の出所を名指し、2本目は限定・例外・反対の立場を探す", () => {
    for (const { output } of claimExamples()) {
      for (const entry of output.claims) {
        expect(entry.queries[0]).toMatch(SOURCE);
        if (entry.queries[1]) expect(entry.queries[1]).toMatch(LIMIT);
      }
    }
  });

  it("構成要素の並びを述べる主張の例示があり、要素の語はどの問いにも無い", () => {
    const composition = claimExamples()
      .flatMap(({ output }) => output.claims)
      .find((entry: any) => entry.kind === "composition");
    expect(composition.content.length).toBeGreaterThanOrEqual(3);
    for (const query of composition.queries) {
      for (const element of composition.content) expect(query).not.toContain(element);
    }
  });

  it("記事全体の例示: 出力は固定の形式で、どの検索語にも中身が無く、1本目は一次の出所を名指す", () => {
    for (const { output } of documentExamples()) {
      expect(output.queries.length).toBeGreaterThanOrEqual(4);
      expect(output.queries.length).toBeLessThanOrEqual(6);
      expect(output.queries[0].query).toMatch(SOURCE);
      for (const entry of output.queries) {
        expect(Object.keys(entry)).toEqual(["about", "kind", "content", "query"]);
        expect(KINDS).toContain(entry.kind);
        expect(entry.query.split(" ").length).toBeLessThanOrEqual(8);
        for (const word of entry.about.split(" ")) expect(entry.query).toContain(word);
      }
      const checked = checkDocumentQueries(output.queries, 6);
      expect(checked.violations).toEqual([]);
      expect(checked.queries).toEqual(output.queries.map((entry: any) => entry.query));
    }
  });
});

describe("問いの点検（コードでも守る決まった規則、ADR-0019）", () => {
  it("検査中の数値・日付を取り除いて検索し、元の形を記録に残す（#31）", () => {
    const c = claim("claim-1", { subject: "フリノバ", numbers: ["142人"], dates: ["2004年"] });
    const checked = checkClaimQueries(c, ["フリノバ 会員数 142人", "AISAS 電通 2004年 提唱"]);
    expect(checked.queries).toEqual(["フリノバ 会員数", "AISAS 電通 提唱"]);
    expect(checked.violations).toEqual([
      { query: "フリノバ 会員数 142人", broke: ["figure"], removed: ["142人"], searched: "フリノバ 会員数" },
      { query: "AISAS 電通 2004年 提唱", broke: ["figure"], removed: ["2004年"], searched: "AISAS 電通 提唱" },
    ]);
  });

  it("生成が挙げた中身（構成要素の語）を取り除き、対象しか残らない問いは検索しない。書かれたままの形は記録に残す", () => {
    // The query found in production: the model's stage names, as the claim wrote them.
    const sips = claim("claim-1", {
      subject: "SIPS",
      normalizedText:
        "SIPSは、Sympathize（共感する）、Interest（興味を持つ）、Participate（参加する）、Share & Spread（共有・拡散する）の頭文字をとっている。",
    });
    const checked = checkClaimQueries(sips, {
      about: "SIPS",
      kind: "composition",
      content: ["Sympathize（共感する）", "Interest", "Participate", "Share & Spread"],
      queries: ["SIPS Sympathize Interest Participate Share Spread", "SIPS 消費行動モデル 頭文字 意味 提唱者"],
    });
    expect(checked.queries).toEqual(["SIPS 消費行動モデル 頭文字 意味 提唱者"]);
    expect(checked.violations).toHaveLength(1);
    expect(checked.violations[0].query).toBe("SIPS Sympathize Interest Participate Share Spread");
    expect(checked.violations[0].broke).toEqual(["content"]);
    expect([...checked.violations[0].removed].sort()).toEqual(
      ["Interest", "Participate", "Share", "Spread", "Sympathize"].sort()
    );
    expect(checked.violations[0]).not.toHaveProperty("searched");
  });

  it("中身を取り除いても問うことが残れば、残りを検索する（限定語・結論）", () => {
    const smoking = claim("claim-1", {
      subject: "改正健康増進法",
      normalizedText: "改正健康増進法により、飲食店は原則屋内禁煙となった。",
    });
    const checked = checkClaimQueries(smoking, {
      about: "改正健康増進法 飲食店",
      kind: "scope",
      content: ["原則", "屋内禁煙"],
      queries: ["改正健康増進法 飲食店 規制 厚生労働省", "改正健康増進法 飲食店 原則屋内禁煙 例外"],
    });
    expect(checked.queries).toEqual(["改正健康増進法 飲食店 規制 厚生労働省", "改正健康増進法 飲食店 例外"]);
    expect(checked.violations).toEqual([
      {
        query: "改正健康増進法 飲食店 原則屋内禁煙 例外",
        broke: ["content"],
        removed: ["屋内禁煙", "原則"],
        searched: "改正健康増進法 飲食店 例外",
      },
    ]);
  });

  it("対象（主語・about）に含まれる語は中身として取り除かない（「何について」は入れてよい）", () => {
    const law = claim("claim-1", { subject: "民法709条", numbers: ["709条"] });
    const checked = checkClaimQueries(law, {
      about: "民法709条",
      kind: "scope",
      content: ["民法709条", "損害賠償"],
      queries: ["民法709条 要件 法務省"],
    });
    expect(checked.queries).toEqual(["民法709条 要件 法務省"]);
    expect(checked.violations).toEqual([]);
  });

  it("英字の語は語の単位で比べる（Do は Document を削らない）。大文字小文字と全角半角は区別しない", () => {
    const c = claim("claim-1", { subject: "PDCAサイクル" });
    const kept = checkClaimQueries(c, { content: ["Do"], queries: ["PDCAサイクル Document 原典"] });
    expect(kept.queries).toEqual(["PDCAサイクル Document 原典"]);
    expect(kept.violations).toEqual([]);

    const taken = checkClaimQueries(c, { content: ["Do"], queries: ["PDCAサイクル ＤＯ 意味"] });
    expect(taken.queries).toEqual(["PDCAサイクル 意味"]);
    expect(taken.violations[0]).toMatchObject({ broke: ["content"], removed: ["Do"] });
  });

  it("主張の文そのものは検索しない。黙って捨てず記録に残す", () => {
    const c = claim("claim-1", {
      originalText: "フリノバの会員は増えた。",
      normalizedText: "フリノバの会員数は増加した。",
    });
    const checked = checkClaimQueries(c, ["フリノバの会員は増えた", "フリノバの会員数は増加した。", "フリノバ 会員数 公式サイト"]);
    expect(checked.queries).toEqual(["フリノバ 会員数 公式サイト"]);
    expect(checked.violations).toEqual([
      { query: "フリノバの会員は増えた", broke: ["sentence"], removed: [] },
      { query: "フリノバの会員数は増加した。", broke: ["sentence"], removed: [] },
    ]);
  });

  it(`重複を除き、1主張あたり ${QUERIES_PER_CLAIM} 本まで`, () => {
    const c = claim("claim-1");
    expect(checkClaimQueries(c, ["a", "a", "b", "c"]).queries).toEqual(["a", "b"]);
  });

  it("記事全体の検索語も、それぞれに挙げた中身を取り除く。上限の本数まで", () => {
    const checked = checkDocumentQueries(
      [
        { about: "富士山", kind: "quantity", content: ["3776メートル"], query: "富士山 標高 3776メートル 国土地理院" },
        { about: "富士山", kind: "degree", content: ["日本一"], query: "富士山 日本一" },
        "富士山 噴火 時期",
        { about: "富士山 山頂", kind: "scope", content: ["県境"], query: "富士山 山頂 所在地" },
      ],
      2
    );
    expect(checked.queries).toEqual(["富士山 標高 国土地理院", "富士山 噴火 時期"]);
    expect(checked.violations).toEqual([
      {
        query: "富士山 標高 3776メートル 国土地理院",
        broke: ["content"],
        removed: ["3776メートル"],
        searched: "富士山 標高 国土地理院",
      },
      { query: "富士山 日本一", broke: ["content"], removed: ["日本一"] },
    ]);
  });
});

describe("答えの読み取り（書かれたままの形で読む）", () => {
  it("主張IDごとに about・kind・content・queries を読む。応答に無い主張は問い0本", () => {
    const claims = [claim("claim-1"), claim("claim-2")];
    const read = readClaimQueries(
      {
        claims: [
          { id: "claim-1", about: "フリノバ", kind: "quantity", content: ["142人"], queries: ["q1", "q2"] },
        ],
      },
      claims
    );
    expect(read.get("claim-1")).toEqual({
      about: "フリノバ",
      kind: "quantity",
      content: ["142人"],
      queries: ["q1", "q2"],
    });
    expect(read.get("claim-2")).toEqual({ content: [], queries: [] });
  });

  it("記事全体の検索語は、項目の形でも文字列だけでも読む", () => {
    expect(
      readDocumentQueries({
        queries: [{ about: "富士山", kind: "quantity", content: ["3776メートル"], query: "富士山 標高" }, "富士山 噴火", ""],
      })
    ).toEqual([
      { about: "富士山", kind: "quantity", content: ["3776メートル"], query: "富士山 標高" },
      { content: [], query: "富士山 噴火" },
    ]);
    expect(readDocumentQueries({})).toEqual([]);
  });
});

describe("生成の呼び出し（主張の問いは全主張で1回。提供元ごとに同じ指示文）", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  function answeringWith(text: string, sent: any[]) {
    return (async (_url: string, init: any) => {
      sent.push(JSON.parse(init.body));
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => "",
        json: async () => ({
          stop_reason: "end_turn",
          content: [{ type: "text", text }],
          choices: [{ finish_reason: "stop", message: { content: text } }],
        }),
      };
    }) as any;
  }

  it("Anthropic に1回だけ送り、主張ごとに書かれたままの形を返す", async () => {
    const sent: any[] = [];
    globalThis.fetch = answeringWith(
      JSON.stringify({
        claims: [
          {
            id: "claim-1",
            about: "フリノバ",
            kind: "quantity",
            content: ["142人"],
            queries: ["フリノバ 会員数 公式サイト", "フリノバ 会員 条件"],
          },
          { id: "claim-2", queries: ["フリノバ 所在地 公式サイト"] },
        ],
      }),
      sent
    );

    const provider = new AnthropicLLMProvider({ apiKey: "test-key" });
    const result = await provider.generateClaimQueries([claim("claim-1"), claim("claim-2")]);

    expect(sent).toHaveLength(1);
    expect(sent[0].system).toBe(CLAIM_QUERY_SYSTEM_PROMPT);
    expect(sent[0]).not.toHaveProperty("temperature");
    expect(result.get("claim-1")).toEqual({
      about: "フリノバ",
      kind: "quantity",
      content: ["142人"],
      queries: ["フリノバ 会員数 公式サイト", "フリノバ 会員 条件"],
    });
    expect(result.get("claim-2")).toEqual({ content: [], queries: ["フリノバ 所在地 公式サイト"] });
  });

  it("記事全体の検索語は、Anthropic にも OpenAI にも同じ指示文を送り、同じ形で読む", async () => {
    const answer = JSON.stringify({
      queries: [{ about: "フリノバ", kind: "origin", content: [], query: "フリノバ 運営者 公式サイト" }],
    });
    const expected = [{ about: "フリノバ", kind: "origin", content: [], query: "フリノバ 運営者 公式サイト" }];

    const toAnthropic: any[] = [];
    globalThis.fetch = answeringWith(answer, toAnthropic);
    expect(await new AnthropicLLMProvider({ apiKey: "test-key" }).generateDocumentQueries("本文")).toEqual(expected);
    expect(toAnthropic[0].system).toBe(DOCUMENT_QUERY_SYSTEM_PROMPT);

    const toOpenAI: any[] = [];
    globalThis.fetch = answeringWith(answer, toOpenAI);
    expect(await new OpenAILLMProvider({ apiKey: "test-key" }).generateDocumentQueries("本文")).toEqual(expected);
    expect(toOpenAI[0].messages[0]).toEqual({ role: "system", content: DOCUMENT_QUERY_SYSTEM_PROMPT });
  });
});

type Page = { url: string; title: string; body: string };

function pipelineFakes(opts: {
  claims: Claim[];
  claimQueries?: (claims: Claim[]) => Promise<Map<string, unknown>>;
  documentQueries?: () => Promise<unknown[]>;
  /** The pages each search finds. Without it, every search finds one page of its own. */
  pages?: (query: string) => Page[];
}) {
  const searched: string[] = [];
  const claimQueryCalls: Claim[][] = [];
  /** Every request JEV was sent, in the order sent. */
  const asked: { state: any; questions: Record<string, unknown> }[] = [];
  const found = new Map<string, Page>();
  const llm = {
    async extractClaims() {
      return opts.claims;
    },
    async generateDocumentQueries() {
      if (opts.documentQueries) return opts.documentQueries();
      return ["フリノバ"];
    },
    async generateClaimQueries(claims: Claim[]) {
      claimQueryCalls.push(claims);
      if (opts.claimQueries) return opts.claimQueries(claims);
      return new Map(claims.map((c) => [c.id, [`${c.id} 一次資料`, `${c.id} 条件`]]));
    },
  };
  const search = {
    async search(query: string) {
      searched.push(query);
      if (opts.pages) {
        const pages = opts.pages(query);
        for (const page of pages) found.set(page.url, page);
        return { results: pages.map((page) => ({ url: page.url, title: page.title })) };
      }
      // Every search finds a page that names the subject, so the article's
      // pages alone would already give every claim candidates.
      return { results: [{ url: `https://example.com/${encodeURIComponent(query)}`, title: "フリノバ" }] };
    },
  } as any;
  const fetchProvider = {
    async fetchUrl(url: string) {
      const page = found.get(url);
      if (page) return { url, title: page.title, content: page.body };
      return { url, title: "フリノバ", content: "フリノバについての本文。" };
    },
  } as any;
  const factCheck = {
    async searchClaims() {
      return { claims: [] };
    },
  } as any;
  const jev = {
    async evaluateAtomicJudgment() {
      throw new Error("not used");
    },
    async ask(state: any, questions: Record<string, unknown>) {
      asked.push({ state, questions });
      const answers: Record<string, any> = {};
      for (const name of Object.keys(questions)) answers[name] = { type: "noul", noul: 0.9 };
      return answers;
    },
  };
  return { options: { llm, search, fetch: fetchProvider, factCheck, jev }, searched, claimQueryCalls, asked };
}

describe("資料の探し方（パイプライン、ADR-0015・0019）", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("記事の検索語に加え、すべての主張の問いで検索する（候補があっても）", async () => {
    const claims = [claim("claim-1"), claim("claim-2"), claim("claim-3")];
    const { options, searched, claimQueryCalls } = pipelineFakes({ claims });

    const output = await runFactPipeline("本文", options as any);

    expect(claimQueryCalls).toHaveLength(1);
    expect(claimQueryCalls[0].map((c) => c.id)).toEqual(["claim-1", "claim-2", "claim-3"]);
    expect([...searched].sort()).toEqual(
      [
        "フリノバ",
        "claim-1 一次資料",
        "claim-1 条件",
        "claim-2 一次資料",
        "claim-2 条件",
        "claim-3 一次資料",
        "claim-3 条件",
      ].sort()
    );
    // The claim's sentence is never a search.
    for (const c of claims) {
      expect(searched).not.toContain(c.originalText);
      expect(searched).not.toContain(c.normalizedText);
    }
    // The trace names this claim's own questions first, then the article's.
    expect(output.claims[1].evidenceTrace?.query).toBe("claim-2 一次資料 / claim-2 条件 / フリノバ");
    // Nothing broke the rules, so there is nothing on the record.
    expect(output.claims[1].evidenceTrace).not.toHaveProperty("queryViolations");
  });

  it("主張の問いを書けなかったときも止まらず、主張の文で検索し直さない", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const claims = [claim("claim-1")];
    const { options, searched } = pipelineFakes({
      claims,
      claimQueries: async () => {
        throw new Error("生成に失敗");
      },
    });

    const output = await runFactPipeline("本文", options as any);

    expect(searched).toEqual(["フリノバ"]);
    expect(output.claims).toHaveLength(1);
    expect(output.claims[0].confidence).toBe(0.9);
  });

  it("中身を入れた問いは中身を除いてから検索し、書かれたままの形を主張の記録とログに残す", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const sips = claim("claim-1", { subject: "SIPS", entities: ["SIPS"] });
    const { options, searched } = pipelineFakes({
      claims: [sips],
      documentQueries: async () => [
        { about: "SIPS", kind: "composition", content: ["Sympathize", "Interest"], query: "SIPS Sympathize Interest 意味" },
        { about: "SIPS", kind: "origin", content: ["電通"], query: "SIPS 提唱者 原典" },
      ],
      claimQueries: async () =>
        new Map([
          [
            "claim-1",
            {
              about: "SIPS",
              kind: "composition",
              content: ["Sympathize", "Interest", "Participate", "Share & Spread"],
              queries: ["SIPS Sympathize Interest Participate Share Spread", "SIPS 消費行動モデル 頭文字 意味 提唱者"],
            },
          ],
        ]),
    });

    const output = await runFactPipeline("本文", options as any);

    expect([...searched].sort()).toEqual(
      ["SIPS 意味", "SIPS 提唱者 原典", "SIPS 消費行動モデル 頭文字 意味 提唱者"].sort()
    );
    const trace = output.claims[0].evidenceTrace!;
    expect(trace.query).toBe("SIPS 消費行動モデル 頭文字 意味 提唱者 / SIPS 意味 / SIPS 提唱者 原典");
    // The claim's own first, then the article's; each as it was written.
    expect(trace.queryViolations?.map((v) => [v.query, v.searched])).toEqual([
      ["SIPS Sympathize Interest Participate Share Spread", undefined],
      ["SIPS Sympathize Interest 意味", "SIPS 意味"],
    ]);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('the search "SIPS Sympathize Interest Participate Share Spread" broke the rules')
    );
  });

  it("点検で直した主張の問いも、③の候補の順（この主張の検索→記事全体の検索、各検索の順位）の先頭に来る（ADR-0021）", async () => {
    vi.spyOn(console, "info").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    // About 45,000 estimated tokens each: the ceiling that used to stand before
    // JEV (ADR-0016) kept four of these six out; now every one is asked about.
    const long = (n: string) => `${n}。` + "い".repeat(30000);
    const own: Page = { url: "https://z-own.example/p", title: "own", body: long("own") };
    const article: Page[] = [0, 1, 2, 3, 4].map((i) => ({
      url: `https://a-doc${i}.example/p`,
      title: `doc${i}`,
      body: long(`doc${i}`),
    }));
    // Only the query with the figure and the content taken out finds the claim's own page.
    const { options, asked } = pipelineFakes({
      claims: [
        claim("claim-1", {
          originalText: "フリノバの会員は9月に142人に到達した。",
          normalizedText: "フリノバの会員数は2025年9月時点で142人である。",
          numbers: ["142人"],
        }),
      ],
      documentQueries: async () => ["記事の検索語"],
      claimQueries: async (claims) =>
        new Map(
          claims.map((c) => [
            c.id,
            { about: "フリノバ", content: ["到達した"], queries: ["フリノバ 会員数 142人 到達した"] },
          ])
        ),
      pages: (query) => (query === "フリノバ 会員数" ? [own] : article),
    });

    // No rate limit in the way of the test: the order is what is looked at.
    const { claims } = await runFactPipeline("本文", {
      ...options,
      jevLimits: { requestsPerMinute: 1e9, tokensPerSecond: 1e12 },
    } as any);

    const trace = claims[0].evidenceTrace!;
    expect(trace.query).toBe("フリノバ 会員数 / 記事の検索語");
    expect(trace.queryViolations).toEqual([
      {
        query: "フリノバ 会員数 142人 到達した",
        broke: ["figure", "content"],
        removed: ["142人", "到達した"],
        searched: "フリノバ 会員数",
      },
    ]);
    // Asked about in the relevance question in this order: the claim's own
    // page first, then the article's, each by rank. In address order the
    // article's pages would come first.
    const relevance = asked.filter((call) => !("support" in call.questions));
    const read = [...new Set(relevance.map((call) => call.state.section.url))];
    expect(read).toEqual([own.url, ...article.map((page) => page.url)]);
    expect(trace).toMatchObject({ found: 6, overCap: 0 });
    expect(trace.judged).toBe(trace.sections);
  });
});

describe("資料の池（並行して検索しても1ページは1回だけ読む）", () => {
  it("同じページが2つの検索に同時に出ても、取得は1回", async () => {
    let fetches = 0;
    const pool = createSourcePool({
      search: {
        async search() {
          return { results: [{ url: "https://example.com/same", title: "同じ" }] };
        },
      } as any,
      fetchProvider: {
        async fetchUrl(url: string) {
          fetches++;
          await new Promise((resolve) => setTimeout(resolve, 5));
          return { url, title: "同じ", content: "本文" };
        },
      } as any,
      resultsPerQuery: 7,
    });

    await Promise.all([pool.seed(["記事の検索語"]), pool.seed(["主張の問い"])]);

    expect(fetches).toBe(1);
    expect(pool.size()).toBe(1);
    expect(pool.queries()).toEqual(["記事の検索語", "主張の問い"]);
  });
});

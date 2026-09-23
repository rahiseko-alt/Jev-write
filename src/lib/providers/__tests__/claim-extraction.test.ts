import { describe, it, expect, afterEach, vi } from "vitest";
import {
  CLAIM_EXTRACTION_SYSTEM_PROMPT,
  readExtractedClaims,
} from "@/lib/providers/llm/claim-extraction";

/**
 * ADR-0017 (north star ①): one fact per claim, understandable on its own,
 * qualifiers kept, true whenever the text is — asked for in three parts with
 * a fixed output and worked examples, the same words for every provider.
 * originalText is copied, not forced to the whole sentence (#45).
 */

const prompt = CLAIM_EXTRACTION_SYSTEM_PROMPT;

function section(heading: string): string {
  const start = prompt.indexOf(heading);
  const next = prompt.indexOf("\n## ", start + heading.length);
  return prompt.slice(start, next === -1 ? undefined : next);
}

/** The worked examples, as text and parsed output. */
function examples(): Array<{ text: string; output: any }> {
  return [...prompt.matchAll(/## Example \d+\nText: (.+)\nOutput:\n([\s\S]+?\n\] \})/g)].map(
    (match) => ({ text: match[1], output: JSON.parse(match[2]) })
  );
}

describe("主張の取り出しの指示文（ADR-0017）", () => {
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

  it("手順は、事実かの判定→原文の保持→1事実1主張と代名詞の補い→限定語の保持→自己点検の順", () => {
    const procedure = section("## Procedure");
    const steps = [
      /1\. Decide whether the sentence states .*fact/,
      /2\. .*copy the words .*"originalText", character for character/,
      /3\. Write one claim per fact.*Replace pronouns/,
      /4\. Keep every qualifier, condition, time, quantity/,
      /5\. Check yourself: if the sentence in the text is true, is the claim true\?/,
    ].map((step) => procedure.search(step));
    expect(steps.every((at) => at >= 0)).toBe(true);
    expect([...steps].sort((a, b) => a - b)).toEqual(steps);
    expect(procedure).toMatch(/Opinions, impressions, predictions, advice, recommendations and hypotheticals/);
  });

  it("禁止事項に、限定語を落とす・意見を混ぜる・割りすぎる・解釈を決め打ちする・主張を落とす、がある", () => {
    const prohibitions = section("## Prohibitions");
    expect(prohibitions).toMatch(/Never drop or soften a qualifier/);
    expect(prohibitions).toMatch(/Never turn an opinion, prediction, piece of advice or hypothetical/);
    expect(prohibitions).toMatch(/never split one fact into pieces/);
    expect(prohibitions).toMatch(/Never choose one reading of an ambiguous sentence/);
    expect(prohibitions).toMatch(/Never leave out a claim because another claim uses the same sentence/);
  });

  it("originalText を1文まるごとに強制しない（#45 で指摘が11→8件に減った形を踏まない）", () => {
    expect(prompt).not.toMatch(/whole sentence/i);
    expect(prompt).toMatch(/the sentence, or the part of\s+it that states this fact/);
    expect(prompt).toMatch(/may share the same "originalText"/);
  });

  it("例示は2つ以上で、どれも検証用の記事とは別の題材", () => {
    const shown = examples();
    expect(shown.length).toBeGreaterThanOrEqual(2);
    const articleTopics =
      /口コミ|AISAS|SIPS|ステマ|景品表示|健康食品|機能性表示|個人情報|Cookie|SEO|Google|ふるさと納税|睡眠|労働基準|有給|インボイス|消費税|マズロー|ピグマリオン|著作権|生成AI/;
    for (const { text, output } of shown) {
      expect(text).not.toMatch(articleTopics);
      expect(JSON.stringify(output)).not.toMatch(articleTopics);
    }
  });

  it("例示の出力は固定の形式どおりで、originalText は本文にそのまま見つかり、意見・助言は主張にしていない", () => {
    const fields = [
      "id",
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
    for (const { text, output } of examples()) {
      expect(output.claims.length).toBeGreaterThan(0);
      output.claims.forEach((claim: any, i: number) => {
        expect(Object.keys(claim)).toEqual(fields);
        expect(claim.id).toBe(`claim-${i + 1}`);
        expect(text).toContain(claim.originalText);
        expect(claim.originalText).not.toMatch(/思う|よいだろう/);
      });
    }
  });

  it("例示で、限定語は言い換えにも残り、主語の省略は実体で補われている", () => {
    const claims = examples().flatMap(({ output }) => output.claims);
    const byOriginal = (text: string) => claims.find((c: any) => c.originalText === text);
    expect(byOriginal("高さは634メートル").normalizedText).toMatch(/^東京スカイツリーの高さ/);
    expect(byOriginal("自立式電波塔としては世界一の高さだ").normalizedText).toContain("自立式電波塔としては");
    const license = claims.find((c: any) => c.originalText.includes("18歳以上"));
    expect(license.normalizedText).toContain("原則として18歳以上");
  });
});

describe("取り出しの答えの読み取り（主張を黙って落とさない）", () => {
  it("同じ文を共有する主張も、本文に見つからない主張も、そのまま残す", () => {
    const claims = readExtractedClaims({
      claims: [
        { id: "claim-1", originalText: "会費は月額1万円で、入会金は無料です。", normalizedText: "会費は月額1万円である。" },
        { id: "claim-2", originalText: "会費は月額1万円で、入会金は無料です。", normalizedText: "入会金は無料である。" },
        { id: "claim-3", originalText: "本文には無い言い回し", normalizedText: "本文には無い言い回しの主張。" },
      ],
    });
    expect(claims.map((c) => c.id)).toEqual(["claim-1", "claim-2", "claim-3"]);
    expect(claims[0].originalText).toBe(claims[1].originalText);
  });

  it("欠けた項目は既定値で補い、配列だけの答えも読む", () => {
    const [claim] = readExtractedClaims([{ id: "claim-1", originalText: "原文。", importance: "odd" }]);
    expect(claim).toMatchObject({
      id: "claim-1",
      originalText: "原文。",
      normalizedText: "原文。",
      numbers: [],
      dates: [],
      entities: [],
      importance: "normal",
      factCheckRequired: true,
    });
    expect(readExtractedClaims({})).toEqual([]);
  });
});

describe("提供元ごとに同じ指示文を送る", () => {
  const realFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = realFetch;
    vi.restoreAllMocks();
  });

  const answer = '{"claims":[{"id":"claim-1","originalText":"原文。","normalizedText":"原文。"}]}';

  it("Anthropic は system に同じ指示文を送り、本文は手を加えずに渡す", async () => {
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

    const claims = await new AnthropicLLMProvider({ apiKey: "test-key" }).extractClaims("本文。");
    expect(sent[0].system).toBe(CLAIM_EXTRACTION_SYSTEM_PROMPT);
    expect(sent[0].messages).toEqual([{ role: "user", content: "本文。" }]);
    expect(claims.map((c) => c.id)).toEqual(["claim-1"]);
  });

  it("OpenAI も system に同じ指示文を送る", async () => {
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

    const claims = await new OpenAILLMProvider({ apiKey: "test-key" }).extractClaims("本文。");
    expect(sent[0].messages[0]).toEqual({ role: "system", content: CLAIM_EXTRACTION_SYSTEM_PROMPT });
    expect(sent[0].messages[1]).toEqual({ role: "user", content: "本文。" });
    expect(claims.map((c) => c.id)).toEqual(["claim-1"]);
  });
});

import { describe, it, expect } from "vitest";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { compareValues, findValues } from "@/lib/pipeline/stated-values";
import { NONE, candidatesFor, statedValues, valueQuestionsFor } from "@/lib/pipeline/value-check";
import { planSupportRequests } from "@/lib/pipeline/support-question";
import { buildRevisedDocument } from "@/lib/revised-document";
import type { AnalysisResult, Claim, ClaimResult } from "@/types";
import type { JEVAnswer, JEVQuestion } from "@/lib/providers";

/**
 * Dates and amounts: code finds the candidates, JEV picks, code compares
 * (docs.typesafe.ai/cookbooks/pre_parsed_value_extraction_cookbook).
 */

describe("日付と数値の取り出し（コード）", () => {
  const dateOf = (text: string) => {
    const [value] = findValues(text);
    return value && value.kind === "date"
      ? { span: value.span, year: value.year, month: value.month, day: value.day }
      : value;
  };

  it("西暦・和暦・全角数字・漢数字・スラッシュを同じ日付として読む", () => {
    expect(dateOf("2023年10月1日から施行")).toEqual({ span: "2023年10月1日", year: 2023, month: 10, day: 1 });
    expect(dateOf("令和5年10月1日から施行")).toEqual({ span: "令和5年10月1日", year: 2023, month: 10, day: 1 });
    expect(dateOf("２０２３年１０月１日から")).toEqual({ span: "２０２３年１０月１日", year: 2023, month: 10, day: 1 });
    expect(dateOf("令和五年十月一日施行")).toEqual({ span: "令和五年十月一日", year: 2023, month: 10, day: 1 });
    expect(dateOf("令和元年5月1日")).toMatchObject({ year: 2019, month: 5, day: 1 });
    expect(dateOf("平成31年4月30日")).toMatchObject({ year: 2019, month: 4, day: 30 });
    expect(dateOf("更新日 2023/10/01")).toMatchObject({ year: 2023, month: 10, day: 1 });
  });

  it("年のない「10月1日」、年と月だけ、年だけも取りこぼさない", () => {
    expect(dateOf("10月1日から施行")).toEqual({ span: "10月1日", year: undefined, month: 10, day: 1 });
    expect(dateOf("２０２３年１０月に")).toMatchObject({ year: 2023, month: 10, day: undefined });
    expect(dateOf("2004年に提唱")).toMatchObject({ year: 2004, month: undefined });
  });

  it("金額・人数・割合を、書き方が違っても同じ値として読む", () => {
    const amounts = findValues("月額15,000円、または1万5000円。会員は１４２人。約6割（６０％）。3倍。");
    expect(amounts.map((v) => (v.kind === "amount" ? [v.span, v.value, v.unit] : v.span))).toEqual([
      ["15,000円", 15000, "円"],
      ["1万5000円", 15000, "円"],
      ["１４２人", 142, "人"],
      ["6割", 60, "%"],
      ["６０％", 60, "%"],
      ["3倍", 3, "倍"],
    ]);
  });

  it("日付の中の数字を数値として二重に拾わない", () => {
    expect(findValues("2023年10月1日に100人").map((v) => v.span)).toEqual(["2023年10月1日", "100人"]);
  });
});

describe("値の比べ方（コード）", () => {
  const one = (text: string) => findValues(text)[0];

  it("年が違えば違う。和暦と西暦は同じ日", () => {
    expect(compareValues(one("2024年10月1日"), one("令和5年10月1日"))).toBe("different");
    expect(compareValues(one("2023年10月1日"), one("令和5年10月1日"))).toBe("same");
  });

  it("片方にしか書かれていない年は、違いとして数えない", () => {
    expect(compareValues(one("2024年10月1日"), one("10月1日"))).toBe("same");
    expect(compareValues(one("10月1日"), one("2023年10月2日"))).toBe("different");
    expect(compareValues(one("2024年"), one("10月1日"))).toBe("unknown");
  });

  it("数値は単位が同じときだけ比べる", () => {
    expect(compareValues(one("15,000円"), one("1万5000円"))).toBe("same");
    expect(compareValues(one("10,000円"), one("1万5000円"))).toBe("different");
    expect(compareValues(one("6割"), one("60%"))).toBe("same");
    expect(compareValues(one("142人"), one("142円"))).toBe("unknown");
  });
});

describe("JEVに選ばせる問い", () => {
  it("候補はページに書かれた同種の値そのもので、該当なしを含む", () => {
    const [stated] = statedValues("2024年10月1日から施行されています。");
    const text = "告示は令和5年10月1日から施行。改正は2024年4月。会員は100人。";
    expect(candidatesFor(stated, text)).toEqual(["令和5年10月1日", "2024年4月"]);

    const questions = valueQuestionsFor([stated], text, 2);
    const question = questions.value0_2;
    expect(question.type).toBe("choice");
    if (question.type !== "choice") return;
    expect(question.instructions).toBe(
      "claim.original は「2024年10月1日」という日付で、ある事柄（いつ起きたか・いくつか等）を述べている。" +
        "sources[2] の本文で、その同じ事柄について書かれている日付はどれか。claim.original と同じ値かどうかは問わない。"
    );
    expect(Object.keys(question.criteria)).toEqual(["令和5年10月1日", "2024年4月", NONE]);
  });

  it("同種の値が1つも無いページには問わない", () => {
    const stated = statedValues("2024年10月1日から施行。");
    expect(valueQuestionsFor(stated, "日付の無い本文。", 0)).toEqual({});
  });

  it("ページごとの問いを、支持の問いと同じリクエストに載せる", () => {
    const stated = statedValues("2024年10月1日から施行。");
    const [request] = planSupportRequests({
      original: "2024年10月1日から施行。",
      article: "記事。",
      pages: [
        { title: "a", url: "https://example.com/a", text: "令和5年10月1日から施行。" },
        { title: "b", url: "https://example.com/b", text: "日付なし。" },
      ],
      questionsFor: (source, index) => valueQuestionsFor(stated, source.text, index),
    });
    expect(Object.keys(request.questions)).toEqual(["support", "value0_0"]);
  });
});

// The production case: seven pages, the Consumer Affairs Agency's among them,
// all said the sentence was backed, 88%, and no ▶.
const SENTENCE = "景品表示法の運用基準に関する告示が指定され、2024年10月1日から施行されています。";
const ARTICLE = `ステマ規制について。${SENTENCE}結び。`;
const CLAIM: Claim = {
  id: "c1",
  originalText: SENTENCE,
  normalizedText: "ステマ規制の告示は2024年10月1日に施行された。",
  subject: "ステマ規制",
  entities: ["ステマ規制"],
  importance: "normal",
  factCheckRequired: true,
};
const PAGE = {
  url: "https://www.caa.go.jp/stealth",
  title: "ステルスマーケティングに関する景品表示法違反被疑事案について",
  body: "ステマ規制の告示は令和5年3月28日に指定され、令和5年10月1日から施行されています。更新 2024年4月1日。",
};

function fakes(pick: (question: Extract<JEVQuestion, { type: "choice" }>) => { choice: string; confidence: number }) {
  const calls: Array<{ state: any; questions: Record<string, JEVQuestion> }> = [];
  const options = {
    llm: {
      async extractClaims() {
        return [CLAIM];
      },
      async generateSearchQueries() {
        return ["ステマ規制 施行日"];
      },
      async generateDocumentQueries() {
        return ["ステマ規制 施行日"];
      },
    } as any,
    factCheck: {
      async search() {
        return [];
      },
    } as any,
    search: {
      async search() {
        return { results: [{ url: PAGE.url, title: PAGE.title }] };
      },
    } as any,
    fetch: {
      async fetchUrl(url: string) {
        return { url, title: PAGE.title, content: PAGE.body };
      },
    } as any,
    jev: {
      async evaluateAtomicJudgment() {
        throw new Error("not used");
      },
      async ask(state: unknown, questions: Record<string, JEVQuestion>) {
        calls.push({ state, questions });
        const answers: Record<string, JEVAnswer> = {};
        for (const [name, question] of Object.entries(questions)) {
          if (question.type === "noul") {
            answers[name] = { type: "noul", noul: 0.88 };
          } else if (question.type === "choice" && name.startsWith("value")) {
            const { choice, confidence } = pick(question);
            answers[name] = { type: "choice", choice, confidence, probabilities: { [choice]: confidence } };
          } else {
            answers[name] = {
              type: "choice",
              choice: "supports",
              confidence: 0.95,
              probabilities: { supports: 0.95 },
            };
          }
        }
        return answers;
      },
    },
  };
  return { options, calls };
}

describe("食い違いの扱い（ADR-0011・ADR-0012）", () => {
  it("JEVが選んだページの値をコードで比べ、違えば資料の値とページを残す。信頼度はJEVの数値のまま", async () => {
    const { options, calls } = fakes(() => ({ choice: "令和5年10月1日", confidence: 0.97 }));

    const { claims } = await runFactPipeline(ARTICLE, options);

    // One request: the value pick rides with the support question.
    expect(calls).toHaveLength(1);
    const question = calls[0].questions.value0_0;
    expect(question.type === "choice" && Object.keys(question.criteria)).toEqual([
      "令和5年3月28日",
      "令和5年10月1日",
      "2024年4月1日",
      NONE,
    ]);
    // JEV is never asked to compare the values.
    expect(JSON.stringify(calls[0].questions)).not.toContain("一致");

    expect(claims[0].confidence).toBe(0.88);
    expect(claims[0].valueConflicts).toEqual([
      {
        stated: "2024年10月1日",
        found: "令和5年10月1日",
        sourceUrl: PAGE.url,
        sourceTitle: PAGE.title,
        confidence: 0.97,
      },
    ]);
  });

  it("同じ日を選んだとき・該当なし・確信が低いときは、食い違いにしない", async () => {
    for (const answer of [
      { choice: "2024年4月1日", confidence: 0.3 },
      { choice: NONE, confidence: 0.99 },
      { choice: "選択肢に無い値", confidence: 0.99 },
    ]) {
      const { options } = fakes(() => answer);
      const { claims } = await runFactPipeline(ARTICLE, options);
      expect(claims[0].valueConflicts).toBeUndefined();
      expect(claims[0].confidence).toBe(0.88);
    }
  });
});

describe("吹き出しと▶（ADR-0012）", () => {
  function analysis(result: ClaimResult): AnalysisResult {
    return {
      originalText: ARTICLE,
      revisedText: ARTICLE,
      summary: {
        claimsChecked: 1,
        supported: 0,
        contradicted: 0,
        mixed: 0,
        insufficient: 0,
        styleIssuesFixed: 0,
      },
      claims: [result],
      styleIssues: [],
      sources: [],
      timings: [],
    };
  }

  const result: ClaimResult = {
    claim: CLAIM,
    verdict: "SUPPORTED",
    evidence: [],
    confidence: 0.88,
  };

  it("信頼度が80%を超えていても、資料の値が違えば▶を付け、数値はJEVのまま出す", () => {
    const conflict = {
      stated: "2024年10月1日",
      found: "令和5年10月1日",
      sourceUrl: PAGE.url,
      sourceTitle: PAGE.title,
      confidence: 0.97,
    };
    const doc = buildRevisedDocument({
      analysis: analysis({ ...result, valueConflicts: [conflict] }),
      adoption: {},
    });
    const finding = doc.findings.find((item) => item.type === "fact")!;
    expect(finding.markKind).toBe("fact");
    expect(finding.confidence).toBe(88);
    expect(finding.valueConflicts).toEqual([conflict]);
  });

  it("食い違いが無ければ、これまでどおり80%を超える文に▶は付かない", () => {
    const doc = buildRevisedDocument({ analysis: analysis(result), adoption: {} });
    const finding = doc.findings.find((item) => item.type === "fact")!;
    expect(finding.markKind).toBeNull();
    expect(finding.valueConflicts).toBeUndefined();
  });
});

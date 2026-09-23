import { describe, it, expect } from "vitest";
import { OrderedPage, interleave, orderForClaim } from "@/lib/pipeline/candidate-order";

/**
 * ADR-0021: the order JEV judges a claim's candidates in. It decides only
 * what is judged first when the time runs out; it never drops a candidate
 * and never decides relevance.
 */

const at = (url: string, over: Partial<OrderedPage> = {}): OrderedPage => ({
  url,
  primary: false,
  origin: new URL(url).hostname,
  ...over,
});

describe("orderForClaim", () => {
  const pages: OrderedPage[] = [
    at("https://own-a.example/"), // 0
    at("https://own-b.example/"), // 1
    at("https://doc-a.example/"), // 2
    at("https://www.nta.go.jp/x", { primary: true }), // 3
    at("https://rest-a.example/"), // 4
    at("https://city.nagoya.lg.jp/y", { primary: true }), // 5
    at("https://doc-b.example/"), // 6
  ];
  const searches = [
    { query: "記事の検索語1", pageIds: [2, 3] },
    { query: "記事の検索語2", pageIds: [6] },
    { query: "この主張の問い1", pageIds: [0, 1] },
    { query: "ほかの主張の問い", pageIds: [4, 5, 0] },
  ];

  it("一次資料が先。そのあとこの主張の検索→記事全体の検索→ほかの検索、それぞれ問いの順・順位の順", () => {
    const order = orderForClaim({ pages, searches, own: ["この主張の問い1"], article: ["記事の検索語1", "記事の検索語2"] });

    expect(order.map((id) => pages[id].url)).toEqual([
      // Primary sources first: the article's search before another claim's.
      "https://www.nta.go.jp/x",
      "https://city.nagoya.lg.jp/y",
      // This claim's own search, by rank (own-a also turned up in another's, lower).
      "https://own-a.example/",
      "https://own-b.example/",
      // The article's searches, in the order written.
      "https://doc-a.example/",
      "https://doc-b.example/",
      // The rest.
      "https://rest-a.example/",
    ]);
  });

  it("どのページも1回ずつ、1件も落とさない", () => {
    const order = orderForClaim({ pages, searches, own: [], article: [] });

    expect([...order].sort((a, b) => a - b)).toEqual(pages.map((_, id) => id));
  });

  it("同じ出所（同じサイト・転載）のページは、最初の1件の位置にまとめる", () => {
    const grouped: OrderedPage[] = [
      at("https://blog.example.com/1", { origin: "example.com" }), // 0
      at("https://other.example/"), // 1
      at("https://blog.example.com/2", { origin: "example.com" }), // 2
      at("https://copy.example.net/", { origin: "example.net、mhlw.go.jp" }), // 3
      at("https://www.mhlw.go.jp/a", { primary: true, origin: "example.net、mhlw.go.jp" }), // 4
    ];
    const order = orderForClaim({
      pages: grouped,
      searches: [{ query: "q", pageIds: [0, 1, 2, 3, 4] }],
      own: ["q"],
      article: [],
    });

    expect(order.map((id) => grouped[id].url)).toEqual([
      "https://www.mhlw.go.jp/a",
      "https://copy.example.net/",
      "https://blog.example.com/1",
      "https://blog.example.com/2",
      "https://other.example/",
    ]);
  });

  it("その主張のファクトチェックの結果は先頭に、ほかの主張の結果は入れない", () => {
    const withReviews = [...pages, at("https://factcheck-a.example/"), at("https://factcheck-b.example/")];
    const order = orderForClaim({
      pages: withReviews,
      searches,
      own: [],
      article: [],
      first: [7],
      exclude: new Set([8]),
    });

    expect(order[0]).toBe(7);
    expect(order).not.toContain(8);
    expect(order).toHaveLength(8);
  });

  it("同じ入力なら何度でも同じ順（渡されたページの並びにもよらない）", () => {
    const reversed = [...pages].reverse();
    const idMap = pages.map((_, id) => pages.length - 1 - id);
    const reversedSearches = searches.map((s) => ({ ...s, pageIds: s.pageIds.map((id) => idMap[id]) }));

    const a = orderForClaim({ pages, searches, own: ["この主張の問い1"], article: ["記事の検索語1"] });
    const b = orderForClaim({
      pages: reversed,
      searches: reversedSearches,
      own: ["この主張の問い1"],
      article: ["記事の検索語1"],
    });

    expect(b.map((id) => reversed[id].url)).toEqual(a.map((id) => pages[id].url));
  });
});

describe("interleave", () => {
  it("主張ごとの候補を1件ずつ順番に取り、すでに取ったものは飛ばす", () => {
    expect(
      interleave([
        ["a1", "a2", "shared", "a3"],
        ["shared", "b1"],
        ["c1"],
      ])
    ).toEqual(["a1", "shared", "c1", "a2", "b1", "a3"]);
  });

  it("候補の多い主張がいても、ほかの主張の最初の候補が先に来る", () => {
    const long = Array.from({ length: 100 }, (_, i) => `long-${i}`);
    const order = interleave([long, ["short-1", "short-2"]]);

    expect(order.slice(0, 4)).toEqual(["long-0", "short-1", "long-1", "short-2"]);
    expect(order).toHaveLength(102);
  });
});

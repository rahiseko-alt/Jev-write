import { describe, it, expect } from "vitest";
import { createSourcePool } from "@/lib/pipeline/source-pool";

type Page = { url: string; title: string; body: string };

function providers(pages: Record<string, Page[]>, delays: Record<string, number> = {}) {
  const searched: string[] = [];
  const fetched: string[] = [];
  const wait = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms));

  const search = {
    async search(query: string) {
      searched.push(query);
      await wait(delays[query]);
      return { results: (pages[query] ?? []).map((p) => ({ url: p.url, title: p.title })) };
    },
  } as any;

  const fetchProvider = {
    async fetchUrl(url: string) {
      fetched.push(url);
      await wait(delays[url]);
      const page = Object.values(pages)
        .flat()
        .find((p) => p.url === url);
      return { url, title: page?.title ?? "", content: page?.body ?? "" };
    },
  } as any;

  return { search, fetchProvider, searched, fetched };
}

describe("source pool", () => {
  it("searches and reads each page once, however many claims use it", async () => {
    const { search, fetchProvider, searched, fetched } = providers({
      "フリノバ 会社概要": [
        { url: "https://example.com/a", title: "会社概要", body: "フリノバは名古屋市にある。" },
      ],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });

    await pool.seed(["フリノバ 会社概要"]);
    await pool.seed(["フリノバ 会社概要"]);

    expect(pool.candidatesFor([])).toHaveLength(1);
    expect(pool.candidatesFor(["フリノバ 会社概要"])).toHaveLength(1);
    expect(searched).toEqual(["フリノバ 会社概要"]);
    expect(fetched).toEqual(["https://example.com/a"]);
  });

  it("reports a search it could not make, rather than passing it off as nothing found", async () => {
    const search = {
      async search() {
        throw new Error("usage limit");
      },
    } as any;
    const pool = createSourcePool({
      search,
      fetchProvider: { async fetchUrl() { return {}; } } as any,
      resultsPerQuery: 4,
    });

    await pool.seed(["q"]);

    expect(pool.searchFailed()).toBe(true);
    expect(pool.failure()).toContain("usage limit");
    expect(pool.size()).toBe(0);
  });
});

describe("候補の出し方（ADR-0016）", () => {
  it("主語の出現回数で並べ替えず、主語に触れていないページも候補から外さない（#22・#39 の逆向きをしない）", async () => {
    const { search, fetchProvider } = providers({
      q: [
        { url: "https://example.com/listing", title: "一覧", body: "フリノバもその一つです。" },
        {
          url: "https://example.com/official",
          title: "フリノバについて",
          body: "フリノバはフリノバのフリノバによるフリノバ。",
        },
        { url: "https://example.com/other", title: "別の話", body: "まったく別の話。" },
      ],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["q"]);

    // The search's own order, all three.
    expect(pool.candidatesFor(["q"]).map((page) => page.url)).toEqual([
      "https://example.com/listing",
      "https://example.com/official",
      "https://example.com/other",
    ]);
  });

  it("その主張の検索の結果を先に、残りの池をその後に、検索の順・順位の順で並べる", async () => {
    const { search, fetchProvider } = providers({
      article: [{ url: "https://example.com/article", title: "記事の検索", body: "記事の検索で見つけた本文。" }],
      own: [
        { url: "https://example.go.jp/own-1", title: "所管官庁", body: "所管官庁の本文。" },
        { url: "https://example.com/article", title: "記事の検索", body: "記事の検索で見つけた本文。" },
      ],
      other: [{ url: "https://example.org/other", title: "別の主張", body: "別の主張の検索で見つけた本文。" }],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["article"]);
    await pool.seed(["own", "other"]);

    expect(pool.candidatesFor(["own", "article"]).map((page) => page.url)).toEqual([
      "https://example.go.jp/own-1",
      "https://example.com/article",
      "https://example.org/other",
    ]);
  });

  it("検索や取得が返ってきた順が違っても、同じ候補が同じ順で出る", async () => {
    const pages = {
      a: [
        { url: "https://a.example/1", title: "a1", body: "本文a1。" },
        { url: "https://a.example/2", title: "a2", body: "本文a2。" },
      ],
      b: [{ url: "https://b.example/1", title: "b1", body: "本文b1。" }],
    };
    const fast = providers(pages, { a: 0, b: 0 });
    const slow = providers(pages, { a: 30, "https://a.example/1": 20, b: 0 });

    const orders: string[][] = [];
    for (const { search, fetchProvider } of [fast, slow]) {
      const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
      await pool.seed(["a", "b"]);
      orders.push(pool.candidatesFor(["a", "b"]).map((page) => page.url));
    }

    expect(orders[0]).toEqual(["https://a.example/1", "https://a.example/2", "https://b.example/1"]);
    expect(orders[1]).toEqual(orders[0]);
  });
});

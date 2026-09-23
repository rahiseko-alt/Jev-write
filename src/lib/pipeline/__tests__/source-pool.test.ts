import { describe, it, expect } from "vitest";
import { createSourcePool } from "@/lib/pipeline/source-pool";
import type { Claim } from "@/types";

function claim(subject: string, entities: string[] = []): Claim {
  return {
    id: `claim-${subject}`,
    originalText: `${subject}についての文。`,
    normalizedText: `${subject}についての文。`,
    subject,
    entities,
    importance: "normal",
    factCheckRequired: true,
  };
}

function providers(pages: Record<string, { url: string; title: string; body: string }[]>) {
  const searched: string[] = [];
  const fetched: string[] = [];

  const search = {
    async search(query: string) {
      searched.push(query);
      return { results: (pages[query] ?? []).map((p) => ({ url: p.url, title: p.title })) };
    },
  } as any;

  const fetchProvider = {
    async fetchUrl(url: string) {
      fetched.push(url);
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

    expect(pool.candidatesFor(claim("フリノバ"), 5)).toHaveLength(1);
    expect(pool.candidatesFor(claim("フリノバ"), 5)).toHaveLength(1);
    expect(searched).toEqual(["フリノバ 会社概要"]);
    expect(fetched).toEqual(["https://example.com/a"]);
  });

  it("puts the page that mentions more of the claim's names first", async () => {
    const { search, fetchProvider } = providers({
      q: [
        { url: "https://example.com/wide", title: "名古屋の場所", body: "フリノバがある。" },
        {
          url: "https://example.com/close",
          title: "ギルドの案内",
          body: "フリノバギルドはフリノバの取り組みである。",
        },
      ],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["q"]);

    const ordered = pool.candidatesFor(claim("フリノバ", ["フリノバギルド"]), 5);

    expect(ordered.map((page) => page.url)).toEqual([
      "https://example.com/close",
      "https://example.com/wide",
    ]);
  });

  it("keeps a page out of a claim it never mentions", async () => {
    const { search, fetchProvider } = providers({
      q: [{ url: "https://example.com/other", title: "別の会社", body: "まったく別の話。" }],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["q"]);

    expect(pool.candidatesFor(claim("フリノバ"), 5)).toHaveLength(0);
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

describe("ページの選び方", () => {
  it("主語を通して扱っているページを、一度だけ触れたページより前に置く", async () => {
    const { search, fetchProvider } = providers({
      q: [
        {
          url: "https://example.com/listing",
          title: "レンタルスペース一覧",
          body: "名古屋のスペースを予約できます。フリノバもその一つです。他の施設も多数。",
        },
        {
          url: "https://example.com/official",
          title: "フリノバについて",
          body: "フリノバはフリーランスの場所です。フリノバの会員は……。フリノバの案内。",
        },
      ],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["q"]);

    const ordered = pool.candidatesFor(claim("フリノバ"), 5);

    expect(ordered[0].url).toBe("https://example.com/official");
  });
});

describe("a claim no page names by its subject", () => {
  it("still gets the pages closest to its wording, so JEV judges them (ADR-0007)", async () => {
    const { search, fetchProvider } = providers({
      q: [
        { url: "https://example.com/near", title: "口コミの効果", body: "少数の悪評は購買意欲を減退させることがある。" },
        { url: "https://example.com/far", title: "天気", body: "明日は晴れる。" },
      ],
    });
    const pool = createSourcePool({ search, fetchProvider, resultsPerQuery: 4 });
    await pool.seed(["q"]);

    const english: Claim = {
      ...claim("A few negative reviews"),
      originalText: "少数の悪評が購買意欲を急激に減退させる",
      normalizedText: "A few negative reviews sharply reduce purchase intent.",
    };

    expect(pool.candidatesFor(english, 5)).toHaveLength(0);
    const closest = pool.closestFor(english, 5);
    expect(closest.map((p) => p.url)).toEqual(["https://example.com/near", "https://example.com/far"]);
  });
});

import { describe, it, expect } from "vitest";
import { isReprint, originsOf, primaryKindOf, siteOf } from "@/lib/pipeline/source-origin";

describe("出所（ADR-0016）", () => {
  it("同じドメインは1つのサイト。www と組織内のサブドメインは同じ、別の組織は別", () => {
    expect(siteOf("https://www.example.com/a")).toBe("example.com");
    expect(siteOf("https://news.example.com/b")).toBe("example.com");
    expect(siteOf("https://www.mhlw.go.jp/x")).toBe("mhlw.go.jp");
    expect(siteOf("https://www.caa.go.jp/x")).toBe("caa.go.jp");
    expect(siteOf("https://shop.example.co.jp/")).toBe("example.co.jp");
    expect(siteOf("https://www.city.yokohama.lg.jp/")).toBe("yokohama.lg.jp");
    expect(siteOf("https://www.city.toyota.aichi.jp/")).toBe("toyota.aichi.jp");
    expect(siteOf("https://www.pref.aichi.jp/")).toBe("pref.aichi.jp");
  });

  it("一次資料をアドレスから見分ける（官公庁・法令・地方公共団体・学術・DOI）。それ以外は付けない", () => {
    expect(primaryKindOf("https://www.mhlw.go.jp/stf/a.html")).toBe("官公庁");
    expect(primaryKindOf("https://elaws.e-gov.go.jp/document?lawid=414AC0000000103")).toBe("法令・官報");
    expect(primaryKindOf("https://laws.e-gov.go.jp/law/414AC0000000103")).toBe("法令・官報");
    expect(primaryKindOf("https://www.city.yokohama.lg.jp/a")).toBe("地方公共団体");
    expect(primaryKindOf("https://www.pref.aichi.jp/a")).toBe("地方公共団体");
    expect(primaryKindOf("https://www.u-tokyo.ac.jp/a")).toBe("学術機関");
    expect(primaryKindOf("https://doi.org/10.1000/xyz123")).toBe("学術論文（DOI）");
    expect(primaryKindOf("https://link.example.com/article/10.1038/s41586-020-2649-2")).toBe("学術論文（DOI）");
    expect(primaryKindOf("https://www.jstage.jst.go.jp/article/x")).toBe("学術論文");
    expect(primaryKindOf("https://www.cdc.gov/a")).toBe("政府・国際機関");
    expect(primaryKindOf("https://www.who.int/a")).toBe("政府・国際機関");
    expect(primaryKindOf("https://example.com/a")).toBeUndefined();
    expect(primaryKindOf("https://ja.wikipedia.org/wiki/a")).toBeUndefined();
    expect(primaryKindOf("not a url")).toBeUndefined();
  });

  it("本文がほぼ同じページは転載として同じ出所。短すぎる本文や別の本文は別", () => {
    const body = "健康増進法の改正により、多数の者が利用する施設は原則屋内禁煙となった。".repeat(10);
    expect(isReprint(body, `トップ　ニュース\n${body}\n関連記事`)).toBe(true);
    expect(isReprint(body, "まったく別の内容の本文。".repeat(30))).toBe(false);
    expect(isReprint("短い。", "短い。")).toBe(false);
  });

  it("同じサイトと転載をまとめ、結果は渡した順に左右されない", () => {
    const body = "受動喫煙の防止に関する基準を定める文書の本文である。".repeat(12);
    const pages = [
      { url: "https://www.mhlw.go.jp/a", text: body },
      { url: "https://copy.example.net/b", text: `転載\n${body}` },
      { url: "https://example.com/1", text: "一つ目のブログ。" },
      { url: "https://blog.example.com/2", text: "二つ目のブログ。" },
      { url: "https://other.example.org/3", text: "別の話題の本文。" },
    ];

    const origins = originsOf(pages);

    expect(origins.map((o) => o.origin)).toEqual([
      "example.net、mhlw.go.jp",
      "example.net、mhlw.go.jp",
      "example.com",
      "example.com",
      "example.org",
    ]);
    expect(origins.map((o) => o.primary)).toEqual([true, false, false, false, false]);

    const reversed = originsOf(pages.slice().reverse()).reverse();
    expect(reversed).toEqual(origins);
  });
});

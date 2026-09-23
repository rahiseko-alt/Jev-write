import { describe, it, expect } from "vitest";
import { isAboutSubject } from "@/lib/pipeline/relevance";
import type { Claim } from "@/types";

function claim(fields: Partial<Claim>): Claim {
  return {
    id: "c1",
    originalText: "オンライン会員は入会金1万円",
    normalizedText: "フリノバのオンライン会員の入会金は1万円である",
    importance: "normal",
    factCheckRequired: true,
    ...fields,
  };
}

const FRINOVA = claim({ subject: "フリノバ", entities: ["フリノバ"] });

describe("isAboutSubject", () => {
  it("rejects a page about a different company with a similar name", () => {
    // 英会話 NOVA の料金ページ。「フリノバ」とは一言も書いていない。
    const page =
      "NOVAの料金プラン。グループレッスンとマンツーマンから選べます。入会金は1万円、月額は12,000円から。";

    expect(isAboutSubject(page, FRINOVA)).toBe(false);
  });

  it("accepts a page that is about the subject", () => {
    const page =
      "フリノバは名古屋のフリーランス向けコミュニティです。オンライン会員の入会金は1万円。";

    expect(isAboutSubject(page, FRINOVA)).toBe(true);
  });

  it("does not care about letter case or full-width characters", () => {
    const page = "ＨＵＢＢはプロコワ×フリノバの総合プラットフォームです。";

    expect(isAboutSubject(page, FRINOVA)).toBe(true);
    expect(isAboutSubject("hubb by procowo", claim({ subject: "HUBB", entities: ["HUBB"] }))).toBe(
      true
    );
  });

  it("does not let a shorter name inside the subject stand in for it", () => {
    // 「ノバ」は「フリノバ」の一部だが、「ノバ」しか書いていないページは別物。
    const page = "ノバ株式会社の決算資料。";

    expect(isAboutSubject(page, FRINOVA)).toBe(false);
  });

  it("falls back to the claim's other names when it has no subject", () => {
    const withoutSubject = claim({ subject: undefined, entities: ["プロコワ"] });

    expect(isAboutSubject("プロコワはコワーキングスペースです。", withoutSubject)).toBe(true);
    expect(isAboutSubject("まったく無関係な記事。", withoutSubject)).toBe(false);
  });

  it("admits the page when the claim names nothing to check against", () => {
    const nameless = claim({ subject: undefined, entities: [] });

    // 判定材料が無いときに落とすと、検証できる主張まで捨ててしまう。
    expect(isAboutSubject("何かの記事。", nameless)).toBe(true);
  });

  it("does not admit a page it could not read", () => {
    expect(isAboutSubject("", FRINOVA)).toBe(false);
  });
});

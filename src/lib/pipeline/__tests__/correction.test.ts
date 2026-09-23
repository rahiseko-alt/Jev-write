import { describe, it, expect } from "vitest";
import { correctionFromEvidence } from "@/lib/pipeline/correction";
import type { Claim } from "@/types";

function claim(text: string): Claim {
  return {
    id: "c1",
    originalText: text,
    normalizedText: text,
    importance: "normal",
    factCheckRequired: true,
  };
}

describe("correctionFromEvidence", () => {
  it("takes the figure the evidence gives for the same thing", () => {
    const corrected = correctionFromEvidence(
      claim("本体価格は139,980円です"),
      "本体価格は49,980円（税込）で、多言語版は69,980円です。"
    );

    expect(corrected).toBe("本体価格は49,980円です");
  });

  it("does not take a figure introduced by different words", () => {
    const corrected = correctionFromEvidence(
      claim("本体価格は139,980円です"),
      "多言語版は69,980円です。"
    );

    expect(corrected).toBeUndefined();
  });

  it("does not swap a length for a percentage", () => {
    const corrected = correctionFromEvidence(
      claim("重量は約3.3kgです"),
      "レンダリング速度は約45%向上しました。"
    );

    expect(corrected).toBeUndefined();
  });

  it("offers nothing when the evidence agrees with the claim", () => {
    const corrected = correctionFromEvidence(
      claim("本体価格は49,980円です"),
      "本体価格は49,980円です。"
    );

    expect(corrected).toBeUndefined();
  });

  it("offers nothing when the evidence carries no figures", () => {
    const corrected = correctionFromEvidence(
      claim("本体価格は139,980円です"),
      "価格についての記述はありません。"
    );

    expect(corrected).toBeUndefined();
  });

  it("offers nothing for an article it has never seen", () => {
    const corrected = correctionFromEvidence(
      claim("売上は前年比120%でした"),
      "四半期の業績は堅調に推移しました。"
    );

    expect(corrected).toBeUndefined();
  });

  it("corrects several figures at once when each is justified", () => {
    const corrected = correctionFromEvidence(
      claim("幅は388mmで、重量は3.3kgです"),
      "幅は388mm、重量は2.8kgと発表されています。"
    );

    expect(corrected).toBe("幅は388mmで、重量は2.8kgです");
  });

  it("leaves the rest of the claim's wording untouched", () => {
    const corrected = correctionFromEvidence(
      claim("メインカメラは20MPをデフォルトとする"),
      "メインカメラは24MPをデフォルトとします。"
    );

    expect(corrected).toBe("メインカメラは24MPをデフォルトとする");
  });
});

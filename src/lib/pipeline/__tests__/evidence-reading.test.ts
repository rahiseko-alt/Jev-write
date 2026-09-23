import { describe, it, expect } from "vitest";
import { readEvidence } from "@/lib/pipeline/evidence-reading";

describe("集めた資料の読み方", () => {
  it("別々のサイト2件が違うことを書いていれば、食い違いとする", () => {
    expect(readEvidence({ supports: 0, contradicts: 2, contradictingSites: 2 })).toBe("conflict");
  });

  it("1つのサイトの複数ページは、1つの声として扱う", () => {
    expect(readEvidence({ supports: 0, contradicts: 3, contradictingSites: 1 })).toBe(
      "single-site-conflict"
    );
  });

  it("裏付けと食い違いが両方あれば、両方を見せる", () => {
    expect(readEvidence({ supports: 1, contradicts: 1, contradictingSites: 1 })).toBe("mixed");
  });

  it("裏付けだけなら裏付け、何も無ければ何も無いとする", () => {
    expect(readEvidence({ supports: 2, contradicts: 0, contradictingSites: 0 })).toBe("supported");
    expect(readEvidence({ supports: 0, contradicts: 0, contradictingSites: 0 })).toBe("none");
  });
});

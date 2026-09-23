import { describe, it, expect } from "vitest";
import { figuresIn } from "@/lib/text/figures";

describe("figuresIn", () => {
  it("reads a decimal as one figure, not two", () => {
    const figures = figuresIn("重量は3.3kgです");

    expect(figures.map((f) => f.text)).toEqual(["3.3kg"]);
    expect(figures[0].unit).toBe("kg");
    expect(figures[0].label).toBe("重量は");
  });

  it("keeps the thousands separator out of the value", () => {
    expect(figuresIn("本体価格は139,980円です")[0].value).toBe("139980");
  });

  it("reads a bare number where no unit was written", () => {
    expect(figuresIn("2025年8月に公開").map((f) => f.text)).toEqual(["2025", "8"]);
  });

  it("leaves bare numbers out when only measurements are wanted", () => {
    const figures = figuresIn("2025年8月に3.3kgで発売", { requireUnit: true });

    expect(figures.map((f) => f.text)).toEqual(["3.3kg"]);
  });

  it("does not read a longer unit as a shorter one", () => {
    expect(figuresIn("転送速度は10Gbpsです")[0].unit).toBe("gbps");
  });
});

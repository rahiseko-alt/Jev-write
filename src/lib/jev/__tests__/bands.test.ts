import { describe, it, expect } from "vitest";
import { ACT_THRESHOLD, BAND_LABEL, CAUTION_THRESHOLD, bandOf } from "@/lib/jev/bands";

describe("confidence bands", () => {
  it("acts at the threshold, not just above it", () => {
    expect(bandOf(ACT_THRESHOLD)).toBe("act");
    expect(bandOf(0.99)).toBe("act");
  });

  it("asks for a look between the two lines", () => {
    expect(bandOf(CAUTION_THRESHOLD)).toBe("caution");
    expect(bandOf(0.79)).toBe("caution");
  });

  it("hands the low end to a person", () => {
    expect(bandOf(0.49)).toBe("review");
    expect(bandOf(0)).toBe("review");
  });

  it("names every band in plain Japanese, carrying the lines it was drawn at", () => {
    const act = `${Math.round(ACT_THRESHOLD * 100)}%`;
    const caution = `${Math.round(CAUTION_THRESHOLD * 100)}`;
    expect(BAND_LABEL.act).toContain(act);
    expect(BAND_LABEL.caution).toContain(caution);
    expect(BAND_LABEL.caution).toContain(act);
    expect(BAND_LABEL.review).toContain(caution);
  });
});

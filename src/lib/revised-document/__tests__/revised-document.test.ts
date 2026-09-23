import { describe, it, expect } from "vitest";
import { buildRevisedDocument, sortByAttention } from "@/lib/revised-document";
import { BAND_LABEL } from "@/lib/jev/bands";
import type { AnalysisResult, ClaimResult, StyleIssue } from "@/types";

function claim(
  originalText: string,
  verdict: ClaimResult["verdict"],
  correctedClaim?: string
): ClaimResult {
  return {
    claim: {
      id: `claim-${originalText.slice(0, 8)}`,
      originalText,
      normalizedText: originalText,
      importance: "normal",
      factCheckRequired: true,
    },
    verdict,
    correctedClaim,
    reason: "テスト用の理由。",
    evidence: [],
  };
}

function styleIssue(targetText: string): StyleIssue {
  return {
    ruleId: "rule-1",
    ruleName: "無意味な反復",
    detected: true,
    confidence: 0.9,
    severity: "medium",
    targetText,
    repairInstruction: "反復を削る。",
  };
}

function analysis(
  originalText: string,
  revisedText: string,
  claims: ClaimResult[] = [],
  styleIssues: StyleIssue[] = []
): AnalysisResult {
  return {
    originalText,
    revisedText,
    summary: {
      claimsChecked: claims.length,
      supported: 0,
      contradicted: 0,
      mixed: 0,
      insufficient: 0,
      styleIssuesFixed: styleIssues.length,
    },
    claims,
    styleIssues,
    sources: [],
    timings: [],
  };
}

const THREE_PARAGRAPHS = [
  "最初の段落の一文目。二文目もここにある。",
  "二つ目の段落。",
  "三つ目の段落の一文目。二文目。三文目。",
].join("\n\n");

const THREE_PARAGRAPHS_REVISED = [
  "最初の段落の一文目。二文目もここにある。",
  "二つ目の段落。",
  "三つ目の段落の一文目。二文目。三文目。",
].join("\n\n");

/**
 * A fact suggestion now starts refused: what a source says differently is not
 * a settled error. Tests about what an accepted correction does say so here.
 */
const ACCEPTED: Record<string, boolean> = Object.fromEntries(
  Array.from({ length: 12 }, (_, i) => [`fact-${i}`, true])
);

describe("buildRevisedDocument", () => {
  describe("the document it marks up", () => {
    it("is the one the analysis ran on, not the one being typed", () => {
      const view = buildRevisedDocument({
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: { ...ACCEPTED },
      });

      expect(view.originalText).toBe(THREE_PARAGRAPHS);
      expect(view.paragraphs).toHaveLength(3);
      expect(view.comparison.map((pair) => pair.original).join("")).not.toBe("");
    });
  });

  describe("paragraph structure", () => {
    it("returns one paragraph per paragraph in the original", () => {
      const view = buildRevisedDocument({
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs).toHaveLength(3);
    });

    it("does not split a paragraph into one entry per sentence", () => {
      const view = buildRevisedDocument({
        analysis: analysis("一文目。二文目。三文目。", "一文目。二文目。三文目。"),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs).toHaveLength(1);
      expect(paragraphText(view.paragraphs[0])).toBe("一文目。二文目。三文目。");
    });

    it("keeps each paragraph's text intact", () => {
      const view = buildRevisedDocument({
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs.map(paragraphText)).toEqual([
        "最初の段落の一文目。二文目もここにある。",
        "二つ目の段落。",
        "三つ目の段落の一文目。二文目。三文目。",
      ]);
    });

    it("ignores blank lines beyond the paragraph breaks themselves", () => {
      const view = buildRevisedDocument({
        analysis: analysis("一つ目。\n\n\n二つ目。", "一つ目。\n\n\n二つ目。"),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs).toHaveLength(2);
    });

    it("returns no paragraphs for empty input", () => {
      const view = buildRevisedDocument({
        analysis: analysis("", ""),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs).toEqual([]);
    });
  });

  describe("revised wording", () => {
    it("places each revised sentence in the paragraph its original came from", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。重さは500g。";
      const revised = "価格は12万円。\n\n発売日は4月1日。重さは500g。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs.map(paragraphText)).toEqual([
        "価格は12万円。",
        "発売日は4月1日。重さは500g。",
      ]);
    });

    it("falls back to the original sentence when the revision runs short", () => {
      const original = "一文目。二文目。三文目。";
      const revised = "一文目を直した。二文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised),
        adoption: { ...ACCEPTED },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("一文目を直した。二文目。三文目。");
    });

    it("uses the original text when the pipeline returned no revision", () => {
      const original = "一文目。二文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, ""),
        adoption: { ...ACCEPTED },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("一文目。二文目。");
    });
  });

  describe("clipboard body", () => {
    it("reproduces the original paragraph breaks", () => {
      const view = buildRevisedDocument({
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe(THREE_PARAGRAPHS_REVISED);
    });

    it("does not insert a line break after every sentence", () => {
      const original = "一文目。二文目。三文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe("一文目。二文目。三文目。");
      expect(view.clipboardText).not.toContain("\n");
    });

    it("carries the revised wording, not the original", () => {
      const original = "価格は10万円。";
      const revised = "価格は12万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe("価格は12万円。");
    });

    it("carries no marks or annotations", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe("価格は12万円。");
    });
  });

  describe("character counts", () => {
    it("counts the original and the revision on the same basis", () => {
      const original = "　一文目。二文目。\n\n　三文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.originalText).toBe(original);
      expect(view.clipboardText.length).toBe(view.originalText.length);
    });

    it("reports the original assembled the same way as the revision", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";
      const revised = "価格は12万円。\n\n発売日は4月1日。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised),
        adoption: { ...ACCEPTED },
      });

      expect(view.originalText).toBe(original);
      expect(view.clipboardText).toBe(revised);
    });

    it("counts the paragraph breaks in both, not just in one", () => {
      const original = "一文目。\n二文目。\n\n三文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      // Three breaks' worth of characters are part of both documents.
      expect(view.originalText).toContain("\n\n");
      expect(view.clipboardText).toContain("\n\n");
    });
  });

  describe("comparison pairs", () => {
    it("pairs each original sentence with its revision", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";
      const revised = "価格は12万円。\n\n発売日は4月1日。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised),
        adoption: { ...ACCEPTED },
      });

      expect(view.comparison).toEqual([
        { original: "価格は10万円。", revised: "価格は12万円。" },
        { original: "発売日は3月1日。", revised: "発売日は4月1日。" },
      ]);
    });
  });

  describe("adoption", () => {
    it("keeps the corrected wording when nothing was rejected", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("価格は12万円。");
      expect(view.clipboardText).toBe("価格は12万円。");
    });

    it("restores the original wording for a rejected fact correction", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { ...ACCEPTED, "fact-0": false },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("価格は10万円。");
      expect(view.clipboardText).toBe("価格は10万円。");
    });

    it("restores the original wording for a rejected style repair", () => {
      const original = "まとめると、こうなる。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、こうなる。")]),
        adoption: { ...ACCEPTED, "style-0": false },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("まとめると、こうなる。");
    });

    it("leaves other sentences corrected when one is rejected", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";
      const revised = "価格は12万円。\n\n発売日は4月1日。";

      const view = buildRevisedDocument({
        analysis: analysis(original, revised, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
          claim("発売日は3月1日。", "CONTRADICTED", "発売日は4月1日。"),
        ]),
        adoption: { ...ACCEPTED, "fact-0": false },
      });

      expect(view.clipboardText).toBe("価格は10万円。\n\n発売日は4月1日。");
    });

    it("reflects a rejection in the comparison pairs too", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { ...ACCEPTED, "fact-0": false },
      });

      expect(view.comparison).toEqual([
        { original: "価格は10万円。", revised: "価格は10万円。" },
      ]);
    });
  });

  describe("the writer's spacing", () => {
    it("keeps a paragraph's leading indentation when nothing changed", () => {
      const original = "　一文目。二文目。\n\n　三文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe(original);
    });

    it("keeps the spaces between sentences", () => {
      const original = "一文目。 二文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe(original);
    });

    it("round-trips an unchanged document character for character", () => {
      const original = "　まえがき。\n本文の一文目。 本文の二文目。\n\n　むすび。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.clipboardText).toBe(original);
    });
  });

  describe("paragraph separators", () => {
    it("reports the breaks that followed each paragraph", () => {
      const original = "一つ目。\n二つ目。\n\n三つ目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      expect(view.paragraphs.map((p) => p.separator)).toEqual(["\n", "\n\n", ""]);
    });

    it("assembles the clipboard body from the paragraphs and their separators", () => {
      const original = "一つ目。\n二つ目。\n\n三つ目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original),
        adoption: { ...ACCEPTED },
      });

      const assembled = view.paragraphs
        .map((p) => p.segments.map((s) => s.text).join("") + p.separator)
        .join("");
      expect(assembled).toBe(view.clipboardText);
    });
  });

  describe("findings", () => {
    it("returns one Finding per claim and per raised style issue", () => {
      const original = "価格は10万円。まとめると、こうなる。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [claim("価格は10万円。", "CONTRADICTED", "価格は12万円。")], [
          styleIssue("まとめると、こうなる。"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.findings.map((f) => f.id)).toEqual(["fact-0", "style-0"]);
    });

    it("places each Finding on the sentence it sits in", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [
          claim("発売日は3月1日。", "CONTRADICTED", "発売日は4月1日。"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.findings[0].lineIndex).toBe(1);
    });

    it("places a Finding on its sentence even when the writer indented it", () => {
      const original = "　価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.findings[0].lineIndex).toBe(0);
    });

    it("marks a Finding as adopted unless it was rejected", () => {
      const original = "価格は10万円。";
      const claims = [claim("価格は10万円。", "CONTRADICTED", "価格は12万円。")];

      const adopted = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", claims),
        adoption: { ...ACCEPTED },
      });
      const rejectedView = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", claims),
        adoption: { ...ACCEPTED, "fact-0": false },
      });

      expect(adopted.findings[0].adopted).toBe(true);
      expect(rejectedView.findings[0].adopted).toBe(false);
    });

    it("reports confidence as a percentage whichever scale it arrived on", () => {
      const original = "価格は10万円。";
      const ratio = { ...claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"), confidence: 0.82 };
      const scaled = { ...claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"), confidence: 82 };

      const fromRatio = buildRevisedDocument({
        analysis: analysis(original, original, [ratio]),
        adoption: { ...ACCEPTED },
      });
      const fromScaled = buildRevisedDocument({
        analysis: analysis(original, original, [scaled]),
        adoption: { ...ACCEPTED },
      });

      expect(fromRatio.findings[0].confidence).toBe(82);
      expect(fromScaled.findings[0].confidence).toBe(82);
    });

    it("carries no timestamp", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.findings[0]).not.toHaveProperty("timeAgo");
    });
  });

  describe("whether anything was found", () => {
    it("reports nothing found when there are no claims and no style issues", () => {
      const view = buildRevisedDocument({
        analysis: analysis("一文目。", "一文目。"),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(false);
    });

    it("reports nothing found when every claim is supported and no style issue was raised", () => {
      const original = "一文目。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [claim("一文目", "SUPPORTED")]),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(false);
    });

    it("reports something found for a contradicted claim", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        ]),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(true);
    });

    it("reports something found for an unverified claim", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [claim("価格は10万円", "INSUFFICIENT")]),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(true);
    });

    it("reports something found for a detected style issue", () => {
      const original = "まとめると、まとめると、こうなる。";

      const view = buildRevisedDocument({
        analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、まとめると、")]),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(true);
    });

    it("ignores style issues the detector did not raise", () => {
      const original = "一文目。";
      const undetected: StyleIssue = { ...styleIssue("一文目"), detected: false };

      const view = buildRevisedDocument({
        analysis: analysis(original, original, [], [undetected]),
        adoption: { ...ACCEPTED },
      });

      expect(view.hasFindings).toBe(false);
    });
  });
});

function paragraphText(paragraph: { segments: { text: string }[] }): string {
  return paragraph.segments.map((s) => s.text).join("");
}

describe("inline marks", () => {
  function marks(view: { paragraphs: { segments: { text: string; mark?: { findingIds: string[]; kind: string } }[] }[] }) {
    return view.paragraphs
      .flatMap((p) => p.segments)
      .filter((s) => s.mark)
      .map((s) => ({ text: s.text, kind: s.mark!.kind, findingId: s.mark!.findingIds[0] }));
  }

  it("marks the corrected span of a fact, not the whole sentence", () => {
    const original = "アップルは2023年9月13日、iPhone 15 Proを発表した。";
    const revised = "アップルは2023年9月12日、iPhone 15 Proを発表した。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("アップルは2023年9月13日", "CONTRADICTED", "アップルは2023年9月12日"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(marks(view)).toEqual([
      { text: "12", kind: "fact", findingId: "fact-0" },
    ]);
  });

  it("marks a repaired AI-tell across its whole sentence", () => {
    const original = "まとめると、まとめると、こうなる。";
    const revised = "こうなる。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [], [styleIssue("まとめると、まとめると、こうなる。")]),
      adoption: { ...ACCEPTED },
    });

    expect(marks(view)).toEqual([
      { text: "こうなる。", kind: "style", findingId: "style-0" },
    ]);
  });

  it("marks an unverified claim across its sentence and leaves the wording alone", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "INSUFFICIENT")]),
      adoption: { ...ACCEPTED },
    });

    expect(marks(view)).toEqual([
      { text: "価格は10万円である。", kind: "unverified", findingId: "fact-0" },
    ]);
  });

  it("leaves a supported claim unmarked", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "SUPPORTED")]),
      adoption: { ...ACCEPTED },
    });

    expect(marks(view)).toEqual([]);
  });

  it("falls back to the sentence when the corrected span cannot be located", () => {
    const original = "価格は10万円である。";
    const revised = "価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("価格は10万円である。", "CONTRADICTED", "まったく別の文言"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(marks(view)).toEqual([
      { text: "価格は12万円である。", kind: "fact", findingId: "fact-0" },
    ]);
  });

  it("loses no text to the marks", () => {
    const original = "アップルは2023年9月13日、iPhone 15 Proを発表した。";
    const revised = "アップルは2023年9月12日、iPhone 15 Proを発表した。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("アップルは2023年9月13日", "CONTRADICTED", "アップルは2023年9月12日"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(paragraphText(view.paragraphs[0])).toBe(revised);
  });

  it("keeps marks out of the clipboard body", () => {
    const original = "アップルは2023年9月13日、iPhone 15 Proを発表した。";
    const revised = "アップルは2023年9月12日、iPhone 15 Proを発表した。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("アップルは2023年9月13日", "CONTRADICTED", "アップルは2023年9月12日"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.clipboardText).toBe(revised);
  });

  it("reaches both Findings when a fact and an AI-tell share a sentence", () => {
    const original = "まとめると、価格は10万円である。";
    const revised = "まとめると、価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(
        original,
        revised,
        [claim("価格は10万円である", "CONTRADICTED", "価格は12万円である")],
        [styleIssue("まとめると、価格は10万円である。")]
      ),
      adoption: { ...ACCEPTED },
    });

    const found = marks(view);
    expect([...new Set(found.map((m) => m.findingId))].sort()).toEqual(["fact-0", "style-0"]);
    expect(paragraphText(view.paragraphs[0])).toBe(revised);
  });
});

describe("a Finding that cannot be placed", () => {
  it("reports no sentence rather than guessing at one", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [
        claim("この文章に存在しない主張", "CONTRADICTED", "訂正後の文言"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].lineIndex).toBe(-1);
  });

  it("marks nothing at all", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [
        claim("この文章に存在しない主張", "CONTRADICTED", "訂正後の文言"),
      ]),
      adoption: { ...ACCEPTED },
    });

    const marked = view.paragraphs.flatMap((p) => p.segments).filter((s) => s.mark);
    expect(marked).toEqual([]);
  });

  it("does not revert another sentence when it is rejected", () => {
    const original = "価格は10万円である。";
    const revised = "価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("この文章に存在しない主張", "CONTRADICTED", "訂正後の文言"),
      ]),
      adoption: { ...ACCEPTED, "fact-0": false },
    });

    expect(view.clipboardText).toBe(revised);
  });

  it("does not mark the first sentence for an unplaceable style issue", () => {
    const original = "一文目。二文目。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [], [styleIssue("どこにも無い言い回し")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].lineIndex).toBe(-1);
    expect(view.paragraphs.flatMap((p) => p.segments).filter((s) => s.mark)).toEqual([]);
  });
});

describe("locating the changed wording", () => {
  function marked(view: { paragraphs: { segments: { text: string; mark?: { findingIds: string[]; kind: string } }[] }[] }) {
    return view.paragraphs
      .flatMap((p) => p.segments)
      .filter((s) => s.mark)
      .map((s) => ({ text: s.text, ids: s.mark!.findingIds, kind: s.mark!.kind }));
  }

  it("marks the figure that changed, not the claim around it", () => {
    const original = "本体価格は49980円です。";
    const revised = "本体価格は69980円です。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("本体価格は49980円", "CONTRADICTED", "本体価格は69980円"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(marked(view).map((m) => m.text)).toEqual(["69980"]);
  });

  it("marks the right occurrence when the figure appears twice", () => {
    const original = "12月の売上は12億円でした。";
    const revised = "12月の売上は15億円でした。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("12月の売上は12億円", "CONTRADICTED", "12月の売上は15億円"),
      ]),
      adoption: { ...ACCEPTED },
    });

    const found = marked(view);
    expect(found.map((m) => m.text)).toEqual(["15"]);
    expect(paragraphText(view.paragraphs[0])).toBe(revised);
  });

  it("keeps both corrections reachable when one sentence carries two", () => {
    const original = "価格は10万円で、重さは500gです。";
    const revised = "価格は12万円で、重さは600gです。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        claim("重さは500g", "CONTRADICTED", "重さは600g"),
      ]),
      adoption: { ...ACCEPTED },
    });

    const ids = marked(view).flatMap((m) => m.ids);
    expect(ids.sort()).toEqual(["fact-0", "fact-1"]);
    expect(paragraphText(view.paragraphs[0])).toBe(revised);
  });

  it("keeps both reachable when neither can be located", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [
        claim("価格は10万円である。", "CONTRADICTED", "まったく別の文言"),
        claim("価格は10万円である。", "CONTRADICTED", "これも別の文言"),
      ]),
      adoption: { ...ACCEPTED },
    });

    const found = marked(view);
    expect(found).toHaveLength(1);
    expect(found[0].ids.sort()).toEqual(["fact-0", "fact-1"]);
  });

  it("treats a MIXED claim as needing a person, not as confirmed", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "MIXED")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].kind).toBe("unverified");
    expect(view.findings[0].categoryLabel).toBe("裏付けなし");
    expect(marked(view).map((m) => m.kind)).toEqual(["unverified"]);
    expect(view.hasFindings).toBe(true);
  });

  it("names the document after its opening sentence", () => {
    const original = "PlayStation 5 Proは家庭用ゲーム機です。次の文。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original),
      adoption: { ...ACCEPTED },
    });

    expect(view.title).toBe("PlayStation 5 Proは家庭用ゲーム機です。");
  });
});

describe("Finding headings", () => {
  it("names the kind and the words that changed", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "価格は12万円である。", [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toBe("資料と食い違い: 10");
  });

  it("names the kind and the claim for an unverified one", () => {
    const original = "価格は10万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "INSUFFICIENT")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toBe("裏付けが見つかりません: 価格は10万円である。");
  });

  it("is meaningful for an article the sample keywords never covered", () => {
    const original = "売上は前年比120%だった。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "売上は前年比140%だった。", [
        claim("売上は前年比120%", "CONTRADICTED", "売上は前年比140%"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toBe("資料と食い違い: 120");
  });

  it("names the rule and its target for an AI-tell", () => {
    const original = "まとめると、こうなる。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、こうなる。")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toBe("無意味な反復: まとめると、こうなる。");
  });
});

describe("Evidence and heading edges", () => {
  it("claims no Evidence for an AI-tell, because none was supplied", () => {
    const original = "まとめると、こうなる。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、こうなる。")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].sourceTitle).toBe("");
    expect(view.findings[0].sourceUrl).toBe("");
  });

  it("names the wording that was wrong, not the wording that replaced it", () => {
    const original = "メインカメラは20MPである。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "メインカメラは48MPである。", [
        claim("メインカメラは20MP", "CONTRADICTED", "メインカメラは48MP"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toBe("資料と食い違い: 20MP");
  });

  it("says a long target was cut rather than ending mid-word", () => {
    const long = "売上は前年比120%で、これは全社の見通しを大きく上回る結果でした。";

    const view = buildRevisedDocument({
      analysis: analysis(long, long, [claim(long, "INSUFFICIENT")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].title).toContain("…");
    expect(view.findings[0].title).not.toContain(long);
  });
});

describe("a refused correction", () => {
  function marked(view: { paragraphs: { segments: { text: string; mark?: { findingIds: string[]; kind: string; rejected: boolean } }[] }[] }) {
    return view.paragraphs
      .flatMap((p) => p.segments)
      .filter((s) => s.mark)
      .map((s) => ({ text: s.text, kind: s.mark!.kind, rejected: s.mark!.rejected }));
  }

  const original = "価格は10万円である。";
  const revised = "価格は12万円である。";
  const claims = [claim("価格は10万円", "CONTRADICTED", "価格は12万円")];

  it("keeps its mark, on the reader's own wording", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED, "fact-0": false },
    });

    expect(marked(view)).toEqual([{ text: "10", kind: "fact", rejected: true }]);
  });

  it("is told apart from one that was accepted", () => {
    const accepted = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED },
    });

    expect(marked(accepted)).toEqual([{ text: "12", kind: "fact", rejected: false }]);
  });

  it("goes back to the correction when it is accepted again", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED, "fact-0": true },
    });

    expect(marked(view)).toEqual([{ text: "12", kind: "fact", rejected: false }]);
    expect(view.clipboardText).toBe(revised);
  });

  it("is not something an unverified claim can be", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "INSUFFICIENT")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].adoptable).toBe(false);
  });

  it("is something a correction can be", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].adoptable).toBe(true);
  });

  it("is not something a confirmed claim can be", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円である。", "SUPPORTED")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].adoptable).toBe(false);
  });
});

describe("refusing one correction among several", () => {
  const original = "価格は10万円で、重さは500gである。";
  const revised = "価格は12万円で、重さは600gである。";
  const claims = [
    claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
    claim("重さは500g", "CONTRADICTED", "重さは600g"),
  ];

  it("puts back only the words that correction replaced", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED, "fact-0": false },
    });

    expect(view.clipboardText).toBe("価格は10万円で、重さは600gである。");
  });

  it("leaves the correction accepted alongside it in place", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED, "fact-1": false },
    });

    expect(view.clipboardText).toBe("価格は12万円で、重さは500gである。");
  });

  it("restores the sentence when both are refused", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, claims),
      adoption: { ...ACCEPTED, "fact-0": false, "fact-1": false },
    });

    expect(view.clipboardText).toBe(original);
  });

  it("restores the whole sentence when the AI-tell repair is refused", () => {
    const before = "まとめると、価格は10万円である。";
    const after = "価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(before, after, [claim("価格は10万円", "CONTRADICTED", "価格は12万円")], [
        styleIssue("まとめると、価格は10万円である。"),
      ]),
      adoption: { ...ACCEPTED, "style-0": false },
    });

    expect(view.clipboardText).toBe(before);
  });

  it("offers nothing to adopt on a claim it could not place", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("この文章に存在しない主張", "CONTRADICTED", "訂正後の文言"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].adoptable).toBe(false);
  });

  it("offers nothing to adopt when the correction reads the same as the original", () => {
    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("価格は10万円", "CONTRADICTED")]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].adoptable).toBe(false);
  });

  it("shows an AI-tell's own rewrite rather than a stock phrase", () => {
    const before = "まとめると、まとめると、こうなる。";
    const after = "こうなる。";

    const view = buildRevisedDocument({
      analysis: analysis(before, after, [], [styleIssue(before)]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].originalText).toBe(before);
    expect(view.findings[0].revisedText).toBe(after);
  });
});

describe("what the panel shows beside the document", () => {
  it("shows the reader's own sentence, not the claim's paraphrase", () => {
    const original = "これによってゲームのレンダリング速度は最大約50%向上するとされています。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [
        {
          claim: {
            id: "c1",
            originalText: original,
            // the pipeline synthesises this; it is not a quote from the article
            normalizedText: "レンダリング速度は最大約50%向上",
            importance: "normal",
            factCheckRequired: true,
          },
          verdict: "INSUFFICIENT",
          reason: "裏付けが見つかりませんでした。",
          evidence: [],
        },
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].sentenceBefore).toBe(original);
    expect(view.findings[0].sentenceAfter).toBe(original);
  });

  it("shows the sentence as the document now reads it", () => {
    const original = "価格は10万円である。";
    const revised = "価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
      ]),
      adoption: { ...ACCEPTED },
    });

    expect(view.findings[0].sentenceBefore).toBe(original);
    expect(view.findings[0].sentenceAfter).toBe(revised);
  });

  it("follows a refusal, so the panel never contradicts the document", () => {
    const original = "価格は10万円である。";
    const revised = "価格は12万円である。";

    const view = buildRevisedDocument({
      analysis: analysis(original, revised, [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
      ]),
      adoption: { ...ACCEPTED, "fact-0": false },
    });

    expect(view.findings[0].sentenceAfter).toBe(original);
    expect(view.clipboardText).toBe(original);
  });
});

describe("where a Finding's evidence went", () => {
  it("carries the trail onto the Finding, so an unverified one can be traced", () => {
    const withTrace = analysis("価格は799ドルです。", "価格は799ドルです。", [
      {
        ...claim("価格は799ドルです。", "INSUFFICIENT"),
        evidenceTrace: {
          query: "価格 799ドル",
          found: 3,
          offSubject: 2,
          unreadable: 1,
          saidNothing: 0,
          weak: 0,
          used: 0,
        },
      },
    ]);

    const view = buildRevisedDocument({ analysis: withTrace, adoption: { ...ACCEPTED } });

    expect(view.findings[0].evidenceTrace).toEqual({
      query: "価格 799ドル",
      found: 3,
      offSubject: 2,
      unreadable: 1,
      saidNothing: 0,
      weak: 0,
      used: 0,
    });
  });
});

describe("JEVの数値を画面まで運ぶ", () => {
  it("確信度の帯と、記事内の整合性の数値を Finding に残す", () => {
    const result = claim("9月には142人に到達した", "CONTRADICTED");
    result.confidence = 0.86;
    result.band = "act";
    result.consistency = { probabilityTrue: 0.11, confidence: 0.89 };
    result.evidence = [
      {
        id: "ev-1",
        claimId: result.claim.id,
        sourceUrl: "https://example.com/a",
        sourceTitle: "公式のお知らせ",
        excerpt: "……",
        sourceType: "official",
        relation: "contradicts",
        confidence: 0.86,
      },
    ];

    const doc = buildRevisedDocument({
      analysis: analysis("9月には142人に到達した。", "9月には142人に到達した。", [result]),
      adoption: { ...ACCEPTED },
    });
    const finding = doc.findings.find((item) => item.type === "fact");

    expect(finding?.confidence).toBe(86);
    expect(finding?.band).toBe("act");
    expect(finding?.bandLabel).toBe(BAND_LABEL.act);
    expect(finding?.consistency).toEqual({ probabilityTrue: 0.11, confidence: 0.89 });
    expect(finding?.evidence?.[0]).toMatchObject({
      relation: "contradicts",
      confidence: 0.86,
    });
  });
});

describe("数字を作らない", () => {
  it("JEVが数値を返さなかった判定は「数値なし」として運ぶ", () => {
    const result = claim("裏付けの見つからなかった文。", "INSUFFICIENT");
    result.confidence = undefined;

    const doc = buildRevisedDocument({
      analysis: analysis("裏付けの見つからなかった文。", "裏付けの見つからなかった文。", [result]),
      adoption: { ...ACCEPTED },
    });
    const finding = doc.findings.find((item) => item.type === "fact");

    expect(finding?.confidence).toBeNull();
    expect(finding?.band).toBeUndefined();
    expect(finding?.bandLabel).toBeUndefined();
  });
});

describe("弱い順に並べる", () => {
  it("数値の無いものを先頭に、その後は辻褄の低い順に並べる", () => {
    const weak = claim("辻褄13%の文。", "INSUFFICIENT");
    weak.confidence = 0.87;
    weak.consistency = { probabilityTrue: 0.13, confidence: 0.87 };

    const strong = claim("辻褄95%の文。", "SUPPORTED");
    strong.confidence = 1;
    strong.consistency = { probabilityTrue: 0.95, confidence: 0.95 };

    const noNumber = claim("数値の無い文。", "INSUFFICIENT");
    noNumber.confidence = undefined;

    const doc = buildRevisedDocument({
      analysis: analysis(
        "辻褄13%の文。辻褄95%の文。数値の無い文。",
        "辻褄13%の文。辻褄95%の文。数値の無い文。",
        [strong, weak, noNumber]
      ),
      adoption: { ...ACCEPTED },
    });

    const order = sortByAttention(doc.findings.filter((f) => f.type === "fact")).map(
      (f) => f.originalText
    );

    expect(order[0]).toContain("数値の無い文");
    expect(order[1]).toContain("辻褄13%");
    expect(order[2]).toContain("辻褄95%");
  });
});

describe("断定しない", () => {
  it("資料が違うことを書いていても、勝手に書き換えない", () => {
    const original = "価格は10万円。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "価格は12万円。", [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
      ]),
      adoption: {},
    });

    // The reader's own words stand until they accept the suggestion.
    expect(view.clipboardText).toBe("価格は10万円。");
    expect(view.findings[0].adopted).toBe(false);
    expect(view.findings[0].adoptable).toBe(true);
  });

  it("札は「誤り」ではなく、資料との関係を述べる", () => {
    const view = buildRevisedDocument({
      analysis: analysis("価格は10万円。", "価格は10万円。", [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        claim("重さは500g", "SUPPORTED"),
        claim("発売日は3月1日", "INSUFFICIENT"),
      ]),
      adoption: {},
    });

    const labels = view.findings.filter((f) => f.type === "fact").map((f) => f.categoryLabel);

    expect(labels).toContain("資料と食い違い");
    expect(labels).toContain("資料と一致");
    expect(labels).toContain("裏付けなし");
    expect(labels.join()).not.toContain("誤り");
  });
});

describe("言い換えられた主張の置き場所", () => {
  it("引用ではなく言い換えでも、その文に結びつける", () => {
    const original = "名古屋駅から徒歩8分、国際センター駅から徒歩3分。名古屋市西区那古野に拠点を構える。";
    const result = claim("フリノバの拠点は名古屋駅から徒歩8分、国際センター駅から徒歩3分である。", "INSUFFICIENT");

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [result]),
      adoption: {},
    });

    expect(view.findings[0].lineIndex).toBe(0);
    expect(view.paragraphs.flatMap((p) => p.segments).some((s) => s.mark)).toBe(true);
  });

  it("言葉をほとんど共有しない主張は、どこにも貼り付けない", () => {
    const original = "名古屋駅から徒歩8分。";
    const result = claim("まったく別の話題についての記述である。", "INSUFFICIENT");

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [result]),
      adoption: {},
    });

    expect(view.findings[0].lineIndex).toBe(-1);
  });
});

describe("印の見た目", () => {
  it("裏付けが無い文は、断られた修正案としては描かない", () => {
    const original = "名古屋駅から徒歩8分。";

    const view = buildRevisedDocument({
      analysis: analysis(original, original, [claim("名古屋駅から徒歩8分", "INSUFFICIENT")]),
      adoption: {},
    });

    const marks = view.paragraphs.flatMap((p) => p.segments).filter((s) => s.mark);
    expect(marks).not.toHaveLength(0);
    expect(marks.every((s) => s.mark!.rejected)).toBe(false);
  });

  it("断られた修正案は、断られたものとして描く", () => {
    const original = "価格は10万円。";

    const view = buildRevisedDocument({
      analysis: analysis(original, "価格は12万円。", [
        claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
      ]),
      adoption: {},
    });

    const marks = view.paragraphs.flatMap((p) => p.segments).filter((s) => s.mark);
    expect(marks.some((s) => s.mark!.rejected)).toBe(true);
  });
});

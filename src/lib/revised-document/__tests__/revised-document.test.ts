import { describe, it, expect } from "vitest";
import { buildRevisedDocument } from "@/lib/revised-document";
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

describe("buildRevisedDocument", () => {
  describe("paragraph structure", () => {
    it("returns one paragraph per paragraph in the original", () => {
      const view = buildRevisedDocument({
        originalText: THREE_PARAGRAPHS,
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: {},
      });

      expect(view.paragraphs).toHaveLength(3);
    });

    it("does not split a paragraph into one entry per sentence", () => {
      const view = buildRevisedDocument({
        originalText: "一文目。二文目。三文目。",
        analysis: analysis("一文目。二文目。三文目。", "一文目。二文目。三文目。"),
        adoption: {},
      });

      expect(view.paragraphs).toHaveLength(1);
      expect(paragraphText(view.paragraphs[0])).toBe("一文目。二文目。三文目。");
    });

    it("keeps each paragraph's text intact", () => {
      const view = buildRevisedDocument({
        originalText: THREE_PARAGRAPHS,
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: {},
      });

      expect(view.paragraphs.map(paragraphText)).toEqual([
        "最初の段落の一文目。二文目もここにある。",
        "二つ目の段落。",
        "三つ目の段落の一文目。二文目。三文目。",
      ]);
    });

    it("ignores blank lines beyond the paragraph breaks themselves", () => {
      const view = buildRevisedDocument({
        originalText: "一つ目。\n\n\n二つ目。",
        analysis: analysis("一つ目。\n\n\n二つ目。", "一つ目。\n\n\n二つ目。"),
        adoption: {},
      });

      expect(view.paragraphs).toHaveLength(2);
    });

    it("returns no paragraphs for empty input", () => {
      const view = buildRevisedDocument({
        originalText: "",
        analysis: analysis("", ""),
        adoption: {},
      });

      expect(view.paragraphs).toEqual([]);
    });
  });

  describe("revised wording", () => {
    it("places each revised sentence in the paragraph its original came from", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。重さは500g。";
      const revised = "価格は12万円。\n\n発売日は4月1日。重さは500g。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, revised),
        adoption: {},
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
        originalText: original,
        analysis: analysis(original, revised),
        adoption: {},
      });

      expect(paragraphText(view.paragraphs[0])).toBe("一文目を直した。二文目。三文目。");
    });

    it("uses the original text when the pipeline returned no revision", () => {
      const original = "一文目。二文目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, ""),
        adoption: {},
      });

      expect(paragraphText(view.paragraphs[0])).toBe("一文目。二文目。");
    });
  });

  describe("clipboard body", () => {
    it("reproduces the original paragraph breaks", () => {
      const view = buildRevisedDocument({
        originalText: THREE_PARAGRAPHS,
        analysis: analysis(THREE_PARAGRAPHS, THREE_PARAGRAPHS_REVISED),
        adoption: {},
      });

      expect(view.clipboardText).toBe(THREE_PARAGRAPHS_REVISED);
    });

    it("does not insert a line break after every sentence", () => {
      const original = "一文目。二文目。三文目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
      });

      expect(view.clipboardText).toBe("一文目。二文目。三文目。");
      expect(view.clipboardText).not.toContain("\n");
    });

    it("carries the revised wording, not the original", () => {
      const original = "価格は10万円。";
      const revised = "価格は12万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, revised),
        adoption: {},
      });

      expect(view.clipboardText).toBe("価格は12万円。");
    });

    it("carries no marks or annotations", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        ]),
        adoption: {},
      });

      expect(view.clipboardText).toBe("価格は12万円。");
    });
  });

  describe("comparison pairs", () => {
    it("pairs each original sentence with its revision", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";
      const revised = "価格は12万円。\n\n発売日は4月1日。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, revised),
        adoption: {},
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
        originalText: original,
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: {},
      });

      expect(paragraphText(view.paragraphs[0])).toBe("価格は12万円。");
      expect(view.clipboardText).toBe("価格は12万円。");
    });

    it("restores the original wording for a rejected fact correction", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { "fact-0": false },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("価格は10万円。");
      expect(view.clipboardText).toBe("価格は10万円。");
    });

    it("restores the original wording for a rejected style repair", () => {
      const original = "まとめると、こうなる。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、こうなる。")]),
        adoption: { "style-0": false },
      });

      expect(paragraphText(view.paragraphs[0])).toBe("まとめると、こうなる。");
    });

    it("leaves other sentences corrected when one is rejected", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";
      const revised = "価格は12万円。\n\n発売日は4月1日。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, revised, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
          claim("発売日は3月1日。", "CONTRADICTED", "発売日は4月1日。"),
        ]),
        adoption: { "fact-0": false },
      });

      expect(view.clipboardText).toBe("価格は10万円。\n\n発売日は4月1日。");
    });

    it("reflects a rejection in the comparison pairs too", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: { "fact-0": false },
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
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
      });

      expect(view.clipboardText).toBe(original);
    });

    it("keeps the spaces between sentences", () => {
      const original = "一文目。 二文目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
      });

      expect(view.clipboardText).toBe(original);
    });

    it("round-trips an unchanged document character for character", () => {
      const original = "　まえがき。\n本文の一文目。 本文の二文目。\n\n　むすび。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
      });

      expect(view.clipboardText).toBe(original);
    });
  });

  describe("paragraph separators", () => {
    it("reports the breaks that followed each paragraph", () => {
      const original = "一つ目。\n二つ目。\n\n三つ目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
      });

      expect(view.paragraphs.map((p) => p.separator)).toEqual(["\n", "\n\n", ""]);
    });

    it("assembles the clipboard body from the paragraphs and their separators", () => {
      const original = "一つ目。\n二つ目。\n\n三つ目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original),
        adoption: {},
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
        originalText: original,
        analysis: analysis(original, original, [claim("価格は10万円。", "CONTRADICTED", "価格は12万円。")], [
          styleIssue("まとめると、こうなる。"),
        ]),
        adoption: {},
      });

      expect(view.findings.map((f) => f.id)).toEqual(["fact-0", "style-0"]);
    });

    it("places each Finding on the sentence it sits in", () => {
      const original = "価格は10万円。\n\n発売日は3月1日。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [
          claim("発売日は3月1日。", "CONTRADICTED", "発売日は4月1日。"),
        ]),
        adoption: {},
      });

      expect(view.findings[0].lineIndex).toBe(1);
    });

    it("places a Finding on its sentence even when the writer indented it", () => {
      const original = "　価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: {},
      });

      expect(view.findings[0].lineIndex).toBe(0);
    });

    it("marks a Finding as adopted unless it was rejected", () => {
      const original = "価格は10万円。";
      const claims = [claim("価格は10万円。", "CONTRADICTED", "価格は12万円。")];

      const adopted = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", claims),
        adoption: {},
      });
      const rejectedView = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", claims),
        adoption: { "fact-0": false },
      });

      expect(adopted.findings[0].adopted).toBe(true);
      expect(rejectedView.findings[0].adopted).toBe(false);
    });

    it("reports confidence as a percentage whichever scale it arrived on", () => {
      const original = "価格は10万円。";
      const ratio = { ...claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"), confidence: 0.82 };
      const scaled = { ...claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"), confidence: 82 };

      const fromRatio = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [ratio]),
        adoption: {},
      });
      const fromScaled = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [scaled]),
        adoption: {},
      });

      expect(fromRatio.findings[0].confidence).toBe(82);
      expect(fromScaled.findings[0].confidence).toBe(82);
    });

    it("carries no timestamp", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [
          claim("価格は10万円。", "CONTRADICTED", "価格は12万円。"),
        ]),
        adoption: {},
      });

      expect(view.findings[0]).not.toHaveProperty("timeAgo");
    });
  });

  describe("whether anything was found", () => {
    it("reports nothing found when there are no claims and no style issues", () => {
      const view = buildRevisedDocument({
        originalText: "一文目。",
        analysis: analysis("一文目。", "一文目。"),
        adoption: {},
      });

      expect(view.hasFindings).toBe(false);
    });

    it("reports nothing found when every claim is supported and no style issue was raised", () => {
      const original = "一文目。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [claim("一文目", "SUPPORTED")]),
        adoption: {},
      });

      expect(view.hasFindings).toBe(false);
    });

    it("reports something found for a contradicted claim", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "価格は12万円。", [
          claim("価格は10万円", "CONTRADICTED", "価格は12万円"),
        ]),
        adoption: {},
      });

      expect(view.hasFindings).toBe(true);
    });

    it("reports something found for an unverified claim", () => {
      const original = "価格は10万円。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [claim("価格は10万円", "INSUFFICIENT")]),
        adoption: {},
      });

      expect(view.hasFindings).toBe(true);
    });

    it("reports something found for a detected style issue", () => {
      const original = "まとめると、まとめると、こうなる。";

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, "こうなる。", [], [styleIssue("まとめると、まとめると、")]),
        adoption: {},
      });

      expect(view.hasFindings).toBe(true);
    });

    it("ignores style issues the detector did not raise", () => {
      const original = "一文目。";
      const undetected: StyleIssue = { ...styleIssue("一文目"), detected: false };

      const view = buildRevisedDocument({
        originalText: original,
        analysis: analysis(original, original, [], [undetected]),
        adoption: {},
      });

      expect(view.hasFindings).toBe(false);
    });
  });
});

function paragraphText(paragraph: { segments: { text: string }[] }): string {
  return paragraph.segments.map((s) => s.text).join("");
}

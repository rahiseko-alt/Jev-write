import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { splitIntoBlocks } from "@/lib/text/blocks";
import { mergeAnalyses } from "@/lib/pipeline/merge-results";
import { buildRevisedDocument } from "@/lib/revised-document";
import type { AnalysisResult } from "@/types";

/**
 * The article as the reader pasted it must come back with the same
 * paragraphs, even though it was checked in blocks. The server trims each
 * block it receives, so the blank lines a cut fell on are not in any block's
 * result — they have to be put back when the blocks are assembled.
 */

const ARTICLE = readFileSync(
  join(__dirname, "../../../../docs/benchmark/article-01.txt"),
  "utf8"
);

/** What /api/analyze returns for one block: the text it was sent, trimmed. */
function serverResult(block: string): AnalysisResult {
  const text = block.trim();
  return {
    originalText: text,
    revisedText: text,
    summary: {
      claimsChecked: 0,
      supported: 0,
      contradicted: 0,
      mixed: 0,
      insufficient: 0,
      styleIssuesFixed: 0,
    },
    claims: [],
    styleIssues: [],
    sources: [],
    timings: [],
  };
}

function paragraphsOnScreen(input: string) {
  const blocks = splitIntoBlocks(input);
  const merged = mergeAnalyses(blocks.map(serverResult), blocks);
  return buildRevisedDocument({ analysis: merged, adoption: {} });
}

describe("paragraph structure across blocks (article-01)", () => {
  const input = ARTICLE.trim();

  it("is checked in more than one block, with cuts on blank lines", () => {
    const blocks = splitIntoBlocks(input);
    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.slice(0, -1).some((b) => b.endsWith("\n\n"))).toBe(true);
  });

  it("shows as many paragraphs as the original has, each starting where the original does", () => {
    const lines = input.split(/\n+/).filter((line) => line.trim().length > 0);
    const view = paragraphsOnScreen(input);

    expect(view.paragraphs).toHaveLength(lines.length);
    view.paragraphs.forEach((paragraph, i) => {
      const text = paragraph.segments.map((s) => s.text).join("");
      expect(text).toBe(lines[i]);
    });
  });

  it("keeps every heading in a paragraph of its own", () => {
    const view = paragraphsOnScreen(input);
    const heads = view.paragraphs.map((p) => p.segments.map((s) => s.text).join(""));

    for (const heading of [
      "■ はじめに",
      "■ SIPS：共感から始まるソーシャル時代のモデル",
      "■ ステマ規制の概要",
      "■ 実務で気をつけたいこと",
    ]) {
      expect(heads).toContain(heading);
    }
  });

  it("gives the text back character for character", () => {
    const view = paragraphsOnScreen(input);
    expect(view.clipboardText).toBe(input);
    expect(view.originalText).toBe(input);
  });
});

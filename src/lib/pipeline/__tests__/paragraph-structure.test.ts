import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { buildRevisedDocument } from "@/lib/revised-document";
import type { AnalysisResult } from "@/types";

/**
 * The article as the reader pasted it must come back with the same
 * paragraphs. The whole article is sent to /api/analyze in one run, and the
 * server trims what it is sent; the blank lines between paragraphs are inside
 * the text, so they survive and every heading keeps a paragraph of its own.
 */

const ARTICLE = readFileSync(
  join(__dirname, "../../../../docs/benchmark/article-01.txt"),
  "utf8"
);

/** What /api/analyze returns for the article: the text it was sent, trimmed. */
function serverResult(article: string): AnalysisResult {
  const text = article.trim();
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
  return buildRevisedDocument({ analysis: serverResult(input), adoption: {} });
}

describe("paragraph structure of a whole article checked in one run (article-01)", () => {
  const input = ARTICLE.trim();

  it("has blank lines between paragraphs to keep", () => {
    expect(input).toContain("\n\n");
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

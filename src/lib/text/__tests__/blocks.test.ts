import { describe, it, expect } from "vitest";
import { splitIntoBlocks } from "@/lib/text/blocks";

const PARAGRAPH = (n: number) =>
  `これは${n}番目の段落です。` + "この段落には十分な長さの文章が入っています。".repeat(6);

describe("splitIntoBlocks", () => {
  it("returns the text as one block when it already fits", () => {
    const text = "短い記事です。これで終わり。";

    expect(splitIntoBlocks(text)).toEqual([text]);
  });

  it("puts the blocks back together into exactly the original text", () => {
    const text = [1, 2, 3, 4, 5, 6, 7, 8].map(PARAGRAPH).join("\n\n");

    expect(splitIntoBlocks(text).join("")).toBe(text);
  });

  it("breaks between paragraphs where it can", () => {
    const text = [1, 2, 3, 4, 5, 6].map(PARAGRAPH).join("\n\n");

    const blocks = splitIntoBlocks(text);

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks[0].trimEnd().endsWith("。")).toBe(true);
  });

  it("never cuts a sentence in half while a sentence end is available", () => {
    const text = "あ。".repeat(600);

    for (const block of splitIntoBlocks(text)) {
      expect(block.endsWith("。")).toBe(true);
    }
  });

  it("still makes progress on a single sentence longer than a block", () => {
    const text = "あ".repeat(2000) + "。";

    const blocks = splitIntoBlocks(text);

    expect(blocks.length).toBeGreaterThan(1);
    expect(blocks.join("")).toBe(text);
    expect(Math.max(...blocks.map((b) => b.length))).toBeLessThanOrEqual(700);
  });

  it("keeps every block inside the size a run can finish", () => {
    const text = [1, 2, 3, 4, 5, 6, 7, 8].map(PARAGRAPH).join("\n\n");

    for (const block of splitIntoBlocks(text)) {
      expect(block.length).toBeLessThanOrEqual(700);
    }
  });

  it("returns nothing for an empty text", () => {
    expect(splitIntoBlocks("   ")).toEqual([]);
  });
});

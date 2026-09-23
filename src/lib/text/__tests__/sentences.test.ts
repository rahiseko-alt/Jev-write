import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { TITLE_MAX_CHARS, splitArticle } from "@/lib/text/sentences";

/**
 * ADR-0020: the sentences are cut by code, by a fixed rule, so the same
 * text is always cut the same way. The generation is handed them numbered.
 */

const ARTICLE = readFileSync(
  join(__dirname, "../../../../docs/benchmark/article-01.txt"),
  "utf8"
).trim();

const texts = (text: string) => splitArticle(text).sentences.map((s) => s.text);

describe("文の区切り（コードで決める）", () => {
  it("同じ入力なら、何度区切っても同じ文・同じ番号になる", () => {
    const first = splitArticle(ARTICLE);
    for (let i = 0; i < 5; i++) {
      expect(splitArticle(ARTICLE)).toEqual(first);
    }
  });

  it("。！？の後ろで区切り、番号は読む順に s1, s2, … と振る", () => {
    const { sentences } = splitArticle("一文目です。二文目ですか？三文目です！\n四文目です。");
    expect(sentences.map((s) => [s.id, s.text])).toEqual([
      ["s1", "一文目です。"],
      ["s2", "二文目ですか？"],
      ["s3", "三文目です！"],
      ["s4", "四文目です。"],
    ]);
  });

  it("続けて並んだ終わりの記号は1つの文の終わりにまとめる", () => {
    expect(texts("本当ですか！？そうです。")).toEqual(["本当ですか！？", "そうです。"]);
  });

  it("かっこの中の。では区切らない", () => {
    expect(texts("彼は「値上げはしない。来年も同じだ。」と述べた。次の文。")).toEqual([
      "彼は「値上げはしない。来年も同じだ。」と述べた。",
      "次の文。",
    ]);
    expect(texts("数値は暫定値である（2024年3月時点。速報値）。次の文。")).toEqual([
      "数値は暫定値である（2024年3月時点。速報値）。",
      "次の文。",
    ]);
  });

  it("閉じないかっこがある行は、かっこを数えずに。ごとに区切る", () => {
    expect(texts("「閉じない引用。二文目。三文目。")).toEqual(["「閉じない引用。", "二文目。", "三文目。"]);
  });

  it("終わりの記号の無い行末の文も1文として残す", () => {
    expect(texts("一文目。記号で終わらない二文目")).toEqual(["一文目。", "記号で終わらない二文目"]);
  });

  it("前後の空白（全角の字下げを含む）は文に含めず、空の文は作らない", () => {
    expect(texts("　字下げの文。 空白の後の文。  \n\n   \n最後の文。")).toEqual([
      "字下げの文。",
      "空白の後の文。",
      "最後の文。",
    ]);
  });

  it("見出し記号で始まり文の終わり方をしない行は見出しとして除く", () => {
    const { sentences, headings } = splitArticle(
      ["■ はじめに", "本文の一文。", "■「健康食品」という言葉に法律上の定義はない", "## まとめ", "【ポイント】", "本文の二文。"].join("\n")
    );
    expect(headings.map((h) => h.text)).toEqual([
      "■ はじめに",
      "■「健康食品」という言葉に法律上の定義はない",
      "## まとめ",
      "【ポイント】",
    ]);
    expect(sentences.map((s) => s.text)).toEqual(["本文の一文。", "本文の二文。"]);
  });

  it("見出し記号で始まっても、文の終わり方をする行は文として扱う", () => {
    const { sentences, headings } = splitArticle("本文。\n【注意】対象は18歳以上です。");
    expect(headings).toEqual([]);
    expect(sentences.map((s) => s.text)).toEqual(["本文。", "【注意】対象は18歳以上です。"]);
  });

  it("後ろに本文が続く最初の短い行は題名として除く。1行だけの文章や長い行は除かない", () => {
    expect(splitArticle("記事の題名\n\n本文です。").headings.map((h) => h.text)).toEqual(["記事の題名"]);
    expect(texts("句点の無い1行だけの文章")).toEqual(["句点の無い1行だけの文章"]);
    const long = "あ".repeat(TITLE_MAX_CHARS + 1);
    expect(splitArticle(`${long}\n本文です。`).headings).toEqual([]);
  });

  it("箇条書きの行（・など）は見出しにせず、文として判定に回す", () => {
    const { sentences, headings } = splitArticle("本文。\n・対象は18歳以上\n・期限は1年");
    expect(headings).toEqual([]);
    expect(sentences.map((s) => s.text)).toEqual(["本文。", "・対象は18歳以上", "・期限は1年"]);
  });

  it("記事01: 題名と■の見出し5行を除き、残りの行はすべて文に区切られる", () => {
    const { sentences, headings } = splitArticle(ARTICLE);
    expect(headings.map((h) => h.text)).toEqual([
      "口コミマーケティングの基礎：AISAS・SIPSとステマ規制を押さえる",
      "■ はじめに",
      "■ AISAS：検索と共有を組み込んだモデル",
      "■ SIPS：共感から始まるソーシャル時代のモデル",
      "■ ステマ規制の概要",
      "■ 実務で気をつけたいこと",
    ]);
    // Every sentence is in the text as written, and the headings and the
    // sentences, in reading order, hold every character of it but the spaces.
    for (const sentence of sentences) expect(ARTICLE).toContain(sentence.text);
    const inOrder = [...headings, ...sentences]
      .sort((a, b) => a.line - b.line)
      .map((unit) => unit.text)
      .join("");
    expect(inOrder.replace(/\s/g, "")).toBe(ARTICLE.replace(/\s/g, ""));
    expect(sentences.every((s) => s.text.endsWith("。"))).toBe(true);
    expect(sentences.map((s) => s.text)).toContain(
      "口コミの影響力が高まる一方で、広告であることを隠して第三者の自発的な感想のように見せかける「ステルスマーケティング（ステマ）」が問題視されてきました。"
    );
  });
});

import { describe, it, expect } from "vitest";
import {
  explainFailure,
  noticeForError,
  noticeForResponse,
} from "@/lib/failure-explanation";

const CREDIT =
  'Anthropic API error (400 Bad Request): {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API."}}';

describe("explainFailure", () => {
  it("tells the writer a low credit balance is the tool's setup, not their text", () => {
    const result = explainFailure(CREDIT);
    expect(result.kind).toBe("setup");
    expect(result.headline).toContain("文章を直す必要はありません");
    expect(result.headline).toContain("管理者に連絡");
    expect(result.service).toBe("文章の解析（Anthropic）");
    expect(result.details).toBe(CREDIT);
  });

  it.each([
    ["Anthropic API error (401 Unauthorized): invalid x-api-key", "setup"],
    ["Anthropic API key is missing. Set ANTHROPIC_API_KEY or CLAUDE_API_KEY in environment.", "setup"],
    ["JEVの鍵が設定されていません（JEV_API_KEY / TYPESAFE_API_KEY）。", "setup"],
    [
      'OpenAI API error (429 Too Many Requests): {"error":{"code":"insufficient_quota"}}',
      "setup",
    ],
    ["Tavily search API error (429 Too Many Requests): rate limit exceeded", "busy"],
    ['Anthropic API error (529 ): {"error":{"type":"overloaded_error"}}', "busy"],
    ["TypeSafe AI Jev request timed out after 30000ms", "busy"],
    ["FUNCTION_INVOCATION_TIMEOUT", "busy"],
    ["Failed to fetch", "busy"],
    [
      "Anthropic の応答が長さ上限（max_tokens=4096）で打ち切られました。文章を短くするか ANTHROPIC_MAX_TOKENS を上げてください。",
      "too-long",
    ],
    ["主張抽出の応答をJSONとして読み取れませんでした（Unexpected token）。", "unknown"],
  ])("classifies %s as %s", (details, kind) => {
    expect(explainFailure(details).kind).toBe(kind);
  });

  it("names the service that failed", () => {
    expect(explainFailure("Tavily search API error (503 Service Unavailable): ").service).toBe(
      "ウェブ検索（Tavily）"
    );
    expect(explainFailure("TypeSafe AI Jev request failed (500 ): x").service).toBe("判定（JEV）");
    expect(explainFailure("Google Fact Check API error (500 ): x").service).toBe(
      "ファクトチェック検索（Google）"
    );
  });

  it("uses the HTTP status when the text says nothing", () => {
    expect(explainFailure("", 504).kind).toBe("busy");
    expect(explainFailure("").kind).toBe("unknown");
  });

  it("does not blame the writer's text when the cause is unknown", () => {
    expect(explainFailure("something odd").headline).toContain("文章が原因かどうかは分かりません");
  });
});

describe("noticeForResponse", () => {
  it("keeps the raw server words as details, under a Japanese headline", () => {
    const notice = noticeForResponse(500, {
      error: "解析ジョブの実行に失敗しました。",
      details: CREDIT,
    });
    expect(notice.headline).toContain("道具側の設定の問題");
    expect(notice.service).toBe("文章の解析（Anthropic）");
    expect(notice.details).toBe(`解析ジョブの実行に失敗しました。 / ${CREDIT}`);
  });

  it("shows an input problem as the server wrote it", () => {
    expect(noticeForResponse(400, { error: "テキストが空です。" })).toEqual({
      headline: "テキストが空です。",
    });
  });

  it("still says something when the server returned no body", () => {
    const notice = noticeForResponse(504, {});
    expect(notice.headline).toContain("少し待ってから");
    expect(notice.details).toContain("504");
  });
});

describe("noticeForError", () => {
  it("keeps the thrown message as details", () => {
    const notice = noticeForError(new TypeError("Failed to fetch"));
    expect(notice.headline).toContain("少し待ってから");
    expect(notice.details).toBe("Failed to fetch");
  });
});

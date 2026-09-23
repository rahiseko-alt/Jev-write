import { describe, it, expect } from "vitest";
import { describeFailure, recordFailure } from "@/lib/providers/diagnostics";

describe("describeFailure", () => {
  it("keeps the credential out of the message", () => {
    const message = describeFailure(
      new Error("request to https://example.com/claims:search?key=abc123secret&x=1 failed")
    );

    expect(message).not.toContain("abc123secret");
    expect(message).toContain("key=***");
  });

  it("redacts a bearer token and an API key", () => {
    expect(describeFailure(new Error("Authorization: Bearer abc.def-ghi"))).not.toContain("abc.def");
    expect(describeFailure(new Error("bad key sk-proj-ABCDEFGH1234"))).not.toContain("ABCDEFGH1234");
  });

  it("does not hand the screen a wall of text", () => {
    expect(describeFailure(new Error("あ".repeat(1000))).length).toBeLessThanOrEqual(200);
  });
});

describe("recordFailure", () => {
  it("counts every failure but keeps the first message", () => {
    const target: { failureCount?: number; lastError?: string } = {};

    recordFailure(target, new Error("最初の失敗"));
    recordFailure(target, new Error("次の失敗"));

    expect(target.failureCount).toBe(2);
    expect(target.lastError).toBe("最初の失敗");
  });
});

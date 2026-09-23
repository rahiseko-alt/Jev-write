import { describe, it, expect, beforeEach } from "vitest";
import {
  STYLE_RULES,
  getEnabledStyleRules,
  getStyleRuleById,
} from "@/lib/rules/style-rules";
import { JobStore } from "@/lib/jobs/job-store";
import { runFactPipeline } from "@/lib/pipeline/fact-pipeline";
import { runStylePipeline } from "@/lib/pipeline/style-pipeline";
import { runRewritePipeline } from "@/lib/pipeline/rewrite-pipeline";
import { runDeltaCheck } from "@/lib/pipeline/delta-check";
import { runOrchestrator } from "@/lib/pipeline/orchestrator";
import { SAMPLE_ARTICLES } from "@/lib/data/sample-articles";
import {
  MockFetchProvider,
  MockGoogleFactCheckClient,
  MockJEVClient,
  MockLLMProvider,
  MockSearchProvider,
} from "@/lib/providers";

describe("Style Rules Registry", () => {
  it("should contain all required style rules AI001 - AI012+", () => {
    const ruleIds = STYLE_RULES.map((r) => r.id);
    const expectedRules = [
      "AI001",
      "AI002",
      "AI003",
      "AI004",
      "AI005",
      "AI006",
      "AI007",
      "AI008",
      "AI009",
      "AI010",
      "AI011",
      "AI012",
    ];

    for (const id of expectedRules) {
      expect(ruleIds).toContain(id);
    }
  });

  it("each rule should have id, name, description, jevQuestion, severity, repairInstruction, enabled", () => {
    for (const rule of STYLE_RULES) {
      expect(rule.id).toBeTruthy();
      expect(rule.name).toBeTruthy();
      expect(rule.description).toBeTruthy();
      expect(rule.jevQuestion).toBeTruthy();
      expect(["low", "medium", "high"]).toContain(rule.severity);
      expect(rule.repairInstruction).toBeTruthy();
      expect(typeof rule.enabled).toBe("boolean");
    }
  });

  it("should filter enabled rules correctly", () => {
    const enabled = getEnabledStyleRules();
    expect(enabled.length).toBeGreaterThanOrEqual(12);
    expect(enabled.every((r) => r.enabled)).toBe(true);
  });

  it("should find rule by id", () => {
    const rule = getStyleRuleById("AI002");
    expect(rule).toBeDefined();
    expect(rule?.name).toContain("対比");
  });
});

describe("JobStore", () => {
  let store: JobStore;

  beforeEach(() => {
    store = new JobStore({ ttlMs: 1000 }); // 1 second TTL for test
  });

  it("should create and retrieve a job", () => {
    const job = store.createJob("Sample test text");
    expect(job.id).toBeTruthy();
    expect(job.status).toBe("QUEUED");
    expect(job.text).toBe("Sample test text");

    const retrieved = store.getJob(job.id);
    expect(retrieved).toEqual(job);
  });

  it("should update a job", () => {
    const job = store.createJob("Test text");
    store.updateJob(job.id, {
      status: "ANALYZING",
      progressPercent: 20,
      currentMessage: "Processing...",
    });

    const updated = store.getJob(job.id);
    expect(updated?.status).toBe("ANALYZING");
    expect(updated?.progressPercent).toBe(20);
    expect(updated?.currentMessage).toBe("Processing...");
  });

  it("should emit progress events and support subscription", () => {
    const job = store.createJob("Test text");
    const events: any[] = [];

    const unsubscribe = store.subscribe(job.id, (ev) => {
      events.push(ev);
    });

    store.emitProgress({
      jobId: job.id,
      status: "FACTCHECK_DATABASE",
      progressPercent: 35,
      currentMessage: "Fact checking database...",
      timestamp: new Date().toISOString(),
    });

    expect(events.length).toBe(1);
    expect(events[0].status).toBe("FACTCHECK_DATABASE");
    expect(events[0].progressPercent).toBe(35);

    unsubscribe();
    store.emitProgress({
      jobId: job.id,
      status: "COMPLETED",
      progressPercent: 100,
      currentMessage: "Done",
      timestamp: new Date().toISOString(),
    });

    expect(events.length).toBe(1); // No new events after unsubscribe
  });

  it("should evict expired jobs", async () => {
    const job = store.createJob("Old text");
    expect(store.getJob(job.id)).toBeDefined();

    // Wait for TTL to pass
    await new Promise((resolve) => setTimeout(resolve, 1100));

    expect(store.getJob(job.id)).toBeUndefined();
  });
});

describe("Fact Pipeline", () => {
  it("should extract claims, query factcheck and return FactLedger", async () => {
    const sample = SAMPLE_ARTICLES[0].text; // iPhone 17 sample
    const output = await runFactPipeline(sample, {
      llm: new MockLLMProvider(),
      factCheck: new MockGoogleFactCheckClient(),
      jev: new MockJEVClient(),
      search: new MockSearchProvider(),
      fetch: new MockFetchProvider(),
    });

    expect(output.claims.length).toBeGreaterThan(0);
    expect(output.factLedger.length).toBe(output.claims.length);

    // Contradicted claim check (iPhone 17 in 2024)
    const contradictedClaim = output.claims.find(
      (c) => c.verdict === "CONTRADICTED"
    );
    expect(contradictedClaim).toBeDefined();
    expect(contradictedClaim?.correctedClaim).toBeTruthy();
  });
});

describe("Style Pipeline", () => {
  it("should detect AI-tells from sample text", async () => {
    const sample = SAMPLE_ARTICLES[0].text;
    const issues = await runStylePipeline(sample, {
      jev: new MockJEVClient(),
      confidenceThreshold: 0.7,
    });

    expect(issues.length).toBeGreaterThan(0);
    const ruleIds = issues.map((i) => i.ruleId);
    expect(ruleIds).toContain("AI002"); // 単なる〜ではない
    expect(ruleIds).toContain("AI003"); // 近年、〜
    expect(ruleIds).toContain("AI012"); // 今後の動向に目が離せません
  });
});

describe("Rewrite Pipeline", () => {
  it("should produce a revised text fixing contradicted facts and AI-tells", async () => {
    const sample = SAMPLE_ARTICLES[0].text;
    const factOutput = await runFactPipeline(sample);
    const styleIssues = await runStylePipeline(sample);

    const rewriteResult = await runRewritePipeline(
      sample,
      factOutput.factLedger,
      styleIssues
    );

    expect(rewriteResult.revisedText).toBeTruthy();
    expect(rewriteResult.revisedText).not.toContain("今後の動向からも目が離せません");
    expect(rewriteResult.revisedText).not.toContain("近年、モバイルテクノロジーの急速な進化");
  });

  it("should accurately detect and correct the 6 intentional mistakes in iPhone 15 Pro article", async () => {
    const input =
      "Appleは2023年9月13日、iPhone 15 ProとiPhone 15 Pro Maxを発表した。両モデルは航空宇宙産業レベルのチタニウムを採用し、A17 Proと新しいアクションボタンを搭載する。メインカメラは48MPで、通常撮影では20MPをデフォルトとする。iPhone 15 Pro Maxには最大6倍の望遠カメラを搭載。USB-C端子はUSB 3に対応し、最大20Gbpsでデータを転送できる。第2世代の超広帯域無線チップによって通信範囲は従来の約2倍になったほか、Wi-Fi 7にも対応している。";

    const factOutput = await runFactPipeline(input);
    const contradicted = factOutput.claims.filter((c) => c.verdict === "CONTRADICTED");
    expect(contradicted.length).toBeGreaterThanOrEqual(1);

    const rewriteResult = await runRewritePipeline(
      input,
      factOutput.factLedger,
      []
    );

    expect(rewriteResult.revisedText).toContain("9月12日");
    expect(rewriteResult.revisedText).toContain("24MP");
    expect(rewriteResult.revisedText).toContain("5倍");
    expect(rewriteResult.revisedText).toContain("10Gbps");
    expect(rewriteResult.revisedText).toContain("3倍");
    expect(rewriteResult.revisedText).toContain("Wi-Fi 6E");
  });

  it("should accurately detect and correct Nintendo Switch 2 announcement and release dates", async () => {
    const input = "Nintendo Switch 2は2025年4月3日に詳細発表、6月6日に発売。";

    const factOutput = await runFactPipeline(input);
    const contradicted = factOutput.claims.filter((c) => c.verdict === "CONTRADICTED");
    expect(contradicted.length).toBeGreaterThanOrEqual(1);

    const rewriteResult = await runRewritePipeline(
      input,
      factOutput.factLedger,
      []
    );

    expect(rewriteResult.revisedText).toContain("4月2日");
    expect(rewriteResult.revisedText).toContain("6月5日");
    expect(rewriteResult.revisedText).not.toContain("4月3日");
    expect(rewriteResult.revisedText).not.toContain("6月6日");
  });
});

describe("Delta Check", () => {
  it("should verify text and pass when no unauthorized modifications exist", async () => {
    const original = "価格は799ドルです。";
    const revised = "ベースモデルの価格は799ドルです。";
    const plan = {
      corrections: [],
      styleIssues: [],
      immutableFacts: ["799ドル"],
      protectedQuotes: [],
      protectedNames: [],
    };

    const delta = await runDeltaCheck(original, revised, plan);
    expect(delta.unauthorizedChangeDetected).toBe(false);
  });

  it("should detect and correct unauthorized numerical hallucination", async () => {
    const original = "価格は799ドルです。";
    const revised = "価格は1299ドルです。"; // Hallucinated number 1299ドル
    const plan = {
      corrections: [],
      styleIssues: [],
      immutableFacts: ["799ドル"],
      protectedQuotes: [],
      protectedNames: [],
    };

    const delta = await runDeltaCheck(original, revised, plan);
    expect(delta.unauthorizedChangeDetected).toBe(true);
  });
});

describe("Orchestrator End-to-End", () => {
  it("says which service answered and which stood in", async () => {
    const result = await runOrchestrator("これはテスト用の短い文章です。");

    const services = result.providerStatuses?.map((s) => s.service) ?? [];
    expect(services).toContain("文章の生成");
    expect(services).toContain("判定（JEV）");
    expect(services).toContain("ウェブ検索");
    // In a test run every one of them is a stand-in, and each says so itself.
    expect(result.providerStatuses?.every((s) => s.stoodIn)).toBe(true);
  });

  it("records that a run answered by stand-ins was not a real check", async () => {
    // In a test run every provider is a stand-in, so the result must say so
    // rather than look like a completed check.
    const result = await runOrchestrator("これはテスト用の短い文章です。");

    expect(result.servedByFallback).toBe(true);
  });

  it("should coordinate full pipeline, emit progress and return complete AnalysisResult", async () => {
    const sample = SAMPLE_ARTICLES[0].text;
    const store = new JobStore();
    const job = store.createJob(sample);

    const progressStatuses: string[] = [];
    const unsubscribe = store.subscribe(job.id, (ev) => {
      progressStatuses.push(ev.status);
    });

    const result = await runOrchestrator(sample, {
      jobId: job.id,
      jobStore: store,
    });

    unsubscribe();

    expect(result.originalText).toBe(sample);
    expect(result.revisedText).toBeTruthy();
    expect(result.claims.length).toBeGreaterThan(0);
    expect(result.styleIssues.length).toBeGreaterThan(0);
    expect(result.summary.claimsChecked).toBe(result.claims.length);
    expect(result.timings.length).toBeGreaterThan(0);

    const finalJob = store.getJob(job.id);
    expect(finalJob?.status).toBe("COMPLETED");
    expect(finalJob?.progressPercent).toBe(100);
    expect(finalJob?.result).toEqual(result);

    expect(progressStatuses).toContain("ANALYZING");
    expect(progressStatuses).toContain("REWRITING");
    expect(progressStatuses).toContain("VERIFYING");
    expect(progressStatuses).toContain("COMPLETED");
  });
});

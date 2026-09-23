import { describe, it, expect, beforeEach } from "vitest";
import {
  STYLE_RULES,
  getEnabledStyleRules,
  getStyleRuleById,
} from "@/lib/rules/style-rules";
import { JobStore } from "@/lib/jobs/job-store";

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

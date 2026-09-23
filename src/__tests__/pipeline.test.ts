import { describe, it, expect, beforeEach } from "vitest";
import { JobStore } from "@/lib/jobs/job-store";

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

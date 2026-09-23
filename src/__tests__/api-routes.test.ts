import { describe, it, expect } from "vitest";
import { POST as analyzeHandler } from "@/app/api/analyze/route";
import { GET as jobHandler } from "@/app/api/analyze/[jobId]/route";
import { GET as eventsHandler } from "@/app/api/analyze/[jobId]/events/route";
import { jobStore } from "@/lib/job-store";
import { NextRequest } from "next/server";

describe("API Routes & Job Store Integration", () => {
  it("should validate input and create job on POST /api/analyze", async () => {
    // 1. Invalid input: empty
    const reqEmpty = new NextRequest("http://localhost:3000/api/analyze", {
      method: "POST",
      body: JSON.stringify({ text: "   " }),
    });
    const resEmpty = await analyzeHandler(reqEmpty);
    expect(resEmpty.status).toBe(400);

    // 2. Valid input. With no credentials configured there is nothing to
    // stand in for them, so the run reports the failure and names it — it
    // never comes back as a finished check.
    const reqValid = new NextRequest("http://localhost:3000/api/analyze", {
      method: "POST",
      body: JSON.stringify({ text: "これはテスト記事です。OpenAIが新しいモデルを発表しました。" }),
    });
    const resValid = await analyzeHandler(reqValid);
    expect(resValid.status).toBe(500);
    const data = await resValid.json();
    expect(data.jobId).toBeTruthy();
    expect(`${data.details}`).toContain("設定されていません");

    // 3. GET /api/analyze/[jobId]
    const reqGet = new NextRequest(`http://localhost:3000/api/analyze/${data.jobId}`);
    const resGet = await jobHandler(reqGet, { params: { jobId: data.jobId } });
    expect(resGet.status).toBe(200);
    const getData = await resGet.json();
    expect(getData.job).toBeDefined();
    expect(getData.job.id).toBe(data.jobId);
    expect(getData.job.text).toContain("テスト記事");

    // 4. GET /api/analyze/[nonExistentJobId] returns 404
    const req404 = new NextRequest("http://localhost:3000/api/analyze/nonexistent");
    const res404 = await jobHandler(req404, { params: { jobId: "nonexistent" } });
    expect(res404.status).toBe(404);

    // 5. GET /api/analyze/[jobId]/events sets up SSE response
    const reqEvents = new NextRequest(`http://localhost:3000/api/analyze/${data.jobId}/events`);
    const resEvents = await eventsHandler(reqEvents, { params: { jobId: data.jobId } });
    expect(resEvents.status).toBe(200);
    expect(resEvents.headers.get("Content-Type")).toContain("text/event-stream");
  });

  it("should support job store TTL and event subscriptions", () => {
    const job = jobStore.createJob("テスト");
    expect(job.id).toBeTruthy();
    expect(job.status).toBe("QUEUED");

    let receivedStatus = "";
    const unsub = jobStore.subscribe(job.id, (evt) => {
      receivedStatus = evt.status;
    });

    jobStore.updateJob(job.id, {
      status: "ANALYZING",
      progressPercent: 20,
      currentMessage: "クレーム検出中",
    });

    expect(receivedStatus).toBe("ANALYZING");
    unsub();
  });
});

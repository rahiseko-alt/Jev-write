import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/job-store";
import { runAnalysis } from "@/lib/orchestrator";

// Allow serverless execution up to 60 seconds
export const maxDuration = 60;
export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { text } = body;

    if (!text || typeof text !== "string") {
      return NextResponse.json(
        { error: "テキストを入力してください。" },
        { status: 400 }
      );
    }

    const trimmedText = text.trim();
    if (trimmedText.length === 0) {
      return NextResponse.json(
        { error: "テキストが空です。" },
        { status: 400 }
      );
    }

    if (trimmedText.length > 10000) {
      return NextResponse.json(
        { error: "テキストは10,000文字以内で入力してください。" },
        { status: 400 }
      );
    }

    const job = jobStore.createJob(trimmedText);

    // Await analysis execution so Vercel Serverless doesn't freeze before completion!
    await runAnalysis(job.id, trimmedText);

    const updatedJob = jobStore.getJob(job.id);

    return NextResponse.json(
      {
        jobId: job.id,
        status: updatedJob?.status,
        result: updatedJob?.result,
        error: updatedJob?.error,
        job: updatedJob,
      },
      { status: 201 }
    );
  } catch (err: any) {
    console.error("Failed to process /api/analyze:", err);
    return NextResponse.json(
      {
        error: "解析ジョブの実行に失敗しました。",
        details: err?.message || String(err),
      },
      { status: 500 }
    );
  }
}

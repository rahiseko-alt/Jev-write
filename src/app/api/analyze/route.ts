import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/job-store";
import { runAnalysis } from "@/lib/orchestrator";

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

    // Trigger analysis asynchronously without awaiting it
    void runAnalysis(job.id, trimmedText);

    return NextResponse.json({ jobId: job.id }, { status: 201 });
  } catch (err) {
    console.error("Failed to process /api/analyze:", err);
    return NextResponse.json(
      { error: "解析ジョブの作成に失敗しました。" },
      { status: 500 }
    );
  }
}

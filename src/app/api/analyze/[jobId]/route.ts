import { NextRequest, NextResponse } from "next/server";
import { jobStore } from "@/lib/job-store";

export async function GET(
  _request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;

  if (!jobId) {
    return NextResponse.json(
      { error: "ジョブIDが指定されていません。" },
      { status: 400 }
    );
  }

  const job = jobStore.getJob(jobId);

  if (!job) {
    return NextResponse.json(
      { error: "指定されたジョブが見つかりません。" },
      { status: 404 }
    );
  }

  return NextResponse.json({ job });
}

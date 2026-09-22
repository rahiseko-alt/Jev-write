import { NextRequest } from "next/server";
import { jobStore } from "@/lib/job-store";
import { JobProgressEvent } from "@/types";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: { jobId: string } }
) {
  const { jobId } = params;
  const job = jobStore.getJob(jobId);

  if (!job) {
    return new Response(
      JSON.stringify({ error: "指定されたジョブが見つかりません。" }),
      {
        status: 404,
        headers: { "Content-Type": "application/json" },
      }
    );
  }

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    start(controller) {
      let isClosed = false;

      const safeClose = () => {
        if (!isClosed) {
          isClosed = true;
          try {
            controller.close();
          } catch {
            // Stream already closed or errored
          }
        }
      };

      const sendEvent = (event: JobProgressEvent) => {
        if (isClosed) return;
        try {
          const payload = `data: ${JSON.stringify(event)}\n\n`;
          controller.enqueue(encoder.encode(payload));
        } catch {
          safeClose();
        }
      };

      // Emit initial event
      const initialEvent: JobProgressEvent = {
        jobId: job.id,
        status: job.status,
        progressPercent: job.progressPercent,
        currentMessage: job.currentMessage,
        claimsCount: job.claimsCount,
        factHits: job.factHits,
        styleIssuesCount: job.styleIssuesCount,
        timestamp: new Date(job.updatedAt).toISOString(),
      };

      sendEvent(initialEvent);

      // If already completed or failed, terminate stream
      if (job.status === "COMPLETED" || job.status === "FAILED") {
        safeClose();
        return;
      }

      // Subscribe to progress events
      const unsubscribe = jobStore.subscribe(jobId, (event: JobProgressEvent) => {
        sendEvent(event);
        if (event.status === "COMPLETED" || event.status === "FAILED") {
          unsubscribe();
          safeClose();
        }
      });

      // Cleanup on client disconnect
      request.signal.addEventListener("abort", () => {
        unsubscribe();
        safeClose();
      });
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
}

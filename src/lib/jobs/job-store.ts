import { EventEmitter } from "events";
import { Job, JobProgressEvent, JobStatus } from "@/types";

export interface JobStoreOptions {
  ttlMs?: number; // Time-to-live in milliseconds (default: 2 hours)
}

export class JobStore {
  private jobs = new Map<string, Job>();
  private emitter = new EventEmitter();
  private ttlMs: number;
  private cleanupTimer?: NodeJS.Timeout;

  constructor(options?: JobStoreOptions) {
    this.ttlMs = options?.ttlMs ?? 2 * 60 * 60 * 1000; // 2 hours
    this.emitter.setMaxListeners(100);

    // Setup periodic cleanup every 15 minutes
    if (typeof setInterval !== "undefined") {
      this.cleanupTimer = setInterval(() => {
        this.cleanExpiredJobs();
      }, 15 * 60 * 1000);

      // Prevent timer from holding Node.js event loop open
      if (this.cleanupTimer.unref) {
        this.cleanupTimer.unref();
      }
    }
  }

  /**
   * Create a new QA Job
   */
  createJob(text: string): Job {
    this.cleanExpiredJobs();

    const id =
      typeof crypto !== "undefined" && crypto.randomUUID
        ? crypto.randomUUID()
        : `job-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

    const now = Date.now();
    const job: Job = {
      id,
      text,
      status: "QUEUED",
      progressPercent: 0,
      currentMessage: "キューに登録されました",
      createdAt: now,
      updatedAt: now,
    };

    this.jobs.set(id, job);
    return job;
  }

  /**
   * Get an existing job by ID
   */
  getJob(jobId: string): Job | undefined {
    this.cleanExpiredJobs();
    return this.jobs.get(jobId);
  }

  /**
   * Update fields of an existing job
   */
  updateJob(jobId: string, updates: Partial<Job>): void {
    const job = this.jobs.get(jobId);
    if (!job) return;

    const updatedJob: Job = {
      ...job,
      ...updates,
      updatedAt: Date.now(),
    };

    this.jobs.set(jobId, updatedJob);

    // If progress-related fields are updated, emit progress event
    if (
      updates.status !== undefined ||
      updates.progressPercent !== undefined ||
      updates.currentMessage !== undefined
    ) {
      const event: JobProgressEvent = {
        jobId,
        status: updatedJob.status,
        progressPercent: updatedJob.progressPercent,
        currentMessage: updatedJob.currentMessage,
        claimsCount: updatedJob.claimsCount,
        factHits: updatedJob.factHits,
        styleIssuesCount: updatedJob.styleIssuesCount,
        timestamp: new Date(updatedJob.updatedAt).toISOString(),
      };
      this.emitter.emit(`job:${jobId}`, event);
      this.emitter.emit("progress", event);
    }
  }

  /**
   * Emit progress event for a job and update job state
   */
  emitProgress(event: JobProgressEvent): void {
    const job = this.jobs.get(event.jobId);
    if (job) {
      job.status = event.status;
      job.progressPercent = event.progressPercent;
      job.currentMessage = event.currentMessage;
      if (event.claimsCount !== undefined) job.claimsCount = event.claimsCount;
      if (event.factHits !== undefined) job.factHits = event.factHits;
      if (event.styleIssuesCount !== undefined)
        job.styleIssuesCount = event.styleIssuesCount;
      job.updatedAt = Date.now();
    }

    this.emitter.emit(`job:${event.jobId}`, event);
    this.emitter.emit("progress", event);
  }

  /**
   * Alias for emitProgress
   */
  emitEvent(jobId: string, event: JobProgressEvent): void {
    this.emitProgress(event);
  }

  /**
   * Subscribe to progress events for a specific job (returns unsubscribe function)
   */
  subscribe(
    jobId: string,
    listener: (event: JobProgressEvent) => void
  ): () => void {
    const eventName = `job:${jobId}`;
    this.emitter.on(eventName, listener);
    return () => {
      this.emitter.off(eventName, listener);
    };
  }

  /**
   * Clean expired jobs beyond TTL
   */
  cleanExpiredJobs(): void {
    const now = Date.now();
    this.jobs.forEach((job, id) => {
      if (now - job.createdAt > this.ttlMs) {
        this.jobs.delete(id);
      }
    });
  }

  /**
   * Clear all jobs (useful for testing)
   */
  clear(): void {
    this.jobs.clear();
  }

  /**
   * Destroy timer when stopping server
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
    }
    this.emitter.removeAllListeners();
  }
}

export const jobStore = new JobStore();

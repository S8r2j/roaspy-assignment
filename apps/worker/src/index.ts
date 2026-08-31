import { Worker, type Job } from "bullmq";
import { URL_CHECK_QUEUE, type UrlCheckJobData } from "@roaspy/shared";
import { createBullMqConnection } from "./lib/redis";
import { checkUrl } from "./lib/checkUrl";
import { publishBatchEvent } from "./lib/events";
import * as repo from "./lib/batches.repo";
import { logger } from "./lib/logger";

// Without these, an uncaught error anywhere in the process (a bug in a
// dependency, a malformed event, etc.) kills the container with nothing
// but Docker's own "exited" status — no record of why. Logging here at
// least leaves a trace before the process exits (BullMQ's own job-level
// try/catch in processJob doesn't cover errors outside job processing,
// e.g. in the Worker's internal event loop or Redis client).
process.on("uncaughtException", (err) => {
  logger.fatal({ err }, "uncaught exception, worker exiting");
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  logger.fatal({ reason }, "unhandled promise rejection, worker exiting");
  process.exit(1);
});

/** BullMQ processor for the url-checks queue — one call per URL job.
 * Checks the batch's cancelled status both before starting the HTTP call
 * and after it resolves (so an in-flight check finishes cleanly instead
 * of being interrupted, and a cancelled batch's late-arriving response
 * never overwrites the cancelled state). A network/timeout error throws
 * so BullMQ retries with exponential backoff, only writing a final
 * `failed` result once attempts are exhausted; a well-formed HTTP
 * response of any status code is written immediately as `succeeded`. */
async function processJob(job: Job<UrlCheckJobData>) {
  const { urlId, batchId, url } = job.data;

  // Bail before making the HTTP call if the batch was cancelled while this
  // job was queued. Jobs already mid-HTTP-call check again after the
  // request resolves (below) rather than here, so an in-flight check
  // finishes cleanly instead of being interrupted.
  const statusBefore = await repo.getBatchStatus(batchId);
  if (statusBefore === "cancelled") {
    const urlRow = await repo.markUrlCancelled(urlId);
    await publishBatchEvent(batchId, { type: "url.updated", url: urlRow });
    return;
  }

  const runningRow = await repo.markUrlRunning(urlId);
  await publishBatchEvent(batchId, { type: "url.updated", url: runningRow });

  const result = await checkUrl(url);

  const statusAfter = await repo.getBatchStatus(batchId);
  if (statusAfter === "cancelled") {
    const urlRow = await repo.markUrlCancelled(urlId);
    await publishBatchEvent(batchId, { type: "url.updated", url: urlRow });
    return;
  }

  // A network/timeout error is transient — throw so BullMQ retries with
  // exponential backoff (up to the configured attempts). A real HTTP
  // response, even a non-2xx one, is a final, successful check.
  if (result.error !== null) {
    if (job.attemptsMade + 1 >= (job.opts.attempts ?? 1)) {
      const urlRow = await repo.markUrlResult(urlId, {
        status: "failed",
        httpStatus: null,
        responseMs: result.responseMs,
        pageTitle: null,
        error: result.error,
        attempt: job.attemptsMade + 1,
      });
      await publishBatchEvent(batchId, { type: "url.updated", url: urlRow });
      await completeBatchIfDone(batchId);
    }
    throw new Error(result.error);
  }

  const urlRow = await repo.markUrlResult(urlId, {
    status: "succeeded",
    httpStatus: result.httpStatus,
    responseMs: result.responseMs,
    pageTitle: result.pageTitle,
    error: null,
    attempt: job.attemptsMade + 1,
  });
  await publishBatchEvent(batchId, { type: "url.updated", url: urlRow });
  await completeBatchIfDone(batchId);
}

/** Checks whether a batch just became fully done and, if so, publishes
 * the one and only `batch.updated` SSE event for that batch's completion.
 * Called after every job's final write (success or exhausted-retry
 * failure) — cheap to call repeatedly since `maybeCompleteBatch` only
 * returns `true` on the actual transition. */
async function completeBatchIfDone(batchId: string) {
  const completed = await repo.maybeCompleteBatch(batchId);
  if (completed) {
    const summary = await repo.getBatchSummary(batchId);
    if (summary) {
      await publishBatchEvent(batchId, { type: "batch.updated", batch: summary });
    }
  }
}

const worker = new Worker<UrlCheckJobData>(URL_CHECK_QUEUE, processJob, {
  connection: createBullMqConnection(),
  concurrency: 5,
  limiter: { max: 10, duration: 1000 }, // global across all worker processes (enforced in Redis)
});

worker.on("failed", (job, err) => {
  logger.error(
    { jobId: job?.id, urlId: job?.data?.urlId, batchId: job?.data?.batchId, attempt: job?.attemptsMade, err },
    "job failed",
  );
});

worker.on("completed", (job) => {
  logger.info({ jobId: job.id, urlId: job.data.urlId, batchId: job.data.batchId }, "job completed");
});

worker.on("error", (err) => {
  // Errors from the Worker itself (e.g. Redis connection issues) rather
  // than from an individual job — these don't go through the job-level
  // "failed" event above and would otherwise be silent.
  logger.error({ err }, "worker error");
});

logger.info({ queue: URL_CHECK_QUEUE }, "worker started");

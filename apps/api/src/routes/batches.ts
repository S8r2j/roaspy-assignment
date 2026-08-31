import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { CreateBatchResponse, GetBatchResponse, ListBatchesResponse, UrlCheckJobData } from "@roaspy/shared";
import * as repo from "../lib/batches.repo";
import { parseUrlList, MAX_URLS_PER_BATCH } from "../lib/parseUrls";
import { urlCheckQueue } from "../lib/queue";
import { getCachedBatchList, setCachedBatchList, invalidateBatchListCache } from "../lib/cache";
import { publishBatchEvent } from "../lib/events";

// The pasted-text submission body is a single text blob (newline/comma
// separated), not a pre-split array — createBatchRequestSchema in
// packages/shared models the post-parse shape, so this route defines its
// own request schema for what actually arrives over the wire.
const submitTextBodySchema = z.object({
  urls: z.string().min(1).optional(),
  text: z.string().min(1).optional(),
});

const uuidParamSchema = z.object({ id: z.string().uuid() });

const listQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

const batchDetailQuerySchema = z.object({
  urlsCursor: z.string().optional(),
});

/** Enqueues one BullMQ job per URL, with a deterministic `jobId = url.id`
 * for idempotency (a duplicate enqueue of a still-waiting/active job is a
 * no-op). Also handles a BullMQ quirk: `.add()` with a `jobId` that
 * already exists in a *terminal* state (failed/completed) silently
 * returns the stale job instead of creating a new one — so any such
 * terminal job for this id is removed first, letting the add create a
 * fresh run. Used both on initial batch submission and by "Retry failed
 * only". */
async function enqueueUrls(batchId: string, urls: { id: string; url: string }[]) {
  for (const { id, url } of urls) {
    const existing = await urlCheckQueue.getJob(id);
    if (existing) {
      const state = await existing.getState();
      if (state === "completed" || state === "failed") {
        await existing.remove();
      }
    }

    const jobData: UrlCheckJobData = { urlId: id, batchId, url };
    const job = await urlCheckQueue.add("check", jobData, { jobId: `${id}` });
    await repo.setUrlJobId(id, job.id!);
  }
}

/** Fastify plugin registering every batch CRUD/control route: create
 * (`POST /batches`), list (`GET /batches`, cached), detail and paginated
 * URLs (`GET /batches/:id`, `GET /batches/:id/urls`), and the two spec'd
 * controls (`POST /batches/:id/cancel`, `POST /batches/:id/retry-failed`).
 * SSE lives in `events.ts` instead, since it needs to bypass Fastify's
 * normal response lifecycle. */
export async function batchRoutes(app: FastifyInstance) {
  app.post("/batches", async (req, reply) => {
    let urls: string[] = [];

    const contentType = req.headers["content-type"] ?? "";
    if (contentType.includes("multipart/form-data")) {
      const file = await req.file();
      if (!file) {
        return reply.code(400).send({ error: "No file uploaded" });
      }
      const buffer = await file.toBuffer();
      urls = parseUrlList(buffer.toString("utf8"));
    } else {
      const parsed = submitTextBodySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: "Request body must include a non-empty 'urls' or 'text' field" });
      }
      const raw = parsed.data.urls ?? parsed.data.text ?? "";
      urls = parseUrlList(raw);
    }

    if (urls.length === 0) {
      return reply.code(400).send({ error: "No valid, publicly-routable http(s) URLs found in submission" });
    }
    if (urls.length > MAX_URLS_PER_BATCH) {
      return reply.code(400).send({ error: `A batch cannot exceed ${MAX_URLS_PER_BATCH} URLs (submitted ${urls.length})` });
    }

    const batchId = await repo.createBatch(urls);
    const urlRows = await repo.listUrlIdsForBatch(batchId);
    await enqueueUrls(batchId, urlRows);
    await invalidateBatchListCache();

    const response: CreateBatchResponse = { batchId };
    return reply.code(201).send(response);
  });

  app.get("/batches", async (req, reply) => {
    const parsedQuery = listQuerySchema.safeParse(req.query);
    if (!parsedQuery.success) {
      return reply.code(400).send({ error: "Invalid query parameters" });
    }
    const cursor = parsedQuery.data.cursor ?? null;
    const limit = parsedQuery.data.limit ?? 20;

    const cached = await getCachedBatchList(cursor, limit);
    if (cached) {
      reply.header("x-cache", "hit");
      return reply.type("application/json").send(cached);
    }

    const { batches, nextCursor } = await repo.listBatches(cursor, limit);
    const response: ListBatchesResponse = { batches, nextCursor };
    const payload = JSON.stringify(response);
    await setCachedBatchList(cursor, limit, payload);

    reply.header("x-cache", "miss");
    return reply.type("application/json").send(payload);
  });

  app.get("/batches/:id", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid batch id" });
    }
    const query = batchDetailQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid query parameters" });
    }
    const { id } = params.data;
    const detail = await repo.getBatchDetail(id, query.data.urlsCursor ?? null);
    if (!detail) {
      return reply.code(404).send({ error: "Batch not found" });
    }
    const response: GetBatchResponse = detail;
    return reply.send(response);
  });

  // Paginated fetch of additional URL rows for a batch already loaded —
  // used to load more pages beyond the first, which GET /batches/:id
  // already includes.
  app.get("/batches/:id/urls", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid batch id" });
    }
    const query = batchDetailQuerySchema.safeParse(req.query);
    if (!query.success) {
      return reply.code(400).send({ error: "Invalid query parameters" });
    }
    const { id } = params.data;
    const status = await repo.getBatchStatus(id);
    if (!status) {
      return reply.code(404).send({ error: "Batch not found" });
    }
    const page = await repo.getUrlsPage(id, query.data.urlsCursor ?? null);
    return reply.send(page);
  });

  app.post("/batches/:id/cancel", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid batch id" });
    }
    const { id } = params.data;
    const status = await repo.getBatchStatus(id);
    if (!status) {
      return reply.code(404).send({ error: "Batch not found" });
    }

    // Remove queued (not-yet-started) jobs from BullMQ so they never run.
    const urls = await repo.listUrlIdsForBatch(id);
    await Promise.all(
      urls.map(async ({ id: urlId }) => {
        const job = await urlCheckQueue.getJob(urlId);
        if (job) {
          const state = await job.getState();
          if (state === "waiting" || state === "delayed") {
            await job.remove();
          }
        }
      }),
    );

    // In-flight jobs finish their HTTP call, then check batch status before
    // writing a final result (see worker processor) — this DB write is what
    // they observe to bail out cleanly instead of overwriting with a result.
    await repo.markBatchCancelled(id);
    await invalidateBatchListCache();

    const summary = await repo.getBatchSummary(id);
    await publishBatchEvent(id, { type: "batch.updated", batch: summary! });

    return reply.send({ ok: true });
  });

  app.post("/batches/:id/retry-failed", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid batch id" });
    }
    const { id } = params.data;
    const status = await repo.getBatchStatus(id);
    if (!status) {
      return reply.code(404).send({ error: "Batch not found" });
    }

    const failed = await repo.listFailedUrlsForBatch(id);
    if (failed.length > 0) {
      await Promise.all(failed.map(({ id: urlId }) => repo.markUrlQueued(urlId)));
      await repo.markBatchRunning(id);
      await enqueueUrls(id, failed);
    }
    await invalidateBatchListCache();

    const summary = await repo.getBatchSummary(id);
    await publishBatchEvent(id, { type: "batch.updated", batch: summary! });

    return reply.send({ ok: true, retried: failed.length });
  });
}

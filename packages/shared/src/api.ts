import { z } from "zod";
import { batchDetailSchema, batchSummarySchema, urlCheckSchema } from "./domain";

/** Request body for `POST /batches` in its post-parse shape (a pre-split
 * array of URLs). The actual wire format for pasted-text submission is a
 * single text blob (`{ urls: string }`), parsed server-side — this schema
 * models the result of that parse, not the raw request body. */
export const createBatchRequestSchema = z.object({
  urls: z.array(z.string()).min(1),
});
export type CreateBatchRequest = z.infer<typeof createBatchRequestSchema>;

/** Response from `POST /batches`: just enough for the client to navigate
 * to and track the new batch. */
export const createBatchResponseSchema = z.object({
  batchId: z.string().uuid(),
});
export type CreateBatchResponse = z.infer<typeof createBatchResponseSchema>;

/** Response from `GET /batches`: one keyset-paginated page of batch
 * summaries. `nextCursor` is non-null when more pages exist. */
export const listBatchesResponseSchema = z.object({
  batches: z.array(batchSummarySchema),
  nextCursor: z.string().nullable(),
});
export type ListBatchesResponse = z.infer<typeof listBatchesResponseSchema>;

/** Response from `GET /batches/:id`: batch detail plus the first page of
 * its URLs. */
export const getBatchResponseSchema = batchDetailSchema;
export type GetBatchResponse = z.infer<typeof getBatchResponseSchema>;

/** SSE event: one URL's row changed state. Carries the full row (not a
 * delta), so an out-of-order or duplicate delivery is safe to apply. */
export const sseUrlUpdatedEventSchema = z.object({
  type: z.literal("url.updated"),
  url: urlCheckSchema,
});
export type SseUrlUpdatedEvent = z.infer<typeof sseUrlUpdatedEventSchema>;

/** SSE event: the batch's own status/aggregate counts changed. Published
 * by the worker only on final batch completion — clients that want live
 * incremental progress derive it themselves from a stream of
 * `url.updated` events instead of waiting on this one. */
export const sseBatchUpdatedEventSchema = z.object({
  type: z.literal("batch.updated"),
  batch: batchSummarySchema,
});
export type SseBatchUpdatedEvent = z.infer<typeof sseBatchUpdatedEventSchema>;

/** Union of every event type sent over `GET /batches/:id/events`. */
export const sseEventSchema = z.discriminatedUnion("type", [
  sseUrlUpdatedEventSchema,
  sseBatchUpdatedEventSchema,
]);
export type SseEvent = z.infer<typeof sseEventSchema>;

/** Name of the shared BullMQ queue that all URL-check jobs are enqueued
 * on, regardless of which batch they belong to. One queue, not one per
 * batch — this is what lets the global rate limit and concurrency cap
 * apply across all batches combined. */
export const URL_CHECK_QUEUE = "url-checks";

/** Payload carried by every BullMQ job on the url-checks queue. `urlId` is
 * also used as the job's deterministic BullMQ job ID (`jobId = urlId`) for
 * idempotency. */
export interface UrlCheckJobData {
  urlId: string;
  batchId: string;
  url: string;
}

import { z } from "zod";

/** Lifecycle states for a batch as a whole. `running` is set at creation
 * time, before any of its URLs have necessarily started — see the display
 * note in the README for how the UI distinguishes "created" from
 * "actively being worked on." */
export const batchStatusSchema = z.enum(["pending", "running", "done", "cancelled"]);
export type BatchStatus = z.infer<typeof batchStatusSchema>;

/** Lifecycle states for a single URL check. A non-2xx/3xx HTTP response
 * (404, 500, etc.) is `succeeded` — the check itself completed. `failed`
 * is reserved for network-level errors (DNS failure, timeout, connection
 * refused) after retries are exhausted. */
export const urlCheckStatusSchema = z.enum([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type UrlCheckStatus = z.infer<typeof urlCheckStatusSchema>;

/** A single URL's check result row, as returned to clients. Mirrors the
 * `urls` table (camelCased). */
export const urlCheckSchema = z.object({
  id: z.string().uuid(),
  batchId: z.string().uuid(),
  url: z.string(),
  status: urlCheckStatusSchema,
  httpStatus: z.number().int().nullable(),
  responseMs: z.number().int().nullable(),
  pageTitle: z.string().nullable(),
  error: z.string().nullable(),
  attempt: z.number().int(),
  updatedAt: z.string(),
});
export type UrlCheck = z.infer<typeof urlCheckSchema>;

/** Aggregate per-status counts for a batch's URLs. Always derived live
 * from `COUNT(*) ... GROUP BY status` against Postgres — never a
 * separately maintained counter, which could drift from the actual rows. */
export const batchCountsSchema = z.object({
  total: z.number().int(),
  queued: z.number().int(),
  running: z.number().int(),
  succeeded: z.number().int(),
  failed: z.number().int(),
  cancelled: z.number().int(),
});
export type BatchCounts = z.infer<typeof batchCountsSchema>;

/** Batch metadata plus aggregate counts, without the full URL list — the
 * shape used by the batch list page (`GET /batches`). */
export const batchSummarySchema = z.object({
  id: z.string().uuid(),
  status: batchStatusSchema,
  createdAt: z.string(),
  counts: batchCountsSchema,
});
export type BatchSummary = z.infer<typeof batchSummarySchema>;

/** A batch summary plus one page of its URL rows. The `urls` list is
 * paginated (keyset, same pattern as the batch list endpoint) rather than
 * always returning every row: at 1000+ URLs per batch, an unpaginated
 * response was ~285KB and fetched in full on every page load and every
 * SSE reconcile, which was the direct cause of batch detail pages feeling
 * slow to open under load. `urlsNextCursor` is non-null when more pages
 * exist beyond what's included here. */
export const batchDetailSchema = batchSummarySchema.extend({
  urls: z.array(urlCheckSchema),
  urlsNextCursor: z.string().nullable(),
});
export type BatchDetail = z.infer<typeof batchDetailSchema>;

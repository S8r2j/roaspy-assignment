import type { BatchStatus, BatchSummary, UrlCheck, UrlCheckStatus } from "@roaspy/shared";
import { pool } from "./db";

function toUrlCheck(row: any): UrlCheck {
  return {
    id: row.id,
    batchId: row.batch_id,
    url: row.url,
    status: row.status,
    httpStatus: row.http_status,
    responseMs: row.response_ms,
    pageTitle: row.page_title,
    error: row.error,
    attempt: row.attempt,
    updatedAt: row.updated_at.toISOString(),
  };
}

async function countsForBatch(batchId: string): Promise<BatchSummary["counts"]> {
  const { rows } = await pool.query(
    `SELECT status, count(*)::int AS count FROM urls WHERE batch_id = $1 GROUP BY status`,
    [batchId],
  );
  const counts = { total: 0, queued: 0, running: 0, succeeded: 0, failed: 0, cancelled: 0 };
  for (const row of rows) {
    counts[row.status as UrlCheckStatus] = row.count;
    counts.total += row.count;
  }
  return counts;
}

/** Returns just a batch's status, or `null` if it doesn't exist. Checked
 * by `processJob` before and after every job's HTTP call, to decide
 * whether to bail out for a batch that was cancelled while this job was
 * queued or in flight. */
export async function getBatchStatus(batchId: string): Promise<BatchStatus | null> {
  const { rows } = await pool.query(`SELECT status FROM batches WHERE id = $1`, [batchId]);
  return rows[0]?.status ?? null;
}

/** Returns batch status + aggregate counts without any URL rows, or
 * `null` if the batch doesn't exist. Used by `completeBatchIfDone` to
 * build the final `batch.updated` SSE event payload. */
export async function getBatchSummary(batchId: string): Promise<BatchSummary | null> {
  const { rows } = await pool.query(`SELECT id, status, created_at FROM batches WHERE id = $1`, [batchId]);
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    counts: await countsForBatch(batchId),
  };
}

/** Marks a URL row as actively being checked. Returns the updated row so
 * the caller can publish a `url.updated` SSE event for it. */
export async function markUrlRunning(urlId: string): Promise<UrlCheck> {
  const { rows } = await pool.query(
    `UPDATE urls SET status = 'running', updated_at = now() WHERE id = $1 RETURNING *`,
    [urlId],
  );
  return toUrlCheck(rows[0]);
}

/** Marks a URL row `cancelled` — called instead of `markUrlResult` when
 * `processJob` finds the batch was cancelled either before starting the
 * HTTP call or after it resolved, so a late-arriving response never
 * overwrites the cancelled state with a stale success/failure. */
export async function markUrlCancelled(urlId: string): Promise<UrlCheck> {
  const { rows } = await pool.query(
    `UPDATE urls SET status = 'cancelled', updated_at = now() WHERE id = $1 RETURNING *`,
    [urlId],
  );
  return toUrlCheck(rows[0]);
}

/** Writes a URL check's final result. Idempotent — keyed on `urlId`
 * (primary key) via `UPDATE ... WHERE id = $1`, not an insert — so
 * BullMQ redelivery of the same job (e.g. after a stalled-job requeue)
 * safely overwrites rather than double-applies. */
export async function markUrlResult(
  urlId: string,
  result: {
    status: "succeeded" | "failed";
    httpStatus: number | null;
    responseMs: number | null;
    pageTitle: string | null;
    error: string | null;
    attempt: number;
  },
): Promise<UrlCheck> {
  const { rows } = await pool.query(
    `UPDATE urls SET status = $2, http_status = $3, response_ms = $4, page_title = $5,
       error = $6, attempt = $7, updated_at = now()
     WHERE id = $1 RETURNING *`,
    [urlId, result.status, result.httpStatus, result.responseMs, result.pageTitle, result.error, result.attempt],
  );
  return toUrlCheck(rows[0]);
}

/** Marks the batch `done` if every one of its URL rows has reached a
 * terminal state (no longer `queued`/`running`). Called after each job
 * completes; cheap enough at this scale and avoids maintaining a separate
 * counter that could drift from the urls table. Returns `true` only on
 * the actual transition, so the caller knows whether to publish a final
 * `batch.updated` event. */
export async function maybeCompleteBatch(batchId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `SELECT count(*) FILTER (WHERE status IN ('queued', 'running'))::int AS pending
     FROM urls WHERE batch_id = $1`,
    [batchId],
  );
  if (rows[0].pending > 0) return false;

  const { rows: updated } = await pool.query(
    `UPDATE batches SET status = 'done' WHERE id = $1 AND status = 'running' RETURNING id`,
    [batchId],
  );
  return updated.length > 0;
}

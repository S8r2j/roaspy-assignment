import type { PoolClient } from "pg";
import { pool } from "./db";
import type { BatchDetail, BatchStatus, BatchSummary, UrlCheck, UrlCheckStatus } from "@roaspy/shared";

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

/** Persists a new batch and all of its URL rows in one transaction, then
 * flips the batch to `running`. Returns the new batch's id. Does not
 * enqueue any BullMQ jobs — the caller does that afterward, once this
 * write has committed, so the batch and its URLs always exist in Postgres
 * before any checking begins. */
export async function createBatch(urls: string[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query<{ id: string }>(
      `INSERT INTO batches (status) VALUES ('pending') RETURNING id`,
    );
    const batchId = rows[0].id;

    const values: string[] = [];
    const params: unknown[] = [];
    urls.forEach((url, i) => {
      params.push(batchId, url);
      values.push(`($${params.length - 1}, $${params.length})`);
    });
    await client.query(
      `INSERT INTO urls (batch_id, url) VALUES ${values.join(", ")}`,
      params,
    );

    await client.query(`UPDATE batches SET status = 'running' WHERE id = $1`, [batchId]);
    await client.query("COMMIT");
    return batchId;
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Returns one keyset-paginated page of batch summaries, newest first.
 * Ordered by `(created_at, id) DESC` — stable under concurrent inserts,
 * unlike offset/limit, which is what makes this safe to page through
 * while other batches are actively being created/updated. */
export async function listBatches(
  cursor: string | null,
  limit: number,
): Promise<{ batches: BatchSummary[]; nextCursor: string | null }> {
  let rows;
  if (cursor) {
    const [createdAt, id] = JSON.parse(Buffer.from(cursor, "base64").toString("utf8"));
    ({ rows } = await pool.query(
      `SELECT id, status, created_at FROM batches
       WHERE (created_at, id) < ($1, $2)
       ORDER BY created_at DESC, id DESC
       LIMIT $3`,
      [createdAt, id, limit],
    ));
  } else {
    ({ rows } = await pool.query(
      `SELECT id, status, created_at FROM batches ORDER BY created_at DESC, id DESC LIMIT $1`,
      [limit],
    ));
  }

  const batches: BatchSummary[] = await Promise.all(
    rows.map(async (row: any) => ({
      id: row.id,
      status: row.status,
      createdAt: row.created_at.toISOString(),
      counts: await countsForBatch(row.id),
    })),
  );

  let nextCursor: string | null = null;
  if (rows.length === limit) {
    const last = rows[rows.length - 1];
    nextCursor = Buffer.from(JSON.stringify([last.created_at.toISOString(), last.id])).toString("base64");
  }

  return { batches, nextCursor };
}

/** Number of URL rows returned per page by `getUrlsPage`/`getBatchDetail`. */
export const URLS_PAGE_SIZE = 25;

/** Returns one keyset-paginated page of a batch's URL rows, ordered by
 * `id` — stable (never changes for a row) rather than `updated_at` (which
 * changes constantly as jobs complete); keyset pagination needs an
 * ordering key that doesn't shift under the rows while a client is paging
 * through them. Used both by `getBatchDetail` (first page) and directly
 * by the `GET /batches/:id/urls` "load more" endpoint (later pages). */
export async function getUrlsPage(
  batchId: string,
  urlsCursor: string | null,
): Promise<{ urls: UrlCheck[]; urlsNextCursor: string | null }> {
  let urlRows;
  if (urlsCursor) {
    const lastId = Buffer.from(urlsCursor, "base64").toString("utf8");
    ({ rows: urlRows } = await pool.query(
      `SELECT * FROM urls WHERE batch_id = $1 AND id > $2 ORDER BY id ASC LIMIT $3`,
      [batchId, lastId, URLS_PAGE_SIZE],
    ));
  } else {
    ({ rows: urlRows } = await pool.query(
      `SELECT * FROM urls WHERE batch_id = $1 ORDER BY id ASC LIMIT $2`,
      [batchId, URLS_PAGE_SIZE],
    ));
  }

  let urlsNextCursor: string | null = null;
  if (urlRows.length === URLS_PAGE_SIZE) {
    urlsNextCursor = Buffer.from(urlRows[urlRows.length - 1].id).toString("base64");
  }

  return { urls: urlRows.map(toUrlCheck), urlsNextCursor };
}

/** Returns full batch detail — status, aggregate counts, and the first
 * (or requested) page of its URL rows — or `null` if the batch doesn't
 * exist. Backing the `GET /batches/:id` route. */
export async function getBatchDetail(
  batchId: string,
  urlsCursor: string | null,
): Promise<BatchDetail | null> {
  const { rows: batchRows } = await pool.query(
    `SELECT id, status, created_at FROM batches WHERE id = $1`,
    [batchId],
  );
  if (batchRows.length === 0) return null;
  const batch = batchRows[0];

  const { urls, urlsNextCursor } = await getUrlsPage(batchId, urlsCursor);

  return {
    id: batch.id,
    status: batch.status,
    createdAt: batch.created_at.toISOString(),
    counts: await countsForBatch(batchId),
    urls,
    urlsNextCursor,
  };
}

/** Returns batch status + aggregate counts without any URL rows, or
 * `null` if the batch doesn't exist. Used after cancel/retry to publish a
 * fresh `batch.updated` SSE event without paying for a full URL fetch. */
export async function getBatchSummary(batchId: string): Promise<BatchSummary | null> {
  const { rows } = await pool.query(
    `SELECT id, status, created_at FROM batches WHERE id = $1`,
    [batchId],
  );
  if (rows.length === 0) return null;
  const row = rows[0];
  return {
    id: row.id,
    status: row.status,
    createdAt: row.created_at.toISOString(),
    counts: await countsForBatch(batchId),
  };
}

/** Returns just a batch's status, or `null` if it doesn't exist. The
 * cheapest possible existence + state check — used by the worker before
 * and after every job's HTTP call to decide whether to bail out for a
 * cancelled batch, and by route handlers as a 404 guard. */
export async function getBatchStatus(batchId: string): Promise<BatchStatus | null> {
  const { rows } = await pool.query(`SELECT status FROM batches WHERE id = $1`, [batchId]);
  return rows[0]?.status ?? null;
}

/** Returns every URL row's id + url for a batch, unfiltered. Used to
 * enqueue BullMQ jobs on batch creation and to look up jobs on cancel. */
export async function listUrlIdsForBatch(batchId: string): Promise<{ id: string; url: string }[]> {
  const { rows } = await pool.query(`SELECT id, url FROM urls WHERE batch_id = $1`, [batchId]);
  return rows;
}

/** Returns only the URL rows currently in `failed` status for a batch —
 * exactly the set "Retry failed only" re-queues. Deliberately excludes
 * `cancelled` rows: cancel is final by design (see README), so this can
 * never resume an abandoned batch, only re-run genuine failures. */
export async function listFailedUrlsForBatch(batchId: string): Promise<{ id: string; url: string }[]> {
  const { rows } = await pool.query(
    `SELECT id, url FROM urls WHERE batch_id = $1 AND status = 'failed'`,
    [batchId],
  );
  return rows;
}

/** Records which BullMQ job id was enqueued for a given URL row. */
export async function setUrlJobId(urlId: string, jobId: string): Promise<void> {
  await pool.query(`UPDATE urls SET job_id = $1 WHERE id = $2`, [jobId, urlId]);
}

/** Resets a URL row back to `queued`, clearing any previous result —
 * used by "Retry failed only" before re-enqueueing a failed URL, so a
 * stale httpStatus/error from the prior attempt doesn't linger if the
 * retry itself never runs for some reason. */
export async function markUrlQueued(urlId: string): Promise<void> {
  await pool.query(
    `UPDATE urls SET status = 'queued', http_status = NULL, response_ms = NULL,
       page_title = NULL, error = NULL, updated_at = now() WHERE id = $1`,
    [urlId],
  );
}

/** Marks a URL row as actively being checked. Returns the updated row (or
 * `null` if the id doesn't exist) so the caller can publish a `url.updated`
 * SSE event for it. */
export async function markUrlRunning(urlId: string): Promise<UrlCheck | null> {
  const { rows } = await pool.query(
    `UPDATE urls SET status = 'running', updated_at = now() WHERE id = $1 RETURNING *`,
    [urlId],
  );
  return rows[0] ? toUrlCheck(rows[0]) : null;
}

/** Writes a URL check's final result. Idempotent — keyed on `urlId`
 * (primary key) via `UPDATE ... WHERE id = $1`, not an insert — so
 * redelivery of the same BullMQ job (e.g. after a stalled-job requeue)
 * safely overwrites rather than double-applying. */
export async function markUrlResult(
  urlId: string,
  result: {
    status: "succeeded" | "failed" | "cancelled";
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

/** Cancels a batch: marks the batch `cancelled` and every one of its
 * still-`queued`/`running` URL rows `cancelled`, in one transaction. Jobs
 * already removed from BullMQ (queued, not yet started) never write a
 * result at all; jobs mid-HTTP-call re-check the batch's status after
 * their request resolves and see `cancelled` here, so they write
 * `cancelled` instead of overwriting with a stale success/failure. */
export async function markBatchCancelled(batchId: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE batches SET status = 'cancelled' WHERE id = $1`, [batchId]);
    await client.query(
      `UPDATE urls SET status = 'cancelled', updated_at = now() WHERE batch_id = $1 AND status IN ('queued', 'running')`,
      [batchId],
    );
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/** Flips a batch back to `running` — used by "Retry failed only" to
 * revive a batch that had already reached `done`, since re-queuing at
 * least one URL means the batch is, by definition, no longer finished. */
export async function markBatchRunning(batchId: string): Promise<void> {
  await pool.query(`UPDATE batches SET status = 'running' WHERE id = $1`, [batchId]);
}

/** Marks the batch `done` if every one of its URL rows has reached a
 * terminal state (no longer `queued`/`running`). Called after each job
 * completes; cheap enough at this scale and avoids maintaining a separate
 * counter that could drift from the urls table. Returns `true` only on
 * the actual transition (so the caller knows whether to publish a final
 * `batch.updated` event), not on every call once already done. */
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

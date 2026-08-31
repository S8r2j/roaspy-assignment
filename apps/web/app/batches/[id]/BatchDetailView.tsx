"use client";

import { useEffect, useRef, useState } from "react";
import type { GetBatchResponse, SseEvent, UrlCheck, UrlCheckStatus } from "@roaspy/shared";
import { API_BASE_PUBLIC } from "../../../lib/api";
import { StatusBadge } from "../../StatusBadge";

/** True for batch statuses that can never change again on their own. */
function isTerminal(status: GetBatchResponse["status"]) {
  return status === "done" || status === "cancelled";
}

/** Live batch detail view: renders the server-rendered `initial` snapshot
 * immediately, then layers SSE-driven live updates on top of it (status
 * badge, progress bar, stat pills, and visible URL rows), plus cancel /
 * retry-failed controls and "load more" pagination for the URL table. */
export function BatchDetailView({ batchId, initial }: { batchId: string; initial: GetBatchResponse }) {
  const [batch, setBatch] = useState<GetBatchResponse>(initial);
  const [busy, setBusy] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  // Bumped to force the SSE effect to reconnect after "Retry failed only"
  // revives an already-finished batch — see the effect below.
  const [sseGeneration, setSseGeneration] = useState(0);
  // Per-URL last-known status, keyed by url id — lets a url.updated event
  // correctly move one count from its old bucket to its new one, for
  // every URL in the batch, not just whichever page is currently loaded
  // into batch.urls. Seeded from the server-rendered initial page so the
  // first SSE event has a real prior status to diff against, not "queued"
  // by default for a row that may already have settled by the time SSR ran.
  const urlStatusRef = useRef<Map<string, UrlCheckStatus>>(
    new Map(initial.urls.map((u) => [u.id, u.status])),
  );

  /** Re-fetches the first page of batch state from the API. Used both on
   * the initial SSE connect and on every reconnect, to reconcile anything
   * missed, since SSE itself has no gap-fill/replay. Intentionally
   * replaces `batch.urls` with just the first page — a full reconcile of
   * every page isn't needed to correct a short gap, and doing so would
   * reintroduce the large-payload cost pagination exists to avoid. */
  async function reconcile() {
    const res = await fetch(`${API_BASE_PUBLIC}/batches/${batchId}`, { cache: "no-store" });
    if (res.ok) {
      const fresh: GetBatchResponse = await res.json();
      setBatch(fresh);
      // A reconcile replaces batch.urls with a fresh first page, so any
      // per-URL status this component had tracked for rows outside that
      // page is now unverifiable — drop it and reseed from what's visible.
      // batch.counts (also refreshed here) remains the source of truth for
      // the aggregate until further url.updated events arrive.
      urlStatusRef.current = new Map(fresh.urls.map((u) => [u.id, u.status]));
    }
  }

  /** Fetches and appends the next page of the batch's URL rows, seeding
   * each new row's status into `urlStatusRef` so subsequent SSE events for
   * those rows can correctly diff against a real prior status. */
  async function loadMoreUrls() {
    if (!batch.urlsNextCursor) return;
    setLoadingMore(true);
    try {
      const res = await fetch(
        `${API_BASE_PUBLIC}/batches/${batchId}/urls?urlsCursor=${encodeURIComponent(batch.urlsNextCursor)}`,
        { cache: "no-store" },
      );
      if (res.ok) {
        const page: { urls: UrlCheck[]; urlsNextCursor: string | null } = await res.json();
        for (const u of page.urls) urlStatusRef.current.set(u.id, u.status);
        setBatch((prev) => ({ ...prev, urls: [...prev.urls, ...page.urls], urlsNextCursor: page.urlsNextCursor }));
      }
    } finally {
      setLoadingMore(false);
    }
  }

  /** Opens (and on `sseGeneration` bump, reopens) the batch's SSE
   * connection, applying incoming events to local state. Skipped entirely
   * for a batch already in a terminal state on mount — see inline
   * comments below for why, and for how counts are derived incrementally
   * rather than trusted from the rarely-published `batch.updated` event. */
  useEffect(() => {
    // A batch that was already done/cancelled when this page loaded can
    // never change again on its own — opening a live SSE connection for it
    // just holds a socket + a 15s heartbeat open for no reason. Only
    // "Retry failed only" can revive a finished batch, and that handler
    // bumps sseGeneration to open a connection at that point instead of
    // speculatively keeping one open the whole time.
    if (isTerminal(batch.status)) return;

    const source = new EventSource(`${API_BASE_PUBLIC}/batches/${batchId}/events`);

    // There is a real gap between the server-rendered `initial` snapshot
    // (fetched during SSR, before this component even mounted) and the
    // moment this EventSource finishes its handshake and the API subscribes
    // to Redis on our behalf. Any url.updated/batch.updated events published
    // in that gap are lost — SSE has no backlog/replay. So reconcile once
    // on every open, including the very first one, not just on reconnects.
    source.onopen = () => {
      reconcile();
    };

    source.onmessage = (msg) => {
      const event: SseEvent = JSON.parse(msg.data);
      if (event.type === "url.updated") {
        // batch.updated (which carries counts/status) is only published
        // once by the worker, on final batch completion — trusting it for
        // live progress would leave the progress bar/stat pills frozen at
        // their initial snapshot for the whole run. So counts are derived
        // here instead, incrementally, from every url.updated event —
        // for every URL in the batch, not just whichever page happens to
        // be loaded into batch.urls. This is the same approach already
        // used on the batches list page (BatchesTable.tsx).
        const perUrl = urlStatusRef.current;
        const prevStatus = perUrl.get(event.url.id) ?? "queued";
        perUrl.set(event.url.id, event.url.status);

        setBatch((prev) => {
          const idx = prev.urls.findIndex((u) => u.id === event.url.id);
          const urls = prev.urls;
          const nextUrls = idx >= 0 ? urls.map((u, i) => (i === idx ? event.url : u)) : urls;

          if (prevStatus === event.url.status) {
            return idx >= 0 ? { ...prev, urls: nextUrls } : prev;
          }
          const counts = { ...prev.counts };
          counts[prevStatus] = Math.max(0, counts[prevStatus] - 1);
          counts[event.url.status] += 1;
          return { ...prev, urls: nextUrls, counts };
        });
      } else if (event.type === "batch.updated") {
        setBatch((prev) => ({ ...prev, status: event.batch.status, counts: event.batch.counts }));
      }
    };

    return () => source.close();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, sseGeneration]);

  /** Calls the cancel endpoint, then reconciles to reflect the resulting
   * state. */
  async function cancelBatch() {
    setBusy(true);
    try {
      await fetch(`${API_BASE_PUBLIC}/batches/${batchId}/cancel`, { method: "POST" });
      await reconcile();
    } finally {
      setBusy(false);
    }
  }

  /** Calls the retry-failed endpoint, reconciles, and reopens the SSE
   * connection (via `sseGeneration`) since retrying can revive a batch
   * that had already reached a terminal state, and the effect above only
   * subscribes for non-terminal batches. */
  async function retryFailed() {
    setBusy(true);
    try {
      await fetch(`${API_BASE_PUBLIC}/batches/${batchId}/retry-failed`, { method: "POST" });
      await reconcile();
      // Retrying failed URLs flips a finished batch back to "running" —
      // reopen the SSE connection the effect above skipped for a
      // terminal batch, so progress on the retry is visible live again.
      setSseGeneration((g) => g + 1);
    } finally {
      setBusy(false);
    }
  }

  /** Copies a URL to the clipboard and briefly shows "Copied!" in its
   * place. Fails silently if the Clipboard API is unavailable — the full
   * URL is still visible via the row's `title` tooltip either way. */
  async function copyUrl(u: UrlCheck) {
    try {
      await navigator.clipboard.writeText(u.url);
      setCopiedId(u.id);
      setTimeout(() => setCopiedId((cur) => (cur === u.id ? null : cur)), 1500);
    } catch {
      // clipboard API unavailable; ignore silently, URL is still visible via title attr
    }
  }

  // batch.counts is the aggregate across ALL urls in the batch (from the
  // server), not just the page(s) currently loaded into batch.urls — this
  // is what stays accurate for the summary line/progress bar/stat pills
  // regardless of how many pages of the table have been loaded.
  const counts = batch.counts;
  const total = counts.total;
  // "Checked" (succeeded/failed only) rather than "settled" (which would
  // also include cancelled) — a batch cancelled 5% of the way through
  // should not read as "100% settled," since the other 95% were never
  // actually checked, just abandoned.
  const checked = counts.succeeded + counts.failed;
  const pct = total > 0 ? Math.round((checked / total) * 100) : 0;
  const canCancel = batch.status === "pending" || batch.status === "running";
  const canRetry = counts.failed > 0;

  // batch.status flips to "running" the moment a batch is created, before
  // any worker has actually picked up one of its jobs — batches share one
  // fixed worker pool and a single global rate limit, processed roughly
  // FIFO by submission order, so a batch can show "running" while 100% of
  // its URLs are still sitting queued behind an earlier batch's jobs.
  // Downgrade the display (not the underlying status) to "Queued" in that
  // case so the badge doesn't contradict a table that's visibly all-queued.
  const displayStatus = batch.status === "running" && total > 0 && counts.queued === total ? "queued" : batch.status;

  return (
    <main>
      {/* Plain <a>, not next/link: a client-side <Link> navigation back to
          "/" can render from Next's Router Cache instead of re-running the
          list page's server fetch, showing a stale batch list even with
          the route marked force-dynamic. A full browser navigation always
          re-fetches, so this is the reliable choice here. */}
      <a href="/" className="back-link">
        &larr; All batches
      </a>

      <div className="card">
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: "0.75rem" }}>
          <div>
            <h2 style={{ margin: "0 0 0.35rem" }}>Batch {batch.id.slice(0, 8)}</h2>
            <div style={{ display: "flex", alignItems: "center", gap: "0.6rem" }}>
              <StatusBadge status={displayStatus} />
              <span className="muted">
                {checked} / {total} checked ({pct}%)
              </span>
            </div>
          </div>
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <button
              onClick={cancelBatch}
              disabled={busy || !canCancel}
              className="btn btn-danger"
              title="Stop processing any URLs still queued or running"
            >
              Cancel batch
            </button>
            <button
              onClick={retryFailed}
              disabled={busy || !canRetry}
              className="btn btn-secondary"
              title="Re-queue only the URLs that failed"
            >
              Retry failed only
            </button>
          </div>
        </div>

        <div style={{ marginTop: "1rem" }}>
          <div
            className="progress-track"
            role="progressbar"
            aria-valuenow={pct}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Batch progress"
          >
            {total > 0 && (
              <>
                <div className="progress-seg progress-seg-succeeded" style={{ width: `${(counts.succeeded / total) * 100}%` }} />
                <div className="progress-seg progress-seg-failed" style={{ width: `${(counts.failed / total) * 100}%` }} />
                <div className="progress-seg progress-seg-cancelled" style={{ width: `${(counts.cancelled / total) * 100}%` }} />
                <div className="progress-seg progress-seg-running" style={{ width: `${(counts.running / total) * 100}%` }} />
              </>
            )}
          </div>

          <div className="stat-row" style={{ marginTop: "0.75rem" }}>
            <span className="stat-pill">
              <strong>{counts.succeeded}</strong> succeeded
            </span>
            <span className="stat-pill">
              <strong>{counts.failed}</strong> failed
            </span>
            <span className="stat-pill">
              <strong>{counts.running}</strong> running
            </span>
            <span className="stat-pill">
              <strong>{counts.queued}</strong> queued
            </span>
            {counts.cancelled > 0 && (
              <span className="stat-pill">
                <strong>{counts.cancelled}</strong> cancelled
              </span>
            )}
          </div>
        </div>
      </div>

      <h2>
        URLs ({batch.urls.length} of {total} loaded)
      </h2>
      <div className="table-scroll">
        <table>
          <thead>
            <tr>
              <th>URL</th>
              <th>Status</th>
              <th>HTTP</th>
              <th>Time (ms)</th>
              <th>Title</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {batch.urls.map((u: UrlCheck) => (
              <tr key={u.id}>
                <td className="url-cell">
                  <button
                    type="button"
                    className="url-copy"
                    title={`${u.url}\n\nClick to copy`}
                    onClick={() => copyUrl(u)}
                  >
                    {copiedId === u.id ? "Copied!" : u.url}
                  </button>
                </td>
                <td>
                  <StatusBadge status={u.status} />
                </td>
                <td>{u.httpStatus ?? "—"}</td>
                <td>{u.responseMs ?? "—"}</td>
                <td>{u.pageTitle ?? "—"}</td>
                <td className="error-text">{u.error ?? ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {batch.urlsNextCursor && (
        <div style={{ marginTop: "0.75rem" }}>
          <button onClick={loadMoreUrls} disabled={loadingMore} className="btn btn-secondary">
            {loadingMore ? "Loading…" : "Load more URLs"}
          </button>
        </div>
      )}
    </main>
  );
}

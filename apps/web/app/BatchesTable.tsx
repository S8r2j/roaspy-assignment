"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import type { BatchSummary, SseEvent, UrlCheckStatus } from "@roaspy/shared";
import { StatusBadge } from "./StatusBadge";
import { API_BASE_PUBLIC } from "../lib/api";

/** True for batch statuses that can never change again on their own. */
function isTerminal(status: BatchSummary["status"]) {
  return status === "done" || status === "cancelled";
}

/** Formats a batch's `createdAt` timestamp for display. Explicitly pinned
 * to `en-US`/UTC rather than `toLocaleString()` with no arguments, which
 * formats using the *host machine's* locale/timezone — different on the
 * server (container, UTC) than in the browser (local timezone). That
 * mismatch caused a React hydration error, which in Next dev mode forces
 * an expensive re-render of the affected subtree — the actual root cause
 * of batch pages once feeling like they took 10+ seconds to become
 * interactive, not a slow request. Explicit locale+timeZone makes the
 * output identical everywhere, so there's nothing to mismatch. */
function formatCreatedAt(iso: string): string {
  return new Date(iso).toLocaleString("en-US", { timeZone: "UTC" });
}

/** Computes the status badge to actually display for a batch, which can
 * differ from `batch.status` itself. `batch.status` flips to `"running"`
 * the moment a batch is created — it means "not finished yet," not "a
 * worker is actively on this batch's URLs right now." Because batches
 * share one fixed-size worker pool and a single global rate limit,
 * processed roughly FIFO by submission order, a batch can sit at status
 * `running` with zero URLs actually started while an earlier batch's jobs
 * are still ahead of it in the queue. Showing "Running" for that case
 * reads as broken, so the display downgrades to `"queued"` until at least
 * one of the batch's own URLs has left the queued state. */
function displayStatus(batch: BatchSummary): BatchSummary["status"] | "queued" {
  if (batch.status === "running" && batch.counts.queued === batch.counts.total) {
    return "queued";
  }
  return batch.status;
}

/** Renders the batches list table and keeps it live: every still-running
 * batch gets its own SSE subscription (the same transport the detail page
 * uses) so progress counts and status update in place without a page
 * reload, even though the list's own data was fetched once from the
 * API's 30s-cached `GET /batches` response. A batch's subscription closes
 * itself the moment it reaches a terminal state. */
export function BatchesTable({ batches: initialBatches }: { batches: BatchSummary[] }) {
  const [batches, setBatches] = useState<BatchSummary[]>(initialBatches);
  const sourcesRef = useRef<Map<string, EventSource>>(new Map());
  // Per-URL last-known status, keyed by url id, scoped under batch id — this
  // is what lets a url.updated event correctly move one count from its old
  // bucket to its new one instead of guessing.
  const urlStatusRef = useRef<Map<string, Map<string, UrlCheckStatus>>>(new Map());

  // The list page's own data comes from the API's 30s cache (per spec), so
  // its progress numbers can otherwise sit stale for up to 30s while a
  // batch is actively running — a bad look on a dashboard whose whole
  // point is watching progress. Rather than fight the cache (which is
  // correct per spec: only creation/terminal transitions must bust it, not
  // every incremental count change), each still-running batch shown here
  // gets its own SSE subscription — the same live-update path the detail
  // page already uses. Progress is derived from url.updated events (fired
  // on every single URL completion) rather than batch.updated (which the
  // worker only ever publishes once, on final completion) — same reasoning
  // as the detail page: trusting the sporadic aggregate event would leave
  // this stuck at its initial snapshot until the very last URL finishes.
  // A batch's subscription closes itself once batch.updated confirms a
  // terminal state; nothing stays open for batches already done/cancelled.
  useEffect(() => {
    const sources = sourcesRef.current;
    const urlStatus = urlStatusRef.current;

    for (const batch of batches) {
      if (isTerminal(batch.status) || sources.has(batch.id)) continue;

      const perUrl = new Map<string, UrlCheckStatus>();
      urlStatus.set(batch.id, perUrl);

      const source = new EventSource(`${API_BASE_PUBLIC}/batches/${batch.id}/events`);
      source.onmessage = (msg) => {
        const event: SseEvent = JSON.parse(msg.data);

        if (event.type === "url.updated") {
          // Every URL starts life as "queued" before this component has
          // seen any event about it — perUrl only records what's been
          // observed *since this SSE connection opened*, so a URL's first
          // observed transition must be treated as coming from "queued",
          // not from "no known prior state" (which would silently skip
          // decrementing counts.queued and leave it stuck at its initial
          // snapshot value forever, even as other counts correctly climb).
          const prevStatus = perUrl.get(event.url.id) ?? "queued";
          perUrl.set(event.url.id, event.url.status);
          if (prevStatus === event.url.status) return;
          setBatches((prev) =>
            prev.map((b) => {
              if (b.id !== batch.id) return b;
              const counts = { ...b.counts };
              counts[prevStatus] = Math.max(0, counts[prevStatus] - 1);
              counts[event.url.status] += 1;
              return { ...b, counts };
            }),
          );
        } else if (event.type === "batch.updated") {
          setBatches((prev) =>
            prev.map((b) => (b.id === batch.id ? { ...b, status: event.batch.status, counts: event.batch.counts } : b)),
          );
          if (isTerminal(event.batch.status)) {
            source.close();
            sources.delete(batch.id);
            urlStatus.delete(batch.id);
          }
        }
      };
      sources.set(batch.id, source);
    }

    return () => {
      for (const source of sources.values()) source.close();
      sources.clear();
      urlStatus.clear();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div className="card" style={{ padding: 0 }}>
      <table>
        <thead>
          <tr>
            <th>Batch</th>
            <th>Status</th>
            <th>Progress</th>
            <th>Created</th>
          </tr>
        </thead>
        <tbody>
          {batches.map((batch) => {
            // "Settled" means genuinely checked (succeeded or failed) —
            // cancelled rows were never actually checked, they were
            // abandoned mid-queue/mid-flight. Counting them as "settled"
            // made a batch stopped 5% of the way through still read as
            // "1000/1000 (100%)", which looks like a full, successful run
            // rather than one that was cut short.
            const checked = batch.counts.succeeded + batch.counts.failed;
            const pct = batch.counts.total > 0 ? Math.round((checked / batch.counts.total) * 100) : 0;
            return (
              <tr key={batch.id}>
                <td>
                  <Link href={`/batches/${batch.id}`}>{batch.id.slice(0, 8)}</Link>
                </td>
                <td>
                  <StatusBadge status={displayStatus(batch)} />
                </td>
                <td>
                  {batch.status === "cancelled" ? (
                    <span className="muted">
                      {checked} / {batch.counts.total} checked before cancelling ({pct}%)
                    </span>
                  ) : (
                    <>
                      <span>
                        {checked} / {batch.counts.total}
                      </span>{" "}
                      <span className="muted">({pct}%)</span>
                    </>
                  )}
                </td>
                <td className="muted">{formatCreatedAt(batch.createdAt)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

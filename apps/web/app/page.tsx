import type { ListBatchesResponse } from "@roaspy/shared";
import { apiBase } from "../lib/api";
import { BatchSubmitForm } from "./BatchSubmitForm";
import { BatchesTable } from "./BatchesTable";

/** Forces this route fully dynamic — no static generation, no client-side
 * Router Cache. Next's Router Cache can otherwise serve a stale render of
 * this route for up to 30s after a soft (`<Link>`) navigation away from
 * it, a separate cache from the `fetch()` below that `cache: "no-store"`
 * does not bypass. That produced a real bug: submit a batch, navigate to
 * its detail page, click back to the list via `<Link>`, and see the
 * pre-submission list until a hard refresh. Batches can appear/change at
 * any time, so this route should never render from a client-cached
 * snapshot. */
export const dynamic = "force-dynamic";

/** Fetches the first page of batches from the API. Intentionally
 * uncached on the Next.js side (`cache: "no-store"`) — the API's own 30s
 * Redis cache is the source of truth for freshness here, so layering a
 * second, uncoordinated cache on top of it would just add another place
 * for staleness to hide. */
async function fetchBatches(): Promise<ListBatchesResponse> {
  const res = await fetch(`${apiBase()}/batches`, { cache: "no-store" });
  if (!res.ok) throw new Error("Failed to load batches");
  return res.json();
}

/** Batches list page (`/`). A Server Component: fetches the first page of
 * batches server-side on every request (see `dynamic` above), then hands
 * off to `BatchesTable` (a Client Component) for live per-batch updates. */
export default async function BatchesListPage() {
  const { batches } = await fetchBatches();

  return (
    <main>
      <BatchSubmitForm />

      <h2>Batches</h2>
      {batches.length === 0 ? (
        <div className="empty-state">No batches yet. Submit URLs above to get started.</div>
      ) : (
        <BatchesTable batches={batches} />
      )}
    </main>
  );
}

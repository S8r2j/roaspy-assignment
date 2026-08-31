import { notFound } from "next/navigation";
import type { GetBatchResponse } from "@roaspy/shared";
import { apiBase } from "../../../lib/api";
import { BatchDetailView } from "./BatchDetailView";

/** Fetches a batch's detail (status, counts, first page of URLs) for the
 * given id, or `null` if it doesn't exist (404 from the API). */
async function fetchBatch(id: string): Promise<GetBatchResponse | null> {
  const res = await fetch(`${apiBase()}/batches/${id}`, { cache: "no-store" });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error("Failed to load batch");
  return res.json();
}

/** Batch detail page (`/batches/:id`). A Server Component: always fetches
 * full current state server-side before rendering, so a cold load (new
 * tab, no client state) is correct whether the batch is still running or
 * already finished. Hands off to `BatchDetailView` (a Client Component)
 * for live SSE updates layered on top of this initial snapshot. */
export default async function BatchDetailPage({ params }: { params: { id: string } }) {
  const initial = await fetchBatch(params.id);
  if (!initial) notFound();

  return <BatchDetailView batchId={params.id} initial={initial} />;
}

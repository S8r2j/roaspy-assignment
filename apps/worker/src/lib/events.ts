import type { SseEvent } from "@roaspy/shared";
import { redis, batchChannel } from "./redis";

/** Publishes a live-update event for a batch to Redis pub/sub. Called by
 * `processJob` on every state transition (running, succeeded, failed,
 * cancelled) and on final batch completion — any API instance with an
 * open SSE connection for this batch relays it to its client. */
export async function publishBatchEvent(batchId: string, event: SseEvent): Promise<void> {
  await redis.publish(batchChannel(batchId), JSON.stringify(event));
}

import type { SseEvent } from "@roaspy/shared";
import { redis, batchChannel } from "./redis";

/** Publishes a live-update event for a batch to Redis pub/sub. Any API
 * instance with an open SSE connection for this batch (from any browser)
 * relays it to its client — used by the API's own cancel/retry route
 * handlers (the worker has its own copy of this function for the same
 * purpose, since it publishes far more often, on every job transition). */
export async function publishBatchEvent(batchId: string, event: SseEvent): Promise<void> {
  await redis.publish(batchChannel(batchId), JSON.stringify(event));
}

import IORedis from "ioredis";
import { env } from "./env";

/** Creates a fresh Redis connection suitable for handing to a BullMQ
 * `Queue`/`Worker`. BullMQ requires `maxRetriesPerRequest: null` on
 * connections it manages, so this can't just reuse the general-purpose
 * `redis` client below. */
export function createBullMqConnection() {
  return new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
}

/** General-purpose Redis client for cache reads/writes and pub/sub
 * publish (not used for BullMQ). */
export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

/** Redis pub/sub channel name for a given batch's live events. Every API
 * instance's SSE connections for this batch subscribe here; the worker
 * publishes here on every state change. */
export function batchChannel(batchId: string) {
  return `batch:${batchId}:events`;
}

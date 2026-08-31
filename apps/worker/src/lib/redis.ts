import IORedis from "ioredis";
import { env } from "./env";

/** Creates a fresh Redis connection suitable for handing to the BullMQ
 * `Worker`. BullMQ requires `maxRetriesPerRequest: null` on connections it
 * manages, so this can't just reuse the general-purpose `redis` client
 * below. */
export function createBullMqConnection() {
  return new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
}

/** General-purpose Redis client for publishing batch/url update events
 * (not used for BullMQ). */
export const redis = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });

/** Redis pub/sub channel name for a given batch's live events. The
 * worker publishes here on every state change; API instances subscribe
 * here on behalf of connected SSE clients. */
export function batchChannel(batchId: string) {
  return `batch:${batchId}:events`;
}

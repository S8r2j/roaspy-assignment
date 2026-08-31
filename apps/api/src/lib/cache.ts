import { redis } from "./redis";

const TTL_SECONDS = 30;
const CACHE_KEY_PREFIX = "cache:batches:list:";
// Tracks which cache keys are currently live so they can all be busted on write.
const CACHE_KEYS_SET = "cache:batches:list:keys";

function cacheKey(cursor: string | null, limit: number) {
  return `${CACHE_KEY_PREFIX}${cursor ?? "first"}:${limit}`;
}

/** Returns the cached JSON response for `GET /batches` with this exact
 * cursor/limit, or `null` on a cache miss. */
export async function getCachedBatchList(cursor: string | null, limit: number): Promise<string | null> {
  return redis.get(cacheKey(cursor, limit));
}

/** Caches a `GET /batches` response for `TTL_SECONDS` and records its key
 * in `CACHE_KEYS_SET` so `invalidateBatchListCache` can find and clear it
 * on the next write. */
export async function setCachedBatchList(cursor: string | null, limit: number, payload: string): Promise<void> {
  const key = cacheKey(cursor, limit);
  await redis
    .multi()
    .set(key, payload, "EX", TTL_SECONDS)
    .sadd(CACHE_KEYS_SET, key)
    .exec();
}

/** Invalidates all cached list pages. Called on any batch creation or
 * terminal status transition so the 30s TTL never causes user-visible
 * staleness on those events — it only bounds staleness for in-flight
 * progress counts. */
export async function invalidateBatchListCache(): Promise<void> {
  const keys = await redis.smembers(CACHE_KEYS_SET);
  if (keys.length === 0) return;
  await redis.multi().del(...keys).del(CACHE_KEYS_SET).exec();
}

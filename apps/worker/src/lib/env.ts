/** Resolved runtime config for the worker process, with local-dev
 * fallbacks so it can start without a `.env` file when Postgres/Redis are
 * reachable at their default ports. */
export const env = {
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/roaspy",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
};

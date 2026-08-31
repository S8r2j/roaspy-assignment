/** Resolved runtime config for the API process, with local-dev fallbacks
 * so the app can start without a `.env` file when Postgres/Redis are
 * reachable at their default ports. */
export const env = {
  port: Number(process.env.PORT ?? 3001),
  databaseUrl: process.env.DATABASE_URL ?? "postgres://postgres:postgres@localhost:5432/roaspy",
  redisUrl: process.env.REDIS_URL ?? "redis://localhost:6379",
};

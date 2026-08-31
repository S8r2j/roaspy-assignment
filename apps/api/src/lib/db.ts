import pg from "pg";
import { env } from "./env";

/** Shared Postgres connection pool for the API process. `max: 20` (above
 * pg's default of 10) — see `apps/worker/src/lib/db.ts` for why: this pool
 * serves the batch detail page's query, which should never be waiting
 * behind other API requests for a free connection. `application_name`
 * makes this pool's connections identifiable in `pg_stat_activity`. */
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 20,
  application_name: "roaspy-api",
});

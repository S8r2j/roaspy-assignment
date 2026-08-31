import pg from "pg";
import { env } from "./env";

/** Shared Postgres connection pool for the worker process. `max: 20`
 * (above pg's default of 10) — with `concurrency: 5` and 2-4 sequential
 * queries per job lifecycle (mark running, mark result, batch-status
 * checks before/after the HTTP call), concurrent job processing can
 * briefly need more than 10 connections at once (observed spiking to 13
 * under load); once a pool hits its max, further queries queue for a
 * free connection rather than erroring. `application_name` makes this
 * pool's connections identifiable in `pg_stat_activity`. */
export const pool = new pg.Pool({
  connectionString: env.databaseUrl,
  max: 20,
  application_name: "roaspy-worker",
});

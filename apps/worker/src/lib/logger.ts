import pino from "pino";

/** Structured JSON logger for the worker process, matching the API's
 * built-in Fastify/pino logger so both processes' logs are consistently
 * shaped. Used for job lifecycle events (completed/failed) and for the
 * process-level crash handlers in `index.ts`, so an uncaught error leaves
 * a record before the container exits instead of just disappearing. */
export const logger = pino({
  level: process.env.LOG_LEVEL ?? "info",
});

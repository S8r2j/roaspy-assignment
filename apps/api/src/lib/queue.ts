import { Queue } from "bullmq";
import { URL_CHECK_QUEUE } from "@roaspy/shared";
import { createBullMqConnection } from "./redis";

export { URL_CHECK_QUEUE };

/** The API's handle on the shared url-checks queue, used to enqueue jobs
 * on batch submission/retry and to inspect job state on cancel. Retries
 * (3, exponential backoff) are set here as defaults; the actual global
 * rate limit and concurrency are configured on the `Worker` side
 * (`apps/worker/src/index.ts`), not here. */
export const urlCheckQueue = new Queue(URL_CHECK_QUEUE, {
  connection: createBullMqConnection(),
  defaultJobOptions: {
    attempts: 3,
    backoff: { type: "exponential", delay: 1000 },
    removeOnComplete: { age: 3600 },
    removeOnFail: { age: 86400 },
  },
});

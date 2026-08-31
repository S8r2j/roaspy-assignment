import type { FastifyInstance } from "fastify";
import IORedis from "ioredis";
import { z } from "zod";
import { env } from "../lib/env";
import { batchChannel } from "../lib/redis";
import * as repo from "../lib/batches.repo";

const uuidParamSchema = z.object({ id: z.string().uuid() });

/** Fastify plugin registering `GET /batches/:id/events`, the SSE stream a
 * batch's connected clients use for live updates. Bypasses Fastify's
 * normal response handling (writes directly to `reply.raw`) because a
 * long-lived streaming response doesn't fit the request/response model
 * `reply.send()` assumes — which is also why CORS headers have to be set
 * by hand here instead of via the `@fastify/cors` plugin. Each connection
 * gets its own dedicated Redis subscriber for the batch's pub/sub channel,
 * cleaned up when the client disconnects. */
export async function eventsRoutes(app: FastifyInstance) {
  app.get("/batches/:id/events", async (req, reply) => {
    const params = uuidParamSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: "Invalid batch id" });
    }
    const { id } = params.data;

    const batch = await repo.getBatchStatus(id);
    if (!batch) {
      return reply.code(404).send({ error: "Batch not found" });
    }

    // This route writes directly to reply.raw and never goes through
    // Fastify's normal send() path, so the @fastify/cors plugin's hooks
    // never run for it — CORS headers have to be set explicitly here.
    const origin = req.headers.origin;
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
      ...(origin ? { "Access-Control-Allow-Origin": origin, Vary: "Origin" } : {}),
    });
    // writeHead alone doesn't guarantee the headers hit the wire — Node can
    // hold them in the socket's internal buffer. Disable Nagle's algorithm
    // and force an explicit flush so the client's EventSource sees the
    // connection open immediately instead of hanging with zero bytes.
    reply.raw.socket?.setNoDelay(true);
    reply.raw.flushHeaders();

    // Send an initial comment immediately so the client's EventSource fires
    // onopen right away, rather than waiting for the first real event or
    // the first heartbeat tick (up to 15s away).
    reply.raw.write(`: connected\n\n`);

    // Dedicated subscriber connection per SSE client — ioredis subscribers
    // can't issue other commands, and this keeps client teardown isolated.
    const subscriber = new IORedis(env.redisUrl, { maxRetriesPerRequest: null });
    const channel = batchChannel(id);

    subscriber.on("message", (_channel, message) => {
      reply.raw.write(`data: ${message}\n\n`);
    });

    await subscriber.subscribe(channel);

    // Heartbeat comment so intermediary proxies/load balancers don't idle-time-out the connection.
    const heartbeat = setInterval(() => {
      reply.raw.write(`: heartbeat\n\n`);
    }, 15000);

    const cleanup = () => {
      clearInterval(heartbeat);
      subscriber.unsubscribe(channel).catch(() => {});
      subscriber.quit().catch(() => {});
    };

    req.raw.on("close", cleanup);
    reply.raw.on("close", cleanup);
  });
}

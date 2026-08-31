import Fastify from "fastify";
import cors from "@fastify/cors";
import multipart from "@fastify/multipart";
import { env } from "./lib/env";
import { batchRoutes } from "./routes/batches";
import { eventsRoutes } from "./routes/events";

const app = Fastify({
  logger: true,
  bodyLimit: 5 * 1024 * 1024, // 5MB cap on JSON/form bodies (pasted text)
});

await app.register(cors, { origin: true });
await app.register(multipart, {
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB cap on CSV uploads
});
await app.register(batchRoutes);
await app.register(eventsRoutes);

app.get("/health", async () => ({ ok: true }));

app
  .listen({ port: env.port, host: "0.0.0.0" })
  .then(() => app.log.info(`api listening on ${env.port}`))
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });

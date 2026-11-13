import { serve } from "@hono/node-server";
import { app } from "./app.ts";

// Lambda Web Functions pass the address to bind as host:port. The fallback is for local runs.
const [hostname = "localhost", port = "8081"] = (
  process.env.AWS_LAMBDA_HTTP_ENDPOINT ?? "localhost:8081"
).split(":");
const server = serve({ fetch: app.fetch, hostname, port: Number(port) });

process.on("SIGTERM", () => server.close(() => process.exit(0)));

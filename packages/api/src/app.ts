import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { authRoutes, requireSameOrigin, requireUser } from "./auth.ts";
import { createDeps, type Deps, type Env, log } from "./deps.ts";
import { apiRoutes } from "./routes.ts";

/**
 * Runtime-agnostic app: mounted by server.ts (Web Function) or lambda.ts (classic Lambda).
 * Dependencies load once per environment, on the first request that needs them.
 */
export function createApp(loadDeps: () => Promise<Deps>) {
  let pending: Promise<Deps> | undefined;
  const app = new Hono<Env>().basePath("/api");

  app.use(async (c, next) => {
    await next();
    // Everything under /api is per-user; never let a cache keep it.
    if (!c.res.headers.has("Cache-Control")) c.header("Cache-Control", "private, no-store");
    c.header("X-Content-Type-Options", "nosniff");
  });

  app.get("/health", (c) => c.json({ ok: true }));

  app.use(async (c, next) => {
    pending ??= loadDeps().catch((err) => {
      pending = undefined; // retry on the next request
      throw err;
    });
    c.set("deps", await pending);
    await next();
  });
  app.use(requireSameOrigin);
  app.route("/auth", authRoutes);
  app.use(requireUser);
  app.route("/", apiRoutes);

  app.notFound((c) => c.json({ error: "not found" }, 404));
  app.onError((err, c) => {
    if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
    log("error", "unhandled error", { method: c.req.method, path: c.req.path, error: String(err) });
    return c.json({ error: "internal error" }, 500);
  });
  return app;
}

export const app = createApp(createDeps);

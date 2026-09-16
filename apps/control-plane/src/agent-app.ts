import Fastify, { type FastifyError } from "fastify";
import { fastifyConnectPlugin } from "@connectrpc/connect-fastify";
import { agentRoutes } from "./rpc/index.js";

// No explicit return-type annotation: with http2 enabled below, Fastify's
// factory returns FastifyInstance<Http2Server, ...>, a different (and
// incompatible) instantiation of the generic from the plain FastifyInstance
// type buildApp() (the browser-facing server) uses — inference carries the
// real, http2-flavored type through instead of forcing a mismatched one.
//
// This is a *second*, separate Fastify instance from buildApp(), not an
// option on it: NodeService.Connect is a true bidirectional stream, which
// needs HTTP/2 framing. Browsers can't speak cleartext HTTP/2 (h2c) at all
// — they require TLS for HTTP/2 (ALPN negotiation) — so one HTTP/1.1,
// no-TLS port cannot also serve h2c. Agents, unlike browsers, are a
// controlled client (this control plane's own Go agent) that can dial h2c
// directly, so this server trades browser-compatibility for the simplest
// dev setup: no certificates. A production deployment can collapse this
// back to one TLS-terminated port with `allowHTTP1`, but that's for a
// later slice.
export async function buildAgentApp() {
  const app = Fastify({
    logger: { level: process.env.LOG_LEVEL ?? "info" },
    // Inventory reports travel over this server; the Fastify default
    // (1MiB) is too small for those payloads.
    bodyLimit: 4 * 1024 * 1024,
    http2: true,
  });

  await app.register(fastifyConnectPlugin, { routes: agentRoutes });

  app.setNotFoundHandler((req, reply) => {
    reply.code(404).send({ error: "not_found", path: req.url });
  });

  app.setErrorHandler<FastifyError>((err, req, reply) => {
    req.log.error({ err }, "agent request failed");
    const status = err.statusCode ?? 500;
    reply.code(status).send({
      error: status >= 500 ? "internal_error" : (err.code ?? "request_error"),
      message: status >= 500 ? "internal error" : err.message,
    });
  });

  return app;
}

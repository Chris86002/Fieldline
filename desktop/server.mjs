import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { AUTH_HEADER, HOST, PORT, assertResources, isAllowedRequest } from "./policy.mjs";

export async function startServer(root, token) {
  if (typeof token !== "string" || !/^[a-f0-9]{64}$/.test(token)) throw new Error("Invalid server token");
  assertResources(root);
  const { middleware } = await import(pathToFileURL(join(root, "server/index.mjs")).href);
  if (typeof middleware !== "function") throw new Error("Desktop build must use Nitro node-middleware");
  const server = createServer((request, response) => {
    if (!isAllowedRequest(request.headers, token)) {
      response.writeHead(403).end("Fieldline desktop only");
      return;
    }
    delete request.headers[AUTH_HEADER];
    middleware(request, response);
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 10_000;
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(PORT, HOST, resolve);
  });
  return server;
}

if (process.parentPort) {
  process.parentPort.once("message", async ({ data }) => {
    try {
      await startServer(data.root, data.token);
      process.parentPort.postMessage({ type: "ready" });
    } catch (error) {
      process.parentPort.postMessage({
        type: "error",
        code: error.code === "EADDRINUSE" ? "EADDRINUSE" : "START_FAILED",
      });
      process.exitCode = 1;
    }
  });
}

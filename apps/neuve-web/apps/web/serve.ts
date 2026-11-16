import { realpath } from "node:fs/promises"
import { join } from "node:path"
import { reviewFetch } from "./serve-handler"

const directory = process.argv[2]
const base = process.env.NEUVE_REVIEW_BASE
if (!directory || !base || !/^\/review\/[a-f0-9]{64}\/$/.test(base))
  throw new Error(
    "The built review server needs its build directory and project base"
  )
const client = await realpath(join(directory, "client"))
const entry = await import(join(directory, "server", "server.js"))
if (typeof entry.default?.fetch !== "function")
  throw new Error("The built review server has no fetch handler")

const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  idleTimeout: 0,
  fetch: reviewFetch(client, base, (request) => entry.default.fetch(request)),
})

for (const signal of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(signal, () => {
    void server.stop(true).then(() => process.exit(0))
  })
process.on("disconnect", () => {
  void server.stop(true).then(() => process.exit(0))
})
if (!process.send) {
  await server.stop(true)
  throw new Error("The built review server requires its workspace IPC channel")
}
process.send({
  kind: "review-ready",
  url: `http://127.0.0.1:${server.port}${base}`,
})

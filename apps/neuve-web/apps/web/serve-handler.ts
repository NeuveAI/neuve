import { realpath, stat } from "node:fs/promises"
import { resolve, sep } from "node:path"
import { withFramingPolicy } from "./src/server/framing"

// Vite enforces this in development. The built listener must enforce it before
// dispatching pages, server functions, events, or static files as well.
const LOOPBACK_HOSTS = /^(?:localhost|127\.0\.0\.1)(?::[0-9]+)?$/

/**
 * The built web app's request handling, shared by the workspace's review
 * server (serve.ts) and `neuve review desk`, which serves the installed desk
 * from the compiled CLI: loopback Host names only, paths under `base`, files
 * from `client` when one matches, and every other request to the app's own
 * server.
 */
export const reviewFetch =
  (
    client: string,
    base: string,
    fetch: (request: Request) => Response | Promise<Response>
  ) =>
  async (request: Request) => {
    if (!LOOPBACK_HOSTS.test(request.headers.get("host") ?? ""))
      return new Response("Forbidden", { status: 403 })
    const url = new URL(request.url)
    if (!url.pathname.startsWith(base))
      return new Response("Not found", { status: 404 })
    let path: string
    try {
      path = decodeURIComponent(url.pathname.slice(base.length))
    } catch {
      return new Response("Invalid path", { status: 400 })
    }
    if (
      path.includes("\\") ||
      path.includes("\0") ||
      path.split("/").includes("..")
    )
      return new Response("Forbidden", { status: 403 })
    if (request.method === "GET" || request.method === "HEAD") {
      const filePath = await realpath(resolve(client, path)).catch(
        () => undefined
      )
      if (filePath?.startsWith(client + sep)) {
        const file = Bun.file(filePath)
        if ((await stat(filePath)).isFile())
          return withFramingPolicy(
            new Response(request.method === "HEAD" ? null : file, {
              headers: {
                "Content-Type": file.type,
                "X-Content-Type-Options": "nosniff",
              },
            })
          )
      }
    }
    return fetch(request)
  }

import { defineConfig } from "vite"
import { devtools } from "@tanstack/devtools-vite"
import { tanstackStart } from "@tanstack/react-start/plugin/vite"
import viteReact from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

/**
 * The loopback names the BFF answers to (ID2). The dev server refuses any
 * other Host header, so a page on another name that resolves to 127.0.0.1
 * (DNS rebinding) cannot reach the server functions or read their answers.
 */
const LOOPBACK_HOSTS = ["localhost", "127.0.0.1"]

/**
 * Workspace packages the server loads from their own package instead of
 * bundling them (M5 S3). `@neuve/harness` finds the parser and the
 * semantic-client worker beside its own sources (`createRequire(import.meta
 * .url)`), so bundling it would change what a review request freezes and its
 * run key. Records' packages stay external with it, so the server holds one
 * copy of each.
 */
const SERVER_EXTERNAL = [
  "@neuve/harness",
  "@neuve/records-core",
  "@neuve/records-schema",
  "@neuve/review-rules",
]
/** The same packages and their subpath exports, for the server build's bundler. */
const SERVER_EXTERNAL_IDS = new RegExp(
  `^(?:${SERVER_EXTERNAL.map((name) => name.replace("/", "\\/")).join("|")})(?:/.*)?$`
)

const config = defineConfig({
  optimizeDeps: { holdUntilCrawlEnd: false },
  resolve: { tsconfigPaths: true, dedupe: ["react", "react-dom", "jotai"] },
  server: { host: "127.0.0.1", allowedHosts: LOOPBACK_HOSTS },
  preview: { host: "127.0.0.1", allowedHosts: LOOPBACK_HOSTS },
  ssr: { external: SERVER_EXTERNAL },
  // Vite externalizes only JavaScript files by itself, and these packages
  // export TypeScript, which Bun runs; the server build leaves them as imports.
  environments: {
    ssr: { build: { rolldownOptions: { external: [SERVER_EXTERNAL_IDS] } } },
  },
  plugins: [
    devtools({ consolePiping: { enabled: false } }),
    tailwindcss(),
    tanstackStart(),
    viteReact(),
  ],
})

export default config

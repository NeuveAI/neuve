import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin, type ViteDevServer } from "vite";

/**
 * The landing site: a static page. `vite build` writes the client assets to
 * dist/, `vite build --ssr` writes the renderer to dist-ssr/, and
 * scripts/prerender.ts fills dist/index.html with the rendered page and
 * writes dist/_headers. Nothing runs on a server.
 */
/** `vite dev` renders the page into index.html as the build does, so dev serves the real page. */
function renderInDev(): Plugin {
  let server: ViteDevServer | undefined;
  return {
    name: "neuve-website:render-in-dev",
    apply: "serve",
    configureServer(s) {
      server = s;
    },
    async transformIndexHtml(html) {
      if (!server) return html;
      const { render } = (await server.ssrLoadModule(
        "/src/entry-server.tsx",
      )) as { render: () => string };
      const { fill } = (await server.ssrLoadModule("/src/build/html.ts")) as {
        fill: (t: string, app: string) => string;
      };
      return fill(html, render());
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), renderInDev()],
  resolve: { dedupe: ["react", "react-dom"] },
  build: { outDir: "dist", emptyOutDir: true, assetsInlineLimit: 0 },
  server: { host: "127.0.0.1" },
  preview: { host: "127.0.0.1" },
});

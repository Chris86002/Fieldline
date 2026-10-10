import { defineConfig } from "vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { nitro } from "nitro/vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: 8080,
    strictPort: true,
  },
  preview: {
    host: "0.0.0.0",
    port: 8081,
    strictPort: true,
  },
  resolve: { tsconfigPaths: true },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    nitro({
      preset: process.env.FIELDLINE_DESKTOP_BUILD === "1" ? "node-middleware" : "node-server",
      ...(process.env.FIELDLINE_DESKTOP_BUILD === "1"
        ? {
            serveStatic: "node",
            output: { dir: ".desktop-output", serverDir: ".desktop-output/server", publicDir: ".desktop-output/public" },
          }
        : {}),
    }),
    viteReact(),
  ],
});

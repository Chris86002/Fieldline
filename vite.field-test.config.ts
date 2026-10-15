import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import viteReact from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

/**
 * Standalone build of the phone field-test page (CC-01):
 * `npm run field-test:build` writes plain static files to dist/field-test/,
 * which any HTTPS static host can serve (GitHub Pages via
 * .github/workflows/field-test-pages.yml). Relative URLs, so it works from a
 * sub-path such as https://<user>.github.io/Fieldline/. No server functions:
 * the field test only needs the browser, location and IndexedDB.
 */
const root = fileURLToPath(new URL("./src/features/field-test/static/", import.meta.url));
const icons = fileURLToPath(new URL("./public/icons/", import.meta.url));

function commit(): string {
  if (process.env.GITHUB_SHA) return process.env.GITHUB_SHA.slice(0, 12);
  try {
    return execFileSync("git", ["rev-parse", "--short=12", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Copies the app icons next to the page (manifest and home-screen icon). */
function appIcons(): Plugin {
  return {
    name: "fieldline-field-test-icons",
    generateBundle() {
      for (const name of ["fieldline-180.png", "fieldline-192.png", "fieldline-512.png"]) {
        this.emitFile({ type: "asset", fileName: `icons/${name}`, source: readFileSync(icons + name) });
      }
    },
  };
}

export default defineConfig({
  root,
  base: "./",
  publicDir: "public",
  resolve: { tsconfigPaths: true },
  define: {
    "import.meta.env.VITE_FIELDLINE_COMMIT": JSON.stringify(commit()),
  },
  build: {
    outDir: fileURLToPath(new URL("./dist/field-test/", import.meta.url)),
    emptyOutDir: true,
  },
  plugins: [tailwindcss(), viteReact(), appIcons()],
});

import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { assertResources } from "../desktop/policy.mjs";

const rootPackage = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const desktopPackage = JSON.parse(readFileSync(new URL("../desktop/package.json", import.meta.url), "utf8"));
if (rootPackage.version !== desktopPackage.version) throw new Error("Root and desktop package versions must match");
const result = spawnSync(process.execPath, ["node_modules/vite/bin/vite.js", "build"], {
  stdio: "inherit",
  env: { ...process.env, FIELDLINE_DESKTOP_BUILD: "1" },
});
if (result.error) throw result.error;
if (result.status !== 0) process.exit(result.status ?? 1);
assertResources(fileURLToPath(new URL("../.desktop-output/", import.meta.url)));

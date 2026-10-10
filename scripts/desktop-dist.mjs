import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createShareBundle } from "./desktop-bundle.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const platform =
  process.argv[2] ?? { win32: "win", darwin: "mac", linux: "linux" }[process.platform];
const nativePlatform = { win: "win32", mac: "darwin", linux: "linux" }[platform];
if (!nativePlatform || process.platform !== nativePlatform || process.argv.length > 3) {
  throw new Error("Build installers on the matching native OS: win, mac, or linux");
}
const arches =
  process.argv[2] === "mac" ? ["x64", "arm64"] : [process.argv[2] ? "x64" : process.arch];
if (arches.some((arch) => !["x64", ...(platform === "mac" ? ["arm64"] : [])].includes(arch))) {
  throw new Error("Unsupported native architecture");
}
const { version } = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
function run(script, args = [], env = process.env) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    cwd: root,
    env,
    stdio: "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${script} failed (${result.status})`);
}
run("scripts/desktop-build.mjs");
for (const arch of arches) {
  run("node_modules/electron-builder/cli.js", [`--${platform}`, `--${arch}`, "--publish", "never"]);
  const executable = {
    win: "win-unpacked/Fieldline.exe",
    mac: `${arch === "arm64" ? "mac-arm64" : "mac"}/Fieldline.app/Contents/MacOS/Fieldline`,
    linux: "linux-unpacked/fieldline",
  }[platform];
  run("scripts/desktop-smoke.mjs", [], {
    ...process.env,
    FIELDLINE_DESKTOP_EXECUTABLE: join(root, "release", executable),
  });
  console.log(
    await createShareBundle({ releaseDir: join(root, "release"), version, platform, arch }),
  );
}

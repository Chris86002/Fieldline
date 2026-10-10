import { createWriteStream } from "node:fs";
import { lstat, mkdir, readdir, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { pipeline } from "node:stream/promises";
import { randomUUID } from "node:crypto";
import yazl from "yazl";

const targets = {
  "win-x64": { extension: "exe", installer: "Install-Fieldline.exe" },
  "mac-x64": { extension: "dmg", installer: "Install-Fieldline.dmg" },
  "mac-arm64": { extension: "dmg", installer: "Install-Fieldline.dmg" },
  "linux-x64": { extension: "AppImage", installer: "Fieldline.AppImage" },
};
const root = fileURLToPath(new URL("../", import.meta.url));

export function startHere(platform, arch) {
  const steps = {
    win: `1. Right-click the ZIP and choose Extract All.
2. Open the extracted folder and double-click Install-Fieldline.exe.
3. Fieldline installs for you, adds shortcuts, and opens when finished.
Usually no administrator permission is needed.`,
    mac: `1. Double-click the ZIP to extract it.
2. Open Install-Fieldline.dmg and drag Fieldline to Applications.
3. Eject the disk, then open Fieldline from Applications.
This copy is for ${arch === "arm64" ? "Apple Silicon" : "Intel"} Macs.`,
    linux: `1. Extract the ZIP.
2. In Fieldline.AppImage's file properties, allow running as a program.
3. Open Fieldline.AppImage.
Linux may need FUSE and system libraries; ask your sender for help.`,
  };
  const warning = {
    win: "If Windows warns, approve only a trusted file via More info > Run anyway, if offered.",
    mac: "If macOS blocks it, approve only a trusted app in System Settings > Privacy & Security > Open Anyway, if allowed.",
    linux: "Only run a file from a sender you trust.",
  };
  return `Welcome to Fieldline!

${steps[platform]}

No Node, npm, developer tools, or GitHub account needed.
This app is unsigned. ${warning[platform]}
Keep security protections on. If blocked or unsure, ask your sender for help.

Maps, search, and weather need internet; this is not complete offline maps.
Your saved marks and tracks stay on this device; there is no cloud sync.
Export a GPX backup from Saved before updating or uninstalling.
`;
}

export async function createShareBundle({ releaseDir, version, platform, arch }) {
  const target = targets[`${platform}-${arch}`];
  if (!target) throw new Error(`Unsupported share target: ${platform}-${arch}`);
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error("Invalid bundle version");
  }
  const installerArch = platform === "linux" && arch === "x64" ? "x86_64" : arch;
  const expected = `Fieldline-${version}-${platform}-${installerArch}.${target.extension}`;
  const matches = (await readdir(releaseDir)).filter(
    (name) => name.toLowerCase() === expected.toLowerCase(),
  );
  if (matches.length !== 1 || matches[0] !== expected) {
    throw new Error(
      `Expected exactly one matching installer named ${expected}; found ${matches.length}`,
    );
  }
  const installerPath = join(releaseDir, expected);
  const stat = await lstat(installerPath);
  if (!stat.isFile() || stat.size === 0)
    throw new Error("Installer must be a nonempty regular file");

  const outputDir = join(releaseDir, "share");
  await mkdir(outputDir, { recursive: true });
  const output = join(outputDir, `Fieldline-${version}-${platform}-${arch}.zip`);
  const temporary = `${output}.${randomUUID()}.tmp`;
  const zip = new yazl.ZipFile();
  // Fixed DOS metadata avoids host timezone, source timestamp, and permission differences.
  const options = {
    mtime: new Date(2000, 0, 1),
    forceDosTimestamp: true,
    compress: false,
    mode: 0o100644,
  };
  zip.addFile(installerPath, target.installer, {
    ...options,
    mode: platform === "linux" ? 0o100755 : options.mode,
  });
  zip.addBuffer(Buffer.from(startHere(platform, arch), "utf8"), "START-HERE.txt", options);
  zip.on("error", (error) => zip.outputStream.destroy(error));
  zip.end();
  try {
    await pipeline(zip.outputStream, createWriteStream(temporary, { flags: "wx" }));
    await rename(temporary, output);
  } finally {
    await rm(temporary, { force: true });
  }
  return output;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: { platform: { type: "string" }, arch: { type: "string" } },
  });
  const { readFile } = await import("node:fs/promises");
  const { version } = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  console.log(await createShareBundle({ releaseDir: join(root, "release"), version, ...values }));
}

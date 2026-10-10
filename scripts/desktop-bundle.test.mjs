import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import unzipper from "unzipper";
import { createShareBundle } from "./desktop-bundle.mjs";

const version = "1.0.0";
async function fixture(t) {
  const releaseDir = await mkdtemp(join(tmpdir(), "fieldline-bundle-"));
  t.after(() => rm(releaseDir, { recursive: true, force: true }));
  return releaseDir;
}

test("each target ZIP contains only its matching installer and concise instructions", async (t) => {
  const releaseDir = await fixture(t);
  const targets = [
    ["win", "x64", "exe", "Install-Fieldline.exe"],
    ["mac", "x64", "dmg", "Install-Fieldline.dmg"],
    ["mac", "arm64", "dmg", "Install-Fieldline.dmg"],
    ["linux", "x64", "AppImage", "Fieldline.AppImage"],
  ];
  for (const [platform, arch, extension] of targets) {
    const installerArch = platform === "linux" ? "x86_64" : arch;
    await writeFile(
      join(releaseDir, `Fieldline-${version}-${platform}-${installerArch}.${extension}`),
      `${platform}-${arch}`,
    );
  }
  for (const name of [
    "builder-debug.yml",
    "source.zip",
    "Fieldline-0.9.0-win-x64.exe",
    "Fieldline-1.0.0-win-x64.exe.blockmap",
  ]) {
    await writeFile(join(releaseDir, name), "must not be shared");
  }
  await mkdir(join(releaseDir, "win-unpacked"));
  await writeFile(join(releaseDir, "win-unpacked", "profile"), "must not be shared");
  for (const [platform, arch, , installer] of targets) {
    const output = await createShareBundle({ releaseDir, version, platform, arch });
    assert.equal(output, join(releaseDir, "share", `Fieldline-${version}-${platform}-${arch}.zip`));
    const zip = await unzipper.Open.file(output);
    assert.deepEqual(
      zip.files.map((file) => file.path),
      [installer, "START-HERE.txt"],
    );
    assert.equal((await zip.files[0].buffer()).toString(), `${platform}-${arch}`);
    const instructions = (await zip.files[1].buffer()).toString();
    assert.match(instructions, /internet/);
    assert.match(instructions, /GPX backup/);
    assert.match(instructions, /Keep security protections on/);
    assert.ok(instructions.split("\n").length < 22);
    if (platform === "win")
      assert.match(
        instructions,
        /Extract All[\s\S]*Install-Fieldline.exe[\s\S]*opens when finished/,
      );
    if (platform === "mac") {
      assert.match(instructions, /drag Fieldline to Applications/);
      assert.match(instructions, arch === "arm64" ? /Apple Silicon/ : /Intel/);
    }
    if (platform === "linux") {
      assert.match(instructions, /FUSE/);
      assert.equal((zip.files[0].externalFileAttributes >>> 16) & 0o777, 0o755);
    }
    assert.equal(zip.files[0].compressionMethod, 0);
  }
});

test("identical bytes produce identical archives despite source timestamp and host timezone", async (t) => {
  const releaseDir = await fixture(t);
  const installer = join(releaseDir, `Fieldline-${version}-win-x64.exe`);
  await writeFile(installer, "installer bytes");
  const options = { releaseDir, version, platform: "win", arch: "x64" };
  const output = await createShareBundle(options);
  const first = await readFile(output);
  await utimes(installer, new Date(), new Date());
  const moduleUrl = new URL("./desktop-bundle.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `import {createShareBundle} from ${JSON.stringify(moduleUrl)}; await createShareBundle(${JSON.stringify(options)});`,
    ],
    { env: { ...process.env, TZ: "Pacific/Honolulu" }, encoding: "utf8" },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(await readFile(output), first);
});

test("rejects unsupported targets, unsafe versions, missing, ambiguous, and invalid installers", async (t) => {
  const releaseDir = await fixture(t);
  const options = { releaseDir, version, platform: "win", arch: "x64" };
  for (const overrides of [
    { platform: "other" },
    { arch: "arm64" },
    { platform: "../win" },
    { version: "../1.0.0" },
  ]) {
    await assert.rejects(createShareBundle({ ...options, ...overrides }), /Unsupported|Invalid/);
  }
  await writeFile(join(releaseDir, "Fieldline-1.0.0-mac-x64.dmg"), "wrong platform");
  await assert.rejects(createShareBundle(options), /exactly one matching/);
  const installer = join(releaseDir, "Fieldline-1.0.0-win-x64.exe");
  await writeFile(installer, "");
  await assert.rejects(createShareBundle(options), /nonempty regular file/);
  await rm(installer);
  await mkdir(installer);
  await assert.rejects(createShareBundle(options), /nonempty regular file/);
  await rm(installer, { recursive: true });
  if (process.platform !== "win32") {
    await symlink(join(releaseDir, "Fieldline-1.0.0-mac-x64.dmg"), installer);
    await assert.rejects(createShareBundle(options), /nonempty regular file/);
    await rm(installer);
    await writeFile(installer, "installer");
    const alternate = join(releaseDir, "fieldline-1.0.0-win-x64.exe");
    await writeFile(alternate, "ambiguous installer");
    const names = await (await import("node:fs/promises")).readdir(releaseDir);
    if (
      names.includes("fieldline-1.0.0-win-x64.exe") &&
      names.includes("Fieldline-1.0.0-win-x64.exe")
    ) {
      await assert.rejects(createShareBundle(options), /exactly one matching.*found 2/);
    }
  }
});

test("Windows installer remains self-contained, one-click, per-user, and data-preserving", async () => {
  const { build } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(build.appId, "org.fieldline.desktop");
  assert.deepEqual(build.win.target, ["nsis"]);
  for (const option of [
    "oneClick",
    "runAfterFinish",
    "createDesktopShortcut",
    "createStartMenuShortcut",
  ]) {
    assert.equal(build.nsis[option], true, option);
  }
  for (const option of [
    "perMachine",
    "allowElevation",
    "allowToChangeInstallationDirectory",
    "deleteAppDataOnUninstall",
  ]) {
    assert.equal(build.nsis[option], false, option);
  }
});

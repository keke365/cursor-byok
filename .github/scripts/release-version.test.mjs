import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { releaseDownloadNotes } from "./release-downloads.mjs";
import { normalizeTauriUpdate } from "./normalize-tauri-update.mjs";

const script = fileURLToPath(new URL("release-version.mjs", import.meta.url));
const fixture = {
  "apps/desktop/package.json": '{"name":"cursor-byok-desktop","version":"2.1.0","dependencies":{"example":"^1.0.0"}}\n',
  "apps/desktop/package-lock.json": '{"version":"2.1.0","lockfileVersion":3,"packages":{"":{"name":"cursor-byok-desktop","version":"2.1.0"},"node_modules/example":{"version":"1.0.0"}}}\n',
  "apps/desktop/src-tauri/tauri.conf.json": '{"version":"2.1.0","productName":"Cursor BYOK"}\n',
  "apps/desktop/src-tauri/Cargo.toml": '[package]\nname = "cursor-byok-desktop"\nversion = "2.1.0"\n\n[dependencies]\nexample = "1.0.0"\n',
  "Cargo.lock": '# Generated lockfile\nversion = 4\n\n[[package]]\nname = "before"\nversion = "1.0.0"\n\n[[package]]\nname = "cursor-byok-desktop"\nversion = "2.1.0"\ndependencies = ["example"]\n\n[[package]]\nname = "cursor-server"\nversion = "0.1.0"\n',
};

async function checkout(t, files = fixture) {
  const root = await mkdtemp(join(tmpdir(), "release-version-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}

function run(root, tag, mode = "--write", prerelease = "false") {
  return execFileSync(process.execPath, [script, mode], {
    cwd: root,
    env: { ...process.env, RELEASE_TAG: tag, IS_PRERELEASE: prerelease },
    encoding: "utf8",
  }).trim();
}

async function snapshot(root) {
  return Object.fromEntries(await Promise.all(Object.keys(fixture).map(async (file) => [
    file, await readFile(join(root, file), "utf8"),
  ])));
}

for (const version of ["2.1.1", "12.34.56", "3.0.0-beta.2", "3.0.0-rc-test.1"]) {
  test(`fresh platform checkouts derive every desktop version from v${version}`, async (t) => {
    const root = await checkout(t);
    assert.equal(run(root, `v${version}`), version);
    const files = await snapshot(root);
    for (const file of ["apps/desktop/package.json", "apps/desktop/package-lock.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
      assert.equal(JSON.parse(files[file]).version, version);
    }
    const lock = JSON.parse(files["apps/desktop/package-lock.json"]);
    assert.equal(lock.packages[""].version, version);
    assert.equal(lock.packages["node_modules/example"].version, "1.0.0");
    assert.deepEqual(JSON.parse(files["apps/desktop/package.json"]).dependencies, { example: "^1.0.0" });
    for (const file of ["Cargo.lock", "apps/desktop/src-tauri/Cargo.toml"]) {
      assert.equal(files[file], fixture[file].replace('version = "2.1.0"', `version = "${version}"`));
    }
    run(root, `v${version}`);
    assert.deepEqual(await snapshot(root), files, "repeated synchronization is idempotent");
  });
}

test("prepare validates a tag without modifying files or reading their old versions", async (t) => {
  const root = await checkout(t);
  assert.equal(run(root, "v9.8.7", "--check"), "9.8.7");
  assert.deepEqual(await snapshot(root), fixture);
});

test("invalid tags, GitHub prereleases, and unknown modes fail without changing files", async (t) => {
  const root = await checkout(t);
  for (const [tag, prerelease, mode] of [
    ["2.1.1", "false"], ["v2.1", "false"], ["vv2.1.1", "false"],
    ["v02.1.1", "false"], ["v2.1.1-beta..1", "false"], ["v2.1.1-beta.01", "false"],
    ["v2.1.1+build.1", "false"], ["v2.1.1\n", "false"], ["v2.1.1';process.exit()", "false"],
    ["", "false"], ["v2.1.1", "true"], ["v2.1.1-beta.1", "true"],
    ["v2.1.1", ""], ["v2.1.1", "false", "--unknown"],
  ]) {
    const result = spawnSync(process.execPath, [script, mode ?? "--write"], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: tag, IS_PRERELEASE: prerelease },
      encoding: "utf8",
    });
    assert.equal(result.status, 1, `${tag}/${prerelease}/${mode}: ${result.stderr}`);
    assert.match(result.stderr, /tag|normal GitHub Release|Usage/);
    assert.deepEqual(await snapshot(root), fixture);
  }
});

test("invalid manifest structure fails before writing any file", async (t) => {
  for (const [file, content] of [
    ["Cargo.lock", fixture["Cargo.lock"].replace('name = "cursor-byok-desktop"', 'name = "other"')],
    ["Cargo.lock", fixture["Cargo.lock"] + '\n[[package]]\nname = "cursor-byok-desktop"\nversion = "1.0.0"\n'],
    ["apps/desktop/src-tauri/Cargo.toml", fixture["apps/desktop/src-tauri/Cargo.toml"].replace('version = "2.1.0"', 'version.workspace = true')],
    ["apps/desktop/package-lock.json", '{"version":"2.1.0","packages":{}}\n'],
  ]) {
    const files = { ...fixture, [file]: content };
    const root = await checkout(t, files);
    const result = spawnSync(process.execPath, [script, "--write"], {
      cwd: root,
      env: { ...process.env, RELEASE_TAG: "v2.1.1", IS_PRERELEASE: "false" },
      encoding: "utf8",
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /desktop|version|package/i);
    assert.deepEqual(await snapshot(root), files);
  }
});

test("preserves Windows CRLF line endings in Cargo files", async (t) => {
  const files = Object.fromEntries(Object.entries(fixture).map(([file, content]) => [file, content.replaceAll("\n", "\r\n")]));
  const root = await checkout(t, files);
  run(root, "v2.1.1");
  for (const file of ["Cargo.lock", "apps/desktop/src-tauri/Cargo.toml"]) {
    assert.equal(await readFile(join(root, file), "utf8"), files[file].replace('version = "2.1.0"', 'version = "2.1.1"'));
  }
});

test("actual repository manifests and downstream release metadata agree with arbitrary tags", async (t) => {
  const files = Object.fromEntries(await Promise.all(Object.keys(fixture).map(async (file) => [
    file, await readFile(new URL(`../../${file}`, import.meta.url), "utf8"),
  ])));
  const root = await checkout(t, files);
  for (const version of ["12.34.56", "12.34.57-beta.1"]) {
    assert.equal(run(root, `v${version}`), version);
    const updated = await snapshot(root);
    for (const file of ["Cargo.lock", "apps/desktop/src-tauri/Cargo.toml"]) {
      const expected = files[file].replace(
        /(name = "cursor-byok-desktop"\r?\nversion = ")[^"]+("\r?\n)/,
        `$1${version}$2`,
      );
      assert.notEqual(expected, files[file]);
      assert.equal(updated[file], expected, "only desktop package version changes");
    }
    for (const file of ["apps/desktop/package.json", "apps/desktop/package-lock.json", "apps/desktop/src-tauri/tauri.conf.json"]) {
      const expected = JSON.parse(files[file]);
      expected.version = version;
      if (file.endsWith("package-lock.json")) expected.packages[""].version = version;
      assert.deepEqual(JSON.parse(updated[file]), expected);
    }
    const release = {
      tag_name: `v${version}`,
      assets: ["_amd64.deb", "_x64-setup.exe"].map((suffix, index) => ({
        id: index + 1,
        name: `Cursor.BYOK_${version}${suffix}`,
        size: 100,
        state: "uploaded",
        browser_download_url: `https://github.com/owner/repo/releases/download/v${version}/Cursor.BYOK_${version}${suffix}`,
      })),
    };
    assert.ok(releaseDownloadNotes(release, version).includes(`/v${version}/`));
    const manifest = normalizeTauriUpdate({
      version: JSON.parse(updated["apps/desktop/src-tauri/tauri.conf.json"]).version,
      platforms: { "windows-x86_64": { signature: "test-signature", url: release.assets[1].browser_download_url } },
    }, release, "owner/repo", version);
    assert.equal(manifest.version, version);
    assert.equal(manifest.platforms["windows-x86_64"].url, release.assets[1].browser_download_url);
  }
});

test("release workflow synchronizes each independent build before npm and Tauri", async () => {
  const workflow = (await readFile(new URL("../workflows/release.yml", import.meta.url), "utf8")).replaceAll("\r\n", "\n");
  const prepare = workflow.split("  prepare:\n")[1].split("\n  publish:")[0];
  const publish = workflow.split("  publish:\n")[1].split("\n  finalize:")[0];
  assert.match(prepare, /node \.github\/scripts\/release-version\.mjs --check/);
  assert.match(publish, /RELEASE_TAG: \$\{\{ github\.event\.release\.tag_name \}\}/);
  assert.match(publish, /IS_PRERELEASE: \$\{\{ github\.event\.release\.prerelease \}\}/);
  const sync = publish.indexOf("node .github/scripts/release-version.mjs --write");
  assert.ok(sync > publish.indexOf("uses: actions/checkout@v4"));
  assert.ok(sync > publish.indexOf("uses: actions/setup-node@v4"));
  assert.ok(sync < publish.indexOf("run: npm ci"));
  assert.ok(sync < publish.indexOf("uses: tauri-apps/tauri-action@v1"));
  assert.doesNotMatch(workflow, /BASH_REMATCH|sed -i|awk -v/);
});

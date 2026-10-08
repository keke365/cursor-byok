import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { releaseConfig } from "./release-config.mjs";

const workflow = await readFile(new URL("../workflows/release.yml", import.meta.url), "utf8");

test("publishing a Release triggers builds even when it already exists", () => {
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
  assert.doesNotMatch(workflow, /should_publish|already published|on:\s*\n\s+push:/);
  assert.match(workflow, /releaseId: \$\{\{ github\.event\.release\.id \}\}/);
  assert.match(workflow, /args: "--bundles deb,appimage,rpm"/);
  assert.match(workflow, /args: "--bundles nsis"/);
  assert.match(workflow, /Verify required installers/);
});

test("download and update endpoints use the current repository", async () => {
  const config = JSON.parse(await readFile(new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.deepEqual(config.plugins.updater.endpoints, [
    "https://github.com/keke365/cursor-byok/releases/latest/download/latest.json",
  ]);
  const portable = await readFile(new URL("../../apps/desktop/src-tauri/src/update/mod.rs", import.meta.url), "utf8");
  assert.match(portable, /const PORTABLE_UPDATE_ENDPOINT: &str =\s*"https:\/\/github.com\/keke365\/cursor-byok\/releases\/latest\/download\/portable-latest.json"/);
});

test("unsigned installers do not require updater signing secrets", async () => {
  const base = JSON.parse(await readFile(new URL("../../apps/desktop/src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  assert.equal(base.bundle.createUpdaterArtifacts, false);
  assert.equal(base.plugins.updater.pubkey, "");
  const config = releaseConfig({ signingKeyConfigured: false, publicKey: "" });
  assert.equal(config.bundle.createUpdaterArtifacts, false);
  assert.equal(config.plugins.updater.pubkey, "");
  assert.match(workflow, /uploadUpdaterJson: \$\{\{ needs\.prepare\.outputs\.signing_enabled == 'true' \}\}/);
});

test("signed builds use this repository's public key", () => {
  const config = releaseConfig({ signingKeyConfigured: true, publicKey: " public-key\n" });
  assert.equal(config.bundle.createUpdaterArtifacts, true);
  assert.equal(config.plugins.updater.pubkey, "public-key");
});

test("installer verification rejects missing, empty, and wrong-version assets", () => {
  const source = workflow.match(/node --input-type=module <<'NODE'\n([\s\S]*?)\n\s+NODE/)[1];
  const body = source.replace(/^\s*import .*;\n/m, "");
  const verify = (assets) => runInNewContext(body, {
    readFileSync: () => JSON.stringify({ assets }),
    process: { env: { VERSION: "1.0.1" } },
  });
  const assets = [
    { name: "Cursor BYOK_1.0.1_amd64.deb", size: 100 },
    { name: "Cursor BYOK_1.0.1_x64-setup.exe", size: 100 },
  ];
  assert.doesNotThrow(() => verify(assets));
  assert.throws(() => verify(assets.slice(0, 1)), /Missing or empty installer/);
  assert.throws(() => verify([{ ...assets[0], size: 0 }, assets[1]]), /Missing or empty installer/);
  assert.throws(() => verify([{ ...assets[0], name: "Cursor BYOK_1.0.0_amd64.deb" }, assets[1]]), /Missing or empty installer/);
});

test("rejects incomplete signing configuration", () => {
  assert.throws(() => releaseConfig({ signingKeyConfigured: true, publicKey: "" }), /TAURI_SIGNING_PUBLIC_KEY/);
  assert.throws(() => releaseConfig({ signingKeyConfigured: false, publicKey: "public-key" }), /TAURI_SIGNING_PRIVATE_KEY/);
});

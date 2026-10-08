import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
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

test("download notes are published after uploads and only after all builds succeed", () => {
  assert.match(workflow, /needs: \[prepare, publish\]\s+if: needs\.publish\.result == 'success'/);
  const upload = workflow.indexOf('run: gh release upload "v${VERSION}" legacy-update/* --clobber');
  const generate = workflow.indexOf('node .github/scripts/release-downloads.mjs release-assets.json "${VERSION}" release-notes.md');
  const publish = workflow.indexOf('gh release edit "v${VERSION}" --notes-file release-notes.md --latest');
  assert.ok(upload !== -1 && generate > upload && publish > generate);
  assert.match(workflow, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/releases\/\$\{RELEASE_ID\}" > release-assets\.json/);
});

test("rejects incomplete signing configuration", () => {
  assert.throws(() => releaseConfig({ signingKeyConfigured: true, publicKey: "" }), /TAURI_SIGNING_PUBLIC_KEY/);
  assert.throws(() => releaseConfig({ signingKeyConfigured: false, publicKey: "public-key" }), /TAURI_SIGNING_PRIVATE_KEY/);
});

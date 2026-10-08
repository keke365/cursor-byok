import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { releaseDownloadNotes } from "./release-downloads.mjs";

function release(body = "## 更新内容\n\n保留手写说明。\n") {
  return {
    tag_name: "v1.0.1",
    body,
    assets: ["_amd64.deb", "_x64-setup.exe"].map((suffix) => ({
      name: `Cursor.BYOK_1.0.1${suffix}`,
      size: 100,
      state: "uploaded",
      browser_download_url: `https://github.com/keke365/cursor-byok/releases/download/v1.0.1/Cursor.BYOK_1.0.1${suffix}`,
    })),
  };
}

test("prepends direct links from uploaded release assets and preserves notes", () => {
  const data = release();
  const notes = releaseDownloadNotes(data, "1.0.1");
  assert.match(notes, /## 安装包下载/);
  for (const asset of data.assets) assert.ok(notes.includes(`(${asset.browser_download_url})`));
  assert.ok(notes.endsWith(data.body));
  assert.ok(notes.indexOf("## 安装包下载") < notes.indexOf("## 更新内容"));
  assert.match(notes, /Linux x86_64.*\.deb/);
  assert.match(notes, /Windows x64.*\.exe/);
});

test("reruns replace only the generated section without duplicating links", () => {
  const data = release();
  const first = releaseDownloadNotes(data, "1.0.1");
  assert.equal(releaseDownloadNotes({ ...data, body: first }, "1.0.1"), first);
  data.assets[0].browser_download_url += "?download=1";
  const next = releaseDownloadNotes({ ...data, body: first }, "1.0.1");
  assert.ok(next.includes(".deb?download=1"));
  assert.equal(next.match(/## 安装包下载/g).length, 1);
  assert.ok(next.endsWith(data.body));
});

test("supports an empty Release body", () => {
  assert.match(releaseDownloadNotes(release(null), "1.0.1"), /## 安装包下载/);
});

test("rejects missing, empty, incomplete, wrong-version and signature-only assets", () => {
  const data = release();
  assert.throws(() => releaseDownloadNotes({ ...data, assets: [] }, "1.0.1"), /installer/);
  for (const patch of [{ size: 0 }, { state: "starter" }, { name: "Cursor.BYOK_1.0.0_amd64.deb" }, { name: "Cursor.BYOK_1.0.1_amd64.deb.sig" }]) {
    assert.throws(() => releaseDownloadNotes({ ...data, assets: [{ ...data.assets[0], ...patch }, data.assets[1]] }, "1.0.1"), /installer/);
  }
  assert.throws(() => releaseDownloadNotes({ ...data, tag_name: "v2.0.0" }, "1.0.1"), /tag/);
});

test("rejects absent or unsafe download URLs and broken section markers", () => {
  const data = release();
  for (const url of [undefined, "javascript:alert(1)", "https://example.com/file\n)"]) {
    assert.throws(() => releaseDownloadNotes({ ...data, assets: [{ ...data.assets[0], browser_download_url: url }, data.assets[1]] }, "1.0.1"), /URL/);
  }
  assert.throws(() => releaseDownloadNotes(release("Notes\n<!-- installer-downloads:start -->"), "1.0.1"), /markers/);
});

test("CLI generates the notes file consumed by the release workflow", async () => {
  const dir = await mkdtemp(join(tmpdir(), "release-downloads-"));
  try {
    const input = join(dir, "release.json");
    const output = join(dir, "notes.md");
    await writeFile(input, JSON.stringify(release()));
    execFileSync(process.execPath, [new URL("release-downloads.mjs", import.meta.url).pathname, input, "1.0.1", output]);
    assert.equal(await readFile(output, "utf8"), releaseDownloadNotes(release(), "1.0.1"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

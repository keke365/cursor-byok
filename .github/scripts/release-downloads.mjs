import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const start = "<!-- installer-downloads:start -->";
const end = "<!-- installer-downloads:end -->";

export function releaseDownloadNotes(release, version) {
  if (release.tag_name !== `v${version}`) throw new Error("Release tag does not match the app version");
  const links = [
    ["_amd64.deb", "Linux x86_64 — 下载 .deb 安装包"],
    ["_x64-setup.exe", "Windows x64 — 下载 .exe 安装程序"],
  ].map(([suffix, label]) => {
    const asset = release.assets?.find(({ name, size, state }) =>
      name.endsWith(`_${version}${suffix}`) && size > 0 && state === "uploaded",
    );
    if (!asset) throw new Error(`Missing or incomplete installer: ${suffix}`);
    const url = asset.browser_download_url;
    if (typeof url !== "string" || !url.startsWith("https://") || /[\s<>]/.test(url)) {
      throw new Error(`Invalid installer download URL: ${asset.name}`);
    }
    // Escape Markdown delimiters without changing the destination of the API URL.
    return `- [${label}](${url.replaceAll("(", "%28").replaceAll(")", "%29")})`;
  });
  const section = [start, "## 安装包下载", "", ...links, "", "其他平台安装包及更新文件见下方 **Assets**。", end].join("\n");
  const body = release.body ?? "";
  const from = body.indexOf(start);
  const to = body.indexOf(end);
  if (from === -1 && to === -1) return `${section}\n\n${body}`;
  if (from === -1 || to < from || body.indexOf(start, from + start.length) !== -1 || body.indexOf(end, to + end.length) !== -1) {
    throw new Error("Invalid installer download section markers; preserve the release notes and fix the markers first");
  }
  return body.slice(0, from) + section + body.slice(to + end.length);
}

async function main() {
  const [input, version, output] = process.argv.slice(2);
  if (!input || !version || !output) throw new Error("Usage: release-downloads.mjs release.json version notes.md");
  const release = JSON.parse(await readFile(input, "utf8"));
  await writeFile(output, releaseDownloadNotes(release, version));
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

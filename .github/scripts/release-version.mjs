import { readFile, writeFile } from "node:fs/promises";

// Keep the complete SemVer prerelease suffix; build metadata is not a release tag.
const number = "(?:0|[1-9][0-9]*)";
const identifier = `(?:${number}|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)`;
const releaseTag = new RegExp(`^v(${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?)$`);

function tagVersion() {
  const tag = process.env.RELEASE_TAG ?? "";
  const match = releaseTag.exec(tag);
  if (!match || match[0] !== tag) {
    throw new Error("Release tag must be vMAJOR.MINOR.PATCH, optionally with a suffix such as -beta.1.");
  }
  // Updater clients use /releases/latest/download/, which excludes GitHub prereleases.
  if (process.env.IS_PRERELEASE !== "false") {
    throw new Error("Publish a normal GitHub Release, including for beta tags; updater clients use releases/latest.");
  }
  return match[1];
}

function replacePackageVersion(source, table, version, file) {
  let packages = 0;
  // Edit only the named package table, preserving all dependency versions and formatting.
  const result = source.split(/(?=^\[)/m).map((section) => {
    if (section.split(/\r?\n/, 1)[0] !== table || !/^name = "cursor-byok-desktop"\r?$/m.test(section)) return section;
    packages += 1;
    if ([...section.matchAll(/^version = "[^"\r\n]+"\r?$/gm)].length !== 1) {
      throw new Error(`${file}: expected one desktop package version`);
    }
    return section.replace(/^(version = ")[^"\r\n]+(")/m, `$1${version}$2`);
  }).join("");
  if (packages !== 1) throw new Error(`${file}: expected one cursor-byok-desktop package`);
  return result;
}

async function synchronize(version) {
  const changes = [];
  for (const file of ["apps/desktop/src-tauri/tauri.conf.json", "apps/desktop/package.json", "apps/desktop/package-lock.json"]) {
    const data = JSON.parse(await readFile(file, "utf8"));
    data.version = version;
    if (file.endsWith("package-lock.json")) {
      if (data.packages?.[""]?.name !== "cursor-byok-desktop") {
        throw new Error(`${file}: expected the desktop root package at packages[""]`);
      }
      data.packages[""].version = version;
    }
    changes.push([file, `${JSON.stringify(data, null, 2)}\n`]);
  }
  for (const [file, table] of [["apps/desktop/src-tauri/Cargo.toml", "[package]"], ["Cargo.lock", "[[package]]"]]) {
    changes.push([file, replacePackageVersion(await readFile(file, "utf8"), table, version, file)]);
  }
  // Validate every manifest before writing, so a malformed checkout fails before mutation.
  for (const [file, content] of changes) await writeFile(file, content);
}

async function main() {
  const [mode, ...extra] = process.argv.slice(2);
  if (!["--check", "--write"].includes(mode) || extra.length) {
    throw new Error("Usage: release-version.mjs --check|--write (RELEASE_TAG and IS_PRERELEASE are required)");
  }
  const version = tagVersion();
  if (mode === "--write") await synchronize(version);
  console.log(version);
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});

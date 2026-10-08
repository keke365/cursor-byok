import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export function releaseConfig({ signingKeyConfigured, publicKey }) {
  const key = publicKey.trim();
  if (signingKeyConfigured && !key) {
    throw new Error("Set the TAURI_SIGNING_PUBLIC_KEY repository variable to the public key matching TAURI_SIGNING_PRIVATE_KEY.");
  }
  if (!signingKeyConfigured && key) {
    throw new Error("Configure the TAURI_SIGNING_PRIVATE_KEY secret or remove TAURI_SIGNING_PUBLIC_KEY to build unsigned installers.");
  }
  return {
    bundle: { createUpdaterArtifacts: signingKeyConfigured },
    plugins: { updater: { pubkey: key } },
  };
}

async function main() {
  const config = releaseConfig({
    signingKeyConfigured: Boolean(process.env.TAURI_SIGNING_PRIVATE_KEY?.trim()),
    publicKey: process.env.TAURI_SIGNING_PUBLIC_KEY ?? "",
  });
  const output = process.argv[2];
  if (output === "--check") {
    console.log(config.bundle.createUpdaterArtifacts);
  } else {
    if (!output) throw new Error("Pass an output configuration path or --check.");
    await writeFile(output, `${JSON.stringify(config, null, 2)}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

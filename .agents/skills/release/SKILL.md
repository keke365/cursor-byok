---
name: release
description: Prepare, authorize, publish, troubleshoot, and verify Cursor BYOK desktop GitHub Releases. Use for version bumps, release tags, GitHub Actions release runs, updater manifests, signing, or release-readiness checks.
---

# Desktop release

Release through `.github/workflows/release.yml`. Follow [RELEASING.md](../../../RELEASING.md) for the current user-facing procedure.

## Publication authority

- Only the current GitHub repository owner may authorize a live release. Determine the repository from `git remote get-url origin`; do not assume the upstream owner or repository.
- Before a live mutation, require an explicit release instruction in the current task and verify `gh api user --jq .login` matches the owner.
- Pushing release tags, rerunning the release workflow, and publishing or editing a GitHub Release are publication actions. A `main` push only prepares the code.
- Without publication authorization, restrict work to inspection, local edits, validation, and a release-ready commit or branch.
- Never print or commit signing private keys. Upload them only to `TAURI_SIGNING_PRIVATE_KEY` when the owner explicitly requests secret configuration.
- Never delete, replace, or move an existing tag or Release without separate explicit authorization.

## Trigger and version policy

- The sole release trigger is `release: types: [published]`. Creating a draft, editing a Release, pushing a tag alone, ordinary `main` pushes, and manual dispatch do not trigger installation-package builds.
- Publishing a Release starts Linux, Windows, and macOS builds and uploads assets to that same Release ID. Do not skip builds merely because the Release is already published.
- Use a `vMAJOR.MINOR.PATCH` tag whose commit is contained in `origin/main`. The tag must equal `v<version>` from the desktop manifests.
- Beta tags use `vMAJOR.MINOR.PATCH-beta.N` and a visibly Beta title or body. Publish them as normal Releases, not GitHub prereleases; updater clients use `/releases/latest/download/`.
- Windows uses NSIS, including beta versions; WiX/MSI cannot represent these prerelease identifiers.
- Recommend leaving Latest unchecked when publishing. The workflow verifies nonempty `.deb` and `setup.exe` assets and marks the completed Release Latest after all platforms succeed.
- Never reuse an already released version. Configuration changes are not retroactively applied to old tag commits.

## Release sources

Keep the desktop version identical in these manifests and locks:

```text
cursor-byok/
├── Cargo.lock
├── apps/desktop/
│   ├── package.json
│   ├── package-lock.json
│   └── src-tauri/
│       ├── Cargo.toml
│       └── tauri.conf.json
└── .github/
    ├── workflows/release.yml
    └── scripts/release-config.mjs
```

Do not change the independent `cursor-server` version just to release the desktop app. The tracked `scripts/cursor-proto/proto/agent_v1.proto` and `aiserver_v1.proto` are required build inputs.

## Signing

- Installation packages build without updater signing secrets. The default Tauri configuration does not create updater artifacts or trust the upstream public key.
- Signed updates require both the `TAURI_SIGNING_PRIVATE_KEY` Actions Secret and matching `TAURI_SIGNING_PUBLIC_KEY` repository variable. Partial configuration is an error.
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` must be absent when the key has no password.
- `release-config.mjs` writes an ignored Tauri configuration override containing the public key and updater-artifact flag, never the private key.
- For signed releases, verify Tauri `latest.json`, Windows `portable-latest.json`, signatures, and legacy `update.json`. Unsigned releases support manual installer upgrades only.
- Use `tauri-action@v1` input `uploadUpdaterJson`; `includeUpdaterJson` is not a valid v1 input.

## Prepare and validate

1. Inspect `git status`, fetch `origin/main`, and preserve unrelated user changes.
2. Choose the next version and update the manifests and locks consistently.
3. Confirm the intended tag and Release do not already exist.
4. For signed updates, verify the repository's configured public key matches its private key without exposing the private key.
5. Run `node --test .github/scripts/*.test.mjs` and `cargo fmt --all -- --check` from the repository root.
6. From `apps/desktop`, run `npm run check` and `npm run tauri:build -- --debug --no-bundle` when platform dependencies are available.
7. Validate workflow YAML and inspect the diff. Do not stage private keys, generated release configuration, or unrelated changes.

## Publish and verify

After the repository owner explicitly authorizes publication:

1. Commit only the reviewed release set and push it to `main`. This does not start release builds.
2. Create the matching tag on the release commit, and publish a normal GitHub Release for that tag. Publication is the build trigger.
3. Follow `Release desktop app` through completion. Report the run URL; diagnose failures before requesting authorization to retry.
4. Verify Linux `.deb` and Windows `setup.exe` exist and are nonempty, all platform builds passed, and the Release is Latest.
5. For signed releases, verify signed artifacts and update manifests as well.
6. Report beta versions explicitly as test builds despite their normal GitHub Release status.

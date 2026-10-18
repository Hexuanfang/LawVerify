---
name: lawverify-build-exe
description: Build the LawVerify desktop installer EXE. Use when the user asks to package, build, or repackage the latest code into an exe or install package, or invites a version bump and fresh setup. Skips version bumps or keeps temp output only when those flags are explicitly requested. Do not use for building the cloud server alone, signing, or website builds.
---

# LawVerify Desktop EXE Build

One-shot pipeline that produces a fresh NSIS installer from the latest desktop code
into `app\release`, bumping the patch version first (unless explicitly told not to).

## Before you start

Follow the repo convention exactly. Do not re-derive the steps — run the script.

## Run

Execute the bundled script from the repo root:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File ".trae\skills\lawverify-build-exe\scripts\build-exe.ps1"
```

Default behavior:
- Reads `app\package.json` `version`, increments the **patch** (e.g. `0.1.16` → `0.1.17`), and writes it back.
- Runs `build`, `build:server`, `prepare:desktop` (bundles the default law library), `prepare:builder-cache`.
- Packages via a temp output dir `app\release-<version>` to avoid the `app.asar` EBUSY lock.
- Copies `LawVerify-Setup-<version>.exe` into `app\release`, keeping all older versions (never deletes them).
- Removes the temp output dir.

Flags (only when the user explicitly asks):
- `-NoVersionBump` — keep the current version, do not increment.
- `-KeepTemp` — keep `app\release-<version>` for debugging.

## Post-check and report to the user

After the script reports success, confirm the artifact exists and summarize:

- Version transition (old → new version, e.g. `0.1.16` → `0.1.17`).
- New installer path: `app\release\LawVerify-Setup-<version>.exe`.
- Note that old installer versions remain in `app\release` and were not deleted.

Expected build warnings (not failures — do not treat as errors):
- Vite "chunks are larger than 500 kB" — benign.
- `TRAE Sandbox Error: hit restricted` on `...\Windows\Recent\CustomDestinations\*.temp` — sandbox only blocks writing Windows "recent documents"; it happens after the exe is built and does not affect the artifact.
- electron-builder `signAndEditExecutable is false` — code signing is handled separately; see `docs/windows-code-signing.md` when signing is requested.

If the script throws (a step exits non-zero or the artifact is missing), report the failing `npm` step and the exit code, and stop — do not hand-patch around the failure.
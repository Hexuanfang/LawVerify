# LawVerify

English | [简体中文](README.md)

**An evidence organization, legal drafting, and sentence-level review workbench for lawyers.**

LawVerify brings case materials, legal documents, statutory references, and comparable cases into one workflow. It combines a Windows desktop client, a local application service, and a separate website and account platform.

Website: [lawagent.zhijing.fun](https://lawagent.zhijing.fun/)

> AI assists review; it does not replace professional legal judgment. Relevance does not establish proof. Evidence excerpts, statutory provisions, case references, and applicability require human verification. The current desktop version is `0.1.33`, defined in [`app/package.json`](app/package.json).

## Features

- **Cases and evidence:** link multiple local folders, import materials incrementally, and parse or preview Word, PDF, image, and text files. Large imports use batching and object storage for originals.
- **Document workspace:** Tiptap editing, document import, AI-assisted drafting with streaming output, Word export, notes, and manual evidence linking or unlinking.
- **Sentence-level review:** highlight the active sentence, navigate between sentences, and inspect associated originals, statutory provisions, and cases in a side panel.
- **Material understanding and case memory:** extract evidentiary purposes, key facts, disputed issues, limitations, and lawyer-focused observations. Reuse analysis through content fingerprints and aggregate case context.
- **Legal knowledge and case retrieval:** bundled legal documents, article-level lookup, embedding-based retrieval, and MCP integrations for Yuandian, WK, and PKULaw. External services require configuration and appropriate access rights.
- **Account platform:** public website, pricing, downloads, account management, points, payments, invoices, and feedback, with separate administrator access.

Image and scanned-document understanding depends on source quality, rendered pages, and model configuration. Empty OCR or placeholder text is not successful recognition. Comprehensive OCR, ASR, and page-region coordinates are not guaranteed for every format.

## Architecture

```text
Windows Electron client / browser workbench
  -> server: local cases, evidence, documents, AI, and retrieval
       -> SQLite workspace + local originals and assets
       -> LLM / vision / embeddings / case MCP providers
       -> cloud-server: cloud identity, points, and account services

Website and account center (web)
  -> preview-server: static delivery + /api/* proxy
       -> cloud-server
            -> PostgreSQL: accounts, orders, points ledger, etc.
```

The desktop installer bundles the local service. End users do not need Node.js, Docker, PostgreSQL, or Qdrant installed. Cloud accounts, models, and external retrieval still depend on their services; this is not a fully offline product.

| Directory | Responsibility |
| --- | --- |
| `app/src/` | React, TypeScript, and Tiptap workbench |
| `app/electron/` | Desktop lifecycle, IPC, updates, asset preparation, signature checks |
| `server/src/` | Express API, document linkage, material analysis, local workspaces |
| `server/src/intelligence/` | Evidence matching, sentence gating, model response parsing |
| `server/src/integrations/` | LLM, embeddings, Qdrant, case MCP providers, Collabora |
| `cloud-server/src/` | Authentication, billing, payments, invoices, releases, administration |
| `web/` | Website, account center, static server, API proxy |
| `files/法律文件/` | Word source documents for the bundled legal library |
| `scripts/`, `docs/` | Build/deployment tooling and topic documentation |

Use the module `package.json` scripts, `src/index.ts` entry points, and `app/electron/main.cjs`. Historical JavaScript files at the repository root are not entry points for the recommended commands below.

### How Linkage Works

`Material understanding -> case memory -> paragraph context -> sentence-level needs -> candidate retrieval -> applicability checks -> sentence attachment`

Evidence retrieval combines content clues, explicit mentions, and vector similarity. Statutes and cases have separate retrieval and applicability checks. Sentence gating, candidate ID validation, excerpt-source checks, and reference limits reduce unnecessary attachments; manual linking supports correction.

These safeguards do not guarantee accuracy. Sentences combining facts and legal evaluation may be missed. Matching an analysis summary is not equivalent to checking every page of the original, and model confidence is not calibrated accuracy. See [`service.ts`](server/src/service.ts) and [`linkage-policy.ts`](server/src/intelligence/linkage-policy.ts).

## Requirements

- Windows is the primary target for desktop builds and PowerShell operations.
- Recommended: **Node.js 22.23.1 or a compatible newer release**, npm, and Git. Local workspaces use built-in `node:sqlite`; older Node releases are unsuitable.
- The cloud account platform requires PostgreSQL. The `commercial` knowledge-store mode additionally requires server-side PostgreSQL, Qdrant, and embeddings.
- LLM, vision, embedding, and case providers require their own configuration and authorization.

There is no root npm workspace. Install dependencies per module. Run all commands below from the repository root.

```powershell
npm --prefix server ci
npm --prefix app ci
npm --prefix cloud-server ci
npm --prefix web ci
```

### Local Workbench

Create configuration files on first setup only; do not overwrite existing configuration.

```powershell
Copy-Item server/.env.example server/.env.local
Copy-Item app/.env.example app/.env.local
```

Edit `server/.env.local`:

- Keep `KNOWLEDGE_RAG_MODE=local`; local workspaces do not need a database service.
- Clear the template `DATABASE_URL` when not using server-side PostgreSQL to avoid connecting to the example database.
- Set a unique `JWT_SECRET`. Configure `LLM_BASE_URL`, `LLM_API_KEY`, `LLM_MODEL`, and `EMBEDDING_*` as needed.
- Configure `LLM_VISION_*` for image understanding and `YUANDIAN_*`, `WK_*`, or `PKULAW_*` for case services.
- Set `CLOUD_API_BASE_URL` when using your own account platform.

In `app/.env.local`, `VITE_API_BASE_URL` points to the local service. `VITE_CLOUD_API_BASE_URL` and `VITE_ACCOUNT_CENTER_URL` default to the official website. For isolated development, use your own platform URLs and avoid test charges against production accounts.

```powershell
# Browser workbench: API on 8787 + Vite on 5173
npm --prefix app run dev:stack

# Alternatively: API + Vite + Electron
npm --prefix app run dev:desktop
```

Choose one command, not both. Starting the app without model configuration does not validate AI analysis, vector retrieval, or generation.

### Website and Cloud Platform

```powershell
Copy-Item cloud-server/.env.example cloud-server/.env.local
Copy-Item web/.env.example web/.env.local
```

Configure PostgreSQL `DATABASE_URL`, a unique `JWT_SECRET`, website origins, and callback URLs. For local integration, set `VITE_CLOUD_API_BASE` in `web/.env.local` to `http://127.0.0.1:4273` and update the workbench cloud URLs accordingly.

Optional development database:

```powershell
docker compose -f docker-compose.cloud-postgres.yml up -d
```

This Compose file uses PostgreSQL 16, host port `54329`, and database `lawverify_cloud`. Credentials are in the Compose file and are for development only. Docker is unnecessary if you already have PostgreSQL.

```powershell
npm --prefix cloud-server run migrate
.\platform-dev.cmd start -Rebuild
.\platform-dev.cmd status
# Stop: .\platform-dev.cmd stop
```

The platform script manages website port `4273` and cloud port `8788`. It stops processes occupying those ports, so check for unrelated important services first. It does not start PostgreSQL, Qdrant, Cloudflare Tunnel, or the desktop workbench.

| Service | Default Address |
| --- | --- |
| Workbench frontend development | `http://127.0.0.1:5173` |
| Workbench API health | `http://127.0.0.1:8787/api/health` |
| Packaged desktop service | Available port starting at `18787` |
| Website and API proxy | `http://127.0.0.1:4273` |
| Cloud health | `http://127.0.0.1:8788/health` |

`npm --prefix web run dev` starts only the website Vite server, not the API-proxy behavior of `preview-server.mjs`. Both backends load `.env` followed by `.env.local`, with the latter taking precedence. Restart frontend development or rebuild after changing `VITE_*`.

## Build and Verify

```powershell
npm --prefix server run test:workspace
npm --prefix server run test:linkage
npm --prefix server run build
npm --prefix app run build
npm --prefix cloud-server run build
npm --prefix web run build
npm --prefix app run lint
```

These tests cover workspace and linkage regressions. They do not certify end-to-end behavior of every model provider, payment channel, or installation environment.

Windows packaging:

```powershell
.\build-desktop.cmd -Dir
.\build-desktop.cmd
# After configuring credentials and reviewing signing settings:
.\build-desktop.cmd -Signed
npm --prefix app run verify:signature
```

Artifacts are written to `app/release/`, with installers named `LawVerify-Setup-<version>.exe`. The root build script uses the current version and does not bump it automatically.

`prepare:desktop` regenerates the bundled legal library's embedding index. It requires a working embedding API and may incur charges; do not delete legal source files to bypass failures. Verify actual signatures before commercial distribution. Currently `signAndEditExecutable=false`; the `-Signed` flag alone does not establish that artifacts are signed. Valid signatures do not guarantee removal of all SmartScreen warnings.

## Data and Security

- Local SQLite workspaces hold cases, documents, analysis, and sentence references; originals and media assets are stored separately. Legacy JSON is used only for initial transactional migration, not ongoing writes.
- Desktop data lives in `%APPDATA%\LawVerify\data` and `%APPDATA%\LawVerify\storage`. Development defaults are `server/data` and `server/storage`, configurable through path environment variables.
- Close the client and back up complete data and storage directories. Do not delete WAL/SHM files independently or replace current SQLite data with old JSON. See [workspace storage](docs/workspace-storage.md).
- Do not commit `.env*` except templates, logs, dependencies, caches, build outputs, or case runtime data. Sensitive information already in Git history requires separate history cleanup and credential rotation.
- **Review packaged credentials:** `prepare-desktop.cjs` copies allowlisted settings, including model and MCP keys, from `server/.env.local` into the installer. Never distribute shared platform secrets; use controlled services or user-owned credentials.
- **Address administrator initialization before deployment:** `seedAdminAccount()` currently contains fixed development credentials and can reset the password on startup. Change this behavior and review `ADMIN_EMAILS`, authorization, HTTPS, allowed origins, payment callback verification, and log redaction. Environment-variable changes alone do not make deployment safe.
- Keep merchant secrets in the cloud service. Enable `DEV_PAYMENT_SIMULATION` only in isolated development.
- Feedback should include the version, reproduction steps, expected behavior, and actual behavior. Redact screenshots and case materials first.

## Documentation

- [Workspace storage and migration](docs/workspace-storage.md)
- [Desktop development commands](docs/desktop-dev-commands.md)
- [Platform commands](docs/platform-dev-commands.md)
- [Windows signing](docs/windows-code-signing.md)
- [Case provider integrations](docs/legal-case-mcp.md)
- [Official legal sources](docs/legal-official-sources.md)
- [Evidence matching design](docs/evidence-matching-architecture.md)

Topic documents are primarily in Chinese. Some early design documents describe historical states or plans; use the source, configuration templates, and this README for current behavior.

## License

No project-level open-source license is currently provided. Public visibility does not grant permission to copy, redistribute, or use the project commercially. Dependencies and legal/case sources remain subject to their own licenses.

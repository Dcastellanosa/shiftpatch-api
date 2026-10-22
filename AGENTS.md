# AGENTS.md — shiftpatch-api

Guidance for AI coding agents (and humans) working in this repository.

## Project

ShiftPatch is a healthcare staffing platform: agencies create open nursing shifts, nurses browse and claim them,
administrators monitor shift status, and nurses with expired credentials are blocked from claiming.

This repository is the **backend API** (Express 5 + TypeScript), deployed to Vercel as a serverless function. The
frontend lives in the separate `shiftpatch-web` repository. Supabase provides the database and Auth.

Architecture rules:

- This API is the **only** layer that talks to Supabase (Auth, Postgres, Storage). The frontend calls it
  same-origin through `/api/*` with `Authorization: Bearer <token>` and never uses Supabase directly.
- The API owns login, bearer-token verification, authorization, business logic, document storage and all database
  access. There are no cookies and no server-side session.
- `api/index.ts` is the Vercel entrypoint. `src/composition/create-app/` builds the Express app. `src/dev-server.ts` is for local
  development only. Do not name any file under `src/` (or the repo root) `app.ts`, `index.ts`, or `server.ts`, including
  inside subdirectories, because Vercel would auto-detect them as an alternative Express entrypoint. No barrel files.
- Environment variables are read only through `src/infrastructure/config/env/` (Zod-validated, fail-fast).
- Business invariants (one claim per shift, credential validity) must be enforced atomically in the database, not by
  read-then-write logic in the API or checks in the frontend.
- Hexagonal (ports and adapters) layout. Dependencies point inward only, and ESLint (`no-restricted-imports`)
  enforces it:
  - `src/domain/`: plain domain types and constants, plus the driven ports in `src/domain/ports/` (`AuthProvider`,
    `TokenVerifier`, `DataStore`, `FileStore`). No framework, Zod, Supabase, jose, multer or I/O imports.
  - `src/application/`: one use case per file. Depends only on the domain.
  - `src/interfaces/http/`: driving adapter (Express `routes/`, `middleware/`, the bearer header reader, multer
    upload middleware, Zod `schemas/`, error mapping). Routes call use cases, never ports directly.
  - `src/infrastructure/`: driven adapters implementing the ports (`auth/` incl. the jose token verifier,
    `persistence/`, `storage/`) and the environment config (`config/`).
  - `src/composition/create-app/`: composition root that wires adapters together. Tests inject fake ports through it.
- Every module is a folder holding its file and its test: `claim-shift/claim-shift.ts`,
  `claim-shift/claim-shift.test.ts`. Import a module by its file path (`../../domain/shift/shift.js`), never through
  an `index.ts`. Exceptions to the folder rule: `src/dev-server.ts` (entrypoint), `src/types/` (ambient declarations)
  and `src/test-support/` (shared fakes). Tests and test support are excluded from the build. Database integration
  tests stay in `test/integration/`.
- Schema changes are versioned SQL in `supabase/migrations/` (additive; never edit a migration that has been
  applied to a shared project). All objects live in the `shiftpatch` schema, never `public`. The development
  Supabase project is shared with another application: apply migrations there with `pnpm db:push:shared`, never
  `supabase db push` or `supabase migration repair`, which would rewrite the other application's history. Every table has RLS. Client roles get `SELECT` only. Writes go through
  `SECURITY DEFINER` functions that only `service_role` may execute.

## Development workflow

1. Prerequisites: Node.js 24.x, pnpm (pinned in `package.json` → `packageManager`).
2. `pnpm install` then `cp .env.example .env` and adjust values.
3. `pnpm dev` runs the API at http://localhost:3000. Check it with `curl http://localhost:3000/health`.
4. Make small, focused changes. Keep commits scoped to one concern with a conventional prefix
   (`feat:`, `fix:`, `chore:`, `test:`, `docs:`, `refactor:`).
5. Run the full verification suite (below) before every commit. Do not commit with failing checks.
6. Do not push, deploy, create Supabase resources, or change Vercel settings unless explicitly asked.

## Verification commands

Run all of these. CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main` and every pull request,
plus a second job that starts a local Supabase stack and runs `pnpm test:db`.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm format:check   # Prettier (`pnpm format` rewrites)
pnpm test        # Vitest + Supertest (src/**/*.test.ts) with coverage; fails below 80%
pnpm build
```

For database, RLS or data-access changes, also run the integration suite against the local Supabase stack
(Docker + Supabase CLI; ports 553xx):

```bash
pnpm db:start    # once: supabase start (Storage enabled: the credentials bucket is created by the migrations)
pnpm test:db     # resets the local DB, seeds the trial dataset (Trial2026!) and the fixtures, runs test/integration/**
```

For runtime changes, also start `pnpm dev` and exercise the affected endpoints.

`pnpm-workspace.yaml` sets `allowBuilds: { esbuild: false }`. esbuild (used by `tsx`) ships prebuilt platform
binaries, so its install script is not needed. Revisit this only if `pnpm dev` fails to start.

## Security rules

- Never commit secrets. `.env`, `.env.*` (except `.env.example`) and `.vercel/` are gitignored. Keep it that way.
- `SUPABASE_SERVICE_ROLE_KEY` is **server-only**. It is used only for the `SECURITY DEFINER` commands (shift,
  cancel, credential, agency, branch, user and eligibility workflows) after the token and role are verified, for
  the Auth admin API (invitations), for the private credentials bucket, and by the seed / e2e scripts. Never return
  it, log it, or send it to the frontend. Reads use a request-scoped client with the caller's access token so Row
  Level Security applies.
- `SUPABASE_JWT_SECRET` is **server-only** too: it lives in the ignored `.env` locally (value from
  `supabase status`) and in Vercel's environment for hosted projects on the legacy HS256 secret. Never commit it,
  print it, or write a value in docs. Projects on asymmetric signing keys omit it (JWKS is used).
- Never run `pnpm seed` against production. The seeded accounts use the specification's public password
  `Trial2026!` (`SEED_USER_PASSWORD` overrides it); it is a trial credential, not an application secret.
- `scripts/e2e-reset.ts` and `scripts/e2e-api.ts` (`pnpm e2e:reset`, `pnpm e2e:api`) exist for shiftpatch-web's local
  Playwright suite. They read the local stack from `supabase status`, refuse non-local addresses, ignore `.env` and
  never print keys. Keep them local-only.
- On every failure path of invitation, password completion and recovery, do not return or log passwords, hashes,
  tokens or invitation URLs, and do not return a session token. `POST /auth/recover` always answers `204`.
- Authentication: `POST /auth/login` and `POST /auth/complete-password` answer exactly
  `{ token, user: { id, name, role } }`; the access token is returned once and never a refresh token. Every other
  route requires `Authorization: Bearer <token>`, verified locally (`src/infrastructure/auth/jose-token-verifier/`:
  signature, issuer, audience, expiry) before the profile, role and agencies are loaded from the database. No
  cookie is ever read or set; a rejected header is `401 "Invalid or expired token"`, never a fall-back.
  `GET /auth/me` exposes only the safe session payload (`src/application/session-payload/`).
- Public identifiers are slugs (`agency-a`, `nurse-1`, `shift-1`, column `slug`), never database UUIDs. Every
  route accepts and returns them; the data store resolves them to UUIDs for the SECURITY DEFINER commands.
  Branch ids stay UUIDs. Shift status is `filled` on the wire (`claimed` in the database).
- `pnpm seed` loads exactly the trial dataset of `scripts/seed-data.ts`. Integration-test fixtures live in
  `test/integration/fixtures.ts` and are seeded by the test global setup only, never by `pnpm seed`.
- Identity comes only from the verified bearer token (`req.auth`, set by `resolveSession`) and the viewer loaded
  from the database (`req.viewer`). Never trust a user ID, role, agency ID, credential state, or token sent in a
  body, query string, custom header or token claim. Never derive roles from `user_metadata`.
- Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) must pass the Origin check (`src/interfaces/http/middleware/origin-check/`). Do not
  bypass it for new routes.
- Never log credentials, cookies, tokens, authorization headers, request bodies, or raw Supabase error objects.
- CORS is an exact-origin allowlist from `CORS_ORIGINS` without credentials; `Authorization` is an allowed header.
  Never use `*` and never allow arbitrary `*.vercel.app` origins.
- Validate all request input (params, query, body) with Zod. Error responses are always exactly
  `{ "error": "<safe message>" }` (one key: no code, details or nesting) and must not leak stack traces or
  internals. Every shift leaves the API through `toContractShift` (nine keys, `status` `open` | `filled`); the
  stored representation is `open` | `claimed` and stays inside the domain, the data store and the SQL.
- Uploads: `multer` memory storage only (never disk), size cap from the domain, type decided by the file's bytes
  (not the declared MIME type), objects written to the private bucket with the service-role client under the
  nurse's own prefix, metadata through `upsert_nurse_credential`. If the database step fails after the upload,
  remove the object. No `storage.objects` policy ever grants client roles access.
- Do not commit machine-specific files or files containing local absolute paths (agent tooling directories such as
  `.claude/`, `.codex/`, `.kiro/`, `.agents/`, `skills/` are gitignored for this reason).

## AI session transcripts

AI-assisted work is part of the hiring-challenge deliverable.

- **Export and preserve every AI session transcript unedited.** Do not delete, truncate, redact, summarize, or
  otherwise modify transcripts or agent session history.
- **Never paste secrets, tokens, credentials, or private environment values into an AI chat.** Because transcripts
  are kept verbatim, anything shared in a session becomes part of the deliverable. Refer to secrets by variable name
  only (e.g. `SUPABASE_SERVICE_ROLE_KEY`), never by value.
- Transcripts may be stored in this repository (e.g. `docs/ai-transcripts/YYYY-MM-DD-<topic>.md`) or delivered
  separately from the public repository if that is more appropriate.

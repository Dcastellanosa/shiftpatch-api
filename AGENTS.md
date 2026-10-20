# AGENTS.md — shiftpatch-api

Guidance for AI coding agents (and humans) working in this repository.

## Project

ShiftPatch is a healthcare staffing platform: agencies create open nursing shifts, nurses browse and claim them,
administrators monitor shift status, and nurses with expired credentials are blocked from claiming.

This repository is the **backend API** (Express 5 + TypeScript), deployed to Vercel as a serverless function. The
frontend lives in the separate `shiftpatch-web` repository. Supabase provides the database and Auth.

Architecture rules:

- This API is a backend-for-frontend (BFF): it is the **only** layer that talks to Supabase. The frontend calls it
  same-origin through `/api/*` and never uses Supabase directly.
- The API owns login, session lifecycle (HttpOnly cookies, validation, refresh), authorization, business logic, and
  all database access.
- `api/index.ts` is the Vercel entrypoint. `src/composition/create-app/` builds the Express app. `src/dev-server.ts` is for local
  development only. Do not create `app.ts`, `index.ts`, or `server.ts` directly in `src/` (or the repo root), because Vercel would
  auto-detect them as an alternative Express entrypoint. `index.ts` inside a module folder is fine.
- Environment variables are read only through `src/infrastructure/config/env/` (Zod-validated, fail-fast).
- Business invariants (one claim per shift, credential validity) must be enforced atomically in the database, not by
  read-then-write logic in the API or checks in the frontend.
- Hexagonal (ports and adapters) layout. Dependencies point inward only, and ESLint (`no-restricted-imports`)
  enforces it:
  - `src/domain/`: plain domain types and constants, plus the driven ports in `src/domain/ports/` (`AuthProvider`,
    `DataStore`). No framework, Zod, Supabase or I/O imports.
  - `src/application/`: one use case per file. Depends only on the domain.
  - `src/interfaces/http/`: driving adapter (Express `routes/`, `middleware/`, cookies, Zod `schemas/`, error
    mapping). Routes call use cases, never ports directly.
  - `src/infrastructure/`: driven adapters implementing the ports (`auth/`, `persistence/`) and the environment
    config (`config/`).
  - `src/composition/create-app/`: composition root that wires adapters together. Tests inject fake ports through it.
- Every module is a folder holding its file, its test and an `index.ts` barrel:
  `claim-shift/claim-shift.ts`, `claim-shift/claim-shift.test.ts`, `claim-shift/index.ts`. Other modules import it
  only through `index.js` (ESLint enforces this); the test imports the file directly. Exceptions:
  `src/dev-server.ts` (entrypoint), `src/types/` (ambient declarations) and `src/test-support/` (shared fakes).
  Tests and test support are excluded from the build. Database integration tests stay in `test/integration/`.
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

Run all of these. CI (`.github/workflows/ci.yml`) runs the same steps on every push to `main` and every pull request.

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm lint
pnpm test        # Vitest + Supertest (src/**/*.test.ts) with coverage; fails below 80%
pnpm build
```

For database, RLS or data-access changes, also run the integration suite against the local Supabase stack
(Docker + Supabase CLI; ports 553xx):

```bash
pnpm db:start    # once: supabase start
pnpm test:db     # resets the local DB, seeds with a throwaway password, runs test/integration/**
```

For runtime changes, also start `pnpm dev` and exercise the affected endpoints.

`pnpm-workspace.yaml` sets `allowBuilds: { esbuild: false }`. esbuild (used by `tsx`) ships prebuilt platform
binaries, so its install script is not needed. Revisit this only if `pnpm dev` fails to start.

## Security rules

- Never commit secrets. `.env`, `.env.*` (except `.env.example`) and `.vercel/` are gitignored. Keep it that way.
- `SUPABASE_SERVICE_ROLE_KEY` is **server-only**. It is used only for the workflow RPCs (`create_shift`,
  `claim_shift`) after the session and role are verified, and by `pnpm seed`. Never return it, log it, or send it
  to the frontend. Reads use a request-scoped client with the caller's access token so Row Level Security applies.
- Never run `pnpm seed` against production. Seeded account passwords come from `SEED_USER_PASSWORD` and are never
  committed.
- Supabase access and refresh tokens live only in HttpOnly cookies set by this API. Never return tokens in JSON.
  Responses expose only the safe session payload (`src/application/session-payload/`).
- Identity comes only from the validated cookie session (`req.auth`, set by `resolveSession`). Never trust a user ID,
  role, agency ID, credential state, or token sent in a body, query string, or custom header. Never derive roles
  from `user_metadata`.
- Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) must pass the Origin check (`src/interfaces/http/middleware/origin-check/`). Do not
  bypass it for new routes.
- Never log credentials, cookies, tokens, authorization headers, request bodies, or raw Supabase error objects.
- CORS is an exact-origin allowlist from `CORS_ORIGINS` with credentials enabled. Never use `*` and never allow
  arbitrary `*.vercel.app` origins.
- Validate all request input (params, query, body) with Zod. Error responses must not leak stack traces or internals.
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

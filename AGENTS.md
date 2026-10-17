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
- `api/index.ts` is the Vercel entrypoint. `src/create-app.ts` builds the Express app. `src/dev-server.ts` is for local
  development only. Do not name files in `src/` `app.ts`, `index.ts`, or `server.ts`, because Vercel would auto-detect
  them as an alternative Express entrypoint.
- Environment variables are read only through `src/config/env.ts` (Zod-validated, fail-fast).
- Business invariants (one claim per shift, credential validity) must be enforced atomically in the database, not by
  read-then-write logic in the API or checks in the frontend.
- Schema changes are versioned SQL in `supabase/migrations/` (additive; never edit a migration that has been
  applied to a shared project). Every table has RLS. Client roles get `SELECT` only. Writes go through
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
pnpm test        # Vitest + Supertest (test/**/*.test.ts)
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
  Responses expose only the safe session payload (`src/auth/session-user.ts`).
- Identity comes only from the validated cookie session (`req.auth`, set by `resolveSession`). Never trust a user ID,
  role, agency ID, credential state, or token sent in a body, query string, or custom header. Never derive roles
  from `user_metadata`.
- Unsafe methods (`POST`, `PUT`, `PATCH`, `DELETE`) must pass the Origin check (`src/http/origin-check.ts`). Do not
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

# AGENTS.md — shiftpatch-api

Guidance for AI coding agents (and humans) working in this repository.

## Project

ShiftPatch is a healthcare staffing platform: agencies create open nursing shifts, nurses browse and claim them,
administrators monitor shift status, and nurses with expired credentials are blocked from claiming.

This repository is the **backend API** (Express 5 + TypeScript), deployed to Vercel as a serverless function. The
frontend lives in the separate `shiftpatch-web` repository. Supabase provides the database and Auth.

Architecture rules:

- This API is the only business-data boundary for the frontend.
- `api/index.ts` is the Vercel entrypoint. `src/create-app.ts` builds the Express app. `src/dev-server.ts` is for local
  development only. Do not name files in `src/` `app.ts`, `index.ts`, or `server.ts`, because Vercel would auto-detect
  them as an alternative Express entrypoint.
- Environment variables are read only through `src/config/env.ts` (Zod-validated, fail-fast).
- Business invariants (one claim per shift, credential validity) must be enforced atomically in the database, not by
  read-then-write logic in the API or checks in the frontend.

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
pnpm test        # placeholder until a test runner is added
pnpm build
```

For runtime changes, also start `pnpm dev` and exercise the affected endpoints.

`pnpm-workspace.yaml` sets `allowBuilds: { esbuild: false }`. esbuild (used by `tsx`) ships prebuilt platform
binaries, so its install script is not needed. Revisit this only if `pnpm dev` fails to start.

## Security rules

- Never commit secrets. `.env`, `.env.*` (except `.env.example`) and `.vercel/` are gitignored. Keep it that way.
- The Supabase secret / service-role key is **server-only**. Never return it in a response, log it, or send it to the
  frontend. Use it only for narrowly scoped server tasks. Default to a request-scoped Supabase client built with the
  publishable key and the caller's JWT so Row Level Security applies.
- Verify Supabase JWTs (signature, issuer, audience, expiry) before trusting any user identity. Never derive roles
  from client input or `user_metadata`.
- CORS is an exact-origin allowlist from `CORS_ORIGINS`. Never use `*` and never allow arbitrary `*.vercel.app`
  origins.
- Validate all request input (params, query, body) with Zod. Error responses must not leak stack traces or internals.
- Do not commit machine-specific files or files containing local absolute paths (agent tooling directories such as
  `.claude/`, `.codex/`, `.kiro/`, `.agents/`, `skills/` are gitignored for this reason).

## AI session transcripts

AI-assisted work is part of the hiring-challenge deliverable.

- **Export and preserve every AI session transcript unedited.** Do not delete, truncate, redact, summarize, or
  otherwise modify transcripts or agent session history.
- **Never paste secrets, tokens, credentials, or private environment values into an AI chat.** Because transcripts
  are kept verbatim, anything shared in a session becomes part of the deliverable. Refer to secrets by variable name
  only (e.g. `SUPABASE_SECRET_KEY`), never by value.
- Transcripts may be stored in this repository (e.g. `docs/ai-transcripts/YYYY-MM-DD-<topic>.md`) or delivered
  separately from the public repository if that is more appropriate.

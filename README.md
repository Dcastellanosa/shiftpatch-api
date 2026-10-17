# shiftpatch-api

Express + TypeScript API for ShiftPatch, a healthcare staffing platform. It is the only business-data boundary for
[shiftpatch-web](https://github.com/Dcastellanosa/shiftpatch-web) and is deployed to Vercel as a serverless function.

> Status: repository baseline. Only `GET /health` exists. There are no business routes, auth, or Supabase integration yet.

## Layout

```
api/index.ts          Vercel serverless entrypoint (exports the Express app)
src/create-app.ts     Express app factory: CORS, JSON parsing, routes, error handling
src/config/env.ts     Zod-validated environment configuration
src/dev-server.ts     Local development server (app.listen), not used on Vercel
vercel.json           Rewrites every path to /api so Express does the routing
```

## Local setup

Prerequisites: Node.js 24.x and pnpm (version pinned in `package.json` → `packageManager`; `corepack enable` will pick it up).

```bash
pnpm install
cp .env.example .env    # then adjust values
pnpm dev                # http://localhost:3000
curl http://localhost:3000/health   # → {"status":"ok"}
```

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run the local server with reload (`tsx watch`) and load `.env` if present |
| `pnpm build` | Compile TypeScript to `dist/` (verifies the emitted build) |
| `pnpm typecheck` | Typecheck without emitting |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Placeholder. Prints "No tests yet" and exits 0 |

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → test → build on every push to `main` and every pull request.

## Environment variables

Defined in `.env.example` and validated at startup by `src/config/env.ts`. The process fails fast with a list of invalid keys if validation fails.

| Variable | Required | Default | Description |
|---|---|---|---|
| `NODE_ENV` | no | `development` | `development`, `test`, or `production` |
| `PORT` | no | `3000` | Local dev server port (ignored on Vercel) |
| `CORS_ORIGINS` | yes | none | Comma-separated exact origins allowed to call the API, e.g. `http://localhost:5173,https://shiftpatch-web.vercel.app` |

CORS behaviour: browser requests from an origin not in `CORS_ORIGINS` receive no CORS headers, so the browser blocks them. Requests without an `Origin` header (curl, server-to-server) are not affected by CORS.

Planned (not used yet): `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_SECRET_KEY`. The secret key is server-only and must never be sent to the frontend.

## Deployment

Separate Vercel project for this repository:

- `vercel.json` sets `"framework": null` (Other) and rewrites all paths to `/api`, so `api/index.ts` is the single function entrypoint.
- Set `CORS_ORIGINS` (and later the Supabase variables) per Vercel environment.
- Deploy this API before the frontend, then add the frontend's production origin to `CORS_ORIGINS` and redeploy.

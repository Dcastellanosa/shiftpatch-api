# shiftpatch-api

Express + TypeScript API for ShiftPatch, a healthcare staffing platform. Deployed to Vercel as a serverless function.

> Status: authentication only. There are no shift, credential, agency, or profile features and no database schema yet.

## Architecture: backend-for-frontend (BFF)

```
Browser ──same-origin /api/*──▶ shiftpatch-web (Vite dev proxy / Vercel route)
                                     │  strips /api, forwards cookies
                                     ▼
                              shiftpatch-api (Express) ──▶ Supabase Auth (and later, the database)
```

- This API is the **only** component that talks to Supabase. The React app never imports a Supabase client and
  never sees a Supabase key or token.
- The API owns login, session lifecycle, token validation, authorization, business logic, and database access.
- Supabase access and refresh tokens are stored only in `HttpOnly` cookies set by this API. JSON responses never
  contain tokens.

## Auth endpoints

Paths are relative to this API. The frontend reaches them as `/api/auth/...`.

| Method | Path | Behaviour |
|---|---|---|
| `POST` | `/auth/login` | Body `{ email, password }` (Zod-validated). Signs in with Supabase Auth on the server, sets session cookies, returns `{ user }`. Invalid body → `400 validation_error`. Rejected credentials → `401 invalid_credentials` (one generic message). |
| `POST` | `/auth/logout` | Revokes the Supabase session (best effort, using the user's own token) and clears both cookies. Returns `204`. |
| `GET` | `/auth/me` | Validates the cookie session with Supabase Auth, refreshing it if needed, and returns `{ user }`. Absent, expired, invalid, or malformed session → `401 unauthenticated`. |
| `GET` | `/health` | `200 {"status":"ok"}`. Needs no Supabase configuration. |

Safe session payload:

```json
{ "user": { "id": "…", "email": "…", "fullName": null, "role": null, "agencyId": null } }
```

`fullName`, `role` and `agencyId` are always `null` for now because there is no profile model yet. They will be
filled from a profiles lookup keyed by the verified user ID (`src/auth/session-user.ts`) without changing the shape.

Errors always use `{ "error": { "code", "message", "details"? } }`. If Supabase is not configured or unreachable,
auth endpoints return `503 auth_unavailable`. Supabase rate limiting returns `429 rate_limited`.

### Session cookies

| Cookie (dev / production) | Contents | Max-Age |
|---|---|---|
| `sp_access` / `__Host-sp_access` | Supabase access token | Token lifetime (`expires_in`, typically 1 hour) |
| `sp_refresh` / `__Host-sp_refresh` | Supabase refresh token | 7 days, re-issued (sliding) on every refresh |

All cookies are `HttpOnly`, `SameSite=Lax` and `Path=/`, with no `Domain` attribute. With no `Domain`, they stay
host-only on the frontend origin when proxied. `Secure` and the `__Host-` prefix apply when `NODE_ENV=production`.

`resolveSession` (`src/auth/session-middleware.ts`) reads the cookies and validates the access token with
`supabase.auth.getUser`. If that fails, it refreshes with the refresh token and re-issues both cookies. If refresh
also fails, it clears the cookies. On success it sets `req.auth`. User IDs, roles or tokens sent in a body, query
string or header are never trusted.

### CSRF protection

Every `POST`, `PUT`, `PATCH` and `DELETE` request must carry an `Origin` header listed in `CORS_ORIGINS`.
Otherwise the API returns `403 invalid_origin`. A browser request (identified by `Sec-Fetch-*` headers) without
`Origin` gets `403 origin_required`. Together with `SameSite=Lax` cookies, this blocks cross-site form and fetch
attacks. Non-browser clients without `Origin` (curl, server-to-server) are allowed, because they cannot carry a
victim's cookies.

### CORS

CORS is an exact-origin allowlist from `CORS_ORIGINS` with `credentials: true`. There are no wildcards. The
frontend normally calls same-origin through its proxy, so CORS only matters for direct cross-origin calls.

## Layout

```
api/index.ts                      Vercel serverless entrypoint (exports the Express app)
src/create-app.ts                 App factory: CORS, origin check, cookies, JSON, routes, error handler
src/config/env.ts                 Zod-validated environment
src/auth/auth-routes.ts           /auth/login, /auth/logout, /auth/me
src/auth/session-middleware.ts    Cookie session resolution + refresh, requireSession
src/auth/session-cookies.ts       Cookie names, options, read/set/clear
src/auth/session-user.ts          Safe session payload (future profile lookup seam)
src/auth/auth-provider.ts         AuthProvider interface (injectable for tests)
src/auth/supabase-auth-provider.ts  Supabase Auth implementation (publishable key, no persisted state)
src/http/                         AppError, body validation, origin check
src/dev-server.ts                 Local development server (not used on Vercel)
test/                             Vitest + Supertest tests (fake AuthProvider, no network)
vercel.json                       Rewrites every path to /api so Express does the routing
```

## Local setup

Prerequisites: Node.js 24.x and pnpm (version pinned in `package.json` → `packageManager`; `corepack enable` will pick it up).

```bash
pnpm install
cp .env.example .env    # set CORS_ORIGINS=http://localhost:5173 at minimum
pnpm dev                # http://localhost:3000
curl http://localhost:3000/health   # → {"status":"ok"}
```

Without `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY`, the server still starts. `/health` works,
`/auth/me` without cookies returns `401`, and anything that needs Supabase returns `503`.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Run the local server with reload (`tsx watch`) and load `.env` if present |
| `pnpm build` | Compile `api/` and `src/` to `dist/` (verifies the emitted build) |
| `pnpm typecheck` | Typecheck source, tests and config without emitting |
| `pnpm lint` | Run ESLint |
| `pnpm test` | Run Vitest + Supertest tests |

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → test → build on every push to `main` and every pull request.

## Environment variables

Defined in `.env.example` and validated at startup by `src/config/env.ts`. Blank values count as unset. Validation
errors name the variable but never echo its value.

| Variable | Required | Description |
|---|---|---|
| `CORS_ORIGINS` | yes | Comma-separated exact frontend origins, e.g. `http://localhost:5173,https://shiftpatch-web.vercel.app`. Used for CORS and the CSRF origin check. |
| `SUPABASE_URL` | for auth | Supabase project URL. Must be set together with `SUPABASE_PUBLISHABLE_KEY`. |
| `SUPABASE_PUBLISHABLE_KEY` | for auth | Supabase publishable (anon) key, used server-side for Supabase Auth calls. |
| `SUPABASE_SERVICE_ROLE_KEY` | no | Server-only. Reserved for future privileged work and not used yet. Never expose it. |
| `NODE_ENV` | no | `development` (default), `test`, or `production`. Production enables `Secure` + `__Host-` cookies. |
| `PORT` | no | Local dev server port (default `3000`). Ignored on Vercel. |

Credentials, cookies, tokens, authorization headers and raw Supabase errors are never logged.

## Deployment

Separate Vercel project for this repository:

- `vercel.json` sets `"framework": null` (Other) and rewrites all paths to `/api`, so `api/index.ts` is the single function entrypoint.
- Set `CORS_ORIGINS` (including the frontend's production origin), `SUPABASE_URL` and `SUPABASE_PUBLISHABLE_KEY` per Vercel environment.
- The frontend Vercel project proxies `/api/*` to this deployment (see shiftpatch-web README). Deploy this API first.

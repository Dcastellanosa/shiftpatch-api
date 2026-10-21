# shiftpatch-api

Express + TypeScript API for ShiftPatch, a healthcare staffing platform. Deployed to Vercel as a serverless function.

> Status: first vertical slice. Agencies post open shifts, eligible nurses claim them atomically, and agencies and
> admins see the status and history. Cancellation, completion, credential uploads, notifications and reporting
> are not built yet.

## Architecture: backend-for-frontend (BFF)

```
Browser ──same-origin /api/*──▶ shiftpatch-web (Vite dev proxy / Vercel route)
                                     │  strips /api, forwards cookies
                                     ▼
                              shiftpatch-api (Express) ──▶ Supabase Auth + Postgres
```

- This API is the **only** component that talks to Supabase. The React app never imports a Supabase client and
  never sees a Supabase key or token.
- The API owns login, session lifecycle, token validation, authorization, business logic, and database access.
- Supabase access and refresh tokens are stored only in `HttpOnly` cookies set by this API. JSON responses never
  contain tokens.

## Security model

Three independent layers, each sufficient to stop the common mistakes of the others:

1. **Express** validates the cookie session with Supabase Auth, loads the caller's role and agency from the
   `profiles` and `agency_memberships` tables (never from the request or `user_metadata`), checks the role per
   route, and validates every param, query and body with Zod.
2. **Row Level Security** on every table. Reads run through a request-scoped Supabase client that carries the
   caller's access token, so Postgres applies the policies to every query. Client roles (`anon`, `authenticated`)
   have `SELECT` only. They have no `INSERT`, `UPDATE` or `DELETE` privilege on any table.
3. **Workflow functions** (`create_shift`, `claim_shift`) are `SECURITY DEFINER`, executable only by
   `service_role`, and do all their checks and writes in one transaction. The API calls them with the service-role
   key, but only after it has verified the session and role. It passes the verified profile ID, never a
   client-supplied one.

The service-role key is used only for those two RPCs (and by `pnpm seed`). It never reaches the browser.

### Atomic claim (`claim_shift`)

One transaction: lock the shift row (`FOR UPDATE`) → lock the nurse's profile row (serializes one nurse's
concurrent claims) → shift exists and is `open` → actor is a nurse → shift has not started → `active` eligibility
at the branch → every required credential has a row with `status = 'valid'` and
`expires_at >= (starts_at AT TIME ZONE 'UTC')::date` → no overlapping `claimed` shift → assign + `claimed` +
append a `shift_events` row. It returns a typed outcome (`shift_command_result`) instead of raising for domain
failures. A `claimed`-only exclusion constraint (`btree_gist`) backs up the overlap rule at the table level.

Concurrent claims of the same shift queue on the row lock. The loser re-reads the committed row and gets
`shift_not_open`. The integration suite covers this with a deterministic lock test and a 10-way race.

## Data model

All ShiftPatch objects live in the dedicated **`shiftpatch`** Postgres schema (policy helpers in
`shiftpatch_private`), not `public`, so the staffing domain can share a Supabase project with other applications.
PostgREST must expose `shiftpatch` (Project Settings → API → Exposed schemas; locally `supabase/config.toml`).
Only `authenticated` (under RLS) and `service_role` have `USAGE` on it. The API's Supabase clients set
`db: { schema: 'shiftpatch' }`.

Migrations are in `supabase/migrations/` (additive only):

| Migration | Contents |
|---|---|
| `20261017210000_staffing_schema.sql` | Enums, 10 tables, FKs, checks, unique pairs, indexes, `updated_at` triggers, cross-table role triggers, append-only trigger on `shift_events`, Auth → profile trigger, `credential_types` reference rows |
| `20261017210100_row_level_security.sql` | Privileges (client roles: `SELECT` only), RLS on every table, policy helpers in a non-exposed `shiftpatch_private` schema |
| `20261017210200_shift_workflow_functions.sql` | `create_shift`, `claim_shift`, `shift_command_result` type, `EXECUTE` revoked from client roles |

Tables: `profiles`, `agencies`, `agency_branches`, `agency_memberships`, `credential_types`, `nurse_credentials`,
`branch_credential_requirements`, `branch_nurse_eligibility`, `shifts`, `shift_events`.

Normalization (3NF): no arrays or comma-separated IDs, and many-to-many relationships use bridge tables
(memberships, eligibility, credential requirements). `shifts` holds only foreign keys, with no copied names.
Eligibility is never stored on a shift; it is evaluated in `claim_shift`.

Integrity rules enforced in the database, not only in Express:

- `ends_at > starts_at`. An `open` shift has no nurse. A `claimed`, `completed` or `no_show` shift has one.
- `assigned_nurse_id` must be a nurse, `created_by_id` an agency user or admin, membership profiles agency
  users, and credential/eligibility profiles nurses (triggers).
- One active membership per agency user (partial unique index), plus `unique (profile_id, agency_id)`,
  `unique (nurse_id, branch_id)`, `unique (agency_id, name)`, and the composite PK on requirements.
- No nurse can hold overlapping `claimed` shifts (exclusion constraint).
- `shift_events` rejects `UPDATE`, `DELETE` and `TRUNCATE`, even from `service_role` and the table owner.
- Profiles are created only for Auth users whose **`app_metadata.role`** is set. Only the service role can write
  `app_metadata`. A role in `user_metadata` is ignored. No client role can update `profiles`.

## Role matrix

| Capability | Admin | Agency user | Nurse |
|---|---|---|---|
| List shifts (`GET /shifts`) | all | own agency | future open shifts at branches with `active` eligibility (+ own with `includeAssigned=true`) |
| Read one shift | any | own agency | the same open shifts, plus shifts assigned to them |
| Create shift | any branch | own agency's branches | — |
| Claim shift | — | — | yes, if every claim rule passes |
| Shift history | any | own agency | shifts assigned to them |
| `GET /me/shifts` | — | — | own |
| `GET /branches` | all | own agency | branches with an eligibility record or an assigned shift |
| Change roles, memberships, eligibility, credentials | not through the API (seed tooling only) | no | no |

## API routes

Paths are relative to this API. The frontend reaches them as `/api/...`. Every shift route needs a cookie session.
Errors always use `{ "error": { "code", "message", "details"? } }`.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | `{ email, password }` → sets cookies, returns `{ user }` |
| `POST` | `/auth/logout` | `204`, clears cookies |
| `GET` | `/auth/me` | `{ user: { id, email, fullName, role, agencyId } }` (role etc. from `profiles`; `null` if not provisioned) |
| `GET` | `/shifts` | Query: `status`, `branchId`, `from`, `to` (ISO with offset; filters `starts_at`), `includeAssigned=true` (nurses). → `{ shifts }` |
| `POST` | `/shifts` | Agency/admin. `{ branchId, title, startsAt, endsAt }` (ISO with offset, ≤ 24 h). → `201 { shift }` |
| `GET` | `/shifts/:shiftId` | → `{ shift }` or `404 shift_not_found` |
| `POST` | `/shifts/:shiftId/claim` | Nurse only. No body. → `{ shift }` |
| `GET` | `/shifts/:shiftId/events` | → `{ events }` (oldest first) |
| `GET` | `/me/shifts` | Nurse only. → `{ upcoming, past }` (past newest first) |
| `GET` | `/branches` | → `{ branches }` (for the create-shift form and admin filters) |
| `GET` | `/health` | `{ "status": "ok" }` |

Shift shape (`src/domain/shift/`, validated by Zod in `src/interfaces/http/schemas/shifts/`):

```json
{
  "id": "uuid", "title": "ICU RN — Night", "status": "open",
  "startsAt": "2026-10-21T23:00:00.000Z", "endsAt": "2026-10-22T11:00:00.000Z",
  "branch": { "id": "uuid", "name": "Riverside Hospital", "address": "…", "timezone": "America/New_York" },
  "agency": { "id": "uuid", "name": "Northwind Care Staffing" },
  "assignedNurse": null, "createdAt": "…", "updatedAt": "…"
}
```

Status codes:

| Status | Codes |
|---|---|
| 400 | `validation_error`, `invalid_json` |
| 401 | `unauthenticated`, `invalid_credentials` |
| 403 | `forbidden` (wrong role), `profile_missing`, `membership_inactive`, `invalid_origin`, `origin_required` |
| 404 | `shift_not_found`, `branch_not_found` (also for another agency's resources), `not_found` |
| 409 | `shift_not_open` (already claimed/not open), `schedule_conflict` |
| 422 | `credential_expired`, `credential_missing`, `credential_revoked`, `eligibility_inactive`, `shift_started`, `shift_in_past` |
| 429 | `rate_limited` (Supabase Auth rate limit on login) |
| 503 | `auth_unavailable`, `data_unavailable` |

### Session cookies, CSRF, CORS

| Cookie (dev / production) | Contents | Max-Age |
|---|---|---|
| `sp_access` / `__Host-sp_access` | Supabase access token | Token lifetime (`expires_in`, typically 1 hour) |
| `sp_refresh` / `__Host-sp_refresh` | Supabase refresh token | 7 days, re-issued (sliding) on every refresh |

All cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, with no `Domain`. `Secure` and the `__Host-` prefix apply
when `NODE_ENV=production`. `resolveSession` validates the access token and refreshes it with the refresh token
if needed.

Every `POST`, `PUT`, `PATCH` and `DELETE` must carry an `Origin` in `CORS_ORIGINS`. Otherwise the API returns
`403 invalid_origin` (or `origin_required` for a browser request without `Origin`). CORS is an exact-origin
allowlist with credentials.

## Layout

```
api/index.ts                         Vercel entrypoint
src/composition/create-app/          Composition root: wires adapters, CORS, origin check, cookies, JSON, routers
src/domain/                          Domain types and constants (no framework imports)
src/domain/ports/                    Driven ports: AuthProvider, DataStore (injectable for tests)
src/application/                     Use cases (claim, create, list, history, sign-in, viewer resolution, ...)
src/interfaces/http/                 Express: routes/, middleware/ (origin, validate, session, viewer), schemas/, errors
src/infrastructure/auth/             Supabase Auth provider
src/infrastructure/persistence/      Supabase data store: RLS-scoped reads and service-role workflow RPCs
src/infrastructure/config/env/       Zod-validated environment (app + seed)
src/test-support/                    Shared test fakes and fixtures (not built)
src/**/<module>/                     One folder per module: <module>.ts, <module>.test.ts (no index.ts barrels)
supabase/config.toml                 Local stack (ports 553xx, sign-up disabled)
supabase/migrations/                 Versioned SQL migrations
scripts/seed.ts, scripts/seed-data.ts  Idempotent seed and deterministic fixtures
test/integration/*.test.ts           Schema, RLS, claim/concurrency and full-API tests against local Supabase
```

## Local setup

Prerequisites: Node.js 24.x, pnpm (pinned in `package.json`), and for database work Docker plus the
[Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
pnpm install
cp .env.example .env    # CORS_ORIGINS=http://localhost:5173, Supabase URL + keys, SEED_USER_PASSWORD
pnpm dev                # http://localhost:3000
```

Without Supabase variables the server still starts. `/health` works and Supabase-backed routes return `503`.

### Migrations and seed

```bash
# Local stack (API on :55321, Postgres on :55322; does not clash with other local Supabase projects)
pnpm db:start           # supabase start (applies migrations)
pnpm db:reset           # re-create the local database from supabase/migrations

# Seed (local or remote: uses SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY / SEED_USER_PASSWORD from the
# environment, falling back to .env; refuses NODE_ENV=production)
pnpm seed

# Remote project used only by ShiftPatch
supabase link --project-ref <ref>
supabase migration list --linked   # review first
pnpm db:push                       # supabase db push

# Remote project shared with another application (the current development project)
supabase link --project-ref <ref>
pnpm db:push:shared -- --dry-run   # lists applied / pending versions
pnpm db:push:shared                # applies pending migrations, one transaction each
```

The development project is shared with another application whose migrations own the CLI history table
(`supabase_migrations.schema_migrations`). `supabase db push` would require rewriting that history, so
`scripts/apply-shared-migrations.sh` runs each pending file through `supabase db query --linked` inside a
transaction and records it in **`shiftpatch_meta.schema_migrations`** instead. The other application's history
is never read or written. After the first apply, add `shiftpatch` to the project's exposed schemas.

To point the API at the local stack, export the values from `supabase status` (`API_URL`, the publishable/anon
key, the secret/service-role key) as `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
Exported variables take precedence over `.env`.

The seed is idempotent. It upserts accounts and reference data, inserts each seeded shift once, and moves
still-open seeded shifts back into the future on every run. It never rewrites claimed shifts or history.

### Test accounts

Created by `pnpm seed`. Every account uses the password in `SEED_USER_PASSWORD`, which you choose locally. No
password is stored in this repository.

| Email | Role | Scenario |
|---|---|---|
| `admin@shiftpatch.test` | admin | Global; no agency |
| `agency.northwind@shiftpatch.test` | agency | Northwind Care Staffing (Downtown Clinic, Riverside Hospital) |
| `agency.harbor@shiftpatch.test` | agency | Harbor Health Partners (Bayview Medical Center, Hillcrest Rehabilitation) |
| `nurse.ava@shiftpatch.test` | nurse | Fully eligible: active at Downtown, Riverside, Bayview. Has claimed shifts, a past completed shift, and an open Riverside shift that overlaps her claim (schedule-conflict demo). |
| `nurse.ben@shiftpatch.test` | nurse | Active at Downtown, but TB test expired → `credential_expired` |
| `nurse.cora@shiftpatch.test` | nurse | Valid credentials, eligibility pending (Downtown) / suspended (Bayview) → sees no open shifts, `eligibility_inactive` |
| `nurse.dev@shiftpatch.test` | nurse | Active at Downtown, no TB test → `credential_missing` |
| `nurse.eli@shiftpatch.test` | nurse | Second fully eligible nurse (Downtown, Hillcrest) |

Branch requirements: every branch requires `nursing_license`. All except Hillcrest also require `tb_test`.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Local server with reload (`tsx watch`), loads `.env` |
| `pnpm build` | Compile `api/` and `src/` to `dist/` |
| `pnpm typecheck` | Typecheck source, scripts, tests and configs |
| `pnpm lint` | ESLint |
| `pnpm test` | Unit + HTTP tests with fakes (no network, no database) and V8 coverage. Fails below 80% statements, branches, functions or lines. HTML report in `coverage/`. Runs in CI. |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:db` | `supabase db reset --local`, seed with a random throwaway password, then schema, RLS, claim/concurrency and full-API tests against the local stack. Refuses non-local URLs. Needs `pnpm db:start` first. |
| `pnpm seed` | Idempotent development seed |
| `pnpm db:start` / `db:reset` / `db:push` | Supabase CLI wrappers |
| `pnpm db:push:shared` | Apply migrations to a linked project shared with another app (own history table) |

CI (`.github/workflows/ci.yml`) runs install → typecheck → lint → test → build. `pnpm test:db` needs Docker and is
run locally. It is not part of CI yet.

## Environment variables

Validated by `src/infrastructure/config/env/`. Blank values count as unset. Validation errors name the variable and never echo
its value.

| Variable | Required | Description |
|---|---|---|
| `CORS_ORIGINS` | yes | Comma-separated exact frontend origins. Used for CORS and the CSRF origin check. |
| `SUPABASE_URL` | for auth/data | Supabase project URL. Must be set together with `SUPABASE_PUBLISHABLE_KEY`. |
| `SUPABASE_PUBLISHABLE_KEY` | for auth/data | Publishable (anon) key. Used for Auth and for RLS-scoped reads with the caller's token. |
| `SUPABASE_SERVICE_ROLE_KEY` | for shift commands | Server-only **service-role JWT or `sb_secret_…` key** (not the anon key). Calls `create_shift` / `claim_shift`. Without it those routes return `503`. |
| `SEED_USER_PASSWORD` | `pnpm seed` only | Password for the seeded test accounts (≥ 12 characters). |
| `NODE_ENV` | no | `development` (default), `test`, `production`. Production enables `Secure` + `__Host-` cookies. |
| `PORT` | no | Local dev server port (default `3000`). |

Credentials, cookies, tokens, authorization headers, request bodies and raw Supabase errors are never logged.
Data-layer errors log only the failing step and the PostgREST error code.

## Deployment prerequisites

Separate Vercel project for this repository (`vercel.json`: framework `null`, all paths rewritten to `/api`).

1. Apply the migrations to the target Supabase project (`supabase db push`, or `pnpm db:push:shared` for a shared
   project), add `shiftpatch` to its exposed schemas, and provision real accounts. Set
   `app_metadata.role` with the service role and add `agency_memberships`, eligibility and credentials. Do not run
   `pnpm seed` against production. It refuses `NODE_ENV=production`.
2. Disable public sign-up in the Supabase project (Auth settings). Accounts are provisioned, not self-registered.
3. Set `CORS_ORIGINS` (including the frontend's production origin), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY` per Vercel environment. Mark the service-role key as sensitive.
4. Deploy this API before the frontend. The frontend proxies `/api/*` here (see shiftpatch-web README).

## Assumptions and open points

The Designli contract, sample data and test IDs were not available. Until they are, this implementation follows
the task brief with these assumptions:

- `GET /branches` was added (not in the brief) so the create-shift form and admin filters can list branches.
- Nurses can also read the branch and agency names for branches where they have eligibility or an assigned
  shift. The shift list cannot be displayed without them.
- A claim is rejected with `422 shift_started` if the shift has already begun. Shift creation is rejected with
  `422 shift_in_past` for past start times. Shifts longer than 24 h are rejected (`400`).
- Credential validity is compared against the shift's start **date in UTC**, as specified. A branch-local date
  would differ for shifts that start late in the evening in US time zones.
- `POST /shifts/:id/claim` maps "not eligible" to `422 eligibility_inactive` even when the nurse could not see the
  shift. The shift ID is a random UUID, so this does not make shifts enumerable.
- Rate limiting is only the Supabase Auth limit on login (`429 rate_limited`). There is no API-level limiter yet.

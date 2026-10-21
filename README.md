# shiftpatch-api

Express + TypeScript API for ShiftPatch, a healthcare staffing platform. Deployed to Vercel as a serverless function.

> Status: vertical slice, agency administration and the trial contract. Agencies post open shifts, eligible nurses
> claim them atomically, agencies and admins see status and history, admins manage agencies, branches and users,
> agencies manage nurse eligibility, and claimed shifts can be cancelled (no-show / advance). Credential uploads,
> timesheets, the audit-log reader, completion and notifications are not built yet.
>
> **Trial contract.** The six routes of the required specification (`POST /api/auth/login`, `GET /api/shifts`,
> `POST /api/shifts`, `POST /api/shifts/:id/claim`, `POST /api/shifts/:id/cancel`,
> `GET /api/agencies/:agencyId/shifts`) are served with `Authorization: Bearer <token>`, public ids
> (`agency-a`, `nurse-1`, `shift-1`), the flat shift shape and `{ "error": "<message>" }` envelopes, both at
> `/api/...` on this host and, prefix-less, behind the web proxy. `pnpm seed` loads exactly the specification's
> sample data. `test/integration/contract-api.test.ts` replays the specification request by request.

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
- The refresh token is stored only in an `HttpOnly` cookie set by this API and never appears in JSON. The access
  token is set as an `HttpOnly` cookie **and** returned once as `token` by the sign-in responses, for API clients
  that authenticate with `Authorization: Bearer <token>` (the trial contract). The React app ignores it.

## Security model

Three independent layers, each sufficient to stop the common mistakes of the others:

1. **Express** validates the cookie session with Supabase Auth, loads the caller's role and agency from the
   `profiles` and `agency_memberships` tables (never from the request or `user_metadata`), checks the role per
   route, and validates every param, query and body with Zod.
2. **Row Level Security** on every table. Reads run through a request-scoped Supabase client that carries the
   caller's access token, so Postgres applies the policies to every query. Client roles (`anon`, `authenticated`)
   have `SELECT` only. They have no `INSERT`, `UPDATE` or `DELETE` privilege on any table.
3. **Workflow functions** (`create_shift`, `claim_shift`, `cancel_shift_claim` and the admin commands) are
   `SECURITY DEFINER`, executable only by `service_role`, and do all their checks and writes in one transaction.
   The API calls them with the service-role key, but only after it has verified the session and role. It passes
   the verified profile ID, never a client-supplied one.

The service-role key is used only for those commands, for resolving public ids to UUIDs, for the Auth admin API
(invitations, deletions) and by `pnpm seed`. It never reaches the browser.

**Marketplace reads.** `GET /shifts` lists every shift of every agency to every signed-in user (the specification's
marketplace). It reads through `list_shifts_marketplace`, a `SECURITY DEFINER` projection that returns only shift,
branch, agency and assigned-nurse columns, so the table policies stay as strict as before: nurses still cannot
read other nurses' profiles or credentials, and shift *history* stays scoped (own claims for nurses, own agencies
for agency users).

**Public ids.** Agencies, users and shifts carry a `slug` (`agency-a`, `nurse-1`, `shift-1`; new rows get
`agency-N`, `nurse-N`, `admin-N`, `shift-N` from a trigger) and every route accepts and returns those, never the
UUIDs. Branch ids are UUIDs.

### Atomic claim (`claim_shift`)

One transaction: lock the shift row (`FOR UPDATE`) → lock the nurse's profile row (serializes one nurse's
concurrent claims) → shift exists and is `open` → actor is a nurse → branch and agency active → `active`
eligibility at the branch → every required credential has a row with `status = 'valid'` and
`expires_at >= (starts_at AT TIME ZONE 'UTC')::date` → no overlapping `claimed` shift → assign + `claimed` +
append a `shift_events` row. It returns a typed outcome (`shift_command_result`) instead of raising for domain
failures. A `claimed`-only exclusion constraint (`btree_gist`) backs up the overlap rule at the table level.

Concurrent claims of the same shift queue on the row lock. The loser re-reads the committed row and gets
`shift_not_open`. The integration suite covers this with a deterministic lock test and a 10-way race.

There is no "shift already started" or "shift in the past" rule: the specification's sample shifts are dated and
must stay claimable, and its create example posts a dated shift.

### Cancellation (`cancel_shift_claim`)

`POST /shifts/:id/cancel` with `{ "reason": "no-show" | "advance" }` releases the claim and reopens the shift in
one transaction: the owning agency, an admin, or the assigned nurse may cancel; the shift must be `filled`; a
`shift_events` row (`no_show` or `cancelled`, `claimed → open`) records it. The response is the reopened shift
plus `cancellation: { reason, previousNurseId }`.

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
| `20261021120000_agency_administration.sql` | Branch status, enforced agency status, write-only `audit_events`, admin commands, inactive guards in `create_shift` / `claim_shift` |
| `20261022090000_delete_agency_and_user.sql` | `delete_agency`, `delete_user`, audit action `deleted` |
| `20261023100000_contract_compatibility.sql` | `slug` columns + trigger, `list_shifts_marketplace`, `cancel_shift_claim`, `create_shift` / `claim_shift` without timing guards |

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
| List shifts (`GET /shifts`, the marketplace) | all | all | all |
| Agency view (`GET /agencies/:agencyId/shifts`) | any agency | own agencies | — |
| Read one shift | any | any | any |
| Create shift | any branch (`branchId` required) | own agency's branches (`branchId` optional with one branch) | — |
| Claim shift | — | — | yes, if every claim rule passes |
| Cancel a filled shift (no-show / advance) | any | own agency's shifts | own claim |
| Shift history | any | own agencies | shifts assigned to them |
| `GET /me/shifts` | — | — | own |
| `GET /branches` | all | own agency | branches with an eligibility record or an assigned shift |
| Agencies and branches (`/admin/agencies*`) | create, rename, activate / deactivate, delete (only without shift history) | — | — |
| Users (`/admin/users*`) | list; invite admins, agency users (agencies) and nurses (one branch); delete (only without history, never oneself) | — | — |
| Nurse eligibility (`/agency/nurses`, `/nurses/:nurseId/eligibility/:branchId`) | activate / suspend at any branch | own agencies' nurses and branches | — |
| Roles, memberships, credentials | not through the API (seed tooling only) | no | no |

## API routes

Every route is served both prefix-less (what the web proxy forwards) and under `/api/...` (what API clients call
on this host). Shift routes need a session: the cookies, or `Authorization: Bearer <token>` with the `token` a
sign-in response returned. Errors always use `{ "error": "<message>", "code": "<machine_code>", "details"? }`.
Ids in paths and bodies are public ids (`shift-1`, `agency-a`, `nurse-1`); branch ids are UUIDs.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | `{ email, password }` → sets cookies, returns `{ token, user: { id, name, email, role, agencyId, agencyIds } }`. `id` is the public id: `nurse-1` / `admin-1`, or the agency (`agency-a`) for agency logins. `401 { "error": "Invalid email or password" }` |
| `POST` | `/auth/logout` | `204`, clears cookies (revokes a bearer session too) |
| `GET` | `/auth/me` | `{ user }` as above, without `token` (`role` etc. `null` if not provisioned) |
| `POST` | `/auth/complete-password` | Public. `{ tokenHash, type: "invite" \| "recovery", password }` from the emailed link → sets cookies, returns `{ token, user }`. Failures set no cookie: `401 invalid_or_expired_link`, `422 weak_password` |
| `POST` | `/auth/recover` | Public. `{ email }` → always `204`; sends a recovery email when the address exists |
| `GET` | `/shifts` | Every shift of every agency. Query: `status` (`open`, `filled`, …), `branchId`, `agencyId`, `from`, `to` (ISO with offset; filter `starts_at`). → `{ shifts }` |
| `POST` | `/shifts` | Agency/admin. `{ role, date, startTime, endTime, branchId? }` (facility-local `YYYY-MM-DD` / `HH:MM` in the branch zone; `endTime` ≤ `startTime` means the next day; `branchId` optional when the caller has one active branch). → `201` the shift |
| `GET` | `/shifts/:shiftId` | → the shift, or `404 shift_not_found` |
| `POST` | `/shifts/:shiftId/claim` | Nurse only. No body. → the filled shift. `403 { "error": "Credential expired, cannot claim shift" }` when a required credential is expired, missing or revoked |
| `POST` | `/shifts/:shiftId/cancel` | Owning agency, admin or the assigned nurse. `{ reason: "no-show" \| "advance" }` → the reopened shift + `cancellation: { reason, previousNurseId }`. `409 shift_not_filled` |
| `GET` | `/shifts/:shiftId/events` | → `{ events }` (oldest first); nurses only for their claims, agencies only for their shifts |
| `GET` | `/agencies/:agencyId/shifts` | Agency (own) or admin. Same query as `/shifts`. → `{ agencyId, shifts }` |
| `GET` | `/me/shifts` | Nurse only. → `{ upcoming, past }` (past newest first) |
| `GET` | `/branches` | → `{ branches }` (for the create-shift form and admin filters) |
| `GET` / `POST` | `/admin/agencies` | Admin. → `{ agencies }` (with `status`, `branchCount`); `{ name }` → `201 { agency }` |
| `GET` / `PATCH` / `DELETE` | `/admin/agencies/:agencyId` | Admin. → `{ agency, branches }`; `{ name?, status? }` → `{ agency }`; `DELETE` → `204` only for agencies whose branches never had a shift (removes branches, memberships, eligibility), else `409 agency_has_shifts` |
| `POST` | `/admin/agencies/:agencyId/branches` | Admin. `{ name, address, timezone }` → `201 { branch }` |
| `PATCH` | `/admin/agencies/:agencyId/branches/:branchId` | Admin. `{ name?, address?, timezone?, status? }` → `{ branch }` |
| `GET` / `POST` | `/admin/users` | Admin. → `{ users }`; `{ email, fullName, role, agencyIds? \| branchId? }` → `201 { user }` and an invitation email. The link never appears in a response or log |
| `DELETE` | `/admin/users/:userId` | Admin. `204`: removes the profile, its access records and the Auth account. `409 cannot_delete_self`, `409 user_has_history` (shifts or recorded actions) |
| `GET` | `/agency/nurses` | Agency. → `{ nurses }`: each nurse with their status at the caller's branches |
| `PUT` / `DELETE` | `/nurses/:nurseId/eligibility/:branchId` | Agency (own branches) or admin. Activates / suspends → `{ eligibility }` |
| `GET` | `/health` | `{ "status": "ok" }` |

Shift shape (`src/domain/shift/`, validated by Zod in `src/interfaces/http/schemas/shifts/`). The first nine
fields are the specification's shape; the rest is extra:

```json
{
  "id": "shift-1", "agencyId": "agency-a", "agencyName": "Sunrise Health Staffing",
  "role": "RN", "date": "2026-10-02", "startTime": "19:00", "endTime": "07:00",
  "status": "open", "claimedBy": null,
  "claimedByName": null,
  "branch": { "id": "uuid", "name": "Main", "address": "…", "timezone": "UTC", "status": "active" },
  "startsAt": "2026-10-02T19:00:00.000Z", "endsAt": "2026-10-03T07:00:00.000Z",
  "createdAt": "…", "updatedAt": "…"
}
```

`date`, `startTime` and `endTime` are the facility-local wall clock in the branch's time zone (the trial branches
use `UTC`, so no conversion happens). `status` is one of `open`, `filled`, `cancelled`, `completed`, `no_show`.

Status codes:

| Status | Codes |
|---|---|
| 400 | `validation_error`, `invalid_json` |
| 401 | `unauthenticated`, `invalid_credentials`, `invalid_or_expired_link` |
| 403 | `forbidden` (wrong role or another agency's view), `credential_expired` / `credential_missing` / `credential_revoked` (claim; message "Credential expired, cannot claim shift"), `profile_missing`, `membership_inactive`, `invalid_origin`, `origin_required` |
| 404 | `shift_not_found`, `branch_not_found` (also for another agency's resources), `agency_not_found`, `nurse_not_found`, `user_not_found`, `not_found` |
| 409 | `shift_not_open` (already claimed/not open), `shift_not_filled` (nothing to cancel), `schedule_conflict`, `name_taken`, `email_exists`, `agency_has_shifts`, `cannot_delete_self`, `user_has_history` |
| 422 | `eligibility_inactive`, `agency_inactive`, `branch_inactive`, `invalid_assignment`, `weak_password` |
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

**Bearer mode (API clients).** `Authorization: Bearer <token>` with the `token` from `POST /auth/login` is
accepted on every route instead of the cookies. It is validated as is: no refresh (the token lives one hour; sign
in again), no cookies read or written, and a rejected header is a `401`, never a fall-back to cookies. Requests
without an `Origin` header (curl, scripts) pass the CSRF check because they cannot carry a victim's cookies.

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

The local stack delivers every email (invitations, password recovery) to Mailpit at http://127.0.0.1:55324
and allows `http://localhost:5173/**` and `http://localhost:5174/**` as redirect targets (`supabase/config.toml`).

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
pnpm db:push:shared -- --dry-run   # lists applied / pending versions (read-only)
pnpm db:push:shared                # APPLIES every pending migration, one transaction each
```

The development project is shared with another application whose migrations own the CLI history table
(`supabase_migrations.schema_migrations`). `supabase db push` would require rewriting that history, so
`scripts/apply-shared-migrations.sh` runs each pending file through `supabase db query --linked` inside a
transaction and records it in **`shiftpatch_meta.schema_migrations`** instead. The other application's history
is never read or written. After the first apply, add `shiftpatch` to the project's exposed schemas.

To point the API at the local stack, export the values from `supabase status` (`API_URL`, the publishable/anon
key, the secret/service-role key) as `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
Exported variables take precedence over `.env`.

The seed is idempotent. It upserts accounts and reference data and inserts each seeded shift once; the trial
shifts keep their dates. It never rewrites claimed shifts or history.

### Trial accounts (`pnpm seed`)

`pnpm seed` loads exactly the sample data of the trial specification (`scripts/seed-data.ts`). Every account uses
the password in `SEED_USER_PASSWORD`; the specification's value is `Trial2026!` (a public trial credential, not a
secret). Public ids are what the API exposes.

| Public id | Name | Login email | Role | Notes |
|---|---|---|---|---|
| `agency-a` | Sunrise Health Staffing | `admin@sunrisehealth.example` | agency | one branch, `Main` (UTC) |
| `agency-b` | Metro Care Partners | `admin@metrocare.example` | agency | one branch, `Main` (UTC) |
| `admin-1` | Alex Kim | `alex.kim@example.com` | admin | |
| `nurse-1` | Maria Lopez | `maria.lopez@example.com` | nurse | licence valid until 2027-01-01; active at both branches; holds `shift-2` |
| `nurse-2` | James Cook | `james.cook@example.com` | nurse | licence expired 2026-06-01 → every claim answers "Credential expired, cannot claim shift" |

| Shift | Agency | Role | Date | Start | End | Status | Claimed by |
|---|---|---|---|---|---|---|---|
| `shift-1` | `agency-a` | RN | 2026-10-02 | 19:00 | 07:00 | open | — |
| `shift-2` | `agency-a` | LPN | 2026-10-03 | 07:00 | 19:00 | filled | `nurse-1` |
| `shift-3` | `agency-b` | RN | 2026-10-04 | 19:00 | 07:00 | open | — |

Both branches require `nursing_license` only. The integration suite seeds additional fixtures
(`test/integration/fixtures.ts`: Northwind, Harbor, Lakeside and their nurses) on top of this dataset for its
own scenarios; they are never part of `pnpm seed`.

## Scripts

| Script | What it does |
|---|---|
| `pnpm dev` | Local server with reload (`tsx watch`), loads `.env` |
| `pnpm build` | Compile `api/` and `src/` to `dist/` |
| `pnpm typecheck` | Typecheck source, scripts, tests and configs |
| `pnpm lint` | ESLint (with `eslint-config-prettier`) |
| `pnpm format` / `pnpm format:check` | Prettier: rewrite / verify formatting |
| `pnpm test` | Unit + HTTP tests with fakes (no network, no database) and V8 coverage. Fails below 80% statements, branches, functions or lines. HTML report in `coverage/`. Runs in CI. |
| `pnpm test:watch` | Vitest in watch mode |
| `pnpm test:db` | `supabase db reset --local`, seed the trial dataset plus the test fixtures with a random throwaway password, then schema, RLS, claim/concurrency, admin, contract and full-API tests against the local stack. Refuses non-local URLs. Needs `pnpm db:start` first. |
| `pnpm seed` | Idempotent development seed |
| `pnpm e2e:reset` | Local only: `supabase db reset --local` + seed with `SEED_USER_PASSWORD` from the environment. Used by shiftpatch-web's Playwright suite with a per-run password |
| `pnpm e2e:api` | Local only: starts the API against the local stack (`E2E_API_PORT`, default 3100; `E2E_WEB_ORIGIN`, default `http://localhost:5174`). Ignores `.env`; keys come from `supabase status` and are never printed |
| `pnpm db:start` / `db:reset` / `db:push` | Supabase CLI wrappers |
| `pnpm db:push:shared` | Apply migrations to a linked project shared with another app (own history table) |

CI (`.github/workflows/ci.yml`) runs two jobs on every push to `main` and every pull request: `verify` (install →
typecheck → lint → format check → unit tests with coverage → build, plus an advisory `pnpm audit`) and `database`
(Supabase CLI starts a throwaway local stack and runs `pnpm test:db`). Dependabot opens weekly grouped updates.

## Environment variables

Validated by `src/infrastructure/config/env/`. Blank values count as unset. Validation errors name the variable and never echo
its value.

| Variable | Required | Description |
|---|---|---|
| `CORS_ORIGINS` | yes | Comma-separated exact frontend origins. Used for CORS and the CSRF origin check. |
| `SUPABASE_URL` | for auth/data | Supabase project URL. Must be set together with `SUPABASE_PUBLISHABLE_KEY`. |
| `SUPABASE_PUBLISHABLE_KEY` | for auth/data | Publishable (anon) key. Used for Auth and for RLS-scoped reads with the caller's token. |
| `SUPABASE_SERVICE_ROLE_KEY` | for commands | Server-only **service-role JWT or `sb_secret_…` key** (not the anon key). Calls the `SECURITY DEFINER` commands (`create_shift`, `claim_shift`, agency/branch/user/eligibility commands) and the Auth admin API (invitations). Without it those routes return `503`. |
| `WEB_ORIGIN` | no | Origin of the web app that receives invitation and recovery links (`<WEB_ORIGIN>/set-password`). Defaults to the first `CORS_ORIGINS` entry. |
| `SEED_USER_PASSWORD` | `pnpm seed` only | Password for the seeded trial accounts (≥ 8 characters; the specification uses `Trial2026!`). |
| `NODE_ENV` | no | `development` (default), `test`, `production`. Production enables `Secure` + `__Host-` cookies. |
| `PORT` | no | Local dev server port (default `3000`). |

Credentials, cookies, tokens, authorization headers, request bodies and raw Supabase errors are never logged.
Data-layer errors log only the failing step and the PostgREST error code.

## Deployment prerequisites

Separate Vercel project for this repository (`vercel.json`: framework `null`, all paths rewritten to `/api`).

1. **Migrations, in order.** Apply `supabase/migrations/*` to the target Supabase project (`supabase db push`, or
   `pnpm db:push:shared` for the shared development project), including `20261021120000_agency_administration.sql`
   (branch status, enforced agency status, audit events, admin commands). Add `shiftpatch` to the project's exposed
   schemas. Do not run `pnpm seed` against production; it refuses `NODE_ENV=production`.
2. **Auth settings (manual, Supabase dashboard).** Disable public sign-up: accounts are invited, never
   self-registered. Under *URL configuration* add `<web origin>/set-password` to the redirect allowlist (for
   example `https://shiftpatch-web.vercel.app/set-password`). Under *Email templates* replace **Invite user** and
   **Reset password** with `supabase/templates/invite.html` and `supabase/templates/recovery.html`: their links are
   `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=…`, so the token travels only in the URL fragment and is
   exchanged by this API (`POST /auth/complete-password`), never by the browser against Supabase. Set the subjects
   from `supabase/config.toml` (`[auth.email.template.invite]` / `[auth.email.template.recovery]`). Keep the default
   OTP expiry (1 h) or shorter.
3. **Environment variables** per Vercel environment: `CORS_ORIGINS` (including the frontend's production origin),
   `WEB_ORIGIN` (the frontend origin the emails should link to), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY` and
   `SUPABASE_SERVICE_ROLE_KEY` (sensitive).
4. **Order.** Migrations → this API → shiftpatch-web (it proxies `/api/*` here; its `API_ORIGIN` points at this
   deployment). Then invite the first administrator with the service role (`provision_user`) or the seed tooling.

## Assumptions and open points

The Designli contract, sample data and test IDs were not available. Until they are, this implementation follows
the task brief with these assumptions:

- `GET /branches` was added (not in the brief) so the create-shift form and admin filters can list branches.
- Nurses can also read the branch and agency names for branches where they have eligibility or an assigned
  shift. The shift list cannot be displayed without them.
- No timing rule: dated (past) shifts can be posted and claimed, because the specification's sample data is
  dated. A shift spans at most 24 hours (`endTime` ≤ `startTime` rolls to the next day).
- The specification's `GET /api/shifts` lists every shift to every role; agency-only views use
  `GET /agencies/:agencyId/shifts`. History, claims and commands stay scoped by role.
- Cancellation (`reason` `no-show` or `advance`) is allowed to the owning agency, an admin, or the assigned nurse,
  and always reopens the shift; the specification does not say who may cancel.
- Agency logins report the agency's public id as `user.id` (`agency-a`), as the specification's example reads; an
  agency user managing several agencies reports the first active one, with all of them in `agencyIds`.
- Credential validity is compared against the shift's start **date in UTC**, as specified. A branch-local date
  would differ for shifts that start late in the evening in US time zones.
- `POST /shifts/:id/claim` maps "not eligible" to `422 eligibility_inactive` even when the nurse could not see the
  shift. The shift ID is a random UUID, so this does not make shifts enumerable.
- Rate limiting is only the Supabase Auth limit on login (`429 rate_limited`). There is no API-level limiter yet.
- The error envelope carries `code` next to the specification's `error` string; clients that compare the whole
  body must tolerate the extra key.

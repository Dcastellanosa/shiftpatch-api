# shiftpatch-api

Express + TypeScript API for ShiftPatch, a healthcare staffing platform. Deployed to Vercel as a serverless function.

> Status: the challenge baseline. Agencies post open shifts, eligible nurses claim them atomically, agencies and
> admins see status and history, claimed shifts are cancelled (no-show / advance) and reopened, nurses upload
> credential documents, admins manage agencies, branches and users and read the audit log, agencies manage nurse
> eligibility, and everyone has a read-only timesheet. Shift completion, notifications and credential export are
> intentionally out of scope (see "Scope notes").
>
> **Trial contract.** The six routes of the required specification (`POST /api/auth/login`, `GET /api/shifts`,
> `POST /api/shifts`, `POST /api/shifts/:id/claim`, `POST /api/shifts/:id/cancel`,
> `GET /api/agencies/:agencyId/shifts`) are served with `Authorization: Bearer <token>`, public ids
> (`agency-a`, `nurse-1`, `shift-1`), exactly the nine-key shift shape and `{ "error": "<message>" }` envelopes,
> both at `/api/...` on this host and, prefix-less, behind the web proxy. `pnpm seed` loads exactly the
> specification's sample data with its password (`Trial2026!`). `test/integration/contract-api.test.ts` replays the
> specification request by request with `toEqual` bodies.

## Architecture: one Bearer-token API

```
Browser ──same-origin /api/*──▶ shiftpatch-web (Vite dev proxy / Vercel route)
   Authorization: Bearer <token>      │  strips /api, forwards the Authorization header
                                      ▼
                               shiftpatch-api (Express) ──▶ Supabase Auth + Postgres + Storage
```

- This API is the **only** component that talks to Supabase. The React app never imports a Supabase client and
  never sees a Supabase key; it only holds the access token it received from `POST /auth/login`, in memory.
- The API owns login, token verification, authorization, business logic, database access and document storage.
- The only credential is `Authorization: Bearer <Supabase access token>`. There are no cookies, no refresh
  tokens in any response and no server-side session: an expired token (one hour) means signing in again.

## Security model

Three independent layers, each sufficient to stop the common mistakes of the others:

1. **Express** verifies the bearer token locally (`jose`: signature through the project's JWKS for ES256/RS256
   keys or `SUPABASE_JWT_SECRET` for HS256, issuer `<SUPABASE_URL>/auth/v1`, audience `authenticated`, expiry),
   then loads the caller's role and agencies from the `profiles` and `agency_memberships` tables (never from the
   token, the request or `user_metadata`), checks the role per route, and validates every param, query and body
   with Zod.
2. **Row Level Security** on every table. Reads run through a request-scoped Supabase client that carries the
   caller's access token, so Postgres applies the policies to every query. Client roles (`anon`, `authenticated`)
   have `SELECT` only. They have no `INSERT`, `UPDATE` or `DELETE` privilege on any table.
3. **Workflow functions** (`create_shift`, `claim_shift`, `cancel_shift_claim` and the admin commands) are
   `SECURITY DEFINER`, executable only by `service_role`, and do all their checks and writes in one transaction.
   The API calls them with the service-role key, but only after it has verified the session and role. It passes
   the verified profile ID, never a client-supplied one.

The service-role key is used only for those commands, for resolving public ids to UUIDs, for the Auth admin API
(invitations, deletions), for the private credentials bucket and by `pnpm seed`. It never reaches the browser.

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
one transaction; a `shift_events` row (`no_show` or `cancelled`, `claimed → open`) records it. Who may cancel:

| Actor | Allowed | Reasons |
|---|---|---|
| Admin | any filled shift | `advance`, `no-show` |
| Agency user | shifts of an agency they are an active member of | `advance`, `no-show` |
| Nurse | only the shift currently assigned to them | `advance` only (`403 "Nurses can only cancel in advance"`) |
| Anyone else | — | `403 "Forbidden"` |

The response is the reopened shift plus `cancellation: { reason, previousNurseId }`.

### Credential uploads (`POST /me/credentials`)

A nurse uploads a licence or screening document as `multipart/form-data` (`file`, `expiresAt`, optional
`credentialTypeCode`, default `nursing_license`). The API reads the file into memory (never to disk), rejects
anything over 5 MiB (`413`) or whose **bytes** are not a PDF, PNG or JPEG (`400 "Unsupported file type"`, whatever
the client declared), writes it to the private `shiftpatch-credentials` bucket with its service-role client under
`<nurse uuid>/<type>/<random>.<ext>`, and records the metadata through `upsert_nurse_credential` (one row per
nurse and credential type; a new upload replaces the previous document and resets the status to `valid`). If the
database refuses or fails after the upload, the object is removed again. No client role can read the bucket; the
React app never touches Storage.

### Audit log (`GET /admin/audit-events`)

`audit_events` (administration) and `shift_events` (shift history) are unreadable by every client role. The only
reader is `list_audit_log_admin()`, a `SECURITY DEFINER` function that refuses non-admins and returns one timeline
(newest first, 500 rows) with public ids for agencies, profiles and shifts.

### Timesheets (`GET /timesheets`)

Read-only rows derived from filled shifts: nurse, agency, role, facility-local date and times, scheduled hours
between the shift's instants, and `worked` (ended) or `scheduled`. A nurse sees their own shifts, an agency user
the shifts of their agencies, an admin everything. No editing workflow exists.

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
| `20261024095000_cancel_authorization.sql` | `cancel_shift_claim` authorization: nurses only their own shift and only `advance` |
| `20261024100000_credential_uploads.sql` | Upload metadata columns, one credential row per nurse and type, `upsert_nurse_credential`, the private `shiftpatch-credentials` bucket |
| `20261024100100_audit_log_reader.sql` | `list_audit_log_admin()` (admins only) |

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
| Cancel a filled shift (no-show / advance) | any | own agency's shifts | own claim, `advance` only |
| Credentials (`GET` / `POST /me/credentials`) | — | — | own |
| Timesheets (`GET /timesheets`) | all | own agencies | own |
| Audit log (`GET /admin/audit-events`) | all | — | — |
| Shift history | any | own agencies | shifts assigned to them |
| `GET /me/shifts` | — | — | own |
| `GET /branches` | all | own agency | branches with an eligibility record or an assigned shift |
| Agencies and branches (`/admin/agencies*`) | create, rename, activate / deactivate, delete (only without shift history) | — | — |
| Users (`/admin/users*`) | list; invite admins, agency users (agencies) and nurses (one branch); delete (only without history, never oneself) | — | — |
| Nurse eligibility (`/agency/nurses`, `/nurses/:nurseId/eligibility/:branchId`) | activate / suspend at any branch | own agencies' nurses and branches | — |
| Roles, memberships, credentials | not through the API (seed tooling only) | no | no |

## API routes

Every route is served both prefix-less (what the web proxy forwards) and under `/api/...` (what API clients call
on this host). Every route except `/health`, `/auth/login`, `/auth/complete-password` and `/auth/recover` needs
`Authorization: Bearer <token>` with the `token` a sign-in response returned: no header → `401 "Authentication
required"`, a malformed, invalid or expired token → `401 "Invalid or expired token"`. Errors are always exactly
`{ "error": "<message>" }`. Ids in paths and bodies are public ids (`shift-1`, `agency-a`, `nurse-1`); branch ids
are UUIDs.

| Method | Path | Notes |
|---|---|---|
| `POST` | `/auth/login` | Strict `{ email, password }` → exactly `{ token, user: { id, name, role } }`. `id` is the public id: `nurse-1` / `admin-1`, or the agency (`agency-a`) for agency logins; `name` is always a string. `401 { "error": "Invalid email or password" }` |
| `POST` | `/auth/logout` | Revokes the presented bearer token (best effort) → `204` |
| `GET` | `/auth/me` | `{ user: { id, name, email, role, agencyId, agencyIds } }` for the bearer token (`role` etc. `null` if not provisioned) |
| `POST` | `/auth/complete-password` | Public. `{ tokenHash, type: "invite" \| "recovery", password }` from the emailed link → the same `{ token, user }` as login. Failures carry no token: `401` (invalid or expired link), `422` (weak password) |
| `POST` | `/auth/recover` | Public. `{ email }` → always `204`; sends a recovery email when the address exists |
| `GET` | `/shifts` | Every shift of every agency. Query: `status` (`open`, `filled`, …), `branchId`, `agencyId`, `from`, `to` (ISO with offset; filter `starts_at`). → `{ shifts }` |
| `POST` | `/shifts` | Agency/admin. `{ role, date, startTime, endTime, branchId? }` (facility-local `YYYY-MM-DD` / `HH:MM` in the branch zone; `endTime` ≤ `startTime` means the next day; `branchId` optional when the caller has one active branch). → `201` the shift |
| `GET` | `/shifts/:shiftId` | → the shift, or `404 "Shift not found"` |
| `POST` | `/shifts/:shiftId/claim` | Nurse only. No body. → the filled shift. `403 { "error": "Credential expired, cannot claim shift" }` when a required credential is expired, missing or revoked |
| `POST` | `/shifts/:shiftId/cancel` | Admin, owning agency, or the assigned nurse (`advance` only). `{ reason: "no-show" \| "advance" }` → the reopened shift + `cancellation: { reason, previousNurseId }`. `403 "Forbidden"`, `403 "Nurses can only cancel in advance"`, `409 "Shift is not filled"` |
| `GET` | `/shifts/:shiftId/events` | → `{ events }` (oldest first); nurses only for their claims, agencies only for their shifts |
| `GET` | `/agencies/:agencyId/shifts` | Agency (own) or admin. Same query as `/shifts`. → `{ agencyId, shifts }` |
| `GET` | `/me/shifts` | Nurse only. → `{ upcoming, past }` (past newest first) |
| `GET` / `POST` | `/me/credentials` | Nurse only. → `{ credentials }`; multipart `file` + `expiresAt` (+ `credentialTypeCode`) → `201 { credential: { id, type, expiresAt, status, fileName, uploadedAt } }`. `400 "Unsupported file type"`, `413 "File too large"`, `400 "Unknown credential type"` |
| `GET` | `/timesheets` | Any role. → `{ timesheets: [{ shiftId, nurseId, nurseName, agencyId, agencyName, role, date, startTime, endTime, scheduledHours, status }] }` |
| `GET` | `/admin/audit-events` | Admin. → `{ events: [{ id, occurredAt, actorId, actorName, entityType, entityId, action, previousStatus, newStatus, reason }] }` |
| `GET` | `/branches` | → `{ branches }` (for the create-shift form and admin filters) |
| `GET` / `POST` | `/admin/agencies` | Admin. → `{ agencies }` (with `status`, `branchCount`); `{ name }` → `201 { agency }` |
| `GET` / `PATCH` / `DELETE` | `/admin/agencies/:agencyId` | Admin. → `{ agency, branches }`; `{ name?, status? }` → `{ agency }`; `DELETE` → `204` only for agencies whose branches never had a shift (removes branches, memberships, eligibility), else `409` |
| `POST` | `/admin/agencies/:agencyId/branches` | Admin. `{ name, address, timezone }` → `201 { branch }` |
| `PATCH` | `/admin/agencies/:agencyId/branches/:branchId` | Admin. `{ name?, address?, timezone?, status? }` → `{ branch }` |
| `GET` / `POST` | `/admin/users` | Admin. → `{ users }`; `{ email, fullName, role, agencyIds? \| branchId? }` → `201 { user }` and an invitation email. The link never appears in a response or log |
| `DELETE` | `/admin/users/:userId` | Admin. `204`: removes the profile, its access records and the Auth account. `409` for oneself or for a user with shifts or recorded actions |
| `GET` | `/agency/nurses` | Agency. → `{ nurses }`: each nurse with their status at the caller's branches |
| `PUT` / `DELETE` | `/nurses/:nurseId/eligibility/:branchId` | Agency (own branches) or admin. Activates / suspends → `{ eligibility }` |
| `GET` | `/health` | `{ "status": "ok" }` |

Shift shape, exactly the specification's nine keys on every route that returns a shift (projected by
`toContractShift` in `src/interfaces/http/schemas/shifts/`; the domain keeps the branch, instants and timestamps
internally):

```json
{
  "id": "shift-1", "agencyId": "agency-a", "agencyName": "Sunrise Health Staffing",
  "role": "RN", "date": "2026-10-02", "startTime": "19:00", "endTime": "07:00",
  "status": "open", "claimedBy": null
}
```

`date`, `startTime` and `endTime` are the facility-local wall clock in the branch's time zone (the trial branches
use `UTC`, so no conversion happens; `endTime` at or before `startTime` means the next day). `status` is `open` or
`filled`. The database stores `open` | `claimed`; `claimed` becomes `filled` only at the HTTP boundary, and no
command produces any other status (a cancellation reopens the shift).

Error envelope: always `{ "error": "<message>" }`, one key, no machine code, no details, no nesting. The messages
the specification fixes are `Invalid email or password` (401 login) and `Credential expired, cannot claim shift`
(403 claim, for an expired, missing or revoked credential). Other messages are safe, human-readable sentences
(`Authentication required`, `Invalid or expired token`, `Forbidden`, `Shift not found`, `Shift is not filled`,
`Invalid request body`, `Request origin is not allowed`, `File too large`, ...); the status code carries the
category.

### Bearer authentication, origin check, CORS

`POST /auth/login` (and `POST /auth/complete-password`) return the Supabase access token once, as `token`. Clients
keep it in memory and send `Authorization: Bearer <token>` on every other request. `resolveSession` verifies it
locally with `jose` — signature (JWKS at `<SUPABASE_URL>/auth/v1/.well-known/jwks.json` for ES256/RS256 keys,
`SUPABASE_JWT_SECRET` for HS256), issuer, audience `authenticated` and expiry — and then `loadViewer` reads the
profile, role and agency memberships from the database. Nothing about authorization is trusted from the token.
There is no refresh: the token lives one hour and the client signs in again. No cookie is ever read or set, and
`POST /auth/logout` revokes the presented token (best effort, always `204`).

Every `POST`, `PUT`, `PATCH` and `DELETE` coming from a browser must carry an `Origin` in `CORS_ORIGINS`:
otherwise `403 "Request origin is not allowed"` (or `403 "Origin header is required"` for a browser request
identified by `Sec-Fetch-*` headers that omits it). Non-browser clients (curl, automated contract checks) send
neither header and pass with their bearer token. CORS is an exact-origin allowlist without credentials;
`Authorization` and `Content-Type` are the allowed headers and `PUT` is among the allowed methods.

## Layout

```
api/index.ts                         Vercel entrypoint
src/composition/create-app/          Composition root: wires adapters, CORS, origin check, JSON, routers
src/domain/                          Domain types and constants (no framework imports)
src/domain/ports/                    Driven ports: AuthProvider, TokenVerifier, DataStore, FileStore (injectable for tests)
src/application/                     Use cases (claim, create, cancel, list, history, sign-in, credentials, timesheets, ...)
src/interfaces/http/                 Express: routes/, middleware/ (origin, validate, session, upload, viewer), bearer/, schemas/, errors
src/infrastructure/auth/             Supabase Auth provider (sign-in, sign-out) and the jose token verifier
src/infrastructure/persistence/      Supabase data store: RLS-scoped reads and service-role workflow RPCs
src/infrastructure/storage/          Supabase Storage file store (private credentials bucket, service role)
src/infrastructure/config/env/       Zod-validated environment (app + seed)
src/test-support/                    Shared test fakes and fixtures (not built)
src/**/<module>/                     One folder per module: <module>.ts, <module>.test.ts (no index.ts barrels)
supabase/config.toml                 Local stack (ports 553xx, sign-up disabled)
supabase/migrations/                 Versioned SQL migrations
scripts/seed.ts, scripts/seed-data.ts  Idempotent seed and deterministic fixtures
test/integration/*.test.ts           Schema, RLS, claim/concurrency, contract, credentials, audit-log and full-API tests against local Supabase
```

## Local setup

Prerequisites: Node.js 24.x, pnpm (pinned in `package.json`), and for database work Docker plus the
[Supabase CLI](https://supabase.com/docs/guides/local-development).

```bash
pnpm install
cp .env.example .env    # CORS_ORIGINS=http://localhost:5173, Supabase URL + keys, SUPABASE_JWT_SECRET
pnpm dev                # http://localhost:3000
```

Without Supabase variables the server still starts. `/health` works and Supabase-backed routes return `503`.
Locally, `SUPABASE_JWT_SECRET` is the "JWT secret" printed by `supabase status` (the local stack signs with HS256);
without it every bearer token is rejected with `401`. It is a server-only secret: keep it in the ignored `.env`.

The local stack delivers every email (invitations, password recovery) to Mailpit at http://127.0.0.1:55324
and allows `http://localhost:5173/**` and `http://localhost:5174/**` as redirect targets (`supabase/config.toml`).
Storage is enabled locally (`[storage]`) so the credentials bucket exists after `pnpm db:start` / `pnpm db:reset`;
if the stack was started before that setting existed, run `supabase stop && supabase start` once.

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
`Trial2026!`, the specification's password (`SEED_USER_PASSWORD` overrides it; it is a public trial credential,
not a secret). Public ids are what the API exposes.

**Trial-data note.** The sample shifts are dated 2026-10-02 to 2026-10-04 and the create example posts
2026-10-05, dates that are already in the past. There is deliberately no "shift already started" or "shift in the
past" rule, so the required flows (claim `shift-1`, post the example shift) work deterministically whenever the
trial is run. Every other safeguard stays: atomic claims, credential expiry, eligibility, inactive agencies and
branches, no overlapping claims.

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
| `pnpm test:db` | `supabase db reset --local`, seed the trial dataset (password `Trial2026!`) plus the test fixtures, then schema, RLS, claim/concurrency, admin, contract, credentials, audit-log and full-API tests against the local stack. Refuses non-local URLs. Needs `pnpm db:start` first. |
| `pnpm seed` | Idempotent development seed |
| `pnpm e2e:reset` | Local only: `supabase db reset --local` + seed exactly the trial dataset (`Trial2026!`). Used by shiftpatch-web's Playwright suite before every spec file |
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
| `SUPABASE_SERVICE_ROLE_KEY` | for commands | Server-only **service-role JWT or `sb_secret_…` key** (not the anon key). Calls the `SECURITY DEFINER` commands (`create_shift`, `claim_shift`, `cancel_shift_claim`, `upsert_nurse_credential`, agency/branch/user/eligibility commands), the Auth admin API (invitations) and the private credentials bucket. Without it those routes return `503`. |
| `SUPABASE_JWT_SECRET` | for HS256 projects | Server-only secret that verifies HS256 access tokens: the local CLI stack (value from `supabase status`) and hosted projects still on the legacy JWT secret (value from the Supabase dashboard, set only in Vercel's environment). Leave unset for projects signing with asymmetric keys: those are verified through their JWKS. Never commit or document its value. |
| `WEB_ORIGIN` | no | Origin of the web app that receives invitation and recovery links (`<WEB_ORIGIN>/set-password`). Defaults to the first `CORS_ORIGINS` entry. |
| `SEED_USER_PASSWORD` | `pnpm seed` only | Password for the seeded trial accounts (≥ 8 characters). Defaults to the specification's `Trial2026!`. |
| `NODE_ENV` | no | `development` (default), `test`, `production`. |
| `PORT` | no | Local dev server port (default `3000`). |

Credentials, tokens, authorization headers, request bodies, uploaded files and raw Supabase errors are never logged.
Data-layer errors log only the failing step and the PostgREST error code.

## Deployment prerequisites

Separate Vercel project for this repository (`vercel.json`: framework `null`, all paths rewritten to `/api`).

1. **Migrations, in order.** Apply `supabase/migrations/*` to the target Supabase project (`supabase db push`, or
   `pnpm db:push:shared` for the shared development project), through `20261024100100_audit_log_reader.sql`. The
   credentials migration creates the private `shiftpatch-credentials` bucket (Storage is always enabled on hosted
   projects). Add `shiftpatch` to the project's exposed schemas. Do not run `pnpm seed` against production; it
   refuses `NODE_ENV=production`.
2. **Auth settings (manual, Supabase dashboard).** Disable public sign-up: accounts are invited, never
   self-registered. Under *URL configuration* add `<web origin>/set-password` to the redirect allowlist (for
   example `https://shiftpatch-web.vercel.app/set-password`). Under *Email templates* replace **Invite user** and
   **Reset password** with `supabase/templates/invite.html` and `supabase/templates/recovery.html`: their links are
   `{{ .RedirectTo }}#token_hash={{ .TokenHash }}&type=…`, so the token travels only in the URL fragment and is
   exchanged by this API (`POST /auth/complete-password`), never by the browser against Supabase. Set the subjects
   from `supabase/config.toml` (`[auth.email.template.invite]` / `[auth.email.template.recovery]`). Keep the default
   OTP expiry (1 h) or shorter.
3. **Environment variables** per Vercel environment: `CORS_ORIGINS` (including the frontend's production origin),
   `WEB_ORIGIN` (the frontend origin the emails should link to), `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`,
   `SUPABASE_SERVICE_ROLE_KEY` (sensitive) and, unless the project signs tokens with asymmetric keys,
   `SUPABASE_JWT_SECRET` (sensitive; from the dashboard). Projects on JWT signing keys need nothing else: the API
   fetches their JWKS.
4. **Order.** Migrations → this API → shiftpatch-web (it proxies `/api/*` here; its `API_ORIGIN` points at this
   deployment). Then invite the first administrator with the service role (`provision_user`) or the seed tooling.

## Scope notes

Intentionally not built, and documented as such for the trial:

- **Shift completion.** No command moves a shift to `completed`; timesheets mark a filled shift as `worked` once
  its end instant has passed.
- **Credential export** (one-click download of a nurse's documents). Documents are stored privately; a signed
  download route would be the next step.
- **Shift notifications** (email on claim / cancellation). Only invitation and recovery emails exist.
- **Analytics (PostHog or similar).** The web app loads no third-party script.

## Assumptions and open points

- `GET /branches` was added (not in the brief) so the create-shift form and admin filters can list branches.
- Nurses can also read the branch and agency names for branches where they have eligibility or an assigned
  shift. The shift list cannot be displayed without them.
- Agency logins carry no `email` in the contract payload; `GET /auth/me` still returns it for clients that need it.
- No timing rule: dated (past) shifts can be posted and claimed, because the specification's sample data is
  dated. A shift spans at most 24 hours (`endTime` ≤ `startTime` rolls to the next day).
- The specification's `GET /api/shifts` lists every shift to every role; agency-only views use
  `GET /agencies/:agencyId/shifts`. History, claims and commands stay scoped by role.
- Cancellation (`reason` `no-show` or `advance`) is allowed to the owning agency and admins with either reason,
  and to the assigned nurse in advance only; it always reopens the shift. The specification does not say who may
  cancel.
- Agency logins report the agency's public id as `user.id` (`agency-a`), as the specification's example reads; an
  agency user managing several agencies reports the first active one, with all of them in `agencyIds`.
- Credential validity is compared against the shift's start **date in UTC**, as specified. A branch-local date
  would differ for shifts that start late in the evening in US time zones.
- `POST /shifts/:id/claim` answers `422` for "not eligible" even when the nurse could not see the shift. Shift
  ids are sequential public ids (`shift-N`) and the marketplace lists every shift anyway, so nothing is revealed.
- Rate limiting is only the Supabase Auth limit on login (`429`). There is no API-level limiter yet.
- The error envelope is exactly `{ "error" }`; clients distinguish cases by status code and message, never by a
  machine code.

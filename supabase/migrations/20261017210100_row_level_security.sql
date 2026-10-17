-- Row Level Security and table privileges.
--
-- The browser never reaches these tables: only shiftpatch-api talks to
-- Supabase. The API reads with a request-scoped client carrying the caller's
-- access token (role `authenticated`), so these policies are a second,
-- independent enforcement layer behind the API's own authorization.
--
-- Client roles (`anon`, `authenticated`) get SELECT only. Every write goes
-- through the security-definer workflow functions, which only the backend's
-- service role may execute.

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

revoke all on table
  shiftpatch.profiles,
  shiftpatch.agencies,
  shiftpatch.agency_branches,
  shiftpatch.agency_memberships,
  shiftpatch.credential_types,
  shiftpatch.nurse_credentials,
  shiftpatch.branch_credential_requirements,
  shiftpatch.branch_nurse_eligibility,
  shiftpatch.shifts,
  shiftpatch.shift_events
from anon, authenticated;

grant select on table
  shiftpatch.profiles,
  shiftpatch.agencies,
  shiftpatch.agency_branches,
  shiftpatch.agency_memberships,
  shiftpatch.credential_types,
  shiftpatch.nurse_credentials,
  shiftpatch.branch_credential_requirements,
  shiftpatch.branch_nurse_eligibility,
  shiftpatch.shifts,
  shiftpatch.shift_events
to authenticated;

-- The backend's privileged role (seed tooling and the workflow functions'
-- callers). Granted explicitly: recent Supabase projects no longer grant DML
-- to service_role by default.
grant select, insert, update, delete on table
  shiftpatch.profiles,
  shiftpatch.agencies,
  shiftpatch.agency_branches,
  shiftpatch.agency_memberships,
  shiftpatch.credential_types,
  shiftpatch.nurse_credentials,
  shiftpatch.branch_credential_requirements,
  shiftpatch.branch_nurse_eligibility,
  shiftpatch.shifts
to service_role;

-- History is append-only even for the backend's privileged role.
grant select, insert on table shiftpatch.shift_events to service_role;
revoke update, delete, truncate on table shiftpatch.shift_events from service_role;

-- Helper functions are not part of the public API surface.
revoke execute on function shiftpatch.set_updated_at() from public, anon, authenticated;
revoke execute on function shiftpatch.assert_profile_role(uuid, shiftpatch.app_role[], text) from public, anon, authenticated;
grant execute on function shiftpatch.assert_profile_role(uuid, shiftpatch.app_role[], text) to service_role;
revoke execute on function shiftpatch.agency_memberships_check_role() from public, anon, authenticated;
revoke execute on function shiftpatch.nurse_credentials_check_role() from public, anon, authenticated;
revoke execute on function shiftpatch.branch_nurse_eligibility_check_role() from public, anon, authenticated;
revoke execute on function shiftpatch.shifts_check_roles() from public, anon, authenticated;
revoke execute on function shiftpatch.shift_events_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policy helpers
--
-- Security-definer lookups keyed by auth.uid(). They live in a schema that
-- PostgREST does not expose and avoid recursive policy evaluation.
-- ---------------------------------------------------------------------------

create schema shiftpatch_private;
revoke all on schema shiftpatch_private from public;
grant usage on schema shiftpatch_private to authenticated;

create function shiftpatch_private.current_app_role()
returns shiftpatch.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from shiftpatch.profiles p where p.id = auth.uid()
$$;

create function shiftpatch_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(shiftpatch_private.current_app_role() = 'admin', false)
$$;

-- Agencies the caller manages through an active membership.
create function shiftpatch_private.member_agency_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.agency_id
  from shiftpatch.agency_memberships m
  join shiftpatch.profiles p on p.id = m.profile_id
  where m.profile_id = auth.uid()
    and m.status = 'active'
    and p.role = 'agency'
$$;

create function shiftpatch_private.member_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from shiftpatch.agency_branches b
  where b.agency_id in (select shiftpatch_private.member_agency_ids())
$$;

-- Branches where the calling nurse is actively eligible.
create function shiftpatch_private.nurse_active_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.branch_id
  from shiftpatch.branch_nurse_eligibility e
  join shiftpatch.profiles p on p.id = e.nurse_id
  where e.nurse_id = auth.uid()
    and e.status = 'active'
    and p.role = 'nurse'
$$;

-- Branches a nurse may see: active eligibility, any eligibility record of
-- their own, or a shift assigned to them (history stays readable after
-- eligibility changes).
create function shiftpatch_private.nurse_visible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.branch_id from shiftpatch.branch_nurse_eligibility e where e.nurse_id = auth.uid()
  union
  select s.branch_id from shiftpatch.shifts s where s.assigned_nurse_id = auth.uid()
$$;

-- Profiles an agency user may see: members of their agency, and nurses
-- assigned to or eligible at their agency's branches.
create function shiftpatch_private.agency_visible_profile_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.profile_id
  from shiftpatch.agency_memberships m
  where m.agency_id in (select shiftpatch_private.member_agency_ids())
  union
  select s.assigned_nurse_id
  from shiftpatch.shifts s
  where s.assigned_nurse_id is not null
    and s.branch_id in (select shiftpatch_private.member_branch_ids())
  union
  select e.nurse_id
  from shiftpatch.branch_nurse_eligibility e
  where e.branch_id in (select shiftpatch_private.member_branch_ids())
$$;

revoke execute on all functions in schema shiftpatch_private from public, anon;
grant execute on all functions in schema shiftpatch_private to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table shiftpatch.profiles enable row level security;
alter table shiftpatch.agencies enable row level security;
alter table shiftpatch.agency_branches enable row level security;
alter table shiftpatch.agency_memberships enable row level security;
alter table shiftpatch.credential_types enable row level security;
alter table shiftpatch.nurse_credentials enable row level security;
alter table shiftpatch.branch_credential_requirements enable row level security;
alter table shiftpatch.branch_nurse_eligibility enable row level security;
alter table shiftpatch.shifts enable row level security;
alter table shiftpatch.shift_events enable row level security;

-- ---------------------------------------------------------------------------
-- SELECT policies (no INSERT/UPDATE/DELETE policies exist for client roles)
-- ---------------------------------------------------------------------------

create policy profiles_select on shiftpatch.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select shiftpatch_private.is_admin())
    or id in (select shiftpatch_private.agency_visible_profile_ids())
  );

create policy agencies_select on shiftpatch.agencies
  for select to authenticated
  using (
    (select shiftpatch_private.is_admin())
    or id in (select shiftpatch_private.member_agency_ids())
    or id in (
      select b.agency_id from shiftpatch.agency_branches b
      where b.id in (select shiftpatch_private.nurse_visible_branch_ids())
    )
  );

create policy agency_branches_select on shiftpatch.agency_branches
  for select to authenticated
  using (
    (select shiftpatch_private.is_admin())
    or agency_id in (select shiftpatch_private.member_agency_ids())
    or id in (select shiftpatch_private.nurse_visible_branch_ids())
  );

create policy agency_memberships_select on shiftpatch.agency_memberships
  for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (select shiftpatch_private.is_admin())
  );

create policy credential_types_select on shiftpatch.credential_types
  for select to authenticated
  using (true);

create policy nurse_credentials_select on shiftpatch.nurse_credentials
  for select to authenticated
  using (
    nurse_id = (select auth.uid())
    or (select shiftpatch_private.is_admin())
  );

create policy branch_credential_requirements_select on shiftpatch.branch_credential_requirements
  for select to authenticated
  using (
    (select shiftpatch_private.is_admin())
    or branch_id in (select shiftpatch_private.member_branch_ids())
    or branch_id in (select shiftpatch_private.nurse_visible_branch_ids())
  );

create policy branch_nurse_eligibility_select on shiftpatch.branch_nurse_eligibility
  for select to authenticated
  using (
    nurse_id = (select auth.uid())
    or (select shiftpatch_private.is_admin())
    or branch_id in (select shiftpatch_private.member_branch_ids())
  );

create policy shifts_select on shiftpatch.shifts
  for select to authenticated
  using (
    (select shiftpatch_private.is_admin())
    or branch_id in (select shiftpatch_private.member_branch_ids())
    or assigned_nurse_id = (select auth.uid())
    or (
      status = 'open'
      and branch_id in (select shiftpatch_private.nurse_active_branch_ids())
    )
  );

create policy shift_events_select on shiftpatch.shift_events
  for select to authenticated
  using (
    (select shiftpatch_private.is_admin())
    or shift_id in (
      select s.id from shiftpatch.shifts s
      where s.branch_id in (select shiftpatch_private.member_branch_ids())
    )
    or shift_id in (
      select s.id from shiftpatch.shifts s
      where s.assigned_nurse_id = (select auth.uid())
    )
  );

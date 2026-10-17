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
  public.profiles,
  public.agencies,
  public.agency_branches,
  public.agency_memberships,
  public.credential_types,
  public.nurse_credentials,
  public.branch_credential_requirements,
  public.branch_nurse_eligibility,
  public.shifts,
  public.shift_events
from anon, authenticated;

grant select on table
  public.profiles,
  public.agencies,
  public.agency_branches,
  public.agency_memberships,
  public.credential_types,
  public.nurse_credentials,
  public.branch_credential_requirements,
  public.branch_nurse_eligibility,
  public.shifts,
  public.shift_events
to authenticated;

-- The backend's privileged role (seed tooling and the workflow functions'
-- callers). Granted explicitly: recent Supabase projects no longer grant DML
-- to service_role by default.
grant select, insert, update, delete on table
  public.profiles,
  public.agencies,
  public.agency_branches,
  public.agency_memberships,
  public.credential_types,
  public.nurse_credentials,
  public.branch_credential_requirements,
  public.branch_nurse_eligibility,
  public.shifts
to service_role;

-- History is append-only even for the backend's privileged role.
grant select, insert on table public.shift_events to service_role;
revoke update, delete, truncate on table public.shift_events from service_role;

-- Helper functions are not part of the public API surface.
revoke execute on function public.set_updated_at() from public, anon, authenticated;
revoke execute on function public.assert_profile_role(uuid, public.app_role[], text) from public, anon, authenticated;
grant execute on function public.assert_profile_role(uuid, public.app_role[], text) to service_role;
revoke execute on function public.agency_memberships_check_role() from public, anon, authenticated;
revoke execute on function public.nurse_credentials_check_role() from public, anon, authenticated;
revoke execute on function public.branch_nurse_eligibility_check_role() from public, anon, authenticated;
revoke execute on function public.shifts_check_roles() from public, anon, authenticated;
revoke execute on function public.shift_events_append_only() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- Policy helpers
--
-- Security-definer lookups keyed by auth.uid(). They live in a schema that
-- PostgREST does not expose and avoid recursive policy evaluation.
-- ---------------------------------------------------------------------------

create schema app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create function app_private.current_app_role()
returns public.app_role
language sql
stable
security definer
set search_path = ''
as $$
  select p.role from public.profiles p where p.id = auth.uid()
$$;

create function app_private.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select coalesce(app_private.current_app_role() = 'admin', false)
$$;

-- Agencies the caller manages through an active membership.
create function app_private.member_agency_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.agency_id
  from public.agency_memberships m
  join public.profiles p on p.id = m.profile_id
  where m.profile_id = auth.uid()
    and m.status = 'active'
    and p.role = 'agency'
$$;

create function app_private.member_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select b.id
  from public.agency_branches b
  where b.agency_id in (select app_private.member_agency_ids())
$$;

-- Branches where the calling nurse is actively eligible.
create function app_private.nurse_active_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.branch_id
  from public.branch_nurse_eligibility e
  join public.profiles p on p.id = e.nurse_id
  where e.nurse_id = auth.uid()
    and e.status = 'active'
    and p.role = 'nurse'
$$;

-- Branches a nurse may see: active eligibility, any eligibility record of
-- their own, or a shift assigned to them (history stays readable after
-- eligibility changes).
create function app_private.nurse_visible_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.branch_id from public.branch_nurse_eligibility e where e.nurse_id = auth.uid()
  union
  select s.branch_id from public.shifts s where s.assigned_nurse_id = auth.uid()
$$;

-- Profiles an agency user may see: members of their agency, and nurses
-- assigned to or eligible at their agency's branches.
create function app_private.agency_visible_profile_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select m.profile_id
  from public.agency_memberships m
  where m.agency_id in (select app_private.member_agency_ids())
  union
  select s.assigned_nurse_id
  from public.shifts s
  where s.assigned_nurse_id is not null
    and s.branch_id in (select app_private.member_branch_ids())
  union
  select e.nurse_id
  from public.branch_nurse_eligibility e
  where e.branch_id in (select app_private.member_branch_ids())
$$;

revoke execute on all functions in schema app_private from public, anon;
grant execute on all functions in schema app_private to authenticated;

-- ---------------------------------------------------------------------------
-- Enable RLS everywhere
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.agencies enable row level security;
alter table public.agency_branches enable row level security;
alter table public.agency_memberships enable row level security;
alter table public.credential_types enable row level security;
alter table public.nurse_credentials enable row level security;
alter table public.branch_credential_requirements enable row level security;
alter table public.branch_nurse_eligibility enable row level security;
alter table public.shifts enable row level security;
alter table public.shift_events enable row level security;

-- ---------------------------------------------------------------------------
-- SELECT policies (no INSERT/UPDATE/DELETE policies exist for client roles)
-- ---------------------------------------------------------------------------

create policy profiles_select on public.profiles
  for select to authenticated
  using (
    id = (select auth.uid())
    or (select app_private.is_admin())
    or id in (select app_private.agency_visible_profile_ids())
  );

create policy agencies_select on public.agencies
  for select to authenticated
  using (
    (select app_private.is_admin())
    or id in (select app_private.member_agency_ids())
    or id in (
      select b.agency_id from public.agency_branches b
      where b.id in (select app_private.nurse_visible_branch_ids())
    )
  );

create policy agency_branches_select on public.agency_branches
  for select to authenticated
  using (
    (select app_private.is_admin())
    or agency_id in (select app_private.member_agency_ids())
    or id in (select app_private.nurse_visible_branch_ids())
  );

create policy agency_memberships_select on public.agency_memberships
  for select to authenticated
  using (
    profile_id = (select auth.uid())
    or (select app_private.is_admin())
  );

create policy credential_types_select on public.credential_types
  for select to authenticated
  using (true);

create policy nurse_credentials_select on public.nurse_credentials
  for select to authenticated
  using (
    nurse_id = (select auth.uid())
    or (select app_private.is_admin())
  );

create policy branch_credential_requirements_select on public.branch_credential_requirements
  for select to authenticated
  using (
    (select app_private.is_admin())
    or branch_id in (select app_private.member_branch_ids())
    or branch_id in (select app_private.nurse_visible_branch_ids())
  );

create policy branch_nurse_eligibility_select on public.branch_nurse_eligibility
  for select to authenticated
  using (
    nurse_id = (select auth.uid())
    or (select app_private.is_admin())
    or branch_id in (select app_private.member_branch_ids())
  );

create policy shifts_select on public.shifts
  for select to authenticated
  using (
    (select app_private.is_admin())
    or branch_id in (select app_private.member_branch_ids())
    or assigned_nurse_id = (select auth.uid())
    or (
      status = 'open'
      and branch_id in (select app_private.nurse_active_branch_ids())
    )
  );

create policy shift_events_select on public.shift_events
  for select to authenticated
  using (
    (select app_private.is_admin())
    or shift_id in (
      select s.id from public.shifts s
      where s.branch_id in (select app_private.member_branch_ids())
    )
    or shift_id in (
      select s.id from public.shifts s
      where s.assigned_nurse_id = (select auth.uid())
    )
  );

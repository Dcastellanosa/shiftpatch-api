-- Agency administration, user provisioning, nurse eligibility management and
-- a write-only audit trail.
--
-- Additive only. Enforces the existing `agencies.status`, adds
-- `agency_branches.status`, allows several active memberships per agency
-- user, and adds the admin command functions. Every command is SECURITY
-- DEFINER, executable only by `service_role`, performs its checks and writes
-- in one transaction, returns a typed outcome, and records an audit row.
--
-- Inactive agency: blocks branch creation, user provisioning, eligibility
-- changes, shift creation and claims at every branch of the agency.
-- Inactive branch: blocks user provisioning, eligibility changes, shift
-- creation and claims at that branch.

-- ---------------------------------------------------------------------------
-- Branch status, multi-agency memberships
-- ---------------------------------------------------------------------------

alter table shiftpatch.agency_branches
  add column status text not null default 'active' check (status in ('active', 'inactive'));

-- An agency user may manage several agencies. `unique (profile_id, agency_id)` stays.
drop index shiftpatch.agency_memberships_one_active_per_profile;

-- ---------------------------------------------------------------------------
-- Audit events: write-only in this slice
--
-- RLS is enabled with no policies and no table privileges for any client role
-- or for service_role. Rows are written only by the SECURITY DEFINER commands
-- below (which run as the table owner) and can never be updated or deleted.
-- ---------------------------------------------------------------------------

create type shiftpatch.audit_entity_type as enum (
  'agency',
  'agency_branch',
  'agency_membership',
  'branch_nurse_eligibility',
  'profile'
);

create type shiftpatch.audit_action as enum (
  'created',
  'updated',
  'activated',
  'deactivated',
  'invited',
  'eligibility_activated',
  'eligibility_suspended'
);

create table shiftpatch.audit_events (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid not null references shiftpatch.profiles (id),
  entity_type shiftpatch.audit_entity_type not null,
  entity_id uuid not null,
  action shiftpatch.audit_action not null,
  previous_status text,
  new_status text,
  -- clock_timestamp(): several audit rows written by one transaction keep their order.
  occurred_at timestamptz not null default clock_timestamp()
);

create index audit_events_entity_idx on shiftpatch.audit_events (entity_type, entity_id, occurred_at);
create index audit_events_actor_idx on shiftpatch.audit_events (actor_id);

alter table shiftpatch.audit_events enable row level security;
revoke all on table shiftpatch.audit_events from public, anon, authenticated, service_role;

create function shiftpatch.audit_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'audit_events is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

revoke execute on function shiftpatch.audit_events_append_only() from public, anon, authenticated;

create trigger audit_events_no_update
  before update or delete on shiftpatch.audit_events
  for each row execute function shiftpatch.audit_events_append_only();

create trigger audit_events_no_truncate
  before truncate on shiftpatch.audit_events
  for each statement execute function shiftpatch.audit_events_append_only();

-- Internal helper used by the commands. Not callable by any client role.
create function shiftpatch.record_audit(
  p_actor_id uuid,
  p_entity_type shiftpatch.audit_entity_type,
  p_entity_id uuid,
  p_action shiftpatch.audit_action,
  p_previous_status text,
  p_new_status text
)
returns void
language sql
volatile
set search_path = ''
as $$
  insert into shiftpatch.audit_events (actor_id, entity_type, entity_id, action, previous_status, new_status)
  values (p_actor_id, p_entity_type, p_entity_id, p_action, p_previous_status, p_new_status)
$$;

revoke execute on function shiftpatch.record_audit(uuid, shiftpatch.audit_entity_type, uuid, shiftpatch.audit_action, text, text)
  from public, anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Composite return type of the admin commands (a type, not a table)
-- ---------------------------------------------------------------------------

create type shiftpatch.admin_command_result as (
  outcome text,
  entity_id uuid
);

-- ---------------------------------------------------------------------------
-- Agencies
-- ---------------------------------------------------------------------------

-- Outcomes: created · actor_not_allowed · name_taken
create function shiftpatch.create_agency(p_actor_id uuid, p_name text)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  begin
    insert into shiftpatch.agencies (name) values (btrim(p_name)) returning id into v_id;
  exception when unique_violation then
    return ('name_taken', null)::shiftpatch.admin_command_result;
  end;

  perform shiftpatch.record_audit(p_actor_id, 'agency', v_id, 'created', null, 'active');
  return ('created', v_id)::shiftpatch.admin_command_result;
end;
$$;

-- Outcomes: updated · actor_not_allowed · agency_not_found · name_taken
-- Null arguments mean "unchanged". Locks the agency row so a status change
-- waits for in-flight shift creations and claims at its branches.
create function shiftpatch.update_agency(p_actor_id uuid, p_agency_id uuid, p_name text, p_status text)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_agency shiftpatch.agencies%rowtype;
  v_name text := nullif(btrim(p_name), '');
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  select * into v_agency from shiftpatch.agencies a where a.id = p_agency_id for update;
  if not found then
    return ('agency_not_found', null)::shiftpatch.admin_command_result;
  end if;

  begin
    update shiftpatch.agencies
    set name = coalesce(v_name, name), status = coalesce(p_status, status)
    where id = p_agency_id;
  exception when unique_violation then
    return ('name_taken', null)::shiftpatch.admin_command_result;
  end;

  if v_name is not null and v_name <> v_agency.name then
    perform shiftpatch.record_audit(p_actor_id, 'agency', p_agency_id, 'updated', v_agency.status, v_agency.status);
  end if;
  if p_status is not null and p_status <> v_agency.status then
    perform shiftpatch.record_audit(
      p_actor_id, 'agency', p_agency_id,
      case when p_status = 'active' then 'activated' else 'deactivated' end::shiftpatch.audit_action,
      v_agency.status, p_status
    );
  end if;
  return ('updated', p_agency_id)::shiftpatch.admin_command_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Branches
-- ---------------------------------------------------------------------------

-- Outcomes: created · actor_not_allowed · agency_not_found · agency_inactive · name_taken
create function shiftpatch.create_branch(
  p_actor_id uuid,
  p_agency_id uuid,
  p_name text,
  p_address text,
  p_timezone text
)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_agency_status text;
  v_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  select a.status into v_agency_status from shiftpatch.agencies a where a.id = p_agency_id for share;
  if not found then
    return ('agency_not_found', null)::shiftpatch.admin_command_result;
  end if;
  if v_agency_status <> 'active' then
    return ('agency_inactive', null)::shiftpatch.admin_command_result;
  end if;

  begin
    insert into shiftpatch.agency_branches (agency_id, name, address, timezone)
    values (p_agency_id, btrim(p_name), btrim(p_address), p_timezone)
    returning id into v_id;
  exception when unique_violation then
    return ('name_taken', null)::shiftpatch.admin_command_result;
  end;

  perform shiftpatch.record_audit(p_actor_id, 'agency_branch', v_id, 'created', null, 'active');
  return ('created', v_id)::shiftpatch.admin_command_result;
end;
$$;

-- Outcomes: updated · actor_not_allowed · branch_not_found · name_taken
-- Null arguments mean "unchanged". Locks the branch row so a status change
-- waits for in-flight shift creations and claims at the branch. Activating a
-- branch under an inactive agency is allowed; availability still requires
-- both to be active.
create function shiftpatch.update_branch(
  p_actor_id uuid,
  p_branch_id uuid,
  p_name text,
  p_address text,
  p_timezone text,
  p_status text
)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_branch shiftpatch.agency_branches%rowtype;
  v_name text := nullif(btrim(p_name), '');
  v_address text := nullif(btrim(p_address), '');
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  select * into v_branch from shiftpatch.agency_branches b where b.id = p_branch_id for update;
  if not found then
    return ('branch_not_found', null)::shiftpatch.admin_command_result;
  end if;

  begin
    update shiftpatch.agency_branches
    set name = coalesce(v_name, name),
        address = coalesce(v_address, address),
        timezone = coalesce(p_timezone, timezone),
        status = coalesce(p_status, status)
    where id = p_branch_id;
  exception when unique_violation then
    return ('name_taken', null)::shiftpatch.admin_command_result;
  end;

  if (v_name is not null and v_name <> v_branch.name)
     or (v_address is not null and v_address <> v_branch.address)
     or (p_timezone is not null and p_timezone <> v_branch.timezone) then
    perform shiftpatch.record_audit(p_actor_id, 'agency_branch', p_branch_id, 'updated', v_branch.status, v_branch.status);
  end if;
  if p_status is not null and p_status <> v_branch.status then
    perform shiftpatch.record_audit(
      p_actor_id, 'agency_branch', p_branch_id,
      case when p_status = 'active' then 'activated' else 'deactivated' end::shiftpatch.audit_action,
      v_branch.status, p_status
    );
  end if;
  return ('updated', p_branch_id)::shiftpatch.admin_command_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- User provisioning (after the Auth user exists)
--
-- Outcomes: provisioned · actor_not_allowed · auth_user_not_found ·
--           profile_exists · invalid_assignment · agency_not_found ·
--           agency_inactive · branch_not_found · branch_inactive
--
-- agency: one active membership per agency id (all must be active agencies).
-- nurse:  one active eligibility at p_branch_id (branch and agency active);
--         the nurse's agency access is derived from that eligibility.
-- admin:  the profile only.
-- ---------------------------------------------------------------------------

create function shiftpatch.provision_user(
  p_actor_id uuid,
  p_user_id uuid,
  p_full_name text,
  p_role shiftpatch.app_role,
  p_agency_ids uuid[],
  p_branch_id uuid
)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_agency_ids uuid[] := coalesce(p_agency_ids, '{}');
  v_agency_id uuid;
  v_status text;
  v_agency_status text;
  v_row_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  if not exists (select 1 from auth.users u where u.id = p_user_id) then
    return ('auth_user_not_found', null)::shiftpatch.admin_command_result;
  end if;
  if exists (select 1 from shiftpatch.profiles p where p.id = p_user_id) then
    return ('profile_exists', null)::shiftpatch.admin_command_result;
  end if;

  if p_role = 'agency' then
    if cardinality(v_agency_ids) = 0 or p_branch_id is not null then
      return ('invalid_assignment', null)::shiftpatch.admin_command_result;
    end if;
    for v_agency_id in select distinct a from unnest(v_agency_ids) as a loop
      select ag.status into v_status from shiftpatch.agencies ag where ag.id = v_agency_id for share;
      if not found then
        return ('agency_not_found', null)::shiftpatch.admin_command_result;
      end if;
      if v_status <> 'active' then
        return ('agency_inactive', null)::shiftpatch.admin_command_result;
      end if;
    end loop;
  elsif p_role = 'nurse' then
    if p_branch_id is null or cardinality(v_agency_ids) > 0 then
      return ('invalid_assignment', null)::shiftpatch.admin_command_result;
    end if;
    select b.status, a.status into v_status, v_agency_status
    from shiftpatch.agency_branches b
    join shiftpatch.agencies a on a.id = b.agency_id
    where b.id = p_branch_id
    for share of b, a;
    if not found then
      return ('branch_not_found', null)::shiftpatch.admin_command_result;
    end if;
    if v_agency_status <> 'active' then
      return ('agency_inactive', null)::shiftpatch.admin_command_result;
    end if;
    if v_status <> 'active' then
      return ('branch_inactive', null)::shiftpatch.admin_command_result;
    end if;
  else
    if cardinality(v_agency_ids) > 0 or p_branch_id is not null then
      return ('invalid_assignment', null)::shiftpatch.admin_command_result;
    end if;
  end if;

  insert into shiftpatch.profiles (id, full_name, role) values (p_user_id, btrim(p_full_name), p_role);
  perform shiftpatch.record_audit(p_actor_id, 'profile', p_user_id, 'invited', null, p_role::text);

  if p_role = 'agency' then
    for v_agency_id in select distinct a from unnest(v_agency_ids) as a loop
      insert into shiftpatch.agency_memberships (profile_id, agency_id, status)
      values (p_user_id, v_agency_id, 'active')
      returning id into v_row_id;
      perform shiftpatch.record_audit(p_actor_id, 'agency_membership', v_row_id, 'created', null, 'active');
    end loop;
  elsif p_role = 'nurse' then
    insert into shiftpatch.branch_nurse_eligibility (nurse_id, branch_id, status, activated_at)
    values (p_user_id, p_branch_id, 'active', now())
    returning id into v_row_id;
    perform shiftpatch.record_audit(p_actor_id, 'branch_nurse_eligibility', v_row_id, 'eligibility_activated', null, 'active');
  end if;

  return ('provisioned', p_user_id)::shiftpatch.admin_command_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Nurse eligibility at a branch
--
-- Outcomes: updated · actor_not_allowed · branch_not_found · nurse_not_found ·
--           agency_inactive · branch_inactive
--
-- Admins may target any nurse and branch. Agency actors may target only
-- branches of agencies where they hold an active membership, and only nurses
-- already connected to those agencies (any eligibility row at one of their
-- branches); anything else answers *_not_found so ids are not enumerable.
-- ---------------------------------------------------------------------------

create function shiftpatch.set_branch_eligibility(
  p_actor_id uuid,
  p_nurse_id uuid,
  p_branch_id uuid,
  p_status shiftpatch.eligibility_status
)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_agency_id uuid;
  v_branch_status text;
  v_agency_status text;
  v_existing shiftpatch.branch_nurse_eligibility%rowtype;
  v_row_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is null or v_role not in ('admin', 'agency') then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;
  if p_status not in ('active', 'suspended') then
    raise exception 'eligibility can only be set to active or suspended' using errcode = 'check_violation';
  end if;

  if v_role = 'admin' then
    select b.agency_id, b.status, a.status into v_agency_id, v_branch_status, v_agency_status
    from shiftpatch.agency_branches b
    join shiftpatch.agencies a on a.id = b.agency_id
    where b.id = p_branch_id
    for share of b, a;
  else
    select b.agency_id, b.status, a.status into v_agency_id, v_branch_status, v_agency_status
    from shiftpatch.agency_branches b
    join shiftpatch.agencies a on a.id = b.agency_id
    join shiftpatch.agency_memberships m on m.agency_id = b.agency_id
    where b.id = p_branch_id
      and m.profile_id = p_actor_id
      and m.status = 'active'
    for share of b, a;
  end if;
  if not found then
    return ('branch_not_found', null)::shiftpatch.admin_command_result;
  end if;

  if not exists (select 1 from shiftpatch.profiles p where p.id = p_nurse_id and p.role = 'nurse') then
    return ('nurse_not_found', null)::shiftpatch.admin_command_result;
  end if;
  if v_role = 'agency' and not exists (
    select 1
    from shiftpatch.branch_nurse_eligibility e
    join shiftpatch.agency_branches b on b.id = e.branch_id
    join shiftpatch.agency_memberships m on m.agency_id = b.agency_id
    where e.nurse_id = p_nurse_id
      and m.profile_id = p_actor_id
      and m.status = 'active'
  ) then
    return ('nurse_not_found', null)::shiftpatch.admin_command_result;
  end if;

  if v_agency_status <> 'active' then
    return ('agency_inactive', null)::shiftpatch.admin_command_result;
  end if;
  if v_branch_status <> 'active' then
    return ('branch_inactive', null)::shiftpatch.admin_command_result;
  end if;

  select * into v_existing
  from shiftpatch.branch_nurse_eligibility e
  where e.nurse_id = p_nurse_id and e.branch_id = p_branch_id
  for update;

  if not found then
    insert into shiftpatch.branch_nurse_eligibility (nurse_id, branch_id, status, activated_at)
    values (p_nurse_id, p_branch_id, p_status, case when p_status = 'active' then now() end)
    returning id into v_row_id;
    perform shiftpatch.record_audit(
      p_actor_id, 'branch_nurse_eligibility', v_row_id,
      case when p_status = 'active' then 'eligibility_activated' else 'eligibility_suspended' end::shiftpatch.audit_action,
      null, p_status::text
    );
    return ('updated', v_row_id)::shiftpatch.admin_command_result;
  end if;

  if v_existing.status <> p_status then
    update shiftpatch.branch_nurse_eligibility
    set status = p_status,
        activated_at = case when p_status = 'active' then now() else activated_at end
    where id = v_existing.id;
    perform shiftpatch.record_audit(
      p_actor_id, 'branch_nurse_eligibility', v_existing.id,
      case when p_status = 'active' then 'eligibility_activated' else 'eligibility_suspended' end::shiftpatch.audit_action,
      v_existing.status::text, p_status::text
    );
  end if;
  return ('updated', v_existing.id)::shiftpatch.admin_command_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- Admin user listing (read helper, callable by authenticated admins only)
--
-- Inner join: the development project is shared with another application
-- whose auth.users rows have no shiftpatch profile and must never be listed.
-- ---------------------------------------------------------------------------

create function shiftpatch.list_users_admin()
returns table (
  id uuid,
  email text,
  full_name text,
  role shiftpatch.app_role,
  invited_at timestamptz,
  confirmed_at timestamptz,
  last_sign_in_at timestamptz
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not shiftpatch_private.is_admin() then
    raise exception 'only administrators may list users' using errcode = 'insufficient_privilege';
  end if;
  return query
    select u.id, u.email::text, p.full_name, p.role, u.invited_at, u.confirmed_at, u.last_sign_in_at
    from auth.users u
    join shiftpatch.profiles p on p.id = u.id
    order by p.full_name, u.id;
end;
$$;

-- ---------------------------------------------------------------------------
-- Privileges: commands for the backend only; the listing for signed-in admins
-- ---------------------------------------------------------------------------

revoke execute on function shiftpatch.create_agency(uuid, text) from public, anon, authenticated;
revoke execute on function shiftpatch.update_agency(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function shiftpatch.create_branch(uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function shiftpatch.update_branch(uuid, uuid, text, text, text, text) from public, anon, authenticated;
revoke execute on function shiftpatch.provision_user(uuid, uuid, text, shiftpatch.app_role, uuid[], uuid) from public, anon, authenticated;
revoke execute on function shiftpatch.set_branch_eligibility(uuid, uuid, uuid, shiftpatch.eligibility_status) from public, anon, authenticated;
grant execute on function shiftpatch.create_agency(uuid, text) to service_role;
grant execute on function shiftpatch.update_agency(uuid, uuid, text, text) to service_role;
grant execute on function shiftpatch.create_branch(uuid, uuid, text, text, text) to service_role;
grant execute on function shiftpatch.update_branch(uuid, uuid, text, text, text, text) to service_role;
grant execute on function shiftpatch.provision_user(uuid, uuid, text, shiftpatch.app_role, uuid[], uuid) to service_role;
grant execute on function shiftpatch.set_branch_eligibility(uuid, uuid, uuid, shiftpatch.eligibility_status) to service_role;

revoke execute on function shiftpatch.list_users_admin() from public, anon;
grant execute on function shiftpatch.list_users_admin() to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Shift workflow: inactive agencies and branches block creation and claims
-- ---------------------------------------------------------------------------

-- Added outcomes: agency_inactive · branch_inactive
create or replace function shiftpatch.create_shift(
  p_actor_id uuid,
  p_branch_id uuid,
  p_title text,
  p_starts_at timestamptz,
  p_ends_at timestamptz
)
returns shiftpatch.shift_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_branch_status text;
  v_agency_status text;
  v_shift_id uuid;
  v_event_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is null or v_role not in ('admin', 'agency') then
    return ('actor_not_allowed', null, null)::shiftpatch.shift_command_result;
  end if;

  -- Share-lock the branch and its agency: a concurrent deactivation waits for
  -- this transaction, and a committed deactivation is seen here.
  if v_role = 'admin' then
    select b.status, a.status into v_branch_status, v_agency_status
    from shiftpatch.agency_branches b
    join shiftpatch.agencies a on a.id = b.agency_id
    where b.id = p_branch_id
    for share of b, a;
  else
    select b.status, a.status into v_branch_status, v_agency_status
    from shiftpatch.agency_branches b
    join shiftpatch.agencies a on a.id = b.agency_id
    join shiftpatch.agency_memberships m on m.agency_id = b.agency_id
    where b.id = p_branch_id
      and m.profile_id = p_actor_id
      and m.status = 'active'
    for share of b, a;
  end if;
  if not found then
    return ('branch_not_found', null, null)::shiftpatch.shift_command_result;
  end if;
  if v_agency_status <> 'active' then
    return ('agency_inactive', null, null)::shiftpatch.shift_command_result;
  end if;
  if v_branch_status <> 'active' then
    return ('branch_inactive', null, null)::shiftpatch.shift_command_result;
  end if;

  if p_ends_at <= p_starts_at then
    return ('invalid_time_range', null, null)::shiftpatch.shift_command_result;
  end if;
  if p_starts_at <= now() then
    return ('shift_in_past', null, null)::shiftpatch.shift_command_result;
  end if;

  insert into shiftpatch.shifts (branch_id, title, starts_at, ends_at, status, created_by_id)
  values (p_branch_id, btrim(p_title), p_starts_at, p_ends_at, 'open', p_actor_id)
  returning id into v_shift_id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status)
  values (v_shift_id, p_actor_id, 'created', null, 'open')
  returning id into v_event_id;

  return ('created', v_shift_id, v_event_id)::shiftpatch.shift_command_result;
end;
$$;

-- Added outcomes (checked after the open/started checks and before the
-- eligibility check): agency_inactive · branch_inactive
create or replace function shiftpatch.claim_shift(p_shift_id uuid, p_nurse_id uuid)
returns shiftpatch.shift_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift shiftpatch.shifts%rowtype;
  v_role shiftpatch.app_role;
  v_branch_status text;
  v_agency_status text;
  v_shift_date date;
  v_missing_type uuid;
  v_event_id uuid;
begin
  -- 1. Lock the target shift. Concurrent claims of the same shift queue here;
  --    the loser re-reads the committed row and sees it is no longer open.
  select * into v_shift from shiftpatch.shifts where id = p_shift_id for update;
  if not found then
    return ('shift_not_found', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 2. Lock the nurse's profile so concurrent claims by the same nurse on
  --    different shifts serialize, which keeps the overlap check reliable.
  select p.role into v_role from shiftpatch.profiles p where p.id = p_nurse_id for no key update;
  if v_role is distinct from 'nurse' then
    return ('not_a_nurse', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  if v_shift.status <> 'open' then
    return ('shift_not_open', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  if v_shift.starts_at <= now() then
    return ('shift_started', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 3. The branch and its agency must be active. Share locks make a
  --    concurrent deactivation wait for this claim, and a committed one win.
  select b.status, a.status into v_branch_status, v_agency_status
  from shiftpatch.agency_branches b
  join shiftpatch.agencies a on a.id = b.agency_id
  where b.id = v_shift.branch_id
  for share of b, a;
  if v_agency_status <> 'active' then
    return ('agency_inactive', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;
  if v_branch_status <> 'active' then
    return ('branch_inactive', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 4. Active eligibility at the shift's branch.
  if not exists (
    select 1 from shiftpatch.branch_nurse_eligibility e
    where e.nurse_id = p_nurse_id and e.branch_id = v_shift.branch_id and e.status = 'active'
  ) then
    return ('eligibility_inactive', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 5. Every required credential type needs a credential that is `valid` and
  --    does not expire before the shift's start date (UTC).
  v_shift_date := (v_shift.starts_at at time zone 'UTC')::date;

  select r.credential_type_id into v_missing_type
  from shiftpatch.branch_credential_requirements r
  where r.branch_id = v_shift.branch_id
    and r.is_required
    and not exists (
      select 1 from shiftpatch.nurse_credentials c
      where c.nurse_id = p_nurse_id
        and c.credential_type_id = r.credential_type_id
        and c.status = 'valid'
        and c.expires_at >= v_shift_date
    )
  order by r.credential_type_id
  limit 1;

  if v_missing_type is not null then
    if not exists (
      select 1 from shiftpatch.nurse_credentials c
      where c.nurse_id = p_nurse_id and c.credential_type_id = v_missing_type
    ) then
      return ('credential_missing', p_shift_id, null)::shiftpatch.shift_command_result;
    end if;
    if not exists (
      select 1 from shiftpatch.nurse_credentials c
      where c.nurse_id = p_nurse_id and c.credential_type_id = v_missing_type and c.status <> 'revoked'
    ) then
      return ('credential_revoked', p_shift_id, null)::shiftpatch.shift_command_result;
    end if;
    return ('credential_expired', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 6. No overlapping claimed shift (half-open ranges: back-to-back is fine).
  if exists (
    select 1 from shiftpatch.shifts s
    where s.assigned_nurse_id = p_nurse_id
      and s.status = 'claimed'
      and s.id <> v_shift.id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    return ('schedule_conflict', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 7. Assign, transition and record history in the same transaction.
  update shiftpatch.shifts
  set status = 'claimed', assigned_nurse_id = p_nurse_id
  where id = v_shift.id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status)
  values (v_shift.id, p_nurse_id, 'claimed', 'open', 'claimed')
  returning id into v_event_id;

  return ('claimed', v_shift.id, v_event_id)::shiftpatch.shift_command_result;
end;
$$;

-- Nurses see open shifts only at active branches of active agencies.
create or replace function shiftpatch_private.nurse_active_branch_ids()
returns setof uuid
language sql
stable
security definer
set search_path = ''
as $$
  select e.branch_id
  from shiftpatch.branch_nurse_eligibility e
  join shiftpatch.profiles p on p.id = e.nurse_id
  join shiftpatch.agency_branches b on b.id = e.branch_id and b.status = 'active'
  join shiftpatch.agencies a on a.id = b.agency_id and a.status = 'active'
  where e.nurse_id = auth.uid()
    and e.status = 'active'
    and p.role = 'nurse'
$$;

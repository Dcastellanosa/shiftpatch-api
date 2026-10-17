-- ShiftPatch staffing schema (3NF).
--
-- Additive only: creates types, tables, constraints, indexes and integrity
-- triggers. Row Level Security and grants live in the next migration; the
-- shift workflow functions live in the one after that.
--
-- Conventions:
--   * Every timestamp is timestamptz (stored as UTC).
--   * Bridge tables model many-to-many relationships (agency membership,
--     branch eligibility, branch credential requirements).
--   * No names are copied into shifts; they are joined from their owners.

create extension if not exists btree_gist with schema extensions;

-- ---------------------------------------------------------------------------
-- Types
-- ---------------------------------------------------------------------------

create type public.app_role as enum ('admin', 'agency', 'nurse');
create type public.membership_status as enum ('active', 'suspended');
create type public.eligibility_status as enum ('pending', 'active', 'suspended');
create type public.shift_status as enum ('open', 'claimed', 'cancelled', 'completed', 'no_show');
create type public.credential_status as enum ('valid', 'expired', 'revoked');
create type public.shift_event_type as enum ('created', 'claimed', 'cancelled', 'completed', 'no_show');

-- ---------------------------------------------------------------------------
-- Shared trigger functions
-- ---------------------------------------------------------------------------

create function public.set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- Raises unless the referenced profile has one of the allowed roles. Used by
-- triggers for cross-table rules that CHECK constraints cannot express.
-- Security definer so the lookup is never filtered by the writer's RLS view.
create function public.assert_profile_role(p_profile_id uuid, p_roles public.app_role[], p_column text)
returns void
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if p_profile_id is null then
    return;
  end if;
  if not exists (
    select 1 from public.profiles p where p.id = p_profile_id and p.role = any (p_roles)
  ) then
    raise exception '% must reference a profile with role %', p_column, p_roles
      using errcode = 'check_violation';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- Profiles (one application role per Auth user)
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  full_name text not null check (char_length(btrim(full_name)) between 1 and 200),
  role public.app_role not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger profiles_set_updated_at
  before update on public.profiles
  for each row execute function public.set_updated_at();

-- Profiles are created only for Auth users provisioned with a role in
-- app_metadata. app_metadata can be written only with the service-role key,
-- so a user can never choose their own role. Users without a role get no
-- profile and therefore no access to business data.
create function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_role text := new.raw_app_meta_data ->> 'role';
begin
  if v_role in ('admin', 'agency', 'nurse') then
    insert into public.profiles (id, full_name, role)
    values (
      new.id,
      coalesce(
        nullif(btrim(new.raw_user_meta_data ->> 'full_name'), ''),
        split_part(coalesce(new.email, 'user'), '@', 1)
      ),
      v_role::public.app_role
    )
    on conflict (id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.handle_new_auth_user() from public, anon, authenticated;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_auth_user();

-- ---------------------------------------------------------------------------
-- Agencies and branches
-- ---------------------------------------------------------------------------

create table public.agencies (
  id uuid primary key default gen_random_uuid(),
  name text not null unique check (char_length(btrim(name)) between 1 and 200),
  status text not null default 'active' check (status in ('active', 'inactive')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create trigger agencies_set_updated_at
  before update on public.agencies
  for each row execute function public.set_updated_at();

create table public.agency_branches (
  id uuid primary key default gen_random_uuid(),
  agency_id uuid not null references public.agencies (id),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  address text not null check (char_length(btrim(address)) between 1 and 500),
  -- IANA zone name, used for display only. Shift times are stored in UTC.
  timezone text not null check (timezone ~ '^[A-Za-z]+(/[A-Za-z0-9_+-]+)*$'),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (agency_id, name)
);

create trigger agency_branches_set_updated_at
  before update on public.agency_branches
  for each row execute function public.set_updated_at();

-- ---------------------------------------------------------------------------
-- Agency memberships (which agency users manage which agency)
-- ---------------------------------------------------------------------------

create table public.agency_memberships (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles (id),
  agency_id uuid not null references public.agencies (id),
  status public.membership_status not null default 'active',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (profile_id, agency_id)
);

-- MVP rule: an agency user has at most one active membership.
create unique index agency_memberships_one_active_per_profile
  on public.agency_memberships (profile_id)
  where status = 'active';

create index agency_memberships_agency_id_idx on public.agency_memberships (agency_id);

create trigger agency_memberships_set_updated_at
  before update on public.agency_memberships
  for each row execute function public.set_updated_at();

create function public.agency_memberships_check_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_profile_role(new.profile_id, array['agency']::public.app_role[], 'agency_memberships.profile_id');
  return new;
end;
$$;

create trigger agency_memberships_check_role
  before insert or update of profile_id on public.agency_memberships
  for each row execute function public.agency_memberships_check_role();

-- ---------------------------------------------------------------------------
-- Credentials (global to a nurse, not branch-specific)
-- ---------------------------------------------------------------------------

create table public.credential_types (
  id uuid primary key default gen_random_uuid(),
  code text not null unique check (code ~ '^[a-z][a-z0-9_]{1,62}$'),
  name text not null check (char_length(btrim(name)) between 1 and 200),
  description text
);

-- Reference data required by the claim rules.
insert into public.credential_types (code, name, description) values
  ('nursing_license', 'Nursing license', 'Active state nursing license (RN or LPN).'),
  ('tb_test', 'TB test', 'Negative tuberculosis screening result.');

create table public.nurse_credentials (
  id uuid primary key default gen_random_uuid(),
  nurse_id uuid not null references public.profiles (id),
  credential_type_id uuid not null references public.credential_types (id),
  issued_at date,
  expires_at date not null,
  -- Future Storage object path. No uploads exist yet.
  file_path text,
  status public.credential_status not null default 'valid',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (issued_at is null or issued_at <= expires_at)
);

create index nurse_credentials_nurse_type_idx
  on public.nurse_credentials (nurse_id, credential_type_id);

create trigger nurse_credentials_set_updated_at
  before update on public.nurse_credentials
  for each row execute function public.set_updated_at();

create function public.nurse_credentials_check_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_profile_role(new.nurse_id, array['nurse']::public.app_role[], 'nurse_credentials.nurse_id');
  return new;
end;
$$;

create trigger nurse_credentials_check_role
  before insert or update of nurse_id on public.nurse_credentials
  for each row execute function public.nurse_credentials_check_role();

create table public.branch_credential_requirements (
  branch_id uuid not null references public.agency_branches (id),
  credential_type_id uuid not null references public.credential_types (id),
  is_required boolean not null default true,
  primary key (branch_id, credential_type_id)
);

create index branch_credential_requirements_type_idx
  on public.branch_credential_requirements (credential_type_id);

-- ---------------------------------------------------------------------------
-- Branch eligibility (a nurse can work in many branches across agencies)
-- ---------------------------------------------------------------------------

create table public.branch_nurse_eligibility (
  id uuid primary key default gen_random_uuid(),
  nurse_id uuid not null references public.profiles (id),
  branch_id uuid not null references public.agency_branches (id),
  status public.eligibility_status not null default 'pending',
  activated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (nurse_id, branch_id),
  check (status <> 'active' or activated_at is not null)
);

create index branch_nurse_eligibility_branch_idx on public.branch_nurse_eligibility (branch_id);

create trigger branch_nurse_eligibility_set_updated_at
  before update on public.branch_nurse_eligibility
  for each row execute function public.set_updated_at();

create function public.branch_nurse_eligibility_check_role()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_profile_role(new.nurse_id, array['nurse']::public.app_role[], 'branch_nurse_eligibility.nurse_id');
  return new;
end;
$$;

create trigger branch_nurse_eligibility_check_role
  before insert or update of nurse_id on public.branch_nurse_eligibility
  for each row execute function public.branch_nurse_eligibility_check_role();

-- ---------------------------------------------------------------------------
-- Shifts
-- ---------------------------------------------------------------------------

create table public.shifts (
  id uuid primary key default gen_random_uuid(),
  branch_id uuid not null references public.agency_branches (id),
  title text not null check (char_length(btrim(title)) between 1 and 200),
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  status public.shift_status not null default 'open',
  assigned_nurse_id uuid references public.profiles (id),
  created_by_id uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint shifts_ends_after_starts check (ends_at > starts_at),
  constraint shifts_open_unassigned check (status <> 'open' or assigned_nurse_id is null),
  constraint shifts_assigned_when_staffed check (
    status not in ('claimed', 'completed', 'no_show') or assigned_nurse_id is not null
  ),
  -- Integrity backstop for claim_shift: a nurse can never hold two
  -- overlapping claimed shifts, whatever path writes the row.
  constraint shifts_no_overlapping_claims exclude using gist (
    assigned_nurse_id with =,
    tstzrange(starts_at, ends_at, '[)') with &&
  ) where (status = 'claimed')
);

create index shifts_branch_starts_idx on public.shifts (branch_id, starts_at);
create index shifts_status_starts_idx on public.shifts (status, starts_at);
create index shifts_assigned_nurse_starts_idx on public.shifts (assigned_nurse_id, starts_at)
  where assigned_nurse_id is not null;
create index shifts_created_by_idx on public.shifts (created_by_id);

create trigger shifts_set_updated_at
  before update on public.shifts
  for each row execute function public.set_updated_at();

create function public.shifts_check_roles()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  perform public.assert_profile_role(new.assigned_nurse_id, array['nurse']::public.app_role[], 'shifts.assigned_nurse_id');
  perform public.assert_profile_role(new.created_by_id, array['agency', 'admin']::public.app_role[], 'shifts.created_by_id');
  return new;
end;
$$;

create trigger shifts_check_roles
  before insert or update of assigned_nurse_id, created_by_id on public.shifts
  for each row execute function public.shifts_check_roles();

-- ---------------------------------------------------------------------------
-- Shift events (append-only audit history)
-- ---------------------------------------------------------------------------

create table public.shift_events (
  id uuid primary key default gen_random_uuid(),
  shift_id uuid not null references public.shifts (id),
  actor_id uuid not null references public.profiles (id),
  event_type public.shift_event_type not null,
  previous_status public.shift_status,
  new_status public.shift_status not null,
  reason text check (reason is null or char_length(reason) <= 1000),
  occurred_at timestamptz not null default now()
);

create index shift_events_shift_occurred_idx on public.shift_events (shift_id, occurred_at);
create index shift_events_actor_idx on public.shift_events (actor_id);

create function public.shift_events_append_only()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  raise exception 'shift_events is append-only'
    using errcode = 'insufficient_privilege';
end;
$$;

create trigger shift_events_no_update
  before update or delete on public.shift_events
  for each row execute function public.shift_events_append_only();

create trigger shift_events_no_truncate
  before truncate on public.shift_events
  for each statement execute function public.shift_events_append_only();

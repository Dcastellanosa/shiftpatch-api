-- Trial contract compatibility.
--
-- Additive. Brings the schema in line with the required API contract:
--   * public slugs (`agency-a`, `nurse-1`, `shift-1`) next to the internal UUIDs,
--     assigned by a trigger for new rows and backfilled for existing ones;
--   * a marketplace read function so every signed-in user can list every shift
--     (the contract's `GET /api/shifts`) without widening the table policies;
--   * `cancel_shift_claim`: no-show / advance cancellation that reopens a shift;
--   * `create_shift` and `claim_shift` no longer reject past or started shifts
--     (the contract's seed data is dated and must stay claimable).

-- ---------------------------------------------------------------------------
-- Slugs
-- ---------------------------------------------------------------------------

create sequence shiftpatch.agency_slug_seq;
create sequence shiftpatch.shift_slug_seq;
create sequence shiftpatch.nurse_slug_seq;
create sequence shiftpatch.admin_slug_seq;
create sequence shiftpatch.agency_user_slug_seq;

alter table shiftpatch.agencies add column slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
alter table shiftpatch.profiles add column slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');
alter table shiftpatch.shifts add column slug text unique check (slug ~ '^[a-z0-9][a-z0-9-]{0,62}$');

-- Picks the next free `<prefix>-<n>`. Explicitly inserted slugs (the seed's
-- `agency-a`, `shift-1`, ...) may already occupy a number, so the loop skips
-- taken values instead of failing on the unique index.
create function shiftpatch.assign_slug()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_prefix text;
  v_seq text;
  v_taken boolean;
begin
  if new.slug is not null then
    return new;
  end if;
  if tg_table_name = 'agencies' then
    v_prefix := 'agency-'; v_seq := 'shiftpatch.agency_slug_seq';
  elsif tg_table_name = 'shifts' then
    v_prefix := 'shift-'; v_seq := 'shiftpatch.shift_slug_seq';
  elsif new.role = 'nurse' then
    v_prefix := 'nurse-'; v_seq := 'shiftpatch.nurse_slug_seq';
  elsif new.role = 'admin' then
    v_prefix := 'admin-'; v_seq := 'shiftpatch.admin_slug_seq';
  else
    v_prefix := 'agency-user-'; v_seq := 'shiftpatch.agency_user_slug_seq';
  end if;
  loop
    new.slug := v_prefix || nextval(v_seq);
    execute format('select exists (select 1 from shiftpatch.%I where slug = $1)', tg_table_name) into v_taken using new.slug;
    exit when not v_taken;
  end loop;
  return new;
end;
$$;

revoke execute on function shiftpatch.assign_slug() from public, anon, authenticated;

create trigger agencies_assign_slug before insert on shiftpatch.agencies
  for each row execute function shiftpatch.assign_slug();
create trigger profiles_assign_slug before insert on shiftpatch.profiles
  for each row execute function shiftpatch.assign_slug();
create trigger shifts_assign_slug before insert on shiftpatch.shifts
  for each row execute function shiftpatch.assign_slug();

-- Backfill existing rows in creation order, then move the sequences past them.
with numbered as (
  select id, row_number() over (order by created_at, id) as n from shiftpatch.agencies where slug is null
)
update shiftpatch.agencies a set slug = 'agency-' || numbered.n from numbered where numbered.id = a.id;

with numbered as (
  select id, row_number() over (order by created_at, id) as n from shiftpatch.shifts where slug is null
)
update shiftpatch.shifts s set slug = 'shift-' || numbered.n from numbered where numbered.id = s.id;

with numbered as (
  select id, role, row_number() over (partition by role order by created_at, id) as n
  from shiftpatch.profiles where slug is null
)
update shiftpatch.profiles p
set slug = case numbered.role when 'nurse' then 'nurse-' when 'admin' then 'admin-' else 'agency-user-' end || numbered.n
from numbered where numbered.id = p.id;

select setval('shiftpatch.agency_slug_seq', greatest(1, (select count(*) from shiftpatch.agencies)), (select count(*) > 0 from shiftpatch.agencies));
select setval('shiftpatch.shift_slug_seq', greatest(1, (select count(*) from shiftpatch.shifts)), (select count(*) > 0 from shiftpatch.shifts));
select setval('shiftpatch.nurse_slug_seq', greatest(1, (select count(*) from shiftpatch.profiles where role = 'nurse')), (select count(*) > 0 from shiftpatch.profiles where role = 'nurse'));
select setval('shiftpatch.admin_slug_seq', greatest(1, (select count(*) from shiftpatch.profiles where role = 'admin')), (select count(*) > 0 from shiftpatch.profiles where role = 'admin'));
select setval('shiftpatch.agency_user_slug_seq', greatest(1, (select count(*) from shiftpatch.profiles where role = 'agency')), (select count(*) > 0 from shiftpatch.profiles where role = 'agency'));

alter table shiftpatch.agencies alter column slug set not null;
alter table shiftpatch.profiles alter column slug set not null;
alter table shiftpatch.shifts alter column slug set not null;

-- ---------------------------------------------------------------------------
-- Marketplace read: every shift, for every signed-in user
--
-- The contract lists every shift across all agencies to nurses. Rather than
-- widening four table policies (which would also expose other nurses'
-- profiles to normal reads), this SECURITY DEFINER projection returns exactly
-- the columns the API needs. Agency and nurse scoping of shift *events*,
-- claims and commands is unchanged.
-- ---------------------------------------------------------------------------

create function shiftpatch.list_shifts_marketplace(p_agency_slug text default null, p_shift_slug text default null)
returns table (
  id uuid,
  slug text,
  title text,
  starts_at timestamptz,
  ends_at timestamptz,
  status shiftpatch.shift_status,
  created_at timestamptz,
  updated_at timestamptz,
  branch_id uuid,
  branch_name text,
  branch_address text,
  branch_timezone text,
  branch_status text,
  agency_id uuid,
  agency_slug text,
  agency_name text,
  agency_status text,
  assigned_nurse_id uuid,
  assigned_nurse_slug text,
  assigned_nurse_name text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
#variable_conflict use_column
begin
  if shiftpatch_private.current_app_role() is null then
    raise exception 'sign in to list shifts' using errcode = 'insufficient_privilege';
  end if;
  return query
    select s.id, s.slug, s.title, s.starts_at, s.ends_at, s.status, s.created_at, s.updated_at,
           b.id, b.name, b.address, b.timezone, b.status,
           a.id, a.slug, a.name, a.status,
           n.id, n.slug, n.full_name
    from shiftpatch.shifts s
    join shiftpatch.agency_branches b on b.id = s.branch_id
    join shiftpatch.agencies a on a.id = b.agency_id
    left join shiftpatch.profiles n on n.id = s.assigned_nurse_id
    where (p_agency_slug is null or a.slug = p_agency_slug)
      and (p_shift_slug is null or s.slug = p_shift_slug)
    order by s.starts_at, s.id;
end;
$$;

revoke execute on function shiftpatch.list_shifts_marketplace(text, text) from public, anon;
grant execute on function shiftpatch.list_shifts_marketplace(text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Cancellation / no-show: release the claim and reopen the shift
--
-- Outcomes: cancelled · actor_not_allowed · invalid_reason · shift_not_found ·
--           shift_not_claimed
-- The previous nurse's slug is returned because the agency may lose
-- visibility of that profile once the claim is gone.
-- ---------------------------------------------------------------------------

create type shiftpatch.cancel_command_result as (
  outcome text,
  shift_id uuid,
  event_id uuid,
  previous_nurse_id uuid,
  previous_nurse_slug text
);

create function shiftpatch.cancel_shift_claim(p_actor_id uuid, p_shift_id uuid, p_reason text)
returns shiftpatch.cancel_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_shift shiftpatch.shifts%rowtype;
  v_allowed boolean := false;
  v_event_id uuid;
  v_nurse_slug text;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is null then
    return ('actor_not_allowed', null, null, null, null)::shiftpatch.cancel_command_result;
  end if;
  if p_reason is null or p_reason not in ('no-show', 'advance') then
    return ('invalid_reason', null, null, null, null)::shiftpatch.cancel_command_result;
  end if;

  select * into v_shift from shiftpatch.shifts where id = p_shift_id for update;
  if not found then
    return ('shift_not_found', null, null, null, null)::shiftpatch.cancel_command_result;
  end if;
  if v_shift.status <> 'claimed' then
    return ('shift_not_claimed', p_shift_id, null, null, null)::shiftpatch.cancel_command_result;
  end if;

  if v_role = 'admin' then
    v_allowed := true;
  elsif v_role = 'agency' then
    v_allowed := exists (
      select 1
      from shiftpatch.agency_branches b
      join shiftpatch.agency_memberships m on m.agency_id = b.agency_id
      where b.id = v_shift.branch_id and m.profile_id = p_actor_id and m.status = 'active'
    );
  else
    v_allowed := v_shift.assigned_nurse_id = p_actor_id;
  end if;
  if not v_allowed then
    return ('actor_not_allowed', p_shift_id, null, null, null)::shiftpatch.cancel_command_result;
  end if;

  select p.slug into v_nurse_slug from shiftpatch.profiles p where p.id = v_shift.assigned_nurse_id;

  update shiftpatch.shifts set status = 'open', assigned_nurse_id = null where id = v_shift.id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status, reason)
  values (
    v_shift.id,
    p_actor_id,
    case when p_reason = 'no-show' then 'no_show' else 'cancelled' end::shiftpatch.shift_event_type,
    'claimed',
    'open',
    p_reason
  )
  returning id into v_event_id;

  return ('cancelled', v_shift.id, v_event_id, v_shift.assigned_nurse_id, v_nurse_slug)::shiftpatch.cancel_command_result;
end;
$$;

revoke execute on function shiftpatch.cancel_shift_claim(uuid, uuid, text) from public, anon, authenticated;
grant execute on function shiftpatch.cancel_shift_claim(uuid, uuid, text) to service_role;

-- ---------------------------------------------------------------------------
-- Shift workflow without timing guards
--
-- The contract's sample shifts are dated and must remain claimable, and its
-- create example posts a dated shift. `shift_in_past` and `shift_started`
-- are no longer produced; every other rule is unchanged.
-- ---------------------------------------------------------------------------

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

  insert into shiftpatch.shifts (branch_id, title, starts_at, ends_at, status, created_by_id)
  values (p_branch_id, btrim(p_title), p_starts_at, p_ends_at, 'open', p_actor_id)
  returning id into v_shift_id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status)
  values (v_shift_id, p_actor_id, 'created', null, 'open')
  returning id into v_event_id;

  return ('created', v_shift_id, v_event_id)::shiftpatch.shift_command_result;
end;
$$;

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
  select * into v_shift from shiftpatch.shifts where id = p_shift_id for update;
  if not found then
    return ('shift_not_found', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  select p.role into v_role from shiftpatch.profiles p where p.id = p_nurse_id for no key update;
  if v_role is distinct from 'nurse' then
    return ('not_a_nurse', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  if v_shift.status <> 'open' then
    return ('shift_not_open', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

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

  if not exists (
    select 1 from shiftpatch.branch_nurse_eligibility e
    where e.nurse_id = p_nurse_id and e.branch_id = v_shift.branch_id and e.status = 'active'
  ) then
    return ('eligibility_inactive', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

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

  if exists (
    select 1 from shiftpatch.shifts s
    where s.assigned_nurse_id = p_nurse_id
      and s.status = 'claimed'
      and s.id <> v_shift.id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    return ('schedule_conflict', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  update shiftpatch.shifts
  set status = 'claimed', assigned_nurse_id = p_nurse_id
  where id = v_shift.id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status)
  values (v_shift.id, p_nurse_id, 'claimed', 'open', 'claimed')
  returning id into v_event_id;

  return ('claimed', v_shift.id, v_event_id)::shiftpatch.shift_command_result;
end;
$$;

-- Shift workflow functions.
--
-- Each function performs its checks and writes in a single transaction and
-- returns a typed outcome instead of raising for expected domain failures.
-- They are SECURITY DEFINER and executable only by `service_role`: the API
-- validates the cookie session and the caller's role first, then passes the
-- verified profile ID. Client roles cannot call them.

create type shiftpatch.shift_command_result as (
  outcome text,
  shift_id uuid,
  event_id uuid
);

-- ---------------------------------------------------------------------------
-- claim_shift
--
-- Outcomes:
--   claimed               success
--   shift_not_found       no shift with that ID
--   not_a_nurse           the actor is not a nurse profile
--   shift_not_open        the shift is claimed, cancelled, completed or no_show
--   shift_started         the shift has already started
--   eligibility_inactive  no active eligibility at the shift's branch
--   credential_missing    a required credential type has never been recorded
--   credential_revoked    a required credential exists only in revoked form
--   credential_expired    a required credential is expired or expires before
--                         the shift's start date (UTC)
--   schedule_conflict     the nurse holds an overlapping claimed shift
-- ---------------------------------------------------------------------------

create function shiftpatch.claim_shift(p_shift_id uuid, p_nurse_id uuid)
returns shiftpatch.shift_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_shift shiftpatch.shifts%rowtype;
  v_role shiftpatch.app_role;
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

  -- 3. Active eligibility at the shift's branch.
  if not exists (
    select 1 from shiftpatch.branch_nurse_eligibility e
    where e.nurse_id = p_nurse_id and e.branch_id = v_shift.branch_id and e.status = 'active'
  ) then
    return ('eligibility_inactive', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 4. Every required credential type needs a credential that is `valid` and
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

  -- 5. No overlapping claimed shift (half-open ranges: back-to-back is fine).
  if exists (
    select 1 from shiftpatch.shifts s
    where s.assigned_nurse_id = p_nurse_id
      and s.status = 'claimed'
      and s.id <> v_shift.id
      and tstzrange(s.starts_at, s.ends_at, '[)') && tstzrange(v_shift.starts_at, v_shift.ends_at, '[)')
  ) then
    return ('schedule_conflict', p_shift_id, null)::shiftpatch.shift_command_result;
  end if;

  -- 6. Assign, transition and record history in the same transaction.
  update shiftpatch.shifts
  set status = 'claimed', assigned_nurse_id = p_nurse_id
  where id = v_shift.id;

  insert into shiftpatch.shift_events (shift_id, actor_id, event_type, previous_status, new_status)
  values (v_shift.id, p_nurse_id, 'claimed', 'open', 'claimed')
  returning id into v_event_id;

  return ('claimed', v_shift.id, v_event_id)::shiftpatch.shift_command_result;
end;
$$;

-- ---------------------------------------------------------------------------
-- create_shift
--
-- Outcomes:
--   created             success
--   actor_not_allowed   the actor is neither an admin nor an agency user
--   branch_not_found    no such branch, or (for agency users) the branch
--                       belongs to an agency they do not actively manage
--   invalid_time_range  ends_at is not after starts_at
--   shift_in_past       starts_at is not in the future
-- ---------------------------------------------------------------------------

create function shiftpatch.create_shift(
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
  v_shift_id uuid;
  v_event_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is null or v_role not in ('admin', 'agency') then
    return ('actor_not_allowed', null, null)::shiftpatch.shift_command_result;
  end if;

  if v_role = 'admin' then
    perform 1 from shiftpatch.agency_branches b where b.id = p_branch_id;
  else
    perform 1
    from shiftpatch.agency_branches b
    join shiftpatch.agency_memberships m on m.agency_id = b.agency_id
    where b.id = p_branch_id
      and m.profile_id = p_actor_id
      and m.status = 'active';
  end if;
  if not found then
    return ('branch_not_found', null, null)::shiftpatch.shift_command_result;
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

-- Backend only. Postgres grants EXECUTE on new functions to PUBLIC by
-- default, so revoke explicitly.
revoke execute on function shiftpatch.claim_shift(uuid, uuid) from public, anon, authenticated;
revoke execute on function shiftpatch.create_shift(uuid, uuid, text, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function shiftpatch.claim_shift(uuid, uuid) to service_role;
grant execute on function shiftpatch.create_shift(uuid, uuid, text, timestamptz, timestamptz) to service_role;

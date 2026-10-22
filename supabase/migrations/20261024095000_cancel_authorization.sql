-- ---------------------------------------------------------------------------
-- Cancellation authorization
--
-- Who may reopen a claimed shift, and with which reason:
--   admin   any claimed shift, `advance` or `no-show`
--   agency  shifts of an agency they are an active member of, either reason
--   nurse   only a shift currently assigned to them, and only `advance`
--           (a no-show is reported by the agency, never self-declared)
-- Anything else is `actor_not_allowed`; a nurse's no-show is
-- `reason_not_allowed`. The shift still reopens atomically and the history
-- row is unchanged.
-- ---------------------------------------------------------------------------

create or replace function shiftpatch.cancel_shift_claim(p_actor_id uuid, p_shift_id uuid, p_reason text)
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
    if v_allowed and p_reason <> 'advance' then
      return ('reason_not_allowed', p_shift_id, null, null, null)::shiftpatch.cancel_command_result;
    end if;
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

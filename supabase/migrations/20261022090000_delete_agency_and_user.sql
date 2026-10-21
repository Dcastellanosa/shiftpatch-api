-- Deletion commands for agencies and user accounts.
--
-- Both are hard deletes limited to records without history: an agency whose
-- branches never had a shift, and a user who never had a shift and never
-- acted (no shift events, no audit events). Everything else keeps its audit
-- trail and is deactivated instead. Only service_role may execute them; the
-- API calls them after verifying the session and the admin role, and the
-- commands re-check the actor.

alter type shiftpatch.audit_action add value if not exists 'deleted';

-- Outcomes: deleted · actor_not_allowed · agency_not_found · agency_has_shifts
create function shiftpatch.delete_agency(p_actor_id uuid, p_agency_id uuid)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_agency shiftpatch.agencies%rowtype;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;

  select * into v_agency from shiftpatch.agencies a where a.id = p_agency_id for update;
  if not found then
    return ('agency_not_found', null)::shiftpatch.admin_command_result;
  end if;
  -- Serialise against concurrent shift creation at these branches.
  perform 1 from shiftpatch.agency_branches b where b.agency_id = p_agency_id for update;

  if exists (
    select 1 from shiftpatch.shifts s
    join shiftpatch.agency_branches b on b.id = s.branch_id
    where b.agency_id = p_agency_id
  ) then
    return ('agency_has_shifts', null)::shiftpatch.admin_command_result;
  end if;

  delete from shiftpatch.branch_credential_requirements r
  using shiftpatch.agency_branches b
  where r.branch_id = b.id and b.agency_id = p_agency_id;
  delete from shiftpatch.branch_nurse_eligibility e
  using shiftpatch.agency_branches b
  where e.branch_id = b.id and b.agency_id = p_agency_id;
  delete from shiftpatch.agency_memberships m where m.agency_id = p_agency_id;
  delete from shiftpatch.agency_branches b where b.agency_id = p_agency_id;

  perform shiftpatch.record_audit(p_actor_id, 'agency', p_agency_id, 'deleted', v_agency.status, null);
  delete from shiftpatch.agencies a where a.id = p_agency_id;
  return ('deleted', p_agency_id)::shiftpatch.admin_command_result;
end;
$$;

-- Outcomes: deleted · actor_not_allowed · user_not_found · self_delete · user_has_history
-- Removes the profile and its access records. The Auth account is removed by
-- the API afterwards, and only when this command reported `deleted`.
create function shiftpatch.delete_user(p_actor_id uuid, p_user_id uuid)
returns shiftpatch.admin_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_profile shiftpatch.profiles%rowtype;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_actor_id;
  if v_role is distinct from 'admin' then
    return ('actor_not_allowed', null)::shiftpatch.admin_command_result;
  end if;
  if p_actor_id = p_user_id then
    return ('self_delete', null)::shiftpatch.admin_command_result;
  end if;

  select * into v_profile from shiftpatch.profiles p where p.id = p_user_id for update;
  if not found then
    return ('user_not_found', null)::shiftpatch.admin_command_result;
  end if;

  if exists (select 1 from shiftpatch.shifts s where s.assigned_nurse_id = p_user_id or s.created_by_id = p_user_id)
     or exists (select 1 from shiftpatch.shift_events e where e.actor_id = p_user_id)
     or exists (select 1 from shiftpatch.audit_events a where a.actor_id = p_user_id) then
    return ('user_has_history', null)::shiftpatch.admin_command_result;
  end if;

  delete from shiftpatch.nurse_credentials c where c.nurse_id = p_user_id;
  delete from shiftpatch.branch_nurse_eligibility e where e.nurse_id = p_user_id;
  delete from shiftpatch.agency_memberships m where m.profile_id = p_user_id;

  perform shiftpatch.record_audit(p_actor_id, 'profile', p_user_id, 'deleted', v_profile.role::text, null);
  delete from shiftpatch.profiles p where p.id = p_user_id;
  return ('deleted', p_user_id)::shiftpatch.admin_command_result;
end;
$$;

revoke execute on function shiftpatch.delete_agency(uuid, uuid) from public, anon, authenticated;
revoke execute on function shiftpatch.delete_user(uuid, uuid) from public, anon, authenticated;
grant execute on function shiftpatch.delete_agency(uuid, uuid) to service_role;
grant execute on function shiftpatch.delete_user(uuid, uuid) to service_role;

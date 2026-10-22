-- ---------------------------------------------------------------------------
-- Audit log reader (administrators only)
--
-- `audit_events` (administration) and `shift_events` (shift history) stay
-- unreadable by every client role. This SECURITY DEFINER function is the
-- only reader: it unifies both into one timeline, resolves entity ids to
-- their public ids where the entity has one, and refuses non-admins.
-- ---------------------------------------------------------------------------

create function shiftpatch.list_audit_log_admin()
returns table (
  id uuid,
  occurred_at timestamptz,
  actor_id uuid,
  actor_slug text,
  actor_name text,
  entity_type text,
  entity_id text,
  action text,
  previous_status text,
  new_status text,
  reason text
)
language plpgsql
stable
security definer
set search_path = ''
as $$
begin
  if not shiftpatch_private.is_admin() then
    raise exception 'only administrators may read the audit log' using errcode = 'insufficient_privilege';
  end if;
  return query
    select *
    from (
      select
        a.id,
        a.occurred_at,
        a.actor_id,
        p.slug as actor_slug,
        p.full_name as actor_name,
        a.entity_type::text as entity_type,
        coalesce(
          case a.entity_type
            when 'agency' then (select g.slug from shiftpatch.agencies g where g.id = a.entity_id)
            when 'profile' then (select q.slug from shiftpatch.profiles q where q.id = a.entity_id)
            else null
          end,
          a.entity_id::text
        ) as entity_id,
        a.action::text as action,
        a.previous_status,
        a.new_status,
        null::text as reason
      from shiftpatch.audit_events a
      left join shiftpatch.profiles p on p.id = a.actor_id
      union all
      select
        e.id,
        e.occurred_at,
        e.actor_id,
        p.slug,
        p.full_name,
        'shift',
        s.slug,
        e.event_type::text,
        e.previous_status::text,
        e.new_status::text,
        e.reason
      from shiftpatch.shift_events e
      join shiftpatch.shifts s on s.id = e.shift_id
      left join shiftpatch.profiles p on p.id = e.actor_id
    ) log
    order by log.occurred_at desc, log.id desc
    limit 500;
end;
$$;

revoke execute on function shiftpatch.list_audit_log_admin() from public, anon;
grant execute on function shiftpatch.list_audit_log_admin() to authenticated, service_role;

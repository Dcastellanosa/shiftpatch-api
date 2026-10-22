-- ---------------------------------------------------------------------------
-- Credential uploads
--
-- Nurses upload their licence/credential documents through the API, which
-- validates the file, stores it in a private bucket with its service-role
-- client and records the metadata here. Clients never reach the bucket.
-- Additive: new nullable columns, one uniqueness rule (one row per nurse and
-- credential type), one service-role-only command, one private bucket.
-- ---------------------------------------------------------------------------

alter table shiftpatch.nurse_credentials
  add column original_name text check (original_name is null or char_length(original_name) between 1 and 255),
  add column content_type text check (content_type is null or content_type in ('application/pdf', 'image/png', 'image/jpeg')),
  add column size_bytes integer check (size_bytes is null or (size_bytes > 0 and size_bytes <= 4194304)),
  add column uploaded_at timestamptz;

comment on column shiftpatch.nurse_credentials.file_path is
  'Object path inside the private shiftpatch-credentials bucket; written only by upsert_nurse_credential.';

create unique index nurse_credentials_nurse_type_uniq
  on shiftpatch.nurse_credentials (nurse_id, credential_type_id);

create type shiftpatch.credential_command_result as (outcome text, credential_id uuid);

create function shiftpatch.upsert_nurse_credential(
  p_nurse_id uuid,
  p_credential_type_code text,
  p_expires_at date,
  p_file_path text,
  p_original_name text,
  p_content_type text,
  p_size_bytes integer
)
returns shiftpatch.credential_command_result
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_role shiftpatch.app_role;
  v_type_id uuid;
  v_id uuid;
begin
  select p.role into v_role from shiftpatch.profiles p where p.id = p_nurse_id;
  if v_role is distinct from 'nurse' then
    return ('not_a_nurse', null)::shiftpatch.credential_command_result;
  end if;

  select t.id into v_type_id from shiftpatch.credential_types t where t.code = p_credential_type_code;
  if v_type_id is null then
    return ('credential_type_not_found', null)::shiftpatch.credential_command_result;
  end if;

  insert into shiftpatch.nurse_credentials
    (nurse_id, credential_type_id, issued_at, expires_at, file_path, original_name, content_type, size_bytes, uploaded_at, status)
  values
    (p_nurse_id, v_type_id, null, p_expires_at, p_file_path, p_original_name, p_content_type, p_size_bytes, now(), 'valid')
  on conflict (nurse_id, credential_type_id) do update set
    issued_at = null,
    expires_at = excluded.expires_at,
    file_path = excluded.file_path,
    original_name = excluded.original_name,
    content_type = excluded.content_type,
    size_bytes = excluded.size_bytes,
    uploaded_at = excluded.uploaded_at,
    status = 'valid'
  returning id into v_id;

  return ('recorded', v_id)::shiftpatch.credential_command_result;
end;
$$;

revoke execute on function shiftpatch.upsert_nurse_credential(uuid, text, date, text, text, text, integer)
  from public, anon, authenticated;
grant execute on function shiftpatch.upsert_nurse_credential(uuid, text, date, text, text, text, integer)
  to service_role;

-- The private bucket. Storage's schema exists wherever the Storage service
-- runs (every hosted project; local stacks with [storage] enabled); the guard
-- keeps the migration valid elsewhere. No storage.objects policies: only the
-- service-role client, which bypasses RLS, touches these objects.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
    values ('shiftpatch-credentials', 'shiftpatch-credentials', false, 4194304, array['application/pdf', 'image/png', 'image/jpeg'])
    on conflict (id) do nothing;
  end if;
end;
$$;

#!/usr/bin/env bash
# Applies supabase/migrations/*.sql to the *linked* Supabase project when that
# project is shared with another application (`supabase link` first).
#
# `supabase db push` cannot be used there: the CLI history table
# (supabase_migrations.schema_migrations) belongs to the other application,
# and pushing would require rewriting it. Instead, each pending migration runs
# through `supabase db query --linked` in one transaction together with a row
# in shiftpatch_meta.schema_migrations, our own history table.
#
# Usage: scripts/apply-shared-migrations.sh [--dry-run]
#        pnpm db:push:shared [-- --dry-run]
#
# Without --dry-run every pending migration is applied to the linked project.
set -euo pipefail
cd "$(dirname "$0")/.."

dry_run=false
# `pnpm db:push:shared -- --dry-run` forwards the literal `--`; skip it.
[[ "${1:-}" == "--" ]] && shift
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=true ;;
    *) echo "Unknown argument: $arg (only --dry-run is accepted)" >&2; exit 2 ;;
  esac
done

query_json() {
  supabase db query --linked -o json "$@" 2>/dev/null
}

applied=$(query_json "select coalesce(string_agg(version, ' '), '') as versions from (
    select version from shiftpatch_meta.schema_migrations
    where to_regclass('shiftpatch_meta.schema_migrations') is not null
  ) v" 2>/dev/null |
  node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{console.log(JSON.parse(s).rows[0].versions)}catch{console.log("")}})' ||
  true)

if [[ "$dry_run" == false ]]; then
  query_json "create schema if not exists shiftpatch_meta;
    revoke all on schema shiftpatch_meta from public;
    create table if not exists shiftpatch_meta.schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    );
    revoke all on table shiftpatch_meta.schema_migrations from public;" >/dev/null
fi

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
pending=0

for file in supabase/migrations/*.sql; do
  name=$(basename "$file" .sql)
  version=${name%%_*}
  if [[ " $applied " == *" $version "* ]]; then
    echo "applied  $name"
    continue
  fi
  pending=$((pending + 1))
  if [[ "$dry_run" == true ]]; then
    echo "pending  $name"
    continue
  fi
  {
    echo "begin;"
    cat "$file"
    echo
    echo "insert into shiftpatch_meta.schema_migrations (version, name) values ('$version', '$name');"
    echo "commit;"
  } >"$tmp/$name.sql"
  if supabase db query --linked -f "$tmp/$name.sql" >/dev/null 2>"$tmp/error.log"; then
    echo "applied  $name (now)"
  else
    echo "FAILED   $name" >&2
    grep -v -i -E 'key|secret|password|token' "$tmp/error.log" | tail -5 >&2
    exit 1
  fi
done

if [[ "$dry_run" == false && "$pending" -gt 0 ]]; then
  query_json "notify pgrst, 'reload schema'" >/dev/null
fi
echo "$pending migration(s) pending before this run."

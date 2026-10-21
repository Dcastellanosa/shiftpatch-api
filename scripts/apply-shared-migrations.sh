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

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Runs a query and prints one column of its first row. The CLI may print
# progress lines (for example "Initialising login role...") before the JSON,
# so the object is located rather than parsed from the start. On any failure
# the CLI's output is shown (minus anything that looks like a credential) and
# the script stops: the history must never be mistaken for "nothing applied".
read_value() {
  local column=$1 sql=$2
  if ! supabase db query --linked -o json "$sql" >"$tmp/query.out" 2>"$tmp/query.err"; then
    echo "supabase db query --linked failed:" >&2
    grep -v -i -E 'key|secret|password|token' "$tmp/query.err" | tail -5 >&2
    return 1
  fi
  node -e '
    const fs = require("fs")
    const s = fs.readFileSync(process.argv[2], "utf8")
    const start = s.indexOf("{")
    try {
      const value = JSON.parse(s.slice(start)).rows[0][process.argv[1]]
      process.stdout.write(value === null || value === undefined ? "" : String(value))
    } catch {
      process.exit(3)
    }' "$column" "$tmp/query.out" || {
    echo "Could not parse the query result. The CLI printed:" >&2
    grep -v -i -E 'key|secret|password|token' "$tmp/query.out" | head -8 >&2
    return 1
  }
}

present=$(read_value present "select (to_regclass('shiftpatch_meta.schema_migrations') is not null) as present") || {
  echo "Could not read the linked project's migration history. Nothing was applied." >&2
  exit 1
}
applied=""
if [[ "$present" == "true" ]]; then
  applied=$(read_value versions "select coalesce(string_agg(version, ' '), '') as versions from shiftpatch_meta.schema_migrations") || {
    echo "Could not read shiftpatch_meta.schema_migrations. Nothing was applied." >&2
    exit 1
  }
fi

if [[ "$dry_run" == false ]]; then
  supabase db query --linked -o json "create schema if not exists shiftpatch_meta;
    revoke all on schema shiftpatch_meta from public;
    create table if not exists shiftpatch_meta.schema_migrations (
      version text primary key,
      name text not null,
      applied_at timestamptz not null default now()
    );
    revoke all on table shiftpatch_meta.schema_migrations from public;" >/dev/null 2>&1
fi

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
  supabase db query --linked -o json "notify pgrst, 'reload schema'" >/dev/null 2>&1
fi
echo "$pending migration(s) pending before this run."

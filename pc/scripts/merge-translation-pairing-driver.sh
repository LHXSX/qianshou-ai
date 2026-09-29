#!/bin/sh

project_prefix=
if [ "$#" -eq 6 ] && [ "$1" = '--project-prefix' ]; then
  project_prefix=$2
  shift 2
fi
if [ "$#" -ne 4 ]; then
  echo 'merge-translation-pairing: expected <ancestor> <current> <other> <repository-path>' >&2
  exit 129
fi

ancestor_path=$1
current_path=$2
other_path=$3
meta_path=$4
driver_directory=$(CDPATH= cd -P "$(dirname "$0")" && pwd) || exit 129
driver_path=$driver_directory/merge-translation-pairing.ts
tsx_loader=$(node -e 'process.stdout.write(require("node:module").createRequire(process.argv[1]).resolve("tsx/esm"))' \
  "$driver_directory/../package.json" 2>/dev/null)

if command -v node >/dev/null 2>&1 \
  && [ -n "$tsx_loader" ] \
  && node --import "$tsx_loader" "$driver_path" --probe >/dev/null 2>&1; then
  if [ -n "$project_prefix" ]; then
    exec node --import "$tsx_loader" "$driver_path" --project-prefix "$project_prefix" \
      "$ancestor_path" "$current_path" "$other_path" "$meta_path"
  fi
  exec node --import "$tsx_loader" "$driver_path" \
    "$ancestor_path" "$current_path" "$other_path" "$meta_path"
fi

echo "merge-translation-pairing: runtime is unavailable; leaving an ordinary text conflict in $meta_path" >&2
git merge-file \
  -L "$meta_path:current" \
  -L "$meta_path:ancestor" \
  -L "$meta_path:other" \
  -- "$current_path" "$ancestor_path" "$other_path"
fallback_status=$?
echo 'merge-translation-pairing: restore Node dependencies, then rerun the merge or `pnpm run resolve-translation-pairing-conflicts`; use `git merge --abort` to cancel' >&2

# A clean text merge is still unverified pairing metadata, so the driver must
# leave Git's index stages unresolved until the repository-aware resolver runs.
if [ "$fallback_status" -gt 127 ]; then
  exit "$fallback_status"
fi
exit 1

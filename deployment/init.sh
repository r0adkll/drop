#!/bin/sh
#
# Creates a Drop deployment repository from the starter files in deployment/template, pinned to one
# Drop release. Run it from a checkout of Drop, or straight from GitHub:
#
#   curl -fsSL https://raw.githubusercontent.com/r0adkll/drop/main/deployment/init.sh | sh -s -- my-drop
#
# Options: --ref <ref> pins another Drop release (default: main), and --github <owner/name> also
# creates a private GitHub repository for it with gh.

set -eu

repository="${DROP_REPOSITORY:-r0adkll/drop}"
ref="${DROP_REF:-main}"
target=""
github=""

usage() {
  cat <<EOF
Usage: init.sh <directory> [--ref <ref>] [--github <owner/name>]

Creates a Drop deployment repository in <directory>, pinned to $repository at --ref (default: $ref).
--github also creates a private GitHub repository for it with gh and adds it as origin.
EOF
}

die() {
  printf 'init.sh: %s\n' "$1" >&2
  exit "${2:-1}"
}

while [ $# -gt 0 ]; do
  case "$1" in
    --ref)
      [ $# -ge 2 ] || die "--ref needs a value." 2
      ref="$2"
      shift 2
      ;;
    --github)
      [ $# -ge 2 ] || die "--github needs owner/name." 2
      github="$2"
      shift 2
      ;;
    -h | --help)
      usage
      exit 0
      ;;
    -*)
      usage >&2
      exit 2
      ;;
    *)
      [ -z "$target" ] || die "only one directory, please." 2
      target="$1"
      shift
      ;;
  esac
done

[ -n "$target" ] || {
  usage >&2
  exit 2
}
printf '%s' "$ref" | grep -Eq '^[A-Za-z0-9._/-]+$' || die "\"$ref\" is not a valid ref." 2
if [ -n "$github" ]; then
  printf '%s' "$github" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || die "--github takes owner/name." 2
fi
if [ -e "$target" ] && [ -n "$(ls -A "$target" 2>/dev/null)" ]; then
  die "$target already exists and isn't empty."
fi
command -v git >/dev/null 2>&1 || die "git is not installed."

# The starter files: next to this script in a checkout, otherwise from GitHub at the ref.
template=""
case "$0" in
  */init.sh)
    here="$(cd "$(dirname "$0")" && pwd)"
    [ -d "$here/template" ] && template="$here/template"
    ;;
esac
if [ -z "$template" ]; then
  command -v curl >/dev/null 2>&1 || die "curl is not installed."
  download="$(mktemp -d)"
  trap 'rm -rf "$download"' EXIT
  curl -fsSL "https://codeload.github.com/$repository/tar.gz/$ref" | tar -xz -C "$download" ||
    die "couldn't download $repository at $ref."
  template="$(find "$download" -maxdepth 3 -type d -path '*/deployment/template' | head -n 1)"
  [ -n "$template" ] || die "$repository at $ref has no deployment/template."
fi

mkdir -p "$target"
cp -R "$template"/. "$target"/
chmod +x "$target/drop"

# Pin the deploy workflow and the config's schema to the chosen release.
pin() {
  sed -e "s#r0adkll/drop/deploy@main#$repository/deploy@$ref#" \
    -e "s#githubusercontent.com/r0adkll/drop/main/#githubusercontent.com/$repository/$ref/#" "$1" >"$1.tmp"
  mv "$1.tmp" "$1"
}
pin "$target/.github/workflows/deploy.yml"
pin "$target/drop.config.json"

git -C "$target" init -q
git -C "$target" symbolic-ref HEAD refs/heads/main

if [ -n "$github" ]; then
  command -v gh >/dev/null 2>&1 || die "gh is not installed, so --github can't create $github."
  gh repo create "$github" --private --source "$target" --remote origin >/dev/null ||
    die "gh couldn't create $github."
  echo "Created the private repository https://github.com/$github as origin."
fi

cat <<EOF
Created a Drop deployment in $target, pinned to $repository/deploy@$ref.

Next:
  1. Edit $target/drop.config.json: your deployment's url and the GitHub accounts (owners) it trusts.
  2. cd $target && ./drop setup
     It creates the Cloudflare resources and the GitHub App, deploys once, and stores CI's credentials.
  3. Commit everything and push to main. The deploy workflow deploys every push.
EOF

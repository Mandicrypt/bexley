#!/usr/bin/env bash
# Commit and push any new Guardian AI proofs to the "proofs" branch.
set -e
cd "${GITHUB_WORKSPACE:-.}/proofs-repo"
git add -A
if git diff --cached --quiet; then exit 0; fi
git -c user.name="Bexley Guardian" -c user.email="guardian@bexley.invalid" commit -q -m "Guardian AI proof"
for i in 1 2 3; do
  git push -q origin HEAD:proofs && exit 0
  git pull -q --rebase origin proofs
done
exit 1

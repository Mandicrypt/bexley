#!/usr/bin/env bash
# Commit and push any new Guardian AI proofs to the "proofs" branch.
set -e
export GIT_AUTHOR_NAME="Bexley Guardian" GIT_AUTHOR_EMAIL="guardian@bexley.invalid"
export GIT_COMMITTER_NAME="Bexley Guardian" GIT_COMMITTER_EMAIL="guardian@bexley.invalid"
cd "${GITHUB_WORKSPACE:-.}/proofs-repo"
git add -A
if git diff --cached --quiet; then exit 0; fi
git commit -q -m "Guardian AI proof"
for i in 1 2 3 4 5; do
  git push -q origin HEAD:proofs && exit 0
  git pull -q --rebase origin proofs || { git rebase --abort 2>/dev/null; sleep 3; }
done
exit 1

#!/usr/bin/env bash
# Configure branch protection and repository security settings for Rocky Reviews.
# Idempotent: safe to re-run; prints what changed.
#
#   scripts/github/protect-main.sh OWNER/REPO [BRANCH]      (BRANCH defaults to main)
#
# Needs: gh (authenticated as a repo admin), jq.
#
# What it enforces on BRANCH:
#   - pull request required (0 approvals: AI review + CI is the change control until the
#     SOC 2 window starts; set REQUIRED_APPROVALS=1 then), stale reviews dismissed,
#     conversations must be resolved
#   - required status checks = the job names in .github/workflows/* (strict: branch up to date)
#   - linear history, signed commits, no force pushes, no deletion, admins included
# Repository-wide:
#   - secret scanning + push protection, Dependabot alerts + security updates,
#     squash-only merges, auto-merge allowed, head branches deleted on merge
#
# Keep REQUIRED_CHECKS in sync with the `name:` of each job in .github/workflows/.
# A required check that never reports blocks every merge, so no workflow may use path filters.
set -euo pipefail

REPO="${1:?usage: $0 OWNER/REPO [BRANCH]}"
BRANCH="${2:-main}"
REQUIRED_APPROVALS="${REQUIRED_APPROVALS:-0}"
STRICT_STATUS_CHECKS="${STRICT_STATUS_CHECKS:-true}"
REQUIRED_CHECKS=(verify actionlint CodeQL Semgrep gitleaks osv-scanner "CLA Assistant")

for tool in gh jq; do
  command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool is required" >&2; exit 2; }
done
gh auth status >/dev/null 2>&1 || { echo "error: gh is not authenticated (run: gh auth login)" >&2; exit 2; }
gh api "repos/$REPO" --jq .full_name >/dev/null || { echo "error: cannot read repos/$REPO" >&2; exit 2; }

say() { printf '\n== %s\n' "$*"; }
show_diff() { # show_diff <label> <before-json> <after-json>
  if [ "$(jq -S . <<<"$2")" = "$(jq -S . <<<"$3")" ]; then
    echo "   unchanged"
  else
    echo "   changed:"
    diff <(jq -S . <<<"$2") <(jq -S . <<<"$3") | grep -E '^[<>]' | sed 's/^</   - before:/; s/^>/   + after: /' || true
  fi
}

# ---------------------------------------------------------------- branch protection
say "Branch protection on $REPO@$BRANCH"
protection_summary='{
  pr_required: (.required_pull_request_reviews != null),
  required_approvals: (.required_pull_request_reviews.required_approving_review_count // null),
  dismiss_stale_reviews: (.required_pull_request_reviews.dismiss_stale_reviews // null),
  status_checks_strict: (.required_status_checks.strict // null),
  status_checks: ((.required_status_checks.checks // []) | map(.context) | sort),
  enforce_admins: (.enforce_admins.enabled // false),
  linear_history: (.required_linear_history.enabled // false),
  conversation_resolution: (.required_conversation_resolution.enabled // false),
  allow_force_pushes: (.allow_force_pushes.enabled // null),
  allow_deletions: (.allow_deletions.enabled // null)
}'
before=$(gh api "repos/$REPO/branches/$BRANCH/protection" 2>/dev/null | jq "$protection_summary" || echo '{"protected": false}')

# Pin every required check to the GitHub Actions app (id 15368) so a status posted by any
# other app or token with the same name can't satisfy it.
GITHUB_ACTIONS_APP_ID=15368
checks_json=$(printf '%s\n' "${REQUIRED_CHECKS[@]}" | jq -R --argjson app "$GITHUB_ACTIONS_APP_ID" '{context: ., app_id: $app}' | jq -s .)
body=$(jq -n \
  --argjson checks "$checks_json" \
  --argjson approvals "$REQUIRED_APPROVALS" \
  --argjson strict "$STRICT_STATUS_CHECKS" '{
    required_status_checks: { strict: $strict, checks: $checks },
    enforce_admins: true,
    required_pull_request_reviews: {
      dismiss_stale_reviews: true,
      require_code_owner_reviews: false,
      required_approving_review_count: $approvals,
      require_last_push_approval: false
    },
    restrictions: null,
    required_linear_history: true,
    allow_force_pushes: false,
    allow_deletions: false,
    block_creations: false,
    required_conversation_resolution: true,
    lock_branch: false,
    allow_fork_syncing: false
  }')
gh api -X PUT "repos/$REPO/branches/$BRANCH/protection" --input - <<<"$body" >/dev/null
after=$(gh api "repos/$REPO/branches/$BRANCH/protection" | jq "$protection_summary")
show_diff "protection" "$before" "$after"

say "Required signed commits on $BRANCH"
before=$(gh api "repos/$REPO/branches/$BRANCH/protection/required_signatures" 2>/dev/null | jq '{signed_commits: .enabled}' || echo '{"signed_commits": false}')
gh api -X POST "repos/$REPO/branches/$BRANCH/protection/required_signatures" >/dev/null
after=$(gh api "repos/$REPO/branches/$BRANCH/protection/required_signatures" | jq '{signed_commits: .enabled}')
show_diff "signatures" "$before" "$after"

# ---------------------------------------------------------------- repository settings
say "Repository settings on $REPO"
repo_summary='{
  allow_squash_merge, allow_merge_commit, allow_rebase_merge, allow_auto_merge,
  delete_branch_on_merge, allow_update_branch,
  squash_merge_commit_title, squash_merge_commit_message,
  secret_scanning: (.security_and_analysis.secret_scanning.status // null),
  push_protection: (.security_and_analysis.secret_scanning_push_protection.status // null)
}'
before=$(gh api "repos/$REPO" | jq "$repo_summary")
gh api -X PATCH "repos/$REPO" --input - >/dev/null <<'EOF'
{
  "allow_squash_merge": true,
  "allow_merge_commit": false,
  "allow_rebase_merge": false,
  "allow_auto_merge": true,
  "delete_branch_on_merge": true,
  "allow_update_branch": true,
  "squash_merge_commit_title": "PR_TITLE",
  "squash_merge_commit_message": "PR_BODY"
}
EOF
# Secret scanning is always on for public repos and the API rejects setting it there,
# so try both flags first and fall back to push protection alone.
if ! gh api -X PATCH "repos/$REPO" --input - >/dev/null 2>&1 <<'EOF'
{ "security_and_analysis": {
    "secret_scanning": { "status": "enabled" },
    "secret_scanning_push_protection": { "status": "enabled" } } }
EOF
then
  gh api -X PATCH "repos/$REPO" --input - >/dev/null <<'EOF'
{ "security_and_analysis": { "secret_scanning_push_protection": { "status": "enabled" } } }
EOF
  echo "   note: secret_scanning flag not settable (already always-on for public repos); push protection set"
fi
after=$(gh api "repos/$REPO" | jq "$repo_summary")
show_diff "repo" "$before" "$after"

say "Dependabot alerts and security updates on $REPO"
alerts_state() { gh api "repos/$REPO/vulnerability-alerts" >/dev/null 2>&1 && echo enabled || echo disabled; }
before=$(jq -n --arg a "$(alerts_state)" '{dependabot_alerts: $a}')
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null
after=$(jq -n --arg a "$(alerts_state)" '{dependabot_alerts: $a}')
show_diff "dependabot" "$before" "$after"
echo "   automated security fixes: requested (API returns no readable state)"

cat <<EOF

Done. Reminders:
  - Commits merged to $BRANCH must be signed: every committer (humans and agents) needs
    SSH or GPG commit signing set up (git config gpg.format ssh; user.signingkey; commit.gpgsign true).
  - Create the CLA signatures branch once: scripts/github/setup-cla-branch.sh $REPO
  - Required checks: ${REQUIRED_CHECKS[*]}
    Workflows must keep these exact job names (.github/workflows/*.yml).
EOF

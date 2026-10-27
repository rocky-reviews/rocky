# Runbook: rebuild a repository's pull request mirror from GitHub

The pull request mirror (`repos`, `pull_requests`, `pr_revisions`) is derived from GitHub
([ADR 0010](../adr/0010-pull-request-mirror.md)). Rebuild it when it is missing or wrong: after a
database restore, after webhooks were lost while the server was down, or when a bug wrote bad
rows.

```sh
pnpm mirror:rebuild <owner/name> [--limit N]
```

- Runs with the worker's configuration: `WORKER_DATABASE_URL` (a `rocky_worker` login),
  `GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY` (and `GITHUB_URL`/`GITHUB_API_URL` for GitHub
  Enterprise Server). Locally these come from `.env`.
- `--limit` (default 1000, at most 10 000) caps how many pull requests are read, newest first.
- Safe to run while the worker runs, and safe to run again: it only upserts, and a second run
  reads nothing but GitHub's listing.
- It deletes nothing. Pull requests in the mirror that GitHub no longer lists are counted as
  `notListed` and kept.

## Output

One log line, `mirror rebuilt`, with ids and counts only: `listed`, `mirrored`, `unchanged`,
`missing` (listed, then 404), `stale` (a webhook wrote a newer snapshot meanwhile),
`revisionsRecorded`, `truncatedDiffs`, `notListed` (`null` when the limit cut the listing),
`limitReached`. Exit code 0.

## Refusals (exit code 1, `errorCode`)

| Code                       | Meaning                                                               | What to do                                                        |
| -------------------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `app_not_installed`        | GitHub says the app is not installed on the repository                | Check the name and the installation's repository selection        |
| `installation_suspended`   | The installation is suspended; GitHub refuses reads on its behalf     | Unsuspend it on GitHub, then run again                            |
| `no_org`                   | Installed on GitHub, but no live org is bound (lifecycle not run yet) | Check the worker and the inbox for the `installation.created` row |
| `repository_inaccessible`  | GitHub refused a token for the repository                             | Check the installation's repository access                        |
| `unsupported_account_type` | An enterprise-level installation, which Rocky does not model          | None                                                              |
| `forge_*`                  | A GitHub read failed (`forge_app_mismatch`: wrong key for the app id) | Check credentials and GitHub's status; run again                  |

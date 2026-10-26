# GitHub API fixtures

Sanitised responses of the GitHub REST API used by tests (P3-3, ADR 0009). They follow the shape
GitHub documents and returns for `GET /app/installations/{installation_id}` (API version
`2022-11-28`), with every identifier replaced by a synthetic value: account `acme` (9001) and
user `octo-dev` (9101), installations 4242 and 4343, app id 123456. No tokens, keys, emails or
real account data.

| File                                   | Status | What it is                                     |
| -------------------------------------- | ------ | ---------------------------------------------- |
| `get-installation.organization.json`   | 200    | An active installation on an organization      |
| `get-installation.user-suspended.json` | 200    | A suspended installation on a personal account |
| `get-installation.not-found.json`      | 404    | Uninstalled (or never this app's) installation |

Tests serve them through `fakeGitHubApi` (`src/testing.ts`), which may substitute ids so one
recorded shape covers several installations. When re-recording against a real installation,
replace every id, login, URL and timestamp before committing, and keep only these fields'
shapes; nothing from the response beyond `id`, `app_id`, `account.{id,login,type}` and
`suspended_at` is read by the adapter.

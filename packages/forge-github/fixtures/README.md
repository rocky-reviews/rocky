# GitHub API fixtures

Responses of the GitHub REST API used by tests (P3-3, ADR 0009; P3-4, ADR 0010; P3-6, ADR 0011). They are **not
recorded** from GitHub: they follow the shape GitHub documents for each endpoint below (API
version `2022-11-28`), with every identifier replaced by a synthetic value: account `acme`
(9001), user `octo-dev` (9101), enterprise `acme-corp` (9201), installations 4242, 4343 and 4444,
app id 123456, repository `acme/api` (77), pull request 847. No tokens (the token field is a
placeholder; the fake issues random test values), keys, emails or real account data.

| File                                                | Status | What it is                                                                                                                                |
| --------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `get-installation.organization.json`                | 200    | An active installation on an organization                                                                                                 |
| `get-installation.user-suspended.json`              | 200    | A suspended installation on a personal account                                                                                            |
| `get-installation.not-found.json`                   | 404    | Uninstalled (or never this app's) installation                                                                                            |
| `get-installation.enterprise.json`                  | 200    | An enterprise account (`slug`, no `login`)                                                                                                |
| `get-app.json`                                      | 200    | The authenticated app (`GET /app`)                                                                                                        |
| `post-installation-access-token.json`               | 201    | `POST /app/installations/{id}/access_tokens`: a token scoped to one repository, read-only (P3-4)                                          |
| `post-installation-access-token.unprocessable.json` | 422    | Minting for a repository the installation cannot access (P3-4)                                                                            |
| `get-pull-request.json`                             | 200    | `GET /repos/{owner}/{repo}/pulls/{number}` (P3-4)                                                                                         |
| `list-pull-requests.json`                           | 200    | One page of `GET /repos/{owner}/{repo}/pulls` (P3-4)                                                                                      |
| `compare-diff.too-large.json`                       | 406    | `compare/{base}...{head}` refusing to render a diff (`errors[].code` `too_large`); the message text is not documented and not read (P3-4) |
| `compare.diff`                                      | 200    | A small unified diff (`application/vnd.github.diff`), synthetic (P3-4)                                                                    |
| `get-repository.json`                               | 200    | `GET /repos/{owner}/{repo}` as a user, with that user's `permissions` (P3-6)                                                              |
| `get-repository.unauthorized.json`                  | 401    | A rejected (expired or revoked) user token (P3-6)                                                                                         |

Tests serve them through `fakeGitHubApi` (`src/testing.ts`), which may substitute ids so one
fixture covers several installations. Webhook payloads are not fixtures: they are built by
`installationPayload` and friends in `src/testing.ts`. Replacing these files with real recorded
responses (and real `installation.created`/`deleted` payloads) is a follow-up (`docs/progress.md`,
P3-3). When recording against a real installation,
replace every id, login, URL and timestamp before committing, and keep only these fields'
shapes; nothing from the response beyond `id`, `app_id`, `target_type`,
`account.{id,login,type,slug}`, `suspended_at`, the 404 `message`, and the app's `id` is read by
the installation reader. The repository reader (P3-4) reads, from a token answer, `token`,
`expires_at`, `permissions` and `repositories[].{id,full_name,private,default_branch}`; from a
pull request, `number`, `state`, `title`, `user.login`, `head.sha`, `base.{sha,repo.id}`,
`created_at`, `updated_at`, `closed_at`, `merged_at`, `additions`, `deletions`, `changed_files`
(the list page: `number`, `head.sha`, `base.repo.id`, `updated_at`); from a 406, `errors[].code`.
The user access reader (P3-6, ADR 0011) reads, from a repository, `id` and `permissions.pull`,
and from a 404 its `message`.
Not yet verified against a live installation: the exact 406 body of an oversized compare diff and
the permissions GitHub requires for `compare` diffs of private repositories (ADR 0010, residual
risks).

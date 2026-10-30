# GitHub API fixtures

Responses of the GitHub REST API used by tests (P3-3, ADR 0009; P3-4, ADR 0010; P3-5, ADR 0026; P3-6, ADR 0011; P7-1, ADR 0020). They are **not
recorded** from GitHub: they follow the shape GitHub documents for each endpoint below (API
version `2022-11-28`), with every identifier replaced by a synthetic value: account `acme`
(9001), user `octo-dev` (9101), enterprise `acme-corp` (9201), installations 4242, 4343 and 4444,
app id 123456, repository `acme/api` (77), pull request 847. No tokens (the token field is a
placeholder; the fake issues random test values), keys, emails or real account data.

| File                                                 | Status | What it is                                                                                                                                                                                                                                             |
| ---------------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `get-installation.organization.json`                 | 200    | An active installation on an organization                                                                                                                                                                                                              |
| `get-installation.user-suspended.json`               | 200    | A suspended installation on a personal account                                                                                                                                                                                                         |
| `get-installation.not-found.json`                    | 404    | Uninstalled (or never this app's) installation                                                                                                                                                                                                         |
| `get-installation.enterprise.json`                   | 200    | An enterprise account (`slug`, no `login`)                                                                                                                                                                                                             |
| `get-app.json`                                       | 200    | The authenticated app (`GET /app`)                                                                                                                                                                                                                     |
| `post-installation-access-token.json`                | 201    | `POST /app/installations/{id}/access_tokens`: a token scoped to one repository, read-only (P3-4)                                                                                                                                                       |
| `post-installation-access-token.unprocessable.json`  | 422    | Minting for a repository the installation cannot access (P3-4)                                                                                                                                                                                         |
| `get-pull-request.json`                              | 200    | `GET /repos/{owner}/{repo}/pulls/{number}` (P3-4)                                                                                                                                                                                                      |
| `list-pull-requests.json`                            | 200    | One page of `GET /repos/{owner}/{repo}/pulls` (P3-4)                                                                                                                                                                                                   |
| `compare-diff.too-large.json`                        | 406    | `compare/{base}...{head}` refusing to render a diff (`errors[].code` `too_large`); the message text is not documented and not read (P3-4)                                                                                                              |
| `compare.diff`                                       | 200    | A small unified diff (`application/vnd.github.diff`), synthetic (P3-4)                                                                                                                                                                                 |
| `get-repository.json`                                | 200    | `GET /repos/{owner}/{repo}` as a user, with that user's `permissions` (P3-6)                                                                                                                                                                           |
| `get-repository.unauthorized.json`                   | 401    | A rejected (expired or revoked) user token (P3-6)                                                                                                                                                                                                      |
| `get-authenticated-user.json`                        | 200    | `GET /user`: whose user token it is (P3-6)                                                                                                                                                                                                             |
| `get-collaborator-permission.json`                   | 200    | `GET /repos/{owner}/{repo}/collaborators/{username}/permission`, the **effective** role (P3-6). Served by the fake only, with GitHub's likely behaviour (`read` for any user on a public or internal repository); Rocky does not call it (ADR 0011 §2) |
| `post-oauth-access-token.json`                       | 200    | `POST https://github.com/login/oauth/access_token` (web host, `Accept: application/json`): an expiring GitHub App user token (P7-1). Token values are placeholders; the fake issues random test values                                                 |
| `post-oauth-access-token.bad-verification-code.json` | 200    | The same endpoint refusing a wrong, expired, reused or PKCE-mismatched code: GitHub answers 200 with an `error` field (P7-1)                                                                                                                           |
| `list-user-installations.json`                       | 200    | `GET /user/installations` with a user token: the app's installations the user can access, one page (P7-1)                                                                                                                                              |
| `get-user-org-membership.json`                       | 200    | `GET /user/memberships/orgs/{org}` with a user token: the user's own membership (`state` `active` or `pending`) (P7-1 review round 1); a non-member gets GitHub's JSON 404                                                                             |
| `post-pull-request-review.json`                      | 200    | `POST /repos/{owner}/{repo}/pulls/{number}/reviews` with a user token: the submitted review (P3-5). The fake serves the same shape for `GET …/reviews` (a list)                                                                                        |

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
The user access reader (P3-6, ADR 0011) reads, from `GET /user`, `id` and `login`; from a
repository, `id`, `private`, `visibility` and `permissions.pull`; from a collaborator permission,
nothing (that endpoint is not used); from the membership check
`GET /repos/{owner}/{repo}/collaborators/{username}` (installation token, `metadata: read`) only
the status (204, or a 404 whose `message` is read); and from a 404 its `message`. The membership
204 has no body and its 404 reuses `get-installation.not-found.json` (GitHub's standard `Not Found`).
Not yet verified against a live installation: the exact 406 body of an oversized compare diff and
the permissions GitHub requires for `compare` diffs of private repositories (ADR 0010, residual
risks).
Login (P7-1, ADR 0020) reads, from the token exchange, `access_token`, `token_type` and
`expires_in` (the refresh token is dropped unread) or `error`; from `GET /user`, `id` and `login`;
from `GET /user/installations`, `total_count` and `installations[].{id,app_id,account.{id,login,type},suspended_at}`; from `GET /user/memberships/orgs/{org}`, `state`, `organization.id` and `user.id` (a 404's `message`).
Not yet verified against a live app: the exchange's answer when PKCE was used (documented as the
same shape), and `GET /user/installations` for a user whose access comes only through a team.

# Runbook: review a real pull request locally

Open a real GitHub pull request in Rocky on your machine: sign in with GitHub, find it in the
inbox, read the briefing, decide the AI drafts and finish the review. This is the H4 dogfooding
path (task H4-2). It takes about 15 minutes once the GitHub App exists.

**What runs where.** `pnpm dev` starts Postgres, the server on `127.0.0.1:4310`, the worker and
the web app (Vite) on `127.0.0.1:5173`. You only ever open `http://127.0.0.1:5173`. Vite
forwards `/api/*` and `/auth/*` to the server (`apps/web/vite.config.ts`,
`apps/web/src/dev-proxy.ts`), so the browser sees one origin: the session cookie and the CSRF
check work as in production.

## Before you start

- The GitHub App exists and is installed on the repository you want to review
  ([runbook H3](h3-create-github-app.md)), and its credentials are in `.env`: `GITHUB_APP_ID`,
  `GITHUB_APP_PRIVATE_KEY`, `GITHUB_WEBHOOK_SECRET`, `GITHUB_APP_CLIENT_ID`,
  `GITHUB_APP_CLIENT_SECRET`.
- The app has the organization permission **Members: read**, accepted on the installation, and
  "Expire user authorization tokens" is on (P7-1 needs-human notes in `docs/progress.md`).
- The repository access check is wired in the server (task H4-1). Until it is, every page that
  shows repository data answers 503 and says "Repository access isn't available yet".

## 1. Configure `.env`

```sh
# The origin the browser shows: the Vite dev server. Login callbacks, return addresses and the
# CSRF Origin check all use it. http is accepted on 127.0.0.1/localhost outside production only
# (non-Secure cookies without the __Host- prefix); production refuses it.
ROCKY_PUBLIC_URL=http://127.0.0.1:5173
# Optional: a fixed session secret, so a server restart keeps you signed in.
# ROCKY_SESSION_SECRET=<openssl rand -hex 32>
# Optional: analyse new pushes automatically (needs an LLM key, e.g. ANTHROPIC_API_KEY).
# ROCKY_ANALYSIS_AUTO=on
```

Use `127.0.0.1`, not `localhost`, everywhere: cookies are per host name, so the two are
different sites to the browser. The Vite proxy targets `http://127.0.0.1:4310`; set
`ROCKY_DEV_SERVER_URL` only if the server listens elsewhere (`off` disables the proxy).

## 2. Add the dev callback URL to the GitHub App

In the app's settings on GitHub ("General", "Callback URL"), add
`http://127.0.0.1:5173/auth/github/callback` next to the existing one. GitHub allows several
callback URLs; keep the production one.

## 3. Start Rocky and fill the mirror

```sh
pnpm dev
# second terminal: webhook deliveries (see runbook H3, step 6)
npx smee-client@<version> --url https://smee.io/<channel> --target http://127.0.0.1:4310/webhooks/github
# third terminal, once: the open pull requests of the repository
pnpm mirror:rebuild <owner/name>
```

The rebuild fills the mirror but never queues an analysis ([mirror rebuild](mirror-rebuild.md)).
With `ROCKY_ANALYSIS_AUTO=on`, the next push to a pull request (or a new one) queues one.

## 4. Sign in and review

1. Open `http://127.0.0.1:5173/inbox` and choose **Sign in with GitHub**. After GitHub, you
   come back to the inbox.
2. The inbox lists the open pull requests of the repositories GitHub lets you read. Open one:
   its address is `http://127.0.0.1:5173/<owner>/<repo>/pull/<number>`, the same shape as on
   github.com.
3. The page shows the briefing once the analysis is done; before that, its state (queued,
   analysing, waiting for approval with the token estimate, failed with a code).
4. Decide the drafts in the review panel, then **Finish review** (⌘/Ctrl+Enter) to post the
   accepted drafts, your comments and the verdict to GitHub as you.

**Not there yet (H4-2 follow-ups):** the server does not serve the diff, so opening a file says
"The diff could not be loaded." (use View on GitHub), and the drafts' Accept and Edit buttons
and own comments live in the file view. Branch names, GitHub approvals and comment counts are
not in the mirror, so the top bar leaves them out.

## Fixtures (development and tests)

The fixtures stay available behind an explicit switch and never call the server. They work only
in the Vite dev server (`pnpm dev`) and in test builds made with `VITE_ROCKY_FIXTURES=on`; a
production build leaves them out, so there `/` with any of these goes to `/inbox`:

| Address                 | Shows                              |
| ----------------------- | ---------------------------------- |
| `/?fixture=pr-847`      | the POC's pull request (pr-847)    |
| `/?pr=<848…856>`        | the briefing's other states (P6-2) |
| `/?fixture=large-diff`  | the 5,000-line diff (P6-3)         |
| `/?diff=newer-push`     | pr-847 after a later push (P6-5)   |
| `/inbox?source=fixture` | the inbox fixture (P6-7)           |
| `/` with none of these  | goes to `/inbox`                   |

## When something is wrong

| You see                                         | Why, and what to do                                                                                               |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| "Sign in with GitHub" again after signing in    | The browser is on another origin than `ROCKY_PUBLIC_URL` (`localhost` vs `127.0.0.1`, or port 4310): open `5173`. |
| GitHub says the redirect URI is not associated  | Step 2: the callback URL for `5173` is missing in the app's settings.                                             |
| 403 `csrf` on Accept, Finish review or sign-out | `ROCKY_PUBLIC_URL` is not the browser's origin; fix `.env` and restart `pnpm dev`.                                |
| "Repository access isn't available yet"         | The server has no repository access check (H4-1).                                                                 |
| "This pull request isn't in Rocky…"             | Not mirrored (run the rebuild), the repository is disabled, or GitHub says you cannot read it.                    |
| "No analysis yet"                               | Nothing queued: turn on `ROCKY_ANALYSIS_AUTO` and push to the pull request.                                       |

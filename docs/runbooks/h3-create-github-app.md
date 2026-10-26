# Runbook H3: create the GitHub App and install it

Gate H3 (task P3-1, [ADR 0008](../adr/0008-github-app-manifest.md)). GitHub requires a person to
click "Create GitHub App". Rocky prepares everything else. This takes about 10 minutes.

**What you end up with:** a private GitHub App owned by the `rocky-reviews` organization, with
`contents:read`, `pull_requests:write`, `checks:read` and `metadata:read`, subscribed to
`pull_request`, installed on `rocky-reviews/rocky`. Its credentials are in your secret manager
and in your local `.env`.

## Before you start

- You are an **owner** of the `rocky-reviews` organization. A GitHub App manager can register
  the app but cannot install it on the organization's repositories (step 5).
- You are on macOS, Linux or WSL. Setup refuses to run on Windows, because file modes cannot
  protect the credentials file there.
- Docker is running, `pnpm install` is done, and `.env` exists (`pnpm dev` creates it from
  `.env.example` on first run).
- **Why the app is created under the organization:** a private app can only be installed on the
  account that owns it. To install it on `rocky-reviews/rocky`, the organization must own it.

## 1. Webhook URL for local development (smee.io)

GitHub has to reach the webhook URL over the internet, and `127.0.0.1` is not reachable. We use
a [smee.io](https://smee.io) channel. It relays deliveries to your machine without opening any
inbound port, and its URL stays the same across restarts. ADR 0008 §6 explains why this was
chosen over tunnels and over creating the app with webhooks inactive.

1. Open <https://smee.io/new> and copy the channel URL (`https://smee.io/<random>`).
   Anyone holding it can read the deliveries. `rocky-reviews/rocky` is public, so this exposes
   nothing private, but never use smee with private repositories.

**Known limitation:** smee-client re-serialises each payload instead of forwarding GitHub's
exact bytes. Deliveries whose JSON comes out differently (HTML comments, emoji, non-ASCII text,
tabs in a PR body, for example) fail Rocky's signature check with **401**. This happens **every
time** for that payload; redelivering does not help. Rocky's check is correct and is not
relaxed. Step 6 tests for it. If it gets in the way, use the cloudflared alternative in
ADR 0008 §6: a named tunnel with an ingress rule limited to `/webhooks/github`.

## 2. Turn setup on

Add to `.env`:

```sh
GITHUB_APP_SETUP=true
GITHUB_APP_WEBHOOK_URL=https://smee.io/<your channel>
# Optional: GITHUB_APP_NAME="Rocky Reviews Dev"   (app names are global on GitHub; max 34 chars)
# Optional: GITHUB_APP_HOMEPAGE_URL=https://github.com/rocky-reviews/rocky   (see step 3.4)
```

Keep `HOST=127.0.0.1` and `PORT=4310` from `.env.example`. The public URL then defaults to
`http://127.0.0.1:4310`. Setup refuses to start in production (`NODE_ENV=production` or
`FLY_APP_NAME`) and when an app is already configured (`GITHUB_APP_ID` is set, or
`~/.rocky/github-app.env` exists).

## 3. Create the app (the H3 click)

1. Run `pnpm dev`. In the server's output, look for:

   ```
   GitHub App setup is open. Open this one-time URL in your browser (do not share it):
     http://127.0.0.1:4310/setup/github-app?token=…
   ```

   The URL is printed to the terminal only, never to the logs. It works once. If it is lost or
   used, restart `pnpm dev` for a new one.

2. Append `&org=rocky-reviews` to that URL and open it in your browser. Use `127.0.0.1` exactly
   as printed; `localhost` will not work because the session cookie is tied to the host.
3. The page explains what will be created. Click **Continue to GitHub**.
4. On GitHub, check the name. Edit it if GitHub says it is taken, for example "Rocky Reviews
   Dev". Do **not** change permissions or events: Rocky refuses to save an app with more access
   than it asked for. Click **Create GitHub App for rocky-reviews**.
   - If GitHub rejects the homepage URL `http://127.0.0.1:4310/`, set
     `GITHUB_APP_HOMEPAGE_URL=https://github.com/rocky-reviews/rocky` in `.env`, restart
     `pnpm dev` and start again from step 1 with the new URL. Nothing was created yet.
5. GitHub sends you back to Rocky. The page says **GitHub App created** and shows where the
   credentials file is. Setup is now closed on this server.
   - If the page has a **Webhook secret** notice, open the credentials file. Paste the value of
     `GITHUB_WEBHOOK_SECRET` into the app's settings on GitHub (General → Webhook secret → Save).
   - If the page says the app has more access than Rocky asked for, or the credentials could not
     be saved, delete the app using the link on the page and start again from step 1 of this section.
   - If the page says **GitHub did not complete the setup**, the app most likely exists on GitHub
     without saved credentials. Open the app list linked on the page. Either delete the app and start
     again (restart `pnpm dev` for a new URL), or keep it and generate a client secret, a private key
     and a webhook secret (`openssl rand -hex 32`) in its settings, then store them as in section 4.

## 4. Where the credentials are and what to store

The credentials file is `~/.rocky/github-app.env`, or `GITHUB_APP_CREDENTIALS_FILE` if you set
it. It is mode `0600` in a `0700` directory, written once, and never overwritten. It contains:

| Variable                   | Secret? | Used by                                           |
| -------------------------- | ------- | ------------------------------------------------- |
| `GITHUB_APP_ID`            | no      | installation tokens (P3-3/P3-4)                   |
| `GITHUB_APP_SLUG`          | no      | links to the app                                  |
| `GITHUB_APP_CLIENT_ID`     | no      | user login (P7-1)                                 |
| `GITHUB_APP_CLIENT_SECRET` | **yes** | user login (P7-1)                                 |
| `GITHUB_WEBHOOK_SECRET`    | **yes** | webhook signatures (P3-2)                         |
| `GITHUB_APP_PRIVATE_KEY`   | **yes** | signs the app's JWTs; whoever has it _is_ the app |

Do this now:

1. **Secret manager:** create one item, for example "Rocky Reviews GitHub App (dev)", holding all
   six values. The private key is the multi-line PEM, including the `BEGIN`/`END` lines. This is
   the only lasting copy: GitHub will not show the key or the client secret again. They can be
   regenerated in the app settings.
2. **Local `.env`:** first delete from `.env` any earlier `GITHUB_WEBHOOK_SECRET=` or
   `GITHUB_APP_*=` line, and the `GITHUB_APP_SETUP=true` line, so no key appears twice. Then append
   the file:

   ```sh
   grep -nE '^(GITHUB_WEBHOOK_SECRET|GITHUB_APP_[A-Z_]+)=' .env   # must print nothing
   cat ~/.rocky/github-app.env >> .env
   ```

   Every value is single-quoted. Node's `--env-file` and a shell's `. file` both read the
   multi-line `GITHUB_APP_PRIVATE_KEY` as-is.

3. **Delete the file:** `rm ~/.rocky/github-app.env`. Also check that no
   `~/.rocky/.rocky-credentials-*.tmp` is left over (one can remain only after a crash).
4. Production (later, Phase 10 / Fly.io): `fly secrets import < github-app.env` from a file you
   created only for this, or set the values one by one from the secret manager. Never commit
   them, and never paste them into an issue, PR or chat.

## 5. Install on `rocky-reviews/rocky`

1. Open the install link from the success page,
   `https://github.com/apps/<slug>/installations/new`. If the page had no link (GitHub returned no
   slug), open the app from `https://github.com/organizations/rocky-reviews/settings/apps` and
   choose **Install App**.
2. Choose the **rocky-reviews** account, then **Only select repositories → rocky-reviews/rocky**,
   then **Install**.

## 6. Check that webhooks arrive

1. Forward the channel to the receiver in a second terminal. Pin a `smee-client` version that
   was published more than 7 days ago (the repository's supply-chain rule; check with
   `npm view smee-client time`):

   ```sh
   npx smee-client@<version> --url https://smee.io/<channel> --target http://127.0.0.1:4310/webhooks/github
   ```

2. Restart `pnpm dev`. The `server listening` line should now show `webhooks: true` and
   `githubAppSetup: false`.
3. On GitHub, open the app's settings → **Advanced → Recent Deliveries**. Redeliver the
   `installation.created` delivery. The server logs `webhook queued` (202), and a second
   redelivery logs `webhook duplicate`.
   - A **401** on `installation` or `ping` almost always means `GITHUB_WEBHOOK_SECRET` in `.env`
     differs from the app's. Compare them.
4. **smee check.** On `rocky-reviews/rocky`, open a test PR whose description contains all of:
   an HTML comment (`<!-- note -->`), an emoji, non-ASCII text (`café`), and a tab character.
   Look for the `pull_request.opened` delivery in the server log:
   - `webhook queued` (202): smee forwarded bytes that verify.
   - `webhook rejected` with reason `unauthenticated` (401), while step 3 passed: this is smee's
     re-serialisation (see section 1). It is expected and will repeat on redelivery. Record it in
     the H3 notes. Use cloudflared (ADR 0008 §6) if PR deliveries must arrive in development.

   Close the test PR afterwards.

## Undo

Delete the app: app settings → Advanced → Danger zone → Delete GitHub App. Then remove the
`GITHUB_APP_*` and `GITHUB_WEBHOOK_SECRET` lines from `.env` and the secret-manager item.

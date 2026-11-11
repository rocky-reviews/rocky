# Setup: from a fresh server to the first analysed pull request

This guide takes a new Linux VM to Rocky's first analysed pull request with the container images
and the setup wizard ([ADR 0044](../adr/0044-setup-wizard.md)). It takes about 15 minutes, most
of it waiting for the image build. The wizard checks each step for you and says what is missing.

You need:

- **A Linux VM** with 2 vCPUs, 4 GB RAM and 20 GB disk (Ubuntu 24.04 LTS is what this guide was
  written against), reachable on ports 80 and 443.
- **A DNS name** pointing at it (an `A` record, for example `rocky.example.com`). GitHub delivers
  webhooks to it and refuses anything but https.
- **A GitHub account** that can create a GitHub App: your own, or an organization you administer.
- **An LLM key**: an Anthropic API key by default. Other providers and local models:
  [LLM roles](configuration.md#llm-roles) and [local models](local-models.md).
- **A repository** to try it on, where you can open a pull request.

The containers, their hardening and the role split are described in
[deploy/README.md](../../deploy/README.md) and [ADR 0043](../adr/0043-container-images-and-self-host-compose.md).

## 1. Install Docker, Caddy and the code (about 3 minutes)

Docker Engine with the Compose plugin, and Caddy as the TLS-terminating proxy (it gets a Let's
Encrypt certificate on its own). Any proxy works; Rocky only needs https in front of
`127.0.0.1:4310`.

```sh
curl -fsSL https://get.docker.com | sudo sh
sudo usermod -aG docker "$USER" && newgrp docker
sudo apt-get install -y caddy git openssl
git clone https://github.com/rocky-reviews/rocky.git && cd rocky
```

Point Caddy at Rocky, replacing the host name:

```sh
echo 'rocky.example.com {
  reverse_proxy 127.0.0.1:4310
}' | sudo tee /etc/caddy/Caddyfile
sudo systemctl reload caddy
```

## 2. Configure (about 1 minute)

`deploy/init-env.sh` writes `deploy/.env` (database passwords) and `deploy/rocky.env` (the
application's settings) with fresh random secrets, mode 0600. It never overwrites either file
and prints no value.

```sh
deploy/init-env.sh https://rocky.example.com
```

Then add your LLM key to `deploy/rocky.env` (`ANTHROPIC_API_KEY=…`). For the first run, also
turn on automatic analysis there, so a new pull request is analysed without anyone asking
(`ROCKY_ANALYSIS_AUTO=on`; [what it spends](configuration.md#analysis-and-indexing)).

**Back up `ROCKY_KEK_KEYS`** from `deploy/rocky.env` somewhere safe now: it encrypts the members'
GitHub tokens, and nothing else can decrypt them ([backups](backups.md#the-encryption-keys)).

## 3. Start in setup mode (about 6 minutes, the image build)

The setup overlay opens the wizard on the server and gives it one directory for the GitHub
App's credentials. Create that directory first, owned by the containers' user and closed to
everyone else (the wizard refuses anything looser):

```sh
sudo install -d -m 0700 -o 65532 -g 65532 deploy/setup
docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.setup.yml up -d --build
docker compose -f deploy/docker-compose.yml logs server | grep /setup/start
```

The last command prints the **one-time setup link**, `https://rocky.example.com/setup/start?token=…`.
Open it in your browser. It works once; if you lose it, restart the server
(`docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.setup.yml restart server`)
for a new one. Until the GitHub App exists, the server serves the wizard only, and the worker
restarts until it has the app's credentials: that is expected.

## 4. The wizard

The page shows four steps, each with its state (Done, To do, Needs attention, Waiting) and what
to do next. **Check again** reloads them; the page also checks on its own every 15 seconds.

1. **Database.** Done when the server reaches Postgres as its own plain login, `pgvector` is
   installed and every migration is applied. With Compose all three are true after the first
   start; if not, the step names what is missing.
2. **GitHub App.** Choose **Create the GitHub App**, then **Continue to GitHub**. GitHub shows the
   app's name and permissions (code, checks and metadata read; pull requests write, to post the
   reviews a person submits); confirm with **Create GitHub App**. For an organization, add
   `?org=<organization>` to the wizard's create link first. Back on Rocky, the credentials are in
   `deploy/setup/github-app.env`. Move them into the configuration and restart:

   ```sh
   sudo cat deploy/setup/github-app.env >> deploy/rocky.env
   sudo rm deploy/setup/github-app.env
   docker compose -f deploy/docker-compose.yml -f deploy/docker-compose.setup.yml up -d
   docker compose -f deploy/docker-compose.yml logs server | grep /setup/start | tail -1
   ```

   Open the new one-time link. The step is Done when GitHub accepts the app's key. **Do not install
   the app before this restart**: until then Rocky does not receive GitHub's events.

3. **LLM provider.** Lists each model the roles use. **Run the test call** sends one short, fixed
   prompt per model (no code, a small output limit; a fraction of a cent) and shows each answer,
   or what the provider said (key rejected, model not available, unreachable). Fix
   `deploy/rocky.env` and restart the server if needed. You can run this step before step 2.
4. **First repository.** **Install on a repository** opens GitHub's install page: choose _Only
   select repositories_ and pick your test repository. Within a few seconds the step shows the
   account as ready, with its repository. Open a pull request there (or push to an open one). With
   `ROCKY_ANALYSIS_AUTO=on` the analysis finishes in a minute or two; the step then links the
   pull request: **Open it in Rocky** and sign in with GitHub to read it.

When all four steps are Done, choose **Finish setup**. The wizard and its API close at once. Then
start without the overlay, so the server runs without the wizard and without the writable
directory:

```sh
docker compose -f deploy/docker-compose.yml up -d
```

## If something goes wrong

| What you see                                          | What to do                                                                                                                                                                                 |
| ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| "Setup link required"                                 | The link was used or the server restarted. Get the latest one from the server's log (step 3).                                                                                              |
| GitHub App: "GitHub must reach Rocky's webhook…"      | `ROCKY_PUBLIC_URL` is not https. Fix it in `deploy/rocky.env` and restart.                                                                                                                 |
| "Credentials file unusable" (after Continue)          | `deploy/setup` is missing, not owned by 65532 or open to others. Run the `install -d` command of step 3 again, then reload.                                                                |
| First repository: installed but "Waiting for GitHub…" | GitHub could not deliver the installation event. On GitHub, open the app's settings → _Advanced_ → _Recent deliveries_: a failed delivery shows why (DNS, TLS); _Redeliver_ it once fixed. |
| No analysis after a pull request                      | `ROCKY_ANALYSIS_AUTO` is off (open the pull request in Rocky and choose Analyze), or the LLM step failed. `docker compose -f deploy/docker-compose.yml logs worker` names the reason.      |

Bare-metal installs (Node and `pnpm`, no containers) use the same wizard: set `ROCKY_SETUP=true`,
start the server, and open the link it prints on stderr ([running it](README.md#running-it-bare-metal)).

## Checklist for a timed run

For verifying this guide on a fresh VM (P10-2's acceptance: under 15 minutes, a screenshot of each
step). Start a timer at the first SSH login.

| #   | Step                                                                  | Screenshot                                   |
| --- | --------------------------------------------------------------------- | -------------------------------------------- |
| 1   | Docker, Caddy, clone (section 1)                                      | `01-terminal-installed.png`                  |
| 2   | `deploy/init-env.sh`, LLM key, `ROCKY_ANALYSIS_AUTO=on` (section 2)   | `02-terminal-configured.png` (no values)     |
| 3   | `up -d --build` with the overlay, the link from the log (section 3)   | `03-terminal-setup-link.png` (token blurred) |
| 4   | The wizard, fresh: database Done                                      | `04-wizard-fresh.png`                        |
| 5   | GitHub's create page with the manifest                                | `05-github-create-app.png`                   |
| 6   | Rocky's "GitHub App created" page                                     | `06-app-created.png`                         |
| 7   | Credentials appended, restart, new link; wizard: GitHub App Done      | `07-wizard-app-configured.png`               |
| 8   | LLM test call: every model answered                                   | `08-wizard-llm-ok.png`                       |
| 9   | GitHub's install page, one repository selected                        | `09-github-install.png`                      |
| 10  | Wizard: the account ready, with its repository                        | `10-wizard-installed.png`                    |
| 11  | A pull request opened on GitHub                                       | `11-github-pull-request.png`                 |
| 12  | Wizard: first repository Done, the pull request linked; note the time | `12-wizard-analysed.png`                     |
| 13  | The pull request in Rocky after signing in                            | `13-rocky-pull-request.png`                  |
| 14  | Finish setup; restart without the overlay; `/setup` answers 404       | `14-setup-closed.png`                        |

# Backups and restore

GitHub is the source of truth: Rocky stores data derived from it, and can rebuild part of that
from GitHub alone. The rest is work and decisions people made in Rocky, plus the keys that make
the encrypted columns readable. A backup has three parts, kept apart:

1. a full dump of the Postgres database ([dump and restore](#dump-and-restore));
2. the encryption keys (`ROCKY_KEK_KEYS`), stored somewhere else ([below](#the-encryption-keys));
3. the rest of the configuration and its secrets ([below](#configuration-and-secrets)).

## What to back up

What the database holds, and what losing it means. "Rebuildable" means it comes back from GitHub
or by recomputing it; "not rebuildable" means a backup is the only copy.

| Data                                                                                                                     | Tables                                                                                      | If lost                                                                                                                                                                                                                            |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Project memory**: conventions learned from reviews and the ones members wrote, their confidence and history            | `memory_entries`, `repos.memory_enabled`                                                    | **Not rebuildable.** Learning starts again from zero.                                                                                                                                                                              |
| **Review work in progress**: what each reviewer accepted, edited or dismissed, and the comments they have not posted yet | `findings_state`, `comments_pending`                                                        | **Not rebuildable.** Nothing on GitHub holds an unposted comment.                                                                                                                                                                  |
| **Orgs, members and roles**: who is owner or admin in Rocky, org settings                                                | `orgs`, `members`                                                                           | **Not rebuildable.** An org is created from GitHub's installation event, which is not sent again for an existing installation (there is no installation reconciler yet). Roles given in Rocky and org settings exist nowhere else. |
| **Encrypted secrets**: each org's wrapped data key, members' GitHub user tokens, an org's own LLM key (unused today)     | `orgs.data_key_ciphertext`, `members.forge_token_ciphertext`, `orgs.llm_api_key_ciphertext` | Unreadable without the KEKs, and losing them needs a manual recovery ([below](#the-encryption-keys)). The org LLM key column is unused today.                                                                                      |
| **Audit log**                                                                                                            | `audit_events`                                                                              | **Not rebuildable.**                                                                                                                                                                                                               |
| **LLM usage**: tokens and cost per call                                                                                  | `llm_usage`                                                                                 | **Not rebuildable.**                                                                                                                                                                                                               |
| **Posted review records**: which attempt posted what (digests and counts, not the text)                                  | `review_submissions`, `review_submission_items`                                             | The reviews themselves are on GitHub. Without these rows, Rocky no longer knows which drafts were already posted.                                                                                                                  |
| **Analyses**: change maps, triage and findings for each revision                                                         | `analyses`, `jobs`                                                                          | **Recomputable at model cost** for each pull request's current head ("Analyze"). Analyses of earlier revisions cannot be redone: GitHub keeps no list of past heads. They expire with `RETENTION_ANALYSES_DAYS` anyway.            |
| **Pull request mirror**: repositories, pull requests, the current head's revision                                        | `repos`, `pull_requests`, `pr_revisions`                                                    | **Rebuildable from GitHub** with `pnpm mirror:rebuild <owner/name>` ([runbook](../runbooks/mirror-rebuild.md)). Earlier revisions (one per push a webhook reported) are not.                                                       |
| **Repository index**: file chunks and their embeddings                                                                   | `code_indexes`, `code_files`, `code_chunks`, `embeddings`                                   | **Rebuildable** by re-indexing from GitHub, at embedding cost.                                                                                                                                                                     |
| **Sign-in state**                                                                                                        | `app.users`, `app.sessions`, `app.session_orgs`, `app.login_attempts`                       | Everyone signs in again.                                                                                                                                                                                                           |
| **Webhook inbox and queues**                                                                                             | `app.webhook_deliveries`, `app.webhook_queue`                                               | Deliveries not yet processed are lost; GitHub's redelivery and the mirror rebuild cover them. A restore within the dedup window keeps redeliveries from being processed twice.                                                     |
| **Bookkeeping**: the migration ledger, retention settings, scheduled org deletions                                       | `app.schema_migrations`, `app.retention_settings`, `app.org_deletions`                      | Comes with the dump. The ledger must match the code you restore with ([upgrades](upgrades.md#version-compatibility)).                                                                                                              |

Logs are not in the database. They carry ids and counts only, so there is nothing in them you
need to keep for a restore.

## The encryption keys

Envelope encryption ([ADR 0006](../adr/0006-envelope-encryption.md)) is what keeps a stolen
dump from exposing tokens: the database holds only ciphertexts and each org's data key **wrapped**
by a key-encryption key. The KEKs live only in `ROCKY_KEK_KEYS`.

- **Back up every KEK the database still uses**, not only the current one. Each wrapped data key
  records which KEK wrapped it, and there is no re-wrap command yet
  ([rotation](configuration.md#encryption-keys)), so every KEK that was ever current may still
  be in use.
- **Keep the KEKs apart from the dumps**: a different secret store, different access. A dump
  together with its KEKs is the plaintext.
- **Losing the KEKs loses the encrypted columns**, not the rest of the database. There is no way
  to decrypt them again. Worse, Rocky does not recover by itself: sign-in opens the org's
  existing wrapped data key, so every org that already has one fails to sign anyone in
  (`unknown_key_version`) until the unreadable values are cleared. The recovery below is
  manual: it follows what the code does when a member is removed and when an org gets its
  first data key, but it has not been run as a drill.
  1. Stop the server and the worker.
  2. Generate a new KEK with a **new id** and set `ROCKY_KEK_KEYS` to it alone, with
     `ROCKY_KEK_CURRENT` naming it.
  3. As a superuser (row-level security is forced on these tables), clear every value the old
     KEKs protected, in one transaction:

     ```sql
     BEGIN;
     UPDATE members SET forge_token_ciphertext = NULL, forge_token_key_version = NULL,
                        forge_access_expires_at = NULL;
     UPDATE orgs SET data_key_ciphertext = NULL, data_key_version = NULL,
                     llm_api_key_ciphertext = NULL, llm_api_key_version = NULL;
     COMMIT;
     ```

  4. Set a new `ROCKY_SESSION_SECRET`, which signs everyone out, and start the processes again.
     The first member of each org to sign in provisions a new data key under the new KEK, and
     each member's token is stored again at their next sign-in. Until then, posting as that
     member reports that no token is stored.

  The org's own LLM key column (`orgs.llm_api_key_ciphertext`) is unused today: nothing writes
  it, so clearing it loses nothing.

- Rotating a KEK does not touch the ciphertexts, so older dumps stay readable with the old KEK.
  Keep every KEK as long as you keep dumps made while it was in use.

## Configuration and secrets

Back up the configuration you run with, with the secrets in your secret manager:

- the GitHub App's id, private key, client id and client secret, and the webhook secret
  (`GITHUB_APP_*`, `GITHUB_WEBHOOK_SECRET`). These can be regenerated on GitHub, but the private
  key and client secret are shown only once; regenerating means updating Rocky at the same time;
- the session secret (`ROCKY_SESSION_SECRET`). Losing it only signs everyone out;
- the LLM provider keys and settings (`ROCKY_LLM_*` and the variables they name);
- the retention settings (`RETENTION_*_DAYS`, `ORG_DELETION_GRACE_DAYS`), since `pnpm db:migrate`
  rewrites them on every run ([configuration](configuration.md#retention)).

## Dump and restore

### Taking a dump

```sh
pg_dump --format=custom --file=rocky-$(date +%Y%m%d).dump "<superuser URL to Rocky's database>"
```

- **Dump as a superuser** (or a role with `BYPASSRLS`). Every tenant table has row-level security,
  forced even for the owner. `pg_dump` turns row security off for its session and then refuses a
  table whose policies would still filter it, so the migrator, the application login and the
  worker login cannot take a full dump.
- **Never add `--enable-row-security`.** It makes the dump obey the policies: with no tenant set,
  every tenant table comes out empty, and the dump looks fine until you restore it.
- **Roles are not in the dump.** `pg_dump` covers one database; roles and role memberships are
  cluster-wide. Dump them too, with `pg_dumpall --roles-only`: besides the roles, it keeps the
  memberships the migrations granted (for example the migrator's membership in
  `rocky_lifecycle`, which lets it hand functions to that role). It includes password hashes, so
  store it like a secret.
- **The provisioning is not reliably in the dump.** The extensions and some of the revokes come
  back with it, but not all: in a drill on Postgres 17 the `REVOKE USAGE ON LANGUAGE sql` was
  missing after the restore, which silently gives every role back the ability to create SQL
  functions. Always run the provisioning again in the database you restore into (below).

Check each dump: `pg_restore --list` should list the tables, and a restore drill (below, on a
scratch cluster) is the only real test.

### Restoring

Restore into an **empty, provisioned database**, as a superuser:

1. **Roles.** Load the `pg_dumpall --roles-only` file with `psql -f` (an error that the superuser
   role already exists is expected). The dump refers to `rocky_app`, `rocky_worker`,
   `rocky_retention`, `rocky_lifecycle`, `rocky_auth`, the migrator and the logins as owners and grantees, so
   the restore fails without them. Change the logins' passwords afterwards if the old cluster may
   be compromised.
2. **Database.** Create the empty database, owned by the migrator.
3. **Provisioning.** Connected to that database, run the extension and revoke statements from
   [provisioning](upgrades.md#provisioning-once-per-database) (not the `CREATE ROLE` lines: the
   roles came in step 1). Use the same or a newer pgvector.
4. **Restore**, keeping owners and privileges (no `--no-owner`, no `--no-privileges`):

   ```sh
   pg_restore --exit-on-error --dbname="<superuser URL to the new database>" rocky-20260101.dump
   ```

5. **Check the revokes held.** Both rows must list only the superuser and the migrator, never
   an entry for everyone (`=U`) or an empty list (which means the default, usable by everyone):

   ```sql
   SELECT lanname, lanacl FROM pg_language WHERE lanname IN ('plpgsql', 'sql');
   ```

6. Run `pnpm db:migrate status` **with the code version the dump was made with**. The ledger must
   list exactly that checkout's migrations. To restore onto newer code, restore with the matching
   version first and then [upgrade](upgrades.md#upgrading).
7. Run `pnpm db:migrate` with your `RETENTION_*` values. Start the server, then the worker.

This procedure (a non-superuser migrator, the dump refused for the owner, an empty dump with
`--enable-row-security`, roles, provisioning, restore, the language check and `db:migrate`) was
run once by hand on the development image (Postgres 17, pgvector 0.8.7) with a schema and a
single org row. It has not been run against a production-sized database.

Things that go wrong:

- **Do not restore data into an already migrated database** (`--data-only`). The schema's
  triggers then run on every restored row as if the application wrote it: for example the audit
  log's insert trigger replaces every restored timestamp with the time of the restore, which
  moves old events out of reach of the retention purge. A full restore creates the triggers after
  the data, which is why it works.
- **Restoring as a non-superuser** cannot hand the purge, claim and sign-in functions to
  `rocky_retention`, `rocky_lifecycle` and `rocky_auth`, and row-level security, forced on every tenant table,
  applies to the load itself.
- **Encrypted columns need the same KEKs.** Start the server with the KEKs from the time of the
  dump (or a later `ROCKY_KEK_KEYS` that still lists them).

### After a restore

- Webhooks delivered while Rocky was down are not in the restored inbox. Redeliver failed
  deliveries from the GitHub App's settings, and run `pnpm mirror:rebuild <owner/name>` for each
  repository to bring the pull request mirror up to date.
- Re-index repositories if the index is older than you want; it is derived data.
- Anything written between the dump and the failure (memory, drafts, roles) is gone. Dump as often
  as you can afford to lose that work.

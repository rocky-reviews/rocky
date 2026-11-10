# Upgrades and migrations

The schema is plain SQL in `packages/db/migrations`, one `NNNN_name.up.sql` /
`NNNN_name.down.sql` pair per version, applied by `pnpm db:migrate`
([ADR 0005](../adr/0005-migrations-and-roles.md)). An upgrade is: back up, stop, migrate, start.

## Version compatibility

- **Code and schema move together.** A checkout's `packages/db/migrations` is exactly the schema
  its server and worker expect. Run the server, the worker and `pnpm db:migrate` from the same
  checkout (or the same image tag). Never run new code on an old schema or old code on a new one.
- **The server and worker do not check the schema version at start.** Running them before
  `pnpm db:migrate` fails at the first query that needs a new table or column, not at boot. Make
  migrating a step that has to succeed before the new processes start.
- **There are no tagged releases yet.** Upgrades are from one commit of `main` to a later one. You
  can skip any number of commits: `pnpm db:migrate` applies every pending migration in order, each
  in its own transaction, so there is no need to stop at intermediate versions.
- **Runtime requirements** can change between versions: Node (`engines` in `package.json`),
  pnpm (`packageManager`), Postgres and pgvector ([requirements](README.md#what-you-need)). Read
  the change log of the commits you are moving across (`git log` on `packages/db/migrations` and
  `docs/adr` is a good start) before upgrading.

## How `pnpm db:migrate` works

```sh
pnpm db:migrate             # apply every pending migration, then write the retention settings
pnpm db:migrate status      # list applied migrations and when
pnpm db:migrate down [n]    # roll back the last n migrations (default 1)
```

- It connects as **`DATABASE_ADMIN_URL`, the table owner** (the migrator), never as the
  application's login. The server and the worker never hold this credential.
- It takes an advisory lock, so two migrators started at once run one after the other.
- Each migration runs in its own transaction with its ledger row in `app.schema_migrations`
  (version, name, and a sha256 of the up and down scripts). A migration that fails rolls back on
  its own; the ones before it stay applied. Fix the cause and run it again.
- **It refuses, before changing anything**, when:
  - the migration files have a gap or a duplicate (versions must be exactly 1..n, each with both
    an `.up.sql` and a `.down.sql`);
  - the database records a migration the checkout does not have, which is what happens when old
    code is pointed at a newer database (see [rolling back](#rolling-back));
  - an applied migration's file content changed (checksum mismatch): applied migrations are never
    edited, a fix is a new migration.
- After `up` it **writes the retention settings** from its own environment (`RETENTION_*_DAYS`,
  `ORG_DELETION_GRACE_DAYS`; [configuration](configuration.md#retention)). An unset variable puts
  that period back to its default, so give the migration step the same values every time.
- Roles are cluster-wide and the extensions are installed by a superuser. Migrations create the
  group roles they need if they are missing, but never drop them, and `down` leaves the roles and
  the extensions in place.

## Database roles

| Role              | Logs in | What it is for                                                                                                           |
| ----------------- | ------- | ------------------------------------------------------------------------------------------------------------------------ |
| migrator          | yes     | Owns the database, schemas and tables. Runs migrations. `CREATEROLE`, not superuser in production. `DATABASE_ADMIN_URL`. |
| `rocky_app`       | no      | Group for the application: plain reads and writes on tenant tables, row-level security enforced and forced.              |
| `rocky_worker`    | no      | Group for the worker on top of `rocky_app`: creating orgs, claiming webhook inbox rows, erasing orgs.                    |
| `rocky_retention` | no      | Owns the retention purge and org deletion functions. Nobody logs in as it.                                               |
| `rocky_lifecycle` | no      | Owns the queue-claim functions. Nobody logs in as it.                                                                    |
| application login | yes     | A member of `rocky_app` and nothing else. `DATABASE_URL`. The server refuses any other kind of login.                    |
| worker login      | yes     | A member of `rocky_app` and `rocky_worker`. `WORKER_DATABASE_URL`.                                                       |

### Provisioning (once per database)

Tenant isolation rests on the application roles being unable to run procedural code or reach
`set_config` indirectly. Only a superuser can take that away, so it is not in a migration;
migration 0001 checks it and refuses to run without it. As a superuser, create the migrator and
the database:

```sql
CREATE ROLE <migrator> LOGIN PASSWORD '<from your secret store>' CREATEROLE;
CREATE DATABASE <database> OWNER <migrator>;
```

Then, connected to that database (extensions and language privileges belong to one database,
so a restore into a new database needs this again):

```sql
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pgcrypto;
REVOKE USAGE ON LANGUAGE plpgsql FROM PUBLIC;
REVOKE USAGE ON LANGUAGE sql FROM PUBLIC;
GRANT USAGE ON LANGUAGE plpgsql, sql TO <migrator>;  -- not needed when the migrator is a superuser
REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION
  pg_catalog.query_to_xml(text, boolean, boolean, text),
  pg_catalog.query_to_xmlschema(text, boolean, boolean, text),
  pg_catalog.query_to_xml_and_xmlschema(text, boolean, boolean, text),
  pg_catalog.ts_stat(text),
  pg_catalog.ts_stat(text, text),
  pg_catalog.ts_rewrite(tsquery, text)
FROM PUBLIC;
CREATE ROLE rocky_app NOLOGIN INHERIT;
CREATE ROLE rocky_worker NOLOGIN INHERIT;
CREATE ROLE <app login> LOGIN PASSWORD '<from your secret store>' INHERIT IN ROLE rocky_app;
CREATE ROLE <worker login> LOGIN PASSWORD '<from your secret store>' INHERIT IN ROLE rocky_app, rocky_worker;
```

This is what `deploy/dev/init.sql` runs for development (where the migrator is the superuser). Why each revoke matters is in
[ADR 0005 §2](../adr/0005-migrations-and-roles.md#2-three-roles-one-owner). Then run
`pnpm db:migrate`. `pnpm seed` checks the extensions and both logins against a local database.

## Upgrading

1. **Read what changed** between your commit and the target (migrations, ADRs, `.env.example`
   and the [configuration reference](configuration.md)). New required variables are refused at
   start, so set them before you restart.
2. **Back up** ([backups](backups.md)): a full `pg_dump` of the database taken as a superuser,
   and a copy of the configuration you run with today. Check the dump is not empty before you go
   on. This is the rollback you can rely on.
3. **Stop the worker, then the server.** The worker stops claiming work; a run in progress is
   claimed again after its lease ends, so nothing is lost. Stopping both avoids old code meeting
   the new schema while it changes.
4. **Install the new version**: check out the target commit (or pull the new image), then
   `pnpm install --frozen-lockfile` and rebuild the web app.
5. **Migrate**: `pnpm db:migrate`, with `DATABASE_ADMIN_URL` and your `RETENTION_*` values.
   `pnpm db:migrate status` lists what is applied.
6. **Start the server, then the worker**, and watch the first log lines: a configuration error
   names the variable and stops the process.

## Rolling back

Two ways back, in order of preference:

- **Restore the backup** taken in step 2 into an empty database, and run the old version. This is
  the only way that brings back data exactly as it was. Anything written after the backup
  (reviews in progress, new analyses, memory changes) is lost; what came from GitHub can be
  rebuilt ([backups](backups.md#what-to-back-up)).
- **Roll the schema back with the new code, then switch to the old code.** The `down` scripts
  live in the newer checkout, and old code refuses a database that records migrations it does not
  know, so the order matters:

  ```sh
  # still on the NEW checkout, with the processes stopped
  pnpm db:migrate status          # note which migrations the upgrade applied
  pnpm db:migrate down <n>        # n = how many the upgrade applied
  # then check out the OLD version and start it
  ```

  A `down` script removes what its migration added: a dropped table or column takes the data
  written into it since the upgrade. Some migrations reshape data on the way up (for example a
  vector column's width), and their `down` cannot restore the old values. Treat `down` as a
  schema rollback, not a data one, and prefer the restore when in doubt.

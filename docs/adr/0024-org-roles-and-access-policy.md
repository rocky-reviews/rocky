# ADR 0024: Roles per org and one access policy for every route

- **Status:** Accepted (defaults chosen for the user; open to veto at review)
- **Date:** 2026-10-28
- **Task:** P7-2
- **Amends:** [ADR 0020](0020-github-login-and-sessions.md) (`activeMember` answers a
  discriminated result; the first owner at sign-in; a "not a member" sign-in clears the stored
  token), [ADR 0008](0008-github-app-manifest.md) (the app subscribes to `organization`),
  [ADR 0007](0007-webhook-inbox.md) (a third inbox lane, `org_member`),
  [ADR 0017](0017-analysis-queue-and-token-limit.md) ("Analyze anyway" is admin-only)

## Context

P7-1 made every Rocky member a real GitHub organization member (or a User account's owner) with
the default role `member`, and left three things to P7-2: roles that mean something, one place
where every route is checked, and what happens when someone leaves the GitHub organization during
a session. GitHub stays the source of truth for identity and repository access (P3-6); Rocky's
roles only decide what someone may do inside Rocky.

## Decision

### 1. Roles and permissions

Three nested roles, stored on `members.role` (tenant table, RLS, only touched inside `withOrg`).
Routes declare a **permission**, never a role; the table is in `packages/core/src/roles.ts`.

| Permission                        | member | admin | owner |
| --------------------------------- | :----: | :---: | :---: |
| `pull_requests.review`            |   ✓    |   ✓   |   ✓   |
| `drafts.own`, `settings.own`      |   ✓    |   ✓   |   ✓   |
| `ask`                             |   ✓    |   ✓   |   ✓   |
| `members.read`                    |        |   ✓   |   ✓   |
| `members.manage` (remove, re-add) |        |   ✓   |   ✓   |
| `repo_settings.manage`            |        |   ✓   |   ✓   |
| `spend_caps.manage`               |        |   ✓   |   ✓   |
| `analysis.approve_over_limit`     |        |   ✓   |   ✓   |
| `memory.edit`                     |        |   ✓   |   ✓   |
| `billing.manage`                  |        |       |   ✓   |
| `org.delete` (with its grace)     |        |       |   ✓   |
| `roles.manage` (admins)           |        |       |   ✓   |
| `ownership.transfer`              |        |       |   ✓   |

- **GitHub access still applies.** A role never widens repository access: even an owner sees a
  repository only while GitHub gives them read access (P3-6), and only a human posts.
- **Seats:** every role takes a seat. Nothing else about billing is decided here.
- `can(role, permission)` fails closed on anything that is not a known role and permission.

### 2. The first owner, and GitHub role changes

- At sign-in, while an org has **no owner**, a person whose `GET /user/memberships/orgs/{org}`
  answer is `state: "active"` with `role: "admin"` becomes the owner (`claimFirstOwner`, under the
  org's owner lock, so two first sign-ins make one owner). On a User-account installation the
  account owner is that admin. Everyone else is a `member`. Audited `member.first_owner`.
- **Later GitHub role changes never change Rocky roles**: once the org has an owner, a GitHub
  promotion or demotion is not mirrored. Roles change only through the routes in §5.
- A `billing_manager` (or any role other than `admin`/`member`) is not an organization member and
  does not sign in (fail closed; P7-1 accepted any active state).
- Only `state: "active"` is membership. A `pending` membership (an invitation not yet accepted)
  counts as **"not a member"** at sign-in, exactly like a 404: that org is left out of the
  sign-in, and an existing member row gets the §6 treatment (token deleted, sessions cut, an admin
  demoted to member).

### 3. Always an owner

An org that has an owner keeps one: the trigger `members_keep_an_owner` (migration 0014) refuses
any UPDATE of `role`/`removed_at` or DELETE that leaves no active owner, for every role. Changes
to owners are serialised by `app.lock_org_owners(org)` (a transaction-scoped advisory lock taken
by the trigger and by every membership-changing function first: role change, removal, re-adding,
transfer, first owner, leaving the GitHub org); under READ COMMITTED the count after the lock
sees every committed change, so two concurrent demotions cannot both win (tested, and the test
fails with the lock removed). Taking it first also puts every membership change of an org in one
order, so their row locks cannot deadlock. It is granted to `rocky_app` only (the worker login
reaches it through its `rocky_app` membership): no other role changes members. Erasure
(`retention.delete_org`, org `erasing_at` set) is not checked. Ownership moves only by transfer
(§5), which promotes the target before demoting the actor in one transaction.

### 4. One policy module (`apps/server/src/auth/policy.ts`)

- Every route declares `config.policy`: `publicRoute(reason)`, `SESSION_ROUTE` or
  `requires(permission)`. An `onRoute` hook registered first in `buildApp` throws
  `RoutePolicyError` for a route without a valid declaration, so it **fails to register** (at
  boot, and in the matrix test). HEAD routes Fastify derives from GETs get the same policy.
- For session and permission routes the hook adds a route-level `onRequest` handler, which runs
  after the global CSRF guard and before the body is read. `sessionAuth.activeMember` resolves
  the member **once** and answers a discriminated result (P7-1 follow-up):

  | Result                     | Answer                             |
  | -------------------------- | ---------------------------------- |
  | no live session            | 401 `{ error: "unauthenticated" }` |
  | no active org (or cut)     | 409 `{ error: "no_active_org" }`   |
  | member row gone or removed | 403 `{ error: "not_a_member" }`    |
  | role lacks the permission  | 403 `{ error: "forbidden" }`       |

- What was resolved is on `request.access` (`session`, `member`); ids come from the session,
  never from the request. The role is **read from the member row inside `withOrg` on every
  request** and never cached in the session, so a role change or removal applies to the target's
  very next request without touching any session.
- Denials are logged as `{ access: { outcome, reason, permission } }`, nothing else.
- **GETs have no side effects** beyond the session's idle touch (ADR 0020's forced-login note):
  the only new GET (`/api/org/members`) reads.

### 5. Routes

| Route                                               | Permission                    | Notes                                                    |
| --------------------------------------------------- | ----------------------------- | -------------------------------------------------------- |
| `GET /api/org/members`                              | `members.read`                | no tokens; login is display data                         |
| `PATCH /api/org/members/:memberId {role}`           | `roles.manage`                | `member`↔`admin` only; an owner target is 409            |
| `DELETE /api/org/members/:memberId`                 | `members.manage`              | not an owner, not oneself; token deleted, sessions cut   |
| `POST /api/org/members/:memberId/restore`           | `members.manage`              | clears `removed_at`, role back to `member`               |
| `POST /api/org/ownership {memberId}`                | `ownership.transfer`          | target owner, actor admin; re-checked with rows locked   |
| `POST /api/analyses/:analysisId/approve-over-limit` | `analysis.approve_over_limit` | plus the P3-6 access check; 503 without it (fail closed) |

**The actor is re-checked at commit.** The policy check runs in an earlier transaction, so each
change re-reads the actor inside its own transaction, after the owner lock and with the row
locked `FOR SHARE`: still an active member of this org whose role holds the route's permission
(`can`). Otherwise the change is refused with `not_permitted` (403 `forbidden`; a transfer
answers `not_owner`, 409) and nothing is written. So a role change racing an ownership transfer
by the same owner, a removal racing the actor's own demotion or removal, or two admins removing
each other resolve one after the other, and the loser is refused (race tests in
`members.test.ts`, which fail with the re-check removed).

Each change is audited in its own transaction (`member.role_changed` with from/to,
`member.removed`, `member.restored`, `org.ownership_transferred`) and calls the access check's
`invalidateMember` after the commit. Target ids are looked up inside the caller's `withOrg`, so
another org's id is a 404 (RLS). `approveAnalysisOverLimit` itself now requires an active admin
or owner in the same transaction (defence in depth).

### 6. Leaving the GitHub organization

- The GitHub App subscribes to `organization` (manifest change). `member_removed` is decoded to
  the forge-neutral `org_member.removed` (installation, organization account, the person's id
  only) and stored in the inbox (CHECKs on type and shape, migration 0014). Every other
  `organization` action is ignored: **nothing is ever granted from a webhook**.
- The worker's `org_member` lane binds the event to the org by installation **and** account id
  (as login does; a mismatch is parked `account_mismatch`) and, inside `withOrg`, deletes the
  person's stored token and their `session_orgs` links (the app role may delete links of the
  current tenant only), audited `member.left_forge` with the delivery id as actor, and completes
  the inbox row in the same transaction. **A non-owner is demoted to `member`** (the audit
  metadata records `from` and `to`), so someone who comes back by signing in once GitHub has them
  again gets no privilege back by default, as with re-adding (§5). The member row stays (it is
  not a Rocky removal). **An owner stays the owner**: the org must keep one (§3), so this case is
  the documented residual risk below.
- Trust boundary: the delivery is authenticated by its HMAC signature, and the event can only
  take access away, so the worker does not ask GitHub again. A replay is deduplicated; a
  reordered or stale removal can at most sign someone out early and demote an admin to member
  (an owner promotes them again).
- `membership` (team membership) events are **not** handled: leaving a team is not leaving the
  organization, and repository access through teams is P3-6's (at most 5 minutes stale).
- On a sign-in where GitHub positively answers "not a member" for an org where a member row
  exists, the same happens (token deleted, sessions cut, audited with source `sign_in`). A failing
  membership check changes nothing stored; that org is just left out of this sign-in.

## Threat model

**Assets:** roles (the right to administer an org), member tokens, session-to-org links, the
audit trail, tenant boundaries.
**Attackers:** a member or admin trying to escalate; a member of another org; a removed member
or someone who left the GitHub org with a live session; concurrent requests; someone who can send
webhook-shaped requests; a future route that forgets the check.

| #   | What can go wrong                                                           | Prevention                                                                                                     | Test                                                                                                                                                    |
| --- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | A member promotes themselves; an admin promotes anyone                      | `roles.manage` is owner-only (policy); `changeMemberRole` accepts `member`/`admin` only                        | `policy.db.test.ts` matrix rows; "R1: a member cannot promote themselves…"; `roles.test.ts`                                                             |
| R2  | An admin makes an owner; the last owner demotes or removes themselves       | `owner` not assignable; owner target refused; trigger `members_keep_an_owner`                                  | "R2: nobody makes an owner…"; `members.test.ts` "refuses demoting, removing or deleting the only owner", "never makes or unmakes an owner"              |
| R3  | Two concurrent demotions/transfers leave no owner (race)                    | Owner advisory lock in the trigger and in every owner change; rows locked `FOR UPDATE`; READ COMMITTED         | `members.test.ts` "serialises concurrent demotions…" (fails without the lock), "two concurrent transfers…", "two first sign-ins at once…"               |
| R4  | A stale role in a cached session keeps privileges after a demotion/removal  | Role re-read from the member row in `withOrg` on every request; removal cuts `session_orgs`                    | "R3: … applies to the target's very next request (no stale role)", "R4: removing a member ends their access at once"                                    |
| R5  | Cross-org role confusion: an admin of B acts as admin in A, or targets A    | Role read for the session's active org only; target ids looked up under the caller's RLS                       | matrix personas `crossOrg`, `otherOrg`; "R6: cross-org…"; `isolation.test.ts` "roles across tenants"; `members.test.ts` "does not find … another org's" |
| R6  | A new route skips the check                                                 | `onRoute` refuses routes without a valid policy; matrix enumerates Fastify's routes and fails on a missing row | "a route without a policy fails to register…", "a malformed policy…", "enumerates every registered route…"                                              |
| R7  | A forged or replayed webhook signs people out or grants access              | HMAC first (ADR 0007); dedup by delivery and body; only takes access away; binding by installation + account   | `org-members.e2e.test.ts` (unsigned 401, replay, account mismatch parked, joins store nothing); `ingress.test.ts` organization events                   |
| R8  | Someone who left the GitHub org keeps a live session and a stored token     | `organization.member_removed` lane; "not a member" at sign-in does the same                                    | `org-members.e2e.test.ts` "deletes the stored token and cuts the org…"; `auth.db.test.ts` "a sign-in where GitHub says 'not a member'…"                 |
| R9  | A role stands in for GitHub access ("Analyze anyway" on an unreadable repo) | Approval route runs the P3-6 check (deny = 404) and fails closed without it; DB re-checks the approver's role  | "R8: approving … needs GitHub read access", "R8b: … fails closed (503)"; `analysis-queue.test.ts` "is refused for a plain member or a removed admin"    |
| R10 | Body or path smuggles the actor or the org                                  | Ids from the session; path ids validated as uuids; body fields other than the documented one ignored           | "R7: ids in the path are validated; a body cannot choose the actor or the org"                                                                          |
| R11 | Logs leak logins, tokens or cookies                                         | Denials log reason and permission; admin routes log outcome and ids                                            | "R9: denials are logged with a reason and a permission only"; e2e log assertions                                                                        |
| R12 | The actor lost the right between the policy check and the change (race)     | Actor re-read `FOR SHARE` in the changing transaction after the owner lock; `not_permitted` otherwise          | `members.test.ts` "the actor is re-checked in the changing transaction" (transfer vs role change, two admins removing each other, restore vs removal)   |
| R13 | An admin who left the GitHub org regains admin when re-invited              | Leaving demotes a non-owner to `member` (webhook and "not a member" sign-in)                                   | `members.test.ts` "deletes the token, cuts the sessions, demotes an admin…"; `org-members.e2e.test.ts`                                                  |

## Consequences

- Every route carries a policy; adding one without it breaks boot and the matrix test.
- The GitHub App needs the `organization` event; installed apps must accept it (needs-human).
- `memberLeftForge` and `removeMember` give the app role DELETE on `app.session_orgs` (current
  tenant only; the isolation matrix pins it).

## Residual risks

- **The repository access check is not wired in `startServer` yet** (it needs installation
  credentials on the server). Until then "Analyze anyway" answers 503 in a running server.
  (Closed by H4-1, [ADR 0033](0033-repository-access-check-wiring.md).)
- **An owner who leaves the GitHub org stays the owner** (the webhook does not change roles);
  they cannot sign in, so the org has no reachable owner until they rejoin. Recovery is an
  operator action (follow-up: a documented runbook or an "owner left" admin path).
- `invalidateMember` is process-local (ADR 0011's broadcast follow-up); the worker cannot reach
  the server's cache, so after a webhook departure a cached allow may live up to 5 minutes. The
  person's sessions are cut at once, so no route reaches the cache for them (tested end to end by
  ADR 0033's "a removal in Rocky is refused before the cache").
- Members are listed up to 1000 (paging is a follow-up). `members.login` is display data.

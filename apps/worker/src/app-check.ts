import { ForgeReadError, type Clock, type InstallationReader } from "@rocky-reviews/core";
import type { Logger } from "@rocky-reviews/log";

/**
 * The app check (review round 1, M2): before the worker claims an installation event or sweeps a
 * deletion, `GET /app` must prove the configured key belongs to the configured app id. GitHub
 * answers 404 for another app's installations, so a key for the wrong app would make every
 * installation look uninstalled; with this gate such a worker claims nothing and erases nothing.
 *
 * A pass is trusted for `recheckMs` (default 1 h, so a rotated key is noticed); a failure is
 * retried on the next call. Failures are logged at error level by code only, at most once per
 * `logEveryMs` while they persist (the inbox polls every few seconds).
 */

export interface AppCheck {
  /** True once the app is verified; false (nothing may be claimed or erased) otherwise. */
  ready(): Promise<boolean>;
}

export interface AppCheckOptions {
  readonly forge: InstallationReader;
  readonly clock: Clock;
  readonly log: Logger;
  readonly recheckMs?: number;
  readonly logEveryMs?: number;
}

export const APP_RECHECK_MS = 60 * 60_000;

const codeOf = (error: unknown): string =>
  error instanceof ForgeReadError ? error.code : "internal_error";

export const createAppCheck = (options: AppCheckOptions): AppCheck => {
  const recheckMs = options.recheckMs ?? APP_RECHECK_MS;
  const logEveryMs = options.logEveryMs ?? 5 * 60_000;
  let verifiedAt: number | undefined;
  let lastFailureLog: { code: string; at: number } | undefined;

  return {
    ready: async () => {
      const now = options.clock.now().getTime();
      if (verifiedAt !== undefined && now - verifiedAt < recheckMs) return true;
      try {
        await options.forge.verifyApp();
      } catch (error) {
        verifiedAt = undefined;
        const code = codeOf(error);
        if (
          lastFailureLog === undefined ||
          lastFailureLog.code !== code ||
          now - lastFailureLog.at >= logEveryMs
        ) {
          lastFailureLog = { code, at: now };
          options.log.error(
            { forge: options.forge.kind, errorCode: code },
            "forge app check failed: not claiming installation events or erasing orgs (check GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY)",
          );
        }
        return false;
      }
      if (verifiedAt === undefined) {
        options.log.info({ forge: options.forge.kind }, "forge app verified");
      }
      verifiedAt = now;
      lastFailureLog = undefined;
      return true;
    },
  };
};

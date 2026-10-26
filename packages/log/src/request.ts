import { randomUUID } from "node:crypto";
import type { Logger } from "pino";

/** Request ids are generated server-side; client-supplied ids are never trusted or echoed. */
export const newRequestId = (): string => randomUUID();

/** A child logger whose every line carries `requestId`, for jobs and non-HTTP entry points. */
export const withRequestId = (log: Logger, requestId: string = newRequestId()): Logger =>
  log.child({ requestId });

/** Live 17 Nov 2026: a prefilled 25-hotel run took 265 s. Booking served 15
 * cards per document and the Actor waited ~50 s in each of three documents for
 * a "load more" control that never appeared, close to Apify's 5-minute QA limit. */

/** First append in a fresh document can take ~31 s (cloud run rQwgL9y0ogItupF7m). */
export const FIRST_DOCUMENT_CONTINUATION_MS = 50_000;
/** Once a search showed no continuation control, later documents of that search
 * rarely do; offset pages carry the rest, so wait only briefly there. */
export const LATER_DOCUMENT_CONTINUATION_MS = 15_000;
/** A run of at most one page of results never needs more than this to collect. */
export const SMALL_RUN_COLLECTION_SECS = 180;
/** Stop starting new pages this close to the run's own timeout. */
export const TIMEOUT_RESERVE_SECS = 60;

/** Seconds since the run started. Replaceable so long test files are not cut short. */
export const runClock = { uptimeSecs: (): number => process.uptime() };

export function continuationBudgetMs(appendedInThisDocument: boolean, continuationAbsentBefore: boolean): number {
  if (appendedInThisDocument || continuationAbsentBefore) return LATER_DOCUMENT_CONTINUATION_MS;
  return FIRST_DOCUMENT_CONTINUATION_MS;
}

/** True when another results page must not be started: small runs after
 * SMALL_RUN_COLLECTION_SECS, and any run within TIMEOUT_RESERVE_SECS of
 * ACTOR_TIMEOUT_AT. Saved hotels are kept and the run succeeds. */
export function collectionTimeExhausted(options: {
  maxResults: number;
  pageSize: number;
  uptimeSecs: number;
  nowMs?: number;
  timeoutAt?: string | undefined;
}): boolean {
  const { maxResults, pageSize, uptimeSecs, nowMs = Date.now(), timeoutAt } = options;
  if (maxResults <= pageSize && uptimeSecs >= SMALL_RUN_COLLECTION_SECS) return true;
  const deadline = timeoutAt ? Date.parse(timeoutAt) : NaN;
  return Number.isFinite(deadline) && nowMs >= deadline - TIMEOUT_RESERVE_SECS * 1000;
}

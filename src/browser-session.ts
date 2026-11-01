import { NonRetryableError } from 'crawlee';
import type { PlaywrightHook, PlaywrightRequestHandler } from 'crawlee';
import type { SearchState } from './types.js';
import { restoreSearchState } from './search-state.js';
import { rejectBookingAccess } from './access-policy.js';

export const BOOKING_MAX_REQUESTS_PER_CRAWL = 2_000;

/** Sequential isolated pages must use the same cookie jar and sticky proxy
 * session. Crawlee fills a larger pool with fresh sessions before reusing one. */
export const bookingBrowserSessions = {
  useSessionPool: true,
  persistCookiesPerSession: true,
  sessionPoolOptions: {
    maxPoolSize: 1,
    sessionOptions: { maxUsageCount: BOOKING_MAX_REQUESTS_PER_CRAWL + 1 },
  },
} as const;

// Internal identity only: never serialize session IDs into output or userData.
const searchSessions = new WeakMap<SearchState, string>();
type Context = Parameters<PlaywrightHook>[0];

function stopSession(request: Context['request'], state: SearchState, reason: string): never {
  request.noRetry = true;
  state.hasMore = false;
  if (state.coverage) { state.coverage.status = 'failed'; state.coverage.reason = reason; }
  throw new NonRetryableError(`BOOKING_SESSION_CONTINUITY: ${reason}`);
}

export function assertBookingSession({ request, session }: Pick<Context, 'request' | 'session'>): SearchState {
  const state = restoreSearchState(request.userData.state as SearchState);
  if (state.coverage?.reason === 'source_access_blocked') rejectBookingAccess(request, state, 'BOOKING_BLOCKED: search already stopped');
  if (isBookingSessionFailure(state.coverage?.reason)) stopSession(request, state, state.coverage!.reason!);
  if (!session) stopSession(request, state, 'browser_session_missing');
  const previous = searchSessions.get(state);
  if (previous && previous !== session.id) stopSession(request, state, 'browser_session_changed');
  searchSessions.set(state, session.id);
  return state;
}

/** Stop before navigating if expiry/retirement would change an active search. */
export const bookingSessionPreNavigation: PlaywrightHook = async context => {
  assertBookingSession(context);
};

/** Crawlee's normal cookie checkpoint precedes the user's handler. Capture
 * cookies set during hydration/collection before closing the isolated page. */
export function withBookingSessionCookies(handler: PlaywrightRequestHandler): PlaywrightRequestHandler {
  return async context => {
    const state = assertBookingSession(context);
    await handler(context);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const cookies = await Promise.race([
        context.browserController.getCookies(context.page),
        new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Cookie checkpoint timeout')), 3_000); }),
      ]);
      context.session!.setCookies(cookies, context.page.url());
    } catch {
      stopSession(context.request, state, 'browser_cookie_checkpoint_failed');
    } finally { if (timer) clearTimeout(timer); }
  };
}

export function isBookingSessionFailure(reason: string | null | undefined): boolean {
  return ['browser_session_missing', 'browser_session_changed', 'browser_cookie_checkpoint_failed'].includes(reason ?? '');
}

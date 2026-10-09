import type { Page } from 'playwright';

export const bookingNavigationOptions = () => ({
  waitUntil: 'domcontentloaded' as const,
  timeout: 30_000,
});

const contextKeys = ['ss', 'dest_id', 'checkin', 'checkout', 'group_adults', 'no_rooms', 'group_children', 'age', 'selected_currency'];
const isBookingOrigin = (url: URL) => url.protocol === 'https:' && ['www.booking.com', 'booking.com'].includes(url.hostname)
  && !url.username && !url.password;

/** The failed saved search redirected to an undated /city/gb/london page.
 * This page is never hotel/stay evidence; only one return to the original
 * search URL is permitted, with the same request-level restoration budget. */
export function isContextFreeCityLanding(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isBookingOrigin(parsed) && /^\/city\/[a-z]{2}\/[^/]+\.html$/i.test(parsed.pathname)
      && !contextKeys.some(key => parsed.searchParams.has(key));
  } catch { return false; }
}

/** Bounded diagnostics expose only route kind and parameter names, never
 * destination text, values, credentials, tracking labels or raw query strings. */
export function searchRedirectDiagnostic(url: string): { routeKind: string; missingFields: string[] } {
  try {
    const parsed = new URL(url);
    if (!isBookingOrigin(parsed)) return { routeKind: 'foreign_or_invalid', missingFields: [] };
    const routeKind = /^\/city\/[a-z]{2}\/[^/]+\.html$/i.test(parsed.pathname) ? 'city_landing'
      : /^\/searchresults(?:\.[a-z]{2,3}(?:-[a-z]{2})?)?\.html$/i.test(parsed.pathname) ? 'search' : 'other';
    return { routeKind, missingFields: contextKeys.filter(key => !parsed.searchParams.has(key)) };
  } catch { return { routeKind: 'foreign_or_invalid', missingFields: [] }; }
}

/** Recognize same-site search shells that have lost their search. */
export function isContextFreeSearchShell(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && ['www.booking.com', 'booking.com'].includes(parsed.hostname)
      && !parsed.username && !parsed.password
      && /^\/searchresults(?:\.[a-z]{2,3}(?:-[a-z]{2})?)?\.html$/i.test(parsed.pathname)
      && !['ss', 'dest_id', 'checkin', 'checkout'].some(key => parsed.searchParams.has(key));
  } catch { return false; }
}

/** Restore a context-free search shell or city landing at most once. Never
 * navigate a login, challenge or foreign page or invent a different search. */
export async function restoreSearchShell(
  page: Pick<Page, 'url' | 'goto'>, requestedUrl: string,
  documentState: 'normal' | 'blocked' | 'no-results' | 'unavailable',
  budget: { bookingSearchShellRestoreAttempted?: boolean } = {},
): Promise<boolean> {
  if (documentState !== 'normal'
    || !(isContextFreeSearchShell(page.url()) || isContextFreeCityLanding(page.url()))) return false;
  const requested = new URL(requestedUrl);
  if (requested.protocol !== 'https:' || !['www.booking.com', 'booking.com'].includes(requested.hostname)
    || requested.username || requested.password || !/^\/searchresults(?:\.[a-z]{2,3}(?:-[a-z]{2})?)?\.html$/i.test(requested.pathname)
    || !(requested.searchParams.has('ss') || requested.searchParams.has('dest_id'))
    || !requested.searchParams.has('checkin') || !requested.searchParams.has('checkout')) {
    throw new Error('BOOKING_INVALID_SEARCH_RESTORE_TARGET');
  }
  if (budget.bookingSearchShellRestoreAttempted) {
    throw new Error('BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE');
  }
  // Retain this on the request across crawler/session retries, including a
  // navigation that fails. A new browser session is not a new repair allowance.
  budget.bookingSearchShellRestoreAttempted = true;
  await page.goto(requested.toString(), bookingNavigationOptions());
  if (isContextFreeSearchShell(page.url()) || isContextFreeCityLanding(page.url())) {
    throw new Error('BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE');
  }
  return true;
}

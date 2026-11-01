import type { Page } from 'playwright';
import { NonRetryableError } from 'crawlee';
import { PROPERTY_CARD_SELECTOR } from './property-cards.js';

export const bookingNavigationOptions = () => ({
  // A deferred script can hold DOMContentLoaded after usable cards render.
  // Receipt of the document is navigation, not proof of hotel data.
  waitUntil: 'commit' as const,
  timeout: 30_000,
});

/** A parsed document or visible source content can reach the collector without
 * waiting for deferred/background scripts. Existing data/access checks remain
 * mandatory; an empty document that is still loading fails within this bound. */
export async function waitForBookingDocument(
  page: Pick<Page, 'waitForFunction'>, timeoutMs = 18_000,
): Promise<void> {
  const ready = await page.waitForFunction(({ cards }) => {
    if (!document.body) return false;
    if (document.readyState !== 'loading') return true;
    const visible = (element: Element) => {
      const box = element.getBoundingClientRect();
      return box.width > 0 && box.height > 0 && getComputedStyle(element).visibility !== 'hidden';
    };
    if (Array.from(document.querySelectorAll(cards + ', h1[data-testid="title"], h2[data-testid="title"], #hp_hotel_name, #hprt-table'))
      .some(visible)) return true;
    // This only lets the collector classify a terminal document; it does not
    // certify a price, an empty search or a valid stay.
    const text = document.body.innerText.slice(0, 5_000);
    return /access denied|verify (?:that )?you are|captcha|unusual traffic|security check|automated requests|no properties found|no results found|something went wrong on our end/i.test(text);
  }, { cards: PROPERTY_CARD_SELECTOR }, { polling: 100, timeout: timeoutMs });
  await ready.dispose();
}

const contextKeys = ['ss', 'dest_id', 'checkin', 'checkout', 'group_adults', 'no_rooms', 'group_children', 'age', 'selected_currency'];
const isBookingOrigin = (url: URL) => url.protocol === 'https:' && ['www.booking.com', 'booking.com'].includes(url.hostname)
  && !url.username && !url.password;

/** Only Booking's canonical home document is a recoverable home landing.
 * Login, account, consent and arbitrary same-origin routes are excluded. */
export function isContextFreeHomeLanding(url: string): boolean {
  try {
    const parsed = new URL(url);
    return isBookingOrigin(parsed) && /^(?:\/|\/index(?:\.[a-z]{2,3}(?:-[a-z]{2})?)?\.html)$/i.test(parsed.pathname)
      && !contextKeys.some(key => parsed.searchParams.has(key));
  } catch { return false; }
}

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
    const routeKind = isContextFreeHomeLanding(url) ? 'home_landing'
      : /^\/city\/[a-z]{2}\/[^/]+\.html$/i.test(parsed.pathname) ? 'city_landing'
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
  page: Pick<Page, 'url' | 'goto' | 'waitForFunction'>, requestedUrl: string,
  documentState: 'normal' | 'blocked' | 'no-results' | 'unavailable',
  budget: { bookingSearchShellRestoreAttempted?: boolean } = {},
): Promise<boolean> {
  if (documentState !== 'normal'
    || !(isContextFreeSearchShell(page.url()) || isContextFreeCityLanding(page.url()) || isContextFreeHomeLanding(page.url()))) return false;
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
  const response = await page.goto(requested.toString(), bookingNavigationOptions());
  if (response && [401, 403, 429].includes(response.status())) {
    throw new NonRetryableError(`BOOKING_BLOCKED: HTTP ${response.status()} during search restoration`);
  }
  await waitForBookingDocument(page);
  if (isContextFreeSearchShell(page.url()) || isContextFreeCityLanding(page.url()) || isContextFreeHomeLanding(page.url())) {
    throw new Error('BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE');
  }
  return true;
}

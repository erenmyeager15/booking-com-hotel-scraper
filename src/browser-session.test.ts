import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from 'apify';
import { Configuration, PlaywrightCrawler } from 'crawlee';
import type { PlaywrightHook, PlaywrightRequestHandler } from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bookingBrowserContext, bookingBrowserPool } from './browser-lifecycle.js';
import { bookingPostNavigation } from './browser-navigation.js';
import { bookingNavigationOptions } from './navigation.js';
import { assertBookingSession, bookingBrowserSessions, bookingSessionPreNavigation, withBookingSessionCookies } from './browser-session.js';
import { restoreSearchState } from './search-state.js';
import { router, buildSearchUrl } from './routes.js';
import type { SearchState, HotelRecord } from './types.js';

const stateFor = (name: string): SearchState => ({
  destination: 'London, United Kingdom', requestNamespace: name,
  checkIn: '2026-11-15', checkOut: '2026-11-17', adults: 2, rooms: 1, childrenAges: [],
  propertyTypes: [], minReviewScore: 0, currency: 'USD', language: 'en-us',
  maxResults: 25, collectedCount: 0, examinedCount: 0, seenIds: [], offset: 0, pageSize: 25,
  hasMore: true, maxPages: 2, coverage: { status: 'pending', successfulPages: 0, reason: null },
});

type Context = Parameters<PlaywrightRequestHandler>[0];
function contextFor(state: SearchState, sessionId?: string): Context {
  return { request: { noRetry: false, userData: { state } },
    session: sessionId ? { id: sessionId, setCookies: () => {} } : undefined,
    page: { url: () => buildSearchUrl(state) }, browserController: { getCookies: async () => [] },
  } as unknown as Context;
}

test('active search rejects a changed session before navigation, without exposing either identity', async () => {
  const state = stateFor('unit-session-change'); state.collectedCount = 15;
  assertBookingSession(contextFor(state, 'private-first-identity'));
  const next = contextFor({ ...state }, 'private-second-identity');
  await assert.rejects(async () => bookingSessionPreNavigation(next, {}), error => {
    assert.match(String(error), /browser_session_changed/);
    assert.doesNotMatch(String(error), /private-first|private-second/); return true;
  });
  assert.equal(next.request.noRetry, true); assert.equal(state.hasMore, false);
  assert.equal(state.collectedCount, 15); assert.equal(state.coverage?.reason, 'browser_session_changed');
});

test('missing session stops without calling the collector or cookie APIs', async () => {
  const state = stateFor('unit-session-missing'); let calls = 0;
  const handler = withBookingSessionCookies(async () => { calls++; });
  const context = contextFor(state);
  await assert.rejects(async () => handler(context), /browser_session_missing/);
  assert.equal(calls, 0); assert.equal(context.request.noRetry, true);
});

test('cookies are read after the collector; a failed checkpoint retains saved progress and prevents continuation', async () => {
  const state = stateFor('unit-cookie-failure'); const calls: string[] = [];
  const context = contextFor(state, 'offline-identity');
  context.browserController.getCookies = async () => { calls.push('cookies'); throw new Error('private-cookie-detail'); };
  const handler = withBookingSessionCookies(async () => { calls.push('collector'); state.collectedCount = 15; });
  await assert.rejects(async () => handler(context), error => {
    assert.match(String(error), /browser_cookie_checkpoint_failed/);
    assert.doesNotMatch(String(error), /private-cookie-detail/); return true;
  });
  assert.deepEqual(calls, ['collector', 'cookies']); assert.equal(state.collectedCount, 15);
  assert.equal(context.request.noRetry, true); assert.equal(state.hasMore, false);
  const queued = contextFor({ ...state }, 'offline-identity');
  await assert.rejects(async () => bookingSessionPreNavigation(queued, {}), /browser_cookie_checkpoint_failed/);
  assert.equal(queued.request.noRetry, true); assert.deepEqual(calls, ['collector', 'cookies']);
});

test('collector denial does not save challenge cookies or alter the access failure', async () => {
  const state = stateFor('unit-denied-handler'); const context = contextFor(state, 'offline-denied'); let cookies = 0;
  context.browserController.getCookies = async () => { cookies++; return []; };
  const denied = new Error('BOOKING_BLOCKED');
  const handler = withBookingSessionCookies(async () => { state.coverage!.reason = 'source_access_blocked'; throw denied; });
  await assert.rejects(async () => handler(context), error => error === denied);
  assert.equal(cookies, 0); assert.equal(state.coverage?.reason, 'source_access_blocked');
  await assert.rejects(async () => bookingSessionPreNavigation(contextFor({ ...state }, 'new-identity'), {}), /BOOKING_BLOCKED/);
  assert.equal(cookies, 0);
});

function pageFixture(offset: number): string {
  return '<html><body><h1>London: 100 properties found</h1>'
    + '<input name="ss" value="London, United Kingdom"><input name="checkin" value="2026-11-15"><input name="checkout" value="2026-11-17">'
    + '<input name="group_adults" value="2"><input name="group_children" value="0"><input name="no_rooms" value="1">'
    + '<button data-testid="header-currency-picker-trigger">USD</button>'
    + Array.from({ length: 15 }, (_, i) => `<div data-testid="property-card" style="height:130px">`
      + `<a data-testid="title-link" href="https://www.booking.com/hotel/gb/session-fixture-${offset + i}.html"><div data-testid="title">Hotel ${offset + i}</div></a>`
      + `<span data-testid="price-and-discounted-price">US$${100 + i}</span><span data-testid="taxes-and-charges">Includes taxes and charges</span></div>`).join('')
    + '<script>document.cookie="early_fixture=retained; path=/"</script></body></html>';
}

// Both controls are fully intercepted, not requests to Booking or a proxy.
// The early cookie is captured by Crawlee; the late cookie is set only after
// the collector. Both must accompany the next document before it is served.
for (const scenario of ['previous-pool', 'without-late-checkpoint', 'production-repair'] as const) {
  test(`real Crawlee 15→25 pagination with cookie continuity: ${scenario}`, async () => {
    const originalPush = Actor.pushData, saved: HotelRecord[] = [], events: string[] = [];
    const offsets: number[] = [], sessions: string[] = [], failures: number[] = [];
    const nextCookies: Array<{ early: boolean; late: boolean }> = [];
    const state = stateFor('session-paging-' + scenario);
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    const collect: PlaywrightRequestHandler = async context => {
      sessions.push(context.session!.id);
      await router(context);
      await context.page.evaluate(() => { document.cookie = 'late_fixture=retained; path=/'; });
    };
    const repaired = scenario === 'production-repair';
    const crawler = new PlaywrightCrawler({
      ...bookingBrowserSessions,
      ...(scenario === 'previous-pool' ? { sessionPoolOptions: { maxPoolSize: 10, sessionOptions: { maxUsageCount: 10 } } } : {}),
      launchContext: { ...bookingBrowserContext, launchOptions: { headless: true } }, browserPoolOptions: bookingBrowserPool,
      maxConcurrency: 1, maxRequestRetries: 0, maxSessionRotations: 0, retryOnBlocked: false,
      // Production allows 150 s; the first rendered-continuation wait is 35 s
      // because live Booking hydrates its list about 10-20 s after first cards.
      navigationTimeoutSecs: 30, requestHandlerTimeoutSecs: 60,
      preNavigationHooks: [
        ...(repaired ? [bookingSessionPreNavigation] : []),
        (async ({ page }, options) => {
          Object.assign(options, bookingNavigationOptions());
          await page.route('**/*', async route => {
            if (route.request().resourceType() !== 'document') { await route.abort(); return; }
            const offset = Number(new URL(route.request().url()).searchParams.get('offset')); offsets.push(offset);
            if (offset) {
              const cookie = (await route.request().allHeaders()).cookie ?? '';
              const present = { early: cookie.includes('early_fixture=retained'), late: cookie.includes('late_fixture=retained') };
              nextCookies.push(present);
              if (!present.early || !present.late) {
                await route.fulfill({ status: 403, contentType: 'text/html', body: '<body>Access denied</body>' }); return;
              }
            }
            await route.fulfill({ contentType: 'text/html', body: pageFixture(offset) });
          });
        }) satisfies PlaywrightHook,
      ],
      postNavigationHooks: [bookingPostNavigation],
      requestHandler: repaired ? withBookingSessionCookies(collect) : collect,
      failedRequestHandler: async ({ response }) => { failures.push(response?.status() ?? 0); },
    }, new Configuration({ persistStorage: false, purgeOnStart: false,
      storageClient: new MemoryStorage({ persistStorage: false, localDataDirectory: join(tmpdir(), 'booking-offline-' + randomUUID()) }) }));
    try {
      await crawler.run([{ url: buildSearchUrl(state), uniqueKey: state.requestNamespace, label: 'search', userData: { state } }]);
      assert.deepEqual(offsets, [0, 15]); assert.equal(nextCookies.length, 1);
      assert.equal(saved.length, repaired ? 25 : 15); assert.equal(events.length, saved.length);
      assert.equal(new Set(saved.map(row => row.propertyId)).size, saved.length);
      assert.ok(events.every(event => event === 'hotel-scraped'));
      assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified && row.rateEvidence.currencyStatus === 'confirmed'));
      if (repaired) {
        assert.deepEqual(failures, []); assert.deepEqual(nextCookies, [{ early: true, late: true }]);
        assert.equal(sessions.length, 2); assert.equal(sessions[0] === sessions[1], true);
        assert.equal(restoreSearchState(state).collectedCount, 25);
      } else {
        assert.deepEqual(failures, [403]);
        assert.deepEqual(nextCookies, [{ early: scenario !== 'previous-pool', late: false }]);
        assert.equal(restoreSearchState(state).coverage?.reason, 'source_access_blocked');
      }
    } finally { Actor.pushData = originalPush; await crawler.browserPool.destroy(); }
  });
}

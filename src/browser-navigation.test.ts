import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from 'apify';
import { Configuration, PlaywrightCrawler } from 'crawlee';
import { MemoryStorage } from '@crawlee/memory-storage';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { bookingPostNavigation } from './browser-navigation.js';
import { bookingBrowserContext, bookingBrowserPool } from './browser-lifecycle.js';
import { bookingBrowserSessions, bookingSessionPreNavigation, withBookingSessionCookies } from './browser-session.js';
import { bookingNavigationOptions, waitForBookingDocument } from './navigation.js';
import { browserFailureDiagnostic, attachPageDiagnostics } from './page-diagnostics.js';
import { router, buildSearchUrl } from './routes.js';
import type { HotelRecord, SearchState } from './types.js';
import { chromium } from 'playwright';

const searchState = (name: string): SearchState => ({
  destination: 'London, United Kingdom', requestNamespace: name,
  checkIn: '2026-11-15', checkOut: '2026-11-17', adults: 2, rooms: 1, childrenAges: [],
  propertyTypes: [], minReviewScore: 0, currency: 'USD', language: 'en-us',
  maxResults: 25, collectedCount: 0, examinedCount: 0, seenIds: [], offset: 0, pageSize: 25,
  hasMore: true, maxPages: 2, coverage: { status: 'pending', successfulPages: 0, reason: null },
});
const fixture = '<html><head><script defer src="https://www.booking.com/offline-deferred.js"></script></head><body>'
  + '<input name="ss" value="London, United Kingdom"><input name="checkin" value="2026-11-15"><input name="checkout" value="2026-11-17">'
  + '<input name="group_adults" value="2"><input name="group_children" value="0"><input name="no_rooms" value="1">'
  + '<button data-testid="header-currency-picker-trigger">USD</button>'
  + Array.from({ length: 25 }, (_, i) => `<div data-testid="property-card" style="height:130px">`
    + `<a data-testid="title-link" href="https://www.booking.com/hotel/gb/fixture-${i}.html"><div data-testid="title">Hotel ${i}</div></a>`
    + `<span data-testid="price-and-discounted-price">US$${100 + i}</span><span data-testid="taxes-and-charges">Includes taxes and charges</span></div>`).join('')
  + '<script>document.cookie="offline_session=retained; path=/"</script></body></html>';

test('real Crawlee pipeline uses the headless shell and saves two exact 25-hotel batches with a stalled DOM event and retained cookies', async () => {
  const originalPush = Actor.pushData, saved: HotelRecord[] = [], events: string[] = [];
  let release!: () => void, documents = 0, scripts = 0, completedHandlers = 0, failures = 0;
  const scriptRelease = new Promise<void>(resolve => { release = resolve; });
  const pendingScripts: Promise<void>[] = [];
  Actor.pushData = (async (record: HotelRecord, event: string) => {
    saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
  }) as unknown as typeof Actor.pushData;
  const crawler = new PlaywrightCrawler({
    launchContext: { ...bookingBrowserContext, launchOptions: { headless: true, executablePath: '/invalid-image-browser' } },
    browserPoolOptions: bookingBrowserPool,
    ...bookingBrowserSessions,
    maxConcurrency: 1, maxRequestRetries: 0, maxSessionRotations: 0, retryOnBlocked: false,
    navigationTimeoutSecs: 30, requestHandlerTimeoutSecs: 30,
    preNavigationHooks: [bookingSessionPreNavigation, async ({ page }, options) => {
      attachPageDiagnostics(page); Object.assign(options, bookingNavigationOptions());
      await page.route('**/*', route => {
        if (route.request().resourceType() === 'script') {
          scripts++;
          pendingScripts.push(scriptRelease.then(() => route.fulfill({ contentType: 'text/javascript', body: '' })).catch(() => {}));
          return;
        }
        assert.equal(route.request().resourceType(), 'document'); documents++;
        return route.fulfill({ contentType: 'text/html', body: fixture });
      });
    }],
    postNavigationHooks: [bookingPostNavigation],
    requestHandler: withBookingSessionCookies(async context => {
      assert.equal(await context.page.evaluate(() => document.readyState), 'interactive');
      assert.equal((await context.page.context().cookies()).find(cookie => cookie.name === 'offline_session')?.value, 'retained');
      if (completedHandlers) assert.equal(context.session?.getCookieString(context.request.url).includes('offline_session=retained'), true,
        'post-navigation readiness must precede Crawlee cookie persistence');
      await router(context); completedHandlers++;
    }),
    failedRequestHandler: async () => { failures++; },
  }, new Configuration({ persistStorage: false, purgeOnStart: false,
    storageClient: new MemoryStorage({ persistStorage: false, localDataDirectory: join(tmpdir(), 'booking-offline-' + randomUUID()) }) }));
  try {
    await crawler.run(['baseline', 'repeat'].map(name => {
      const state = searchState('native-' + name);
      return { url: buildSearchUrl(state), uniqueKey: name, label: 'search', userData: { state } };
    }));
    assert.equal(failures, 0); assert.equal(completedHandlers, 2); assert.equal(documents, 2); assert.equal(scripts, 2);
    assert.equal(saved.length, 50); assert.equal(events.length, 50);
    assert.ok(events.every(event => event === 'hotel-scraped'));
    assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified && row.rateEvidence.currencyStatus === 'confirmed'));
    for (const batch of [saved.slice(0, 25), saved.slice(25)]) assert.equal(new Set(batch.map(row => row.propertyId)).size, 25);
  } finally { release(); await Promise.allSettled(pendingScripts); Actor.pushData = originalPush; await crawler.browserPool.destroy(); }
});

test('HTTP access denials stop before document waits or collection, preserving saved progress', async () => {
  for (const status of [401, 403, 429]) {
    const state = searchState('http-denial-' + status); state.collectedCount = 5;
    const request = { noRetry: false, userData: { state } };
    let waits = 0;
    await assert.rejects(async () => bookingPostNavigation({
      response: { status: () => status }, request,
      page: { waitForFunction: async () => { waits++; } },
    } as unknown as Parameters<typeof bookingPostNavigation>[0], {}), /BOOKING_BLOCKED/);
    assert.equal(waits, 0); assert.equal(request.noRetry, true); assert.equal(state.collectedCount, 5);
    assert.equal(state.coverage?.reason, 'source_access_blocked');
  }
});

test('no document response and a still-loading empty shell remain failures with bounded diagnostics', async () => {
  const browser = await chromium.launch({ headless: true });
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const pending: Promise<unknown>[] = [];
  try {
    const page = await browser.newPage(); attachPageDiagnostics(page);
    await page.route('**/*', route => { pending.push(released.then(() => route.abort()).catch(() => {})); });
    await assert.rejects(page.goto(buildSearchUrl(searchState('no-response')), { ...bookingNavigationOptions(), timeout: 150 }), /Timeout/);
    const failed = await browserFailureDiagnostic(page);
    assert.equal(failed.documentReceived, false); assert.equal(failed.propertyCards ?? 0, 0);
    // A parser-blocking script keeps this document in loading state without any
    // hotel/terminal content. Commit must not turn it into a successful search.
    const empty = await browser.newPage(); attachPageDiagnostics(empty);
    await empty.route('**/*', route => {
      if (route.request().resourceType() === 'script') {
        pending.push(released.then(() => route.abort()).catch(() => {})); return;
      }
      return route.fulfill({ contentType: 'text/html', body: '<html><body><script src="https://www.booking.com/offline-pending.js"></script>' });
    });
    await empty.goto(buildSearchUrl(searchState('empty-loading')), bookingNavigationOptions());
    await assert.rejects(waitForBookingDocument(empty, 200), /Timeout/);
    const emptyDiagnostic = await browserFailureDiagnostic(empty);
    assert.equal(emptyDiagnostic.documentReceived, true); assert.equal(emptyDiagnostic.documentStatus, 200);
    assert.equal(emptyDiagnostic.readyState, 'loading'); assert.equal(emptyDiagnostic.propertyCards, 0);
  } finally { release(); await Promise.allSettled(pending); await browser.close(); }
});

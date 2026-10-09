import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from 'apify';
import { chromium } from 'playwright';
import { router, buildSearchUrl } from './routes.js';
import { emptyMonitor, prepareRateChange } from './monitor.js';
import type { HotelRecord, SearchState } from './types.js';

const stateFor = (name: string, maxResults: number): SearchState => ({
  destination: 'London, United Kingdom', requestNamespace: name,
  searchUrl: 'https://www.booking.com/searchresults.en-gb.html?ss=London%2C+Greater+London%2C+United+Kingdom&dest_id=-2601889&dest_type=city&checkin=2026-11-15&checkout=2026-11-17&group_adults=2&no_rooms=1&group_children=0&selected_currency=GBP&lang=en-gb',
  checkIn: '2026-11-15', checkOut: '2026-11-17', adults: 2, rooms: 1, childrenAges: [],
  propertyTypes: [], minReviewScore: 0, currency: 'GBP', language: 'en-gb',
  maxResults, collectedCount: 0, examinedCount: 0, seenIds: [], offset: 0, pageSize: 25,
  hasMore: true, maxPages: 4, coverage: { status: 'pending', successfulPages: 0, reason: null },
});

function fixtureHtml(offset: number, options: { destinationInput?: string; cardParameters?: Record<string, string>;
  datesLabel?: string; occupancyLabel?: string; currency?: string } = {}): string {
  const parameters = new URLSearchParams({ checkin: '2026-11-15', checkout: '2026-11-17',
    group_adults: '2', no_rooms: '1', group_children: '0', dest_id: '-2601889', dest_type: 'city', ...options.cardParameters });
  for (const [key, value] of [...parameters]) if (!value) parameters.delete(key);
  const card = (index: number) => '<div data-testid="property-card" style="height:150px"><div data-testid="property-card-container">'
    + `<a data-testid="title-link" href="https://www.booking.com/hotel/gb/offline-${index}.en-gb.html?${parameters.toString().replaceAll('&', '&amp;')}"><div data-testid="title">Offline hotel ${index}</div></a>`
    + `<span data-testid="price-and-discounted-price">£${219 + index}</span><span data-testid="price-for-x-nights">2 nights, 2 adults</span>`
    + '<span data-testid="taxes-and-charges">Includes taxes and charges</span></div></div>';
  return '<h1>London: 6,754 properties found</h1>' + (options.destinationInput ?? '<input name="ss" value="London">')
    + `<button data-testid="searchbox-dates-container">${options.datesLabel ?? 'Sun 15 Nov — Tue 17 Nov'}</button>`
    + `<button data-testid="occupancy-config" aria-label="Number of travellers and rooms. Currently selected: ${options.occupancyLabel ?? '2 adults · 0 children · 1 room'}"></button>`
    + `<button data-testid="header-currency-picker-trigger">${options.currency ?? 'GBP'}</button>`
    + Array.from({ length: 15 }, (_, index) => card(offset + index)).join('')
    + '<script>addEventListener("scroll",()=>{if(!document.getElementById("loaded")){const extra=document.createElement("div");extra.id="loaded";extra.innerHTML='
    + JSON.stringify(Array.from({ length: 15 }, (_, index) => card(offset + 15 + index)).join('')) + ';document.body.append(extra);}});</script>';
}

test('unresolved destination with read-only or hidden controls still collects 25 priced rows without form edits or false alerts', async () => {
  const browser = await chromium.launch({ headless: true });
  const originalPush = Actor.pushData;
  try {
    const page = await browser.newPage();
    let visits = 0;
    const options = { destinationInput: '<input name="ss" value="London" readonly aria-label="Search in your own words">'
      + '<input name="ss" value="London" hidden><button type="submit">Search</button>',
      cardParameters: { dest_id: '', dest_type: '' } };
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      visits++;
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0, options) });
    });
    const state = { ...stateFor('offline-readonly-collector', 25), searchUrl: undefined };
    const requestedUrl = buildSearchUrl(state);
    await page.goto(requestedUrl);
    await page.evaluate(() => {
      document.documentElement.dataset.formEdits = '0';
      for (const event of ['input', 'change', 'submit']) document.addEventListener(event, () => {
        document.documentElement.dataset.formEdits = String(Number(document.documentElement.dataset.formEdits) + 1);
      });
    });
    const saved: HotelRecord[] = [], events: string[] = [];
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    await router({ page, request: { url: requestedUrl, label: 'search', userData: { state } },
      log: { info: () => {}, debug: () => {}, warning: () => {} },
      crawler: { addRequests: async () => { throw new Error('No extra navigation is allowed'); } },
    } as unknown as Parameters<typeof router>[0]);
    assert.equal(saved.length, 25);
    assert.equal(new Set(saved.map(row => row.propertyId)).size, 25);
    assert.equal(events.length, 25);
    assert.ok(events.every(event => event === 'hotel-scraped'));
    assert.ok(saved.every(row => row.totalPrice !== null && row.totalPrice > 0
      && row.rateEvidence?.searchContextVerified === false
      && row.rateEvidence.comparisonWarnings.includes('search_context_not_verified')));
    assert.equal(visits, 1);
    assert.equal(state.searchUrl, undefined);
    assert.equal(page.url(), requestedUrl);
    assert.equal(await page.evaluate(() => document.documentElement.dataset.formEdits), '0');
    const history = emptyMonitor(), monitor = { monitorName: 'offline-readonly', market: 'US', threshold: 5, historyLimit: 3 };
    for (const record of saved) {
      const first = prepareRateChange(record, history, monitor); first.commit();
      const repeat = prepareRateChange({ ...record, totalPrice: record.totalPrice! / 2,
        scrapedAt: '2026-10-10T12:00:00Z' }, history, monitor).record.rateChange!;
      assert.equal(repeat.status, 'not_comparable');
      assert.equal(repeat.alert, false);
      assert.equal(repeat.priceChangePercent, null);
      assert.equal(repeat.observations.length, 2);
    }
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector rejects rendered date, guest, location and currency contradictions before saving or billing', async () => {
  const browser = await chromium.launch({ headless: true });
  const originalPush = Actor.pushData;
  let saved = 0;
  Actor.pushData = (async () => { saved++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const cases: Parameters<typeof fixtureHtml>[1][] = [
      { datesLabel: 'Sun 15 November 2027 — Tue 17 November 2027' },
      { occupancyLabel: '3 adults · 0 children · 1 room' },
      { destinationInput: '<input name="ss" value="Paris, France" readonly>' },
      { destinationInput: '<input name="ss" value="London, Canada" readonly>' },
      { currency: 'USD' },
      { cardParameters: { checkin: '2027-11-15' } },
      { cardParameters: { dest_id: '-2140479' } },
      { cardParameters: { dest_type: 'airport' } },
    ];
    for (const [index, options] of cases.entries()) {
      const page = await browser.newPage();
      await page.route('**/*', route => route.request().resourceType() === 'document'
        ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0, options) }) : route.abort());
      const state = stateFor(`offline-mismatched-collector-${index}`, 25);
      const request = { url: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
      await page.goto(request.url);
      await assert.rejects(async () => await router({ page, request,
        log: { info: () => {}, debug: () => {}, warning: () => {} }, crawler: {},
      } as unknown as Parameters<typeof router>[0]), /BOOKING_RENDERED_SEARCH_MISMATCH/, JSON.stringify(options));
      assert.equal(request.noRetry, true);
      assert.equal(state.collectedCount, 0);
      await page.close();
    }
    assert.equal(saved, 0);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector restores the observed city redirect once and saves 25 verified priced hotels', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  const saved: HotelRecord[] = [], events: string[] = [];
  try {
    const page = await browser.newPage(), state = stateFor('offline-city-redirect', 25);
    const request = { url: buildSearchUrl(state), label: 'search', userData: { state, bookingSearchShellRestoreAttempted: false }, noRetry: false };
    let searchVisits = 0, cityVisits = 0;
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      const url = new URL(route.request().url());
      if (url.pathname.startsWith('/city/')) {
        cityVisits++;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>London city information</h1>' });
      }
      assert.equal(route.request().url(), request.url, 'restoration must keep the exact approved stay and filters');
      assert.equal(++searchVisits, 1, 'only one search restoration is permitted');
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(0) });
    });
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    // Start at the already-observed landing state. Its captured request does
    // not establish whether Booking used a server or client-side redirect.
    await page.goto('https://www.booking.com/city/gb/london.en-gb.html');
    assert.equal(page.url(), 'https://www.booking.com/city/gb/london.en-gb.html');
    await router({ page, request, log: { info: () => {}, debug: () => {}, warning: () => {} },
      crawler: { addRequests: async () => { throw Error('No extra search may be queued'); } },
    } as unknown as Parameters<typeof router>[0]);
    assert.equal(searchVisits, 1); assert.equal(cityVisits, 1);
    assert.equal(request.userData.bookingSearchShellRestoreAttempted, true);
    assert.equal(page.url(), request.url);
    assert.equal(saved.length, 25); assert.equal(new Set(saved.map(row => row.propertyId)).size, 25);
    assert.deepEqual(events, Array(25).fill('hotel-scraped'));
    assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified === true
      && row.rateEvidence.taxStatus === 'included' && row.totalPrice !== null && row.totalPrice > 0));
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('actual browser collector never saves or bills a persistent city redirect and does not restore again on retry', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let restorations = 0, cityVisits = 0, billed = 0;
  Actor.pushData = (async () => { billed++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('offline-persistent-city', 25);
    const request = { url: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
    await page.route('**/*', route => {
      if (route.request().resourceType() !== 'document') return route.abort();
      if (new URL(route.request().url()).pathname.startsWith('/city/')) {
        cityVisits++;
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>London city information</h1>' });
      }
      throw Error('The persistent-landing transport never fetches another source');
    });
    await page.goto('https://www.booking.com/city/gb/london.en-gb.html');
    // Model the recorded final URL with an intercepted real document, without
    // letting a fixture's HTTP redirect chain reach the external website.
    const navigate = page.goto.bind(page);
    page.goto = async (url, options) => {
      assert.equal(url, request.url, 'attempt only the original search, not an invented destination');
      assert.equal(++restorations, 1, 'persistent redirect must stop, not loop');
      return navigate('https://www.booking.com/city/gb/london.en-gb.html', options);
    };
    const collect = async () => await router({ page, request, log: { info: () => {}, debug: () => {}, warning: () => {} }, crawler: {},
    } as unknown as Parameters<typeof router>[0]);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(request.noRetry, true);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(restorations, 1); assert.equal(cityVisits, 2);
    assert.equal(billed, 0); assert.equal(state.collectedCount, 0);
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

test('a failed browser restoration preserves 20 prior HTTP hotels and diagnoses the current route, not stale loadedUrl', async () => {
  const browser = await chromium.launch({ headless: true }), originalPush = Actor.pushData;
  let restorations = 0, newCharges = 0;
  const warnings: Array<{ message: string; details: unknown }> = [];
  Actor.pushData = (async () => { newCharges++; return { chargedCount: 1, eventChargeLimitReached: false }; }) as unknown as typeof Actor.pushData;
  try {
    const page = await browser.newPage(), state = stateFor('offline-partial-city-failure', 25);
    state.collectedCount = 20;
    state.examinedCount = 20;
    state.seenIds = Array.from({ length: 20 }, (_, index) => `http-${index}`);
    state.coverage!.successfulPages = 1;
    const before = structuredClone(state);
    const request = { url: buildSearchUrl(state), loadedUrl: buildSearchUrl(state), label: 'search', userData: { state }, noRetry: false };
    const landing = 'https://www.booking.com/city/gb/london.en-gb.html?label=private-tracking';
    await page.route('**/*', route => route.request().resourceType() === 'document'
      ? route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(20) }) : route.abort());
    await page.goto(landing);
    const navigate = page.goto.bind(page);
    page.goto = async (url, options) => {
      assert.equal(url, request.url);
      assert.equal(++restorations, 1);
      return navigate(landing, options);
    };
    const collect = async () => await router({ page, request,
      log: { info: () => {}, debug: () => {}, warning: (message: string, details: unknown) => { warnings.push({ message, details }); } },
      crawler: {},
    } as unknown as Parameters<typeof router>[0]);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    await assert.rejects(collect(), /BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE/);
    assert.equal(request.noRetry, true);
    assert.equal(restorations, 1);
    assert.equal(newCharges, 0, 'never save or bill redirected cards or previously saved HTTP rows');
    assert.deepEqual(state, before, 'retain all prior counts, IDs and coverage without inventing completion');
    assert.equal(request.loadedUrl, request.url, 'persisted initial URL is not the current page after restoration');
    assert.equal(warnings.length, 2);
    for (const { details } of warnings) {
      assert.deepEqual(details, { routeKind: 'city_landing',
        missingFields: ['ss', 'dest_id', 'checkin', 'checkout', 'group_adults', 'no_rooms', 'group_children', 'age', 'selected_currency'],
        restorationAttempted: true, retainedHotels: 20 });
      assert.equal(/private-tracking|london|2026-11|2601889|booking\.com/i.test(JSON.stringify(details)), false);
    }
  } finally { Actor.pushData = originalPush; await browser.close(); }
});

for (const limit of [25, 50]) {
  test(`actual browser collector saves exactly ${limit} unique, verified rows across lazy-loaded batches`, async () => {
    const browser = await chromium.launch({ headless: true });
    const saved: HotelRecord[] = [];
    const chargedEvents: string[] = [];
    const originalPush = Actor.pushData;
    Actor.pushData = (async (record: HotelRecord, event: string) => {
      saved.push(record); chargedEvents.push(event);
      return { chargedCount: 1, eventChargeLimitReached: false };
    }) as unknown as typeof Actor.pushData;
    try {
      const page = await browser.newPage();
      await page.route('**/*', route => {
        if (route.request().resourceType() !== 'document') return route.abort();
        const offset = Number(new URL(route.request().url()).searchParams.get('offset') ?? '0');
        return route.fulfill({ contentType: 'text/html; charset=utf-8', body: fixtureHtml(offset) });
      });
      const state = stateFor(`offline-collector-${limit}`, limit);
      const pending: Array<{ url: string; userData: { state: SearchState } }> = [{ url: buildSearchUrl(state), userData: { state } }];
      let visits = 0;
      while (pending.length) {
        const request = pending.shift()!;
        await page.goto(request.url);
        visits++;
        assert.ok(visits <= 2, 'bounded test must not issue extra requests');
        await router({ page, request: { ...request, label: 'search' },
          log: { info: () => {}, debug: () => {}, warning: () => {} },
          crawler: { addRequests: async (requests: typeof pending) => { pending.push(...requests); } },
        } as unknown as Parameters<typeof router>[0]);
      }
      assert.equal(saved.length, limit);
      assert.equal(new Set(saved.map(record => record.propertyId)).size, limit);
      assert.equal(state.collectedCount, limit);
      assert.equal(state.coverage?.reason, 'max_results');
      assert.equal(visits, limit === 25 ? 1 : 2);
      assert.ok(chargedEvents.every(event => event === 'hotel-scraped'));
      assert.ok(saved.every(record => record.rateEvidence?.searchContextVerified === true
        && record.rateEvidence.taxStatus === 'included' && record.rateEvidence.currencyStatus === 'confirmed'
        && record.checkIn === '2026-11-15' && record.checkOut === '2026-11-17'
        && record.totalPrice !== null && record.totalPrice > 0));
    } finally { Actor.pushData = originalPush; await browser.close(); }
  });
}

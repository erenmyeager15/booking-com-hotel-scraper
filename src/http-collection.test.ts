import test from 'node:test';
import assert from 'node:assert/strict';
import { Actor } from 'apify';
import { CheerioCrawler, type CheerioCrawlingContext } from 'crawlee';
import { load } from 'cheerio';
import { runHttpFastPath, type SearchRequest } from './http-fast-path.js';
import { buildSearchUrl } from './routes.js';
import type { HotelRecord, SearchState } from './types.js';

let sequence = 0;
const stateFor = (): SearchState => ({
  destination: 'London, United Kingdom', requestNamespace: `offline-http-${sequence++}`,
  checkIn: '2026-11-15', checkOut: '2026-11-17', adults: 2, rooms: 1, childrenAges: [],
  currency: 'GBP', language: 'en-gb', propertyTypes: [], minReviewScore: 0,
  maxResults: 25, pageSize: 25, offset: 0, collectedCount: 0, examinedCount: 0,
  seenIds: [], hasMore: true, maxPages: 2,
  coverage: { status: 'pending', successfulPages: 0, reason: null },
});
const fullForm = '<input name="ss" value="London, United Kingdom"><input name="checkin" value="2026-11-15">'
  + '<input name="checkout" value="2026-11-17"><input name="group_adults" value="2">'
  + '<input name="group_children" value="0"><input name="no_rooms" value="1">';

function fixture(count = 25, form = '<input name="ss" value="London" readonly>', startIndex = 0): string {
  return `<h1>London: 100 properties found</h1>${form}`
    + '<button data-testid="header-currency-picker-trigger">GBP</button>'
    + Array.from({ length: count }, (_, itemIndex) => {
      const index = startIndex + itemIndex;
      return '<div data-testid="property-card"><div data-testid="property-card-container">'
      + `<a data-testid="title-link" href="/hotel/gb/http-${index}.html?checkin=2026-11-15&amp;checkout=2026-11-17&amp;group_adults=2&amp;group_children=0&amp;no_rooms=1">`
      + `<span data-testid="title">HTTP hotel ${index}</span></a><span data-testid="price-and-discounted-price">GBP ${200 + index}</span>`
      + '<span data-testid="taxes-and-charges">Includes taxes and charges</span></div></div>';
    }).join('');
}

/** Drive the real HTTP request handler with an offline DOM. Replacing only run()
 * prevents any network, proxy, SDK storage or crawler request-queue operations. */
async function collect(html: string | ((request: SearchRequest) => string), state = stateFor(), loadedUrl?: string) {
  const originalRun = CheerioCrawler.prototype.run, originalPush = Actor.pushData;
  const saved: HotelRecord[] = [], events: string[] = [];
  const requestedUrls: string[] = [];
  let visits = 0;
  CheerioCrawler.prototype.run = (async function (this: CheerioCrawler, requests: SearchRequest[]) {
    const handler = (this as unknown as { requestHandler: (context: CheerioCrawlingContext) => Promise<void> }).requestHandler;
    const pending = [...requests];
    while (pending.length) {
      const request = pending.shift()!;
      assert.ok(++visits <= 2, 'offline handler must not issue an unbounded request sequence');
      requestedUrls.push(request.url);
      await handler({ $: load(typeof html === 'function' ? html(request) : html),
        request: { ...request, loadedUrl: loadedUrl ?? request.url },
        log: { info: () => {}, warning: () => {}, debug: () => {} },
        crawler: { addRequests: async (next: SearchRequest[]) => { pending.push(...next); } },
      } as unknown as CheerioCrawlingContext);
    }
    return {};
  }) as unknown as typeof originalRun;
  Actor.pushData = (async (record: HotelRecord, event: string) => {
    saved.push(record); events.push(event); return { chargedCount: 1, eventChargeLimitReached: false };
  }) as unknown as typeof originalPush;
  try {
    const result = await runHttpFastPath([{ url: buildSearchUrl(state), uniqueKey: state.requestNamespace!,
      label: 'search', userData: { state } }], undefined);
    return { result, saved, events, state, visits, requestedUrls };
  } finally { CheerioCrawler.prototype.run = originalRun; Actor.pushData = originalPush; }
}

test('real HTTP fast path saves 25 priced rows without unnecessary browser fallback for an unverified form', async () => {
  const { result, saved, events, visits } = await collect(fixture());
  assert.equal(saved.length, 25, JSON.stringify(result));
  assert.equal(new Set(saved.map(row => row.propertyId)).size, 25);
  assert.equal(result.chargedHotelCount, 25);
  assert.equal(result.fallbackRequests.length, 0);
  assert.equal(result.noResultDestinationCount, 0);
  assert.equal(visits, 1);
  assert.deepEqual(events, Array(25).fill('hotel-scraped'));
  assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified === false
    && row.rateEvidence.currencyStatus === 'confirmed' && row.rateEvidence.taxStatus === 'included'
    && row.totalPrice !== null && row.totalPrice > 0));
});

test('real HTTP fast path retains verified form evidence for ordinary collection', async () => {
  const { result, saved } = await collect(fixture(25, fullForm));
  assert.equal(result.fallbackRequests.length, 0);
  assert.equal(saved.length, 25, JSON.stringify(result));
  assert.ok(saved.every(row => row.rateEvidence?.searchContextVerified === true));
});

test('real HTTP fast path never saves or bills cards with explicit rendered or URL contradictions', async () => {
  for (const html of [fixture(25, fullForm.replace('2026-11-15', '2027-11-15')),
    fixture(25, fullForm.replace('name="group_adults" value="2"', 'name="group_adults" value="3"')),
    fixture(25, fullForm.replace('London, United Kingdom', 'Paris, France')),
    fixture().replace('>GBP</button>', '>USD</button>')]) {
    const { result, saved, events } = await collect(html);
    assert.equal(saved.length, 0); assert.equal(events.length, 0);
    assert.equal(result.fallbackRequests.length, 1);
    assert.equal(result.noResultDestinationCount, 0);
  }
  const state = stateFor(), wrongUrl = buildSearchUrl(state).replace('www.booking.com', 'example.com');
  const { result, saved } = await collect(fixture(25, fullForm), state, wrongUrl);
  assert.equal(saved.length, 0); assert.equal(result.fallbackRequests.length, 1);
});

test('unknown empty search falls back rather than inventing genuine no availability', async () => {
  const { result, saved, events, state } = await collect('<h1>No properties found</h1><input name="ss" value="London" readonly>');
  assert.equal(saved.length, 0); assert.equal(events.length, 0);
  assert.equal(result.fallbackRequests.length, 1);
  assert.equal(result.noResultDestinationCount, 0);
  assert.equal(state.coverage?.status, 'pending');
});

test('positive source evidence can establish a genuine empty search without a browser', async () => {
  const { result, saved, state } = await collect(`<h1>No properties found</h1>${fullForm}`);
  assert.equal(saved.length, 0); assert.equal(result.fallbackRequests.length, 0);
  assert.equal(result.noResultDestinationCount, 1);
  assert.equal(state.coverage?.status, 'empty');
});

test('foreign property links are never saved or billed as Booking hotels', async () => {
  const { result, saved, events } = await collect(fixture().replaceAll('/hotel/gb/http-', 'https://example.com/hotel/gb/http-'));
  assert.equal(saved.length, 0); assert.equal(events.length, 0);
  assert.equal(result.fallbackRequests.length, 1);
});

test('HTTP short lazy batch continues from its actual card count and fills 25 without double billing', async () => {
  const collected = await collect(request => {
    const offset = Number(new URL(request.url).searchParams.get('offset') ?? 0);
    return offset === 0 ? fixture(20) : fixture(25, undefined, offset);
  });
  assert.equal(collected.saved.length, 25, JSON.stringify(collected.result));
  assert.equal(new Set(collected.saved.map(row => row.propertyId)).size, 25);
  assert.equal(collected.events.length, 25);
  assert.equal(collected.result.fallbackRequests.length, 0);
  assert.equal(collected.visits, 2);
  assert.deepEqual(collected.requestedUrls.map(url => new URL(url).searchParams.get('offset')), ['0', '20']);
});

test('HTTP short-batch continuation is bounded and preserves billed IDs when Booking repeats the page', async () => {
  const collected = await collect(fixture(20));
  assert.equal(collected.saved.length, 20, JSON.stringify(collected.result));
  assert.equal(collected.result.fallbackRequests.length, 1);
  assert.equal(collected.visits, 2);
  assert.equal(collected.result.fallbackRequests[0].userData.state.offset, 20);
  assert.equal(collected.result.fallbackRequests[0].userData.state.seenIds.length, 20);
  assert.equal(new Set(collected.result.fallbackRequests[0].userData.state.seenIds).size, 20);
});

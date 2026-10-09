import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInput, normalizeSearchUrls, resolveSearchContext } from './input.js';
import { buildSearchUrl, hasSearchContext } from './routes.js';
import type { SearchState } from './types.js';

const today = new Date('2026-10-09T10:00:00Z');
// Exact public URL rejected before browsing in cloud run ay8Kdkwx3iIXKVj95.
const savedUrl = 'https://www.booking.com/searchresults.en-gb.html?ss=London%2C+Greater+London%2C+United+Kingdom&dest_id=-2601889&dest_type=city&checkin=2026-11-15&checkout=2026-11-17&group_adults=2&no_rooms=1&group_children=0&selected_currency=GBP&lang=en-gb';

test('the observed localized Booking search URL passes the real input pipeline without changing its stay or destination', () => {
  const input = normalizeInput({ searchUrls: [savedUrl], maxResults: 25, trackChanges: true,
    monitorName: 'input-regression', proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: 'US' } }, today);
  assert.deepEqual(input.destinations, []);
  assert.deepEqual(input.searchUrls, [savedUrl]);
  const resolved = resolveSearchContext(input.searchUrls[0], input, today);
  assert.equal(resolved.checkIn, '2026-11-15');
  assert.equal(resolved.checkOut, '2026-11-17');
  assert.equal(resolved.currency, 'GBP');
  assert.equal(resolved.language, 'en-gb');
  assert.equal(resolved.adults, 2); assert.equal(resolved.rooms, 1);
  assert.deepEqual(resolved.childrenAges, []);
  const state = { ...resolved, destination: 'London, Greater London, United Kingdom', propertyTypes: [],
    minReviewScore: 0, maxResults: 25, pageSize: 25, offset: 0, collectedCount: 0,
    examinedCount: 0, seenIds: [], hasMore: true } satisfies SearchState;
  const paged = new URL(buildSearchUrl(state));
  assert.equal(paged.pathname, '/searchresults.en-gb.html');
  assert.equal(paged.searchParams.get('dest_id'), '-2601889');
  assert.equal(paged.searchParams.get('dest_type'), 'city');
  assert.equal(hasSearchContext(paged.toString(), state), true);
});

test('localized search filenames retain filters, ordering, child ages and exact parameters', () => {
  for (const locale of ['en-gb', 'en-us', 'fr', 'de', 'pt-br', 'pt-pt', 'zh-cn', 'zh-tw', 'ja', 'fil']) {
    const url = savedUrl.replace('searchresults.en-gb.html', `searchresults.${locale}.html`)
      + '&nflt=class%3D5%3Bht_id%3D201&order=price&age=5&age=9#map';
    const normalized = normalizeSearchUrls([url])[0];
    assert.equal(normalized, url.replace('#map', ''));
    const parsed = new URL(normalized);
    assert.equal(parsed.searchParams.get('nflt'), 'class=5;ht_id=201');
    assert.equal(parsed.searchParams.get('order'), 'price');
    assert.deepEqual(parsed.searchParams.getAll('age'), ['5', '9']);
  }
});

test('legacy Booking search paths and URL deduplication remain supported', () => {
  for (const path of ['/searchresults', '/searchresults/', '/searchresults.html', '/searchresults.html/', '/searchresults.en-gb.html/']) {
    const url = `https://www.booking.com${path}?ss=London`;
    assert.deepEqual(normalizeSearchUrls([url, url + '#fragment']), [url]);
  }
});

test('locale support never widens validation to foreign sites, credentials or non-search routes', () => {
  for (const url of [
    savedUrl.replace('www.booking.com', 'example.com'),
    savedUrl.replace('www.booking.com', 'booking.com.example.com'),
    savedUrl.replace('https:', 'http:'),
    savedUrl.replace('https://', 'https://user:password@'),
    savedUrl.replace('/searchresults.en-gb.html', '/hotel/gb/example.en-gb.html'),
    savedUrl.replace('/searchresults.en-gb.html', '/login/searchresults.en-gb.html'),
    savedUrl.replace('/searchresults.en-gb.html', '/searchresults.php'),
    savedUrl.replace('/searchresults.en-gb.html', '/searchresults.en-gb.html.bak'),
    savedUrl.replace('/searchresults.en-gb.html', '/searchresults.en-gb'),
    'https://www.booking.com/',
  ]) assert.throws(() => normalizeSearchUrls([url]), /Booking|HTTPS|search-results/);
});

test('ordinary destination mode and current default settings are untouched by localized URL support', () => {
  const input = normalizeInput({ destinations: ['London, United Kingdom'], maxResults: 25, currency: 'GBP',
    checkIn: '2026-11-15', checkOut: '2026-11-17', proxyConfiguration: { useApifyProxy: true, apifyProxyCountry: 'US' } }, today);
  assert.deepEqual(input.destinations, ['London, United Kingdom']);
  assert.deepEqual(input.searchUrls, []);
  assert.equal(input.maxResults, 25); assert.equal(input.currency, 'GBP');
  assert.equal(input.allowResidentialFallback, false);
  assert.deepEqual(input.proxyConfiguration, { useApifyProxy: true, apifyProxyCountry: 'US' });
});

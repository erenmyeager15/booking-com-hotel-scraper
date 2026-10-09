import test from 'node:test';
import assert from 'node:assert/strict';
import { load } from 'cheerio';
import { chromium } from 'playwright';
import { assessSearchEvidence, browserSearchFields, htmlSearchFields } from './search-evidence.js';
import { buildSearchUrl, hasSearchContext, classifyBookingDocument, router } from './routes.js';
import type { SearchState } from './types.js';

const state = { destination: 'London, United Kingdom', checkIn: '2026-11-15', checkOut: '2026-11-17',
  adults: 2, rooms: 1, childrenAges: [], currency: 'GBP', propertyTypes: [], stars: [],
  minReviewScore: 0, offset: 0, pageSize: 25 } as unknown as SearchState;
const form = '<input name="ss" value="London, United Kingdom"><input name="checkin" value="2026-11-15">'
  + '<input name="checkout" value="2026-11-17"><input name="group_adults" value="2"><input name="no_rooms" value="1">'
  + '<input name="group_children" value="0">';
const assess = (html: string) => assessSearchEvidence(htmlSearchFields(load(html)), state);

test('Booking HTTP-202 error shell is unavailable, not empty inventory or a bot block', () => {
  const body = "Oops! Something went wrong on our end. We're working hard to fix it. Error code: 502 Try again";
  assert.equal(classifyBookingDocument('Booking.com Online Hotel Reservations', body), 'unavailable');
  assert.equal(classifyBookingDocument('', 'Room 502. Something went wrong with my stay, said a reviewer.'), 'normal');
  assert.equal(classifyBookingDocument('', body + ' Verify you are human'), 'blocked');
});
test('nonzero counts ending in zero are never classified as an empty search', () => {
  for (const count of ['10', '20', '100', '1,000', '1 000']) {
    assert.equal(classifyBookingDocument('', `London: ${count} properties found`), 'normal', count);
  }
  assert.equal(classifyBookingDocument('', 'London: 0 properties found'), 'no-results');
  assert.equal(classifyBookingDocument('', '0 properties are available'), 'no-results');
});

test('matching requested URL cannot overrule wrong rendered dates', () => {
  assert.equal(hasSearchContext(buildSearchUrl(state), state), true);
  const html = '<input name="ss" value="London%2C+United+Kingdom">'
    + '<button data-testid="searchbox-dates-container">Select datesFri 9 Oct — Sat 10 Oct</button>'
    + '<h1>0 properties are available in and around this destination</h1>';
  assert.equal(classifyBookingDocument('', load(html).text()), 'no-results');
  assert.equal(assess(html).status, 'mismatch');
});
test('only positive full-date form evidence confirms the stay', () => {
  assert.equal(assess(form).status, 'confirmed');
  assert.equal(assess('').status, 'unknown');
  assert.equal(assess('<button data-testid="searchbox-dates-container">Sun 15 Nov — Tue 17 Nov</button>').status, 'unknown');
});
test('wrong or conflicting date inputs reject the page', () => {
  for (const html of [form.replace('2026-11-15', '2027-11-15'), form.replace('2026-11-17', ''),
    form + '<input name="checkin" value="2026-10-09">']) assert.equal(assess(html).status, 'mismatch');
});
test('year-bearing and whitespace-free English date labels catch contradictions', () => {
  for (const label of ['Sun15Nov2027 — Tue17Nov2027', 'Sun 15 November 2027 — Tue 17 November 2027', 'Fri9Oct — Sat10Oct']) {
    const result = assess(form + `<button data-testid="searchbox-dates-container">${label}</button>`);
    assert.equal(result.status, 'mismatch', label);
  }
});
test('localized or absent evidence is unknown, not fabricated', () => {
  assert.equal(assess('<input name="ss" value="London, United Kingdom"><button data-testid="searchbox-dates-container">15 nov. — 17 nov.</button>').status, 'unknown');
  assert.equal(assess(form.replace('London, United Kingdom', 'London%2C+United+Kingdom')).status, 'unknown');
  assert.equal(assess(form.replace('London, United Kingdom', '')).status, 'mismatch');
});
test('explicit different cities and region labels are rejected without editing the form', () => {
  for (const destination of ['Paris, France', 'Paris', 'London, Canada']) {
    assert.equal(assess(form.replace('London, United Kingdom', destination)).status, 'mismatch', destination);
  }
  // A short city does not establish the requested country. Recognized equivalent
  // country labels and encoded text stay uncertain, not a contradictory city.
  assert.equal(assess(form.replace('London, United Kingdom', 'London')).status, 'unknown');
  assert.equal(assess(form.replace('London, United Kingdom', 'London, UK')).status, 'unknown');
});
test('explicit guest and room mismatches are rejected', () => {
  assert.equal(assess(form.replace('name="group_adults" value="2"', 'name="group_adults" value="3"')).status, 'mismatch');
  assert.equal(assess(form + '<button data-testid="occupancy-config">2 adults · 1 children · 1 room</button>').status, 'mismatch');
  assert.equal(assess(form + '<button data-testid="occupancy-config">2 adults · 0 children · 1 room</button>').status, 'confirmed');
});
test('correct dates alone cannot verify an unobserved guest configuration', () => {
  assert.equal(assess(form.replace(/<input name="(?:group_adults|group_children|no_rooms)"[^>]+>/g, '')).status, 'unknown');
  assert.equal(assess(form.replace('name="group_children" value="0"', 'name="unobserved_children" value="0"')).status, 'unknown');
});
test('source child ages must match before a family stay is comparable', () => {
  const family = { ...state, childrenAges: [5] };
  const familyForm = form.replace('name="group_children" value="0"', 'name="group_children" value="1"');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(familyForm)), family).status, 'unknown');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(familyForm + '<input name="age" value="5">')), family).status, 'confirmed');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(familyForm + '<input name="age" value="9">')), family).status, 'mismatch');
});
test('foreign origins and wrong child counts cannot verify URL context', () => {
  const url = buildSearchUrl(state);
  assert.equal(hasSearchContext(url.replace('www.booking.com', 'example.com'), state), false);
  assert.equal(hasSearchContext(url.replace('group_children=0', 'group_children=1'), state), false);
});

const renderedHotelLink = (overrides: Record<string, string> = {}) => {
  const url = new URL('https://www.booking.com/hotel/gb/hilton-london-kensington.en-gb.html');
  for (const [key, value] of Object.entries({ checkin: state.checkIn, checkout: state.checkOut,
    group_adults: '2', group_children: '0', no_rooms: '1', dest_id: '-2601889', dest_type: 'city', ...overrides })) url.searchParams.set(key, value);
  return `<div data-testid="property-card"><a data-testid="title-link" href="${url.toString().replaceAll('&', '&amp;')}">Hilton London Kensington Hotel</a></div>`;
};
const modernState = { ...state, searchUrl: 'https://www.booking.com/searchresults.en-gb.html?ss=London%2C+Greater+London%2C+United+Kingdom&dest_id=-2601889&dest_type=city' };
const modernForm = '<input name="ss" value="London"><button data-testid="searchbox-dates-container">Sun 15 Nov — Tue 17 Nov</button>'
  + '<button data-testid="occupancy-config" aria-label="Number of travellers and rooms. Currently selected: 2 adults · 0 children · 1 room"></button>'
  + '<button data-testid="header-currency-picker-trigger" aria-label="Prices in Pound Sterling GBP">GBP</button>';

test('observed modern Booking card links confirm full dates without nonexistent hidden inputs', () => {
  assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm + renderedHotelLink())), modernState).status, 'confirmed');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm)), modernState).status, 'unknown');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm + renderedHotelLink())), state).status, 'unknown');
});

test('rendered hotel links cannot overrule a wrong year, guests, destination or currency', () => {
  for (const overrides of [{ checkin: '2027-11-15' }, { group_adults: '3' }, { group_children: '1' },
    { dest_id: '-2140479' }, { dest_type: 'airport' }, { ss: 'Paris, France' }, { selected_currency: 'USD' }] as Record<string, string>[]) {
    assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm + renderedHotelLink(overrides))), modernState).status, 'mismatch');
  }
  assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm.replaceAll('GBP', 'USD') + renderedHotelLink())), modernState).status, 'mismatch');
  assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm + renderedHotelLink() + renderedHotelLink({ checkout: '2026-11-18' }))), modernState).status, 'mismatch');
});
test('a resolved search URL cannot keep the same label but silently switch destination identity', () => {
  const resolved = { ...modernState, searchUrl: buildSearchUrl(state) + '&dest_id=-2601889&dest_type=city' };
  assert.equal(hasSearchContext(resolved.searchUrl, resolved), true);
  for (const [key, value] of [['dest_id', '-2140479'], ['dest_type', 'airport']]) {
    const wrong = new URL(resolved.searchUrl); wrong.searchParams.set(key, value);
    assert.equal(hasSearchContext(wrong.toString(), resolved), false);
  }
});

test('foreign or incomplete property links never establish stay evidence', () => {
  for (const html of [renderedHotelLink().replace('www.booking.com', 'example.com'),
    '<div data-testid="property-card"><a data-testid="title-link" href="/hotel/gb/example.html">Hotel</a></div>']) {
    assert.equal(assessSearchEvidence(htmlSearchFields(load(modernForm + html)), modernState).status, 'unknown');
  }
});

test('selected source calendar dates can verify genuine empty searches with full-year evidence', () => {
  const calendar = '<span role="checkbox" aria-checked="true" data-date="2026-11-15" aria-label="Sunday, 15 November 2026, Check-in date"></span>'
    + '<span role="checkbox" aria-checked="true" data-date="2026-11-17" aria-label="Tuesday, 17 November 2026, Check-out date"></span>';
  assert.equal(assess(form.replace(/<input name="check(?:in|out)"[^>]+>/g, '') + calendar).status, 'confirmed');
  assert.equal(assess(form + calendar.replace('2026-11-15', '2027-11-15')).status, 'mismatch');
});
test('offline real-browser reader uses current input values, not stale HTML attributes', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent(form);
    assert.equal(assessSearchEvidence(await browserSearchFields(page), state).status, 'confirmed');
    await page.locator('input[name="checkin"]').fill('2026-10-09');
    assert.equal(assessSearchEvidence(await browserSearchFields(page), state).status, 'mismatch');
    await page.setContent('<input name="ss" value=""><button data-testid="searchbox-dates-container">Fri 9 Oct — Sat 10 Oct</button>');
    assert.equal(assessSearchEvidence(await browserSearchFields(page), state).status, 'mismatch');
  } finally { await browser.close(); }
});

test('real search and detail handlers reject the observed 502 page before card waits or extraction', async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.route('**/*', route => route.abort());
    await page.setContent('<h1>Oops!</h1><p>Something went wrong on our end.</p><p>Error code: 502</p>');
    let unexpectedOperations = 0;
    const guardedPage = new Proxy(page, { get(target, property) {
      if (['goto','waitForSelector','locator'].includes(String(property))) return () => {
        unexpectedOperations++;
        throw new Error('Unexpected navigation, wait, or extraction on an unavailable source');
      };
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    } });
    for (const label of ['search','detail']) {
      const context = { page: guardedPage,
        request: { label, url: buildSearchUrl(state), userData: {
          state: { ...state, requestNamespace: `offline-unavailable-${label}`, hasMore: true, collectedCount: 0, maxResults: 25 },
          record: {},
        } },
        log: { debug: () => {}, info: () => {} }, crawler: {},
      } as unknown as Parameters<typeof router>[0];
      await assert.rejects(async () => await router(context), /BOOKING_SOURCE_UNAVAILABLE/);
    }
    assert.equal(unexpectedOperations, 0);
  } finally { await browser.close(); }
});

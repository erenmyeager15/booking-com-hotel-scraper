import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingNavigationOptions, isContextFreeSearchShell, isContextFreeCityLanding,
  restoreSearchShell, searchRedirectDiagnostic } from './navigation.js';
import type { Page } from 'playwright';

const target = 'https://www.booking.com/searchresults.html?ss=London&checkin=2026-11-15&checkout=2026-11-17&group_adults=2&no_rooms=1&selected_currency=GBP&nflt=class%3D5&offset=25';
function page(url: string, after = target) {
  let current = url;
  const calls: Array<{url:string;options:unknown}> = [];
  const mock = {url:()=>current,goto:async (next:string, options:unknown)=>{calls.push({url:next,options});current=after;return null;}};
  return {port:mock as Pick<Page,'url'|'goto'>, calls};
}
test('navigation waits for DOM rather than unrelated load completion', () => {
  assert.deepEqual(bookingNavigationOptions(), {waitUntil:'domcontentloaded',timeout:30000});
});
test('only context-free Booking search shells are eligible', () => {
  assert.ok(isContextFreeSearchShell('https://www.booking.com/searchresults.en-gb.html'));
  for (const url of [target,'https://example.com/searchresults.html','https://www.booking.com/login.html',
    'https://www.booking.com/searchresults.html?ss=Paris','http://www.booking.com/searchresults.html',
    'https://user:password@www.booking.com/searchresults.html']) assert.equal(isContextFreeSearchShell(url),false,url);
});
test('one restoration preserves the exact stay, filters and pagination', async () => {
  const p=page('https://www.booking.com/searchresults.en-gb.html');
  assert.equal(await restoreSearchShell(p.port,target,'normal'),true);
  assert.equal(await restoreSearchShell(p.port,target,'normal'),false);
  assert.deepEqual(p.calls,[{url:target,options:bookingNavigationOptions()}]);
});
test('persistent context loss fails instead of looping or saving the wrong search', async () => {
  const p=page('https://www.booking.com/searchresults.html','https://www.booking.com/searchresults.en-gb.html');
  await assert.rejects(restoreSearchShell(p.port,target,'normal'),/CONTEXT_LOST/);
  assert.equal(p.calls.length,1);
});

test('a crawler retry cannot repeat a successful shell repair in another session', async () => {
  const budget = {};
  const first = page('https://www.booking.com/searchresults.html');
  assert.equal(await restoreSearchShell(first.port, target, 'normal', budget), true);
  const retry = page('https://www.booking.com/searchresults.en-gb.html');
  await assert.rejects(restoreSearchShell(retry.port, target, 'normal', budget), /CONTEXT_LOST/);
  assert.equal(first.calls.length, 1);
  assert.equal(retry.calls.length, 0);
});
test('blocked, empty, login and foreign pages never trigger restoration', async () => {
  for (const state of ['blocked','no-results','unavailable'] as const) {
    const p=page('https://www.booking.com/searchresults.html');
    assert.equal(await restoreSearchShell(p.port,target,state),false);assert.equal(p.calls.length,0);
  }
  for(const url of ['https://account.booking.com/sign-in','https://example.com/searchresults.html']) {
    const p=page(url);assert.equal(await restoreSearchShell(p.port,target,'normal'),false);assert.equal(p.calls.length,0);
  }
});
test('invalid restoration targets cannot issue requests', async () => {
  for(const target of ['https://example.com/searchresults.html','https://www.booking.com/hotel/gb/a.html',
    'https://www.booking.com/searchresults.html?ss=London']) {
    const p=page('https://www.booking.com/searchresults.html');
    await assert.rejects(restoreSearchShell(p.port,target,'normal'),/INVALID_SEARCH/);assert.equal(p.calls.length,0);
  }
});

const observedCityLanding = 'https://www.booking.com/city/gb/london.en-gb.html';
test('only an undated same-site city landing is eligible for the observed redirect repair', () => {
  assert.equal(isContextFreeCityLanding(observedCityLanding), true);
  assert.equal(isContextFreeCityLanding(observedCityLanding + '?aid=tracking'), true);
  for (const url of [observedCityLanding + '?checkin=2026-11-15', observedCityLanding + '?ss=London',
    observedCityLanding + '?group_adults=2', observedCityLanding + '?selected_currency=GBP',
    observedCityLanding.replace('www.booking.com', 'example.com'),
    observedCityLanding.replace('https:', 'http:'), observedCityLanding.replace('https://', 'https://user:secret@'),
    'https://www.booking.com/login.html', 'https://www.booking.com/hotel/gb/example.html']) {
    assert.equal(isContextFreeCityLanding(url), false, url);
  }
});

test('the observed city redirect permits one exact saved-search restoration without changing any parameters', async () => {
  const saved = target.replace('searchresults.html', 'searchresults.en-gb.html') + '&dest_id=-2601889&dest_type=city';
  const p = page(observedCityLanding, saved), budget = {};
  assert.equal(await restoreSearchShell(p.port, saved, 'normal', budget), true);
  assert.deepEqual(p.calls, [{ url: saved, options: bookingNavigationOptions() }]);
  const retry = page(observedCityLanding, saved);
  await assert.rejects(restoreSearchShell(retry.port, saved, 'normal', budget), /CONTEXT_LOST/);
  assert.equal(retry.calls.length, 0);
});

test('a persistent city redirect stops after one restoration and never becomes a valid empty search', async () => {
  const p = page(observedCityLanding, observedCityLanding), budget = {};
  await assert.rejects(restoreSearchShell(p.port, target, 'normal', budget), /CONTEXT_LOST_AFTER_RESTORE/);
  assert.equal(p.calls.length, 1);
  await assert.rejects(restoreSearchShell(p.port, target, 'normal', budget), /CONTEXT_LOST_AFTER_RESTORE/);
  assert.equal(p.calls.length, 1);
});

test('blocked, unavailable and no-result city landings do not permit extra navigation', async () => {
  for (const state of ['blocked', 'unavailable', 'no-results'] as const) {
    const p = page(observedCityLanding);
    assert.equal(await restoreSearchShell(p.port, target, state), false);
    assert.equal(p.calls.length, 0);
  }
});

test('redirect diagnostics reveal only route and missing parameter names', () => {
  const result = searchRedirectDiagnostic(observedCityLanding + '?aid=private-tracking&label=private-label');
  assert.equal(result.routeKind, 'city_landing');
  assert.ok(['checkin','checkout','group_adults','selected_currency'].every(key => result.missingFields.includes(key)));
  assert.equal(/private-tracking|private-label|london|label|aid/i.test(JSON.stringify(result)), false);
  assert.deepEqual(searchRedirectDiagnostic(observedCityLanding.replace('https://', 'https://user:secret@')),
    { routeKind: 'foreign_or_invalid', missingFields: [] });
  assert.deepEqual(searchRedirectDiagnostic('not a URL secret'), { routeKind: 'foreign_or_invalid', missingFields: [] });
});

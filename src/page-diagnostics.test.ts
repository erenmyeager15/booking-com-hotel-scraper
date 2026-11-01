import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import type { Page } from 'playwright';
import { attachPageDiagnostics, pageDiagnosticCounters, browserFailureDiagnostic } from './page-diagnostics.js';

test('page failure counters retain no private data, install once and stay bounded', () => {
  const frame = {}, events = new EventEmitter();
  const page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
  attachPageDiagnostics(page); attachPageDiagnostics(page);
  events.emit('requestfailed', { resourceType: () => 'script', url: () => 'private-url' });
  events.emit('requestfailed', { resourceType: () => 'fetch', failure: () => ({ errorText: 'private-error' }) });
  events.emit('requestfailed', { resourceType: () => 'image' });
  events.emit('pageerror', new Error('private-message'));
  const response = (status: number, navigation: boolean) => ({ status: () => status,
    request: () => ({ isNavigationRequest: () => navigation }), frame: () => frame });
  events.emit('response', response(200, true));
  events.emit('response', response(503, false));
  events.emit('response', response(429, false));
  assert.deepEqual(pageDiagnosticCounters(page), { scriptFailures: 1, dataFailures: 1, pageErrors: 1,
    httpClientErrors: 1, httpServerErrors: 1, documentStatus: 200,
    documentInFlight: true, documentFinished: false, pendingScripts: 0, pendingDataRequests: 0 });
  const copy = pageDiagnosticCounters(page); copy.scriptFailures = 999;
  assert.equal(pageDiagnosticCounters(page).scriptFailures, 1);
  for (let i = 0; i < 1100; i++) events.emit('pageerror', new Error('private-message'));
  assert.equal(pageDiagnosticCounters(page).pageErrors, 1000);
  assert.equal(JSON.stringify(pageDiagnosticCounters(page)).includes('private'), false);
});

test('pending main document, scripts and data are distinguished from failed requests without retaining their contents', () => {
  const frame = {}, events = new EventEmitter();
  const page = Object.assign(events, { mainFrame: () => frame }) as unknown as Page;
  attachPageDiagnostics(page);
  const request = (type: string) => ({ resourceType: () => type, isNavigationRequest: () => type === 'document', frame: () => frame });
  const document = request('document'), script = request('script'), data = request('fetch');
  for (const value of [document, script, data]) events.emit('request', value);
  events.emit('response', { status: () => 200, request: () => document, frame: () => frame });
  assert.equal(pageDiagnosticCounters(page).documentInFlight, true);
  assert.equal(pageDiagnosticCounters(page).pendingScripts, 1); assert.equal(pageDiagnosticCounters(page).pendingDataRequests, 1);
  assert.equal(pageDiagnosticCounters(page).scriptFailures, 0);
  events.emit('requestfinished', document); events.emit('requestfinished', script); events.emit('requestfailed', data);
  const done = pageDiagnosticCounters(page);
  assert.equal(done.documentInFlight, false); assert.equal(done.documentFinished, true);
  assert.equal(done.pendingScripts, 0); assert.equal(done.pendingDataRequests, 0); assert.equal(done.dataFailures, 1);
  events.emit('requestfailed', data); assert.equal(pageDiagnosticCounters(page).pendingDataRequests, 0);
});

test('a hung or closed renderer cannot prevent bounded navigation diagnostics', async () => {
  const frame = {}, events = new EventEmitter();
  const page = Object.assign(events, { mainFrame: () => frame,
    url: () => 'https://www.booking.com/searchresults.html?ss=private&label=secret',
    isClosed: () => false, evaluate: () => new Promise(() => {}) }) as unknown as Page;
  attachPageDiagnostics(page);
  events.emit('response', { status: () => 200,
    request: () => ({ isNavigationRequest: () => true }), frame: () => frame });
  const result = await browserFailureDiagnostic(page, 20);
  assert.equal(result.documentReceived, true); assert.equal(result.documentStatus, 200);
  assert.equal(result.structureAvailable, false); assert.equal(result.routeKind, 'search');
  assert.equal(/private|secret|booking\.com/.test(JSON.stringify(result)), false);
  page.isClosed = () => true;
  assert.equal((await browserFailureDiagnostic(page)).structureAvailable, false);
  assert.equal((await browserFailureDiagnostic(undefined)).documentReceived, false);
});

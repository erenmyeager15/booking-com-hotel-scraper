import assert from 'node:assert/strict';
import test from 'node:test';
import { FRESH_RETRY_DEADLINE_SECS, MAX_FRESH_SESSION_RETRIES, MAX_NETWORK_RETRIES, freshRetryDecision, isTransientNetworkError } from './retry-policy.js';

test('proxy connection errors are transient; Booking responses and other errors are not', () => {
  for (const code of ['TUNNEL_CONNECTION_FAILED', 'PROXY_CONNECTION_FAILED', 'NETWORK_CHANGED', 'CONNECTION_RESET', 'TIMED_OUT', 'EMPTY_RESPONSE']) {
    assert.equal(isTransientNetworkError(`page.goto: net::ERR_${code} at https://www.booking.com/searchresults.html`), true, code);
  }
  for (const message of ['BOOKING_BLOCKED: challenge', 'BOOKING_SEARCH_CONTEXT_LOST_AFTER_RESTORE', 'page.goto: net::ERR_ABORTED at https://www.booking.com/',
    'Navigation timed out after 30 seconds', 'net::ERR_CERT_AUTHORITY_INVALID']) {
    assert.equal(isTransientNetworkError(message), false, message);
  }
});

test('network-only failures back off and get more retries than page-level failures', () => {
  // The QA failure: three attempts within 3 s. Now the waits are 5, 10, 20, 30 s.
  const delays = [0, 1, 2, 3].map(retriesUsed => freshRetryDecision({ networkOnly: true, retriesUsed, uptimeSecs: 20 }));
  assert.deepEqual(delays.map(d => d.delaySecs), [5, 10, 20, 30]);
  assert.ok(delays.every(d => d.retry));
  assert.equal(freshRetryDecision({ networkOnly: true, retriesUsed: MAX_NETWORK_RETRIES, uptimeSecs: 20 }).retry, false);

  assert.deepEqual(freshRetryDecision({ networkOnly: false, retriesUsed: 0, uptimeSecs: 20 }), { retry: true, delaySecs: 0 });
  assert.equal(freshRetryDecision({ networkOnly: false, retriesUsed: MAX_FRESH_SESSION_RETRIES, uptimeSecs: 20 }).retry, false);
});

test('no retry starts, or waits, past the QA time budget', () => {
  assert.equal(freshRetryDecision({ networkOnly: false, retriesUsed: 0, uptimeSecs: FRESH_RETRY_DEADLINE_SECS }).retry, false);
  // A 30 s wait that would end past the deadline is skipped.
  assert.equal(freshRetryDecision({ networkOnly: true, retriesUsed: 3, uptimeSecs: FRESH_RETRY_DEADLINE_SECS - 20 }).retry, false);
  assert.equal(freshRetryDecision({ networkOnly: true, retriesUsed: 0, uptimeSecs: FRESH_RETRY_DEADLINE_SECS - 20 }).retry, true);
});

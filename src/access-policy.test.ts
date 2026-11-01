import test from 'node:test';
import assert from 'node:assert/strict';
import { NonRetryableError } from 'crawlee';
import { isBookingAccessDenied, rejectBookingAccess } from './access-policy.js';
import type { SearchState } from './types.js';

test('explicit source denials are terminal, not generic network or server errors', () => {
  for (const message of ['BOOKING_BLOCKED: London', 'BOOKING_DETAIL_BLOCKED_AFTER_INTERACTION: 123',
    'Request failed with status code 403', 'Request blocked - received 403 status code.',
    'Response code 429', 'HTTP 429', 'Access denied']) {
    assert.equal(isBookingAccessDenied(new Error(message)), true, message);
  }
  for (const message of ['HTTP 502', 'socket timed out', 'property 403', 'PRICE_CONTEXT_MISMATCH']) {
    assert.equal(isBookingAccessDenied(new Error(message)), false, message);
  }
});

test('blocked browser collection marks failed coverage and disables retries without erasing saved progress', () => {
  const request = { noRetry: false };
  const state = { hasMore: true, collectedCount: 20, seenIds: ['retained-property'],
    coverage: { status: 'pending', reason: null, successfulPages: 1 } } as unknown as SearchState;
  assert.throws(() => rejectBookingAccess(request, state, 'BOOKING_BLOCKED: London'), NonRetryableError);
  assert.equal(request.noRetry, true);
  assert.equal(state.hasMore, false);
  assert.equal(state.coverage?.status, 'failed');
  assert.equal(state.coverage?.reason, 'source_access_blocked');
  assert.equal(state.collectedCount, 20);
  assert.deepEqual(state.seenIds, ['retained-property']);
});

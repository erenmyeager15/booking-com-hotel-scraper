import test from 'node:test';
import assert from 'node:assert/strict';
import { bookingCompletionStatus, shortBatchContinuation, searchPageLimitReached } from './completion.js';
import type { SearchState } from './types.js';
const state = (reason: string | null, status: 'limited' | 'complete' | 'failed' | 'pending' = 'limited') => ({
  coverage: { reason, status, successfulPages: 1 }, offset: 0, pageSize: 25, maxPages: 4,
} as SearchState);
test('short lazy coverage never reports top-level success merely because requests succeeded', () => {
  for (const reason of ['lazy_load_incomplete','repeated_page','page_cap']) assert.equal(bookingCompletionStatus([state(reason)],0,false),'partial');
  assert.equal(bookingCompletionStatus([state('max_results')],0,false),'succeeded');
  assert.equal(bookingCompletionStatus([state('spending_limit')],0,false),'succeeded');
  assert.equal(bookingCompletionStatus([state(null,'complete')],0,true),'succeeded_no_matches');
  assert.equal(bookingCompletionStatus([state(null,'complete')],1,false),'partial');
});
test('15-card stalled batches continue by consumed source cards with a real page-count cap', () => {
  const s=state(null,'pending');
  assert.equal(shortBatchContinuation(s,15,15,0,15,6754),'next');
  assert.equal(shortBatchContinuation(s,15,0,15,15,6754),'repeated_page');
  s.offset=15;s.coverage!.successfulPages=4;
  assert.equal(searchPageLimitReached(s),true);
  assert.equal(shortBatchContinuation(s,15,15,0,15,6754),'page_cap');
  assert.equal(shortBatchContinuation(s,15,15,0,15,30),null);
  assert.equal(shortBatchContinuation(s,15,0,0,0,6754),null);
});

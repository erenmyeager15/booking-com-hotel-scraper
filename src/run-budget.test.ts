import assert from 'node:assert/strict';
import test from 'node:test';
import { FIRST_DOCUMENT_CONTINUATION_MS, LATER_DOCUMENT_CONTINUATION_MS, SMALL_RUN_COLLECTION_SECS, TIMEOUT_RESERVE_SECS,
  collectionTimeExhausted, continuationBudgetMs } from './run-budget.js';

test('only the first document of a search gets the long continuation wait', () => {
  assert.equal(continuationBudgetMs(false, false), FIRST_DOCUMENT_CONTINUATION_MS);
  // The 265 s QA run: three documents x ~50 s each. Later documents now wait 15 s.
  assert.equal(continuationBudgetMs(false, true), LATER_DOCUMENT_CONTINUATION_MS);
  assert.equal(continuationBudgetMs(true, false), LATER_DOCUMENT_CONTINUATION_MS);
});

test('a default-size run stops paging after the small-run budget; larger runs do not', () => {
  assert.equal(collectionTimeExhausted({ maxResults: 25, pageSize: 25, uptimeSecs: SMALL_RUN_COLLECTION_SECS - 1 }), false);
  assert.equal(collectionTimeExhausted({ maxResults: 25, pageSize: 25, uptimeSecs: SMALL_RUN_COLLECTION_SECS }), true);
  assert.equal(collectionTimeExhausted({ maxResults: 200, pageSize: 25, uptimeSecs: 600 }), false, 'big runs keep their full time');
});

test('any run stops starting pages near its own timeout', () => {
  const now = Date.parse('2026-11-17T12:00:00Z');
  const at = (secs: number) => new Date(now + secs * 1000).toISOString();
  assert.equal(collectionTimeExhausted({ maxResults: 500, pageSize: 25, uptimeSecs: 900, nowMs: now, timeoutAt: at(TIMEOUT_RESERVE_SECS + 1) }), false);
  assert.equal(collectionTimeExhausted({ maxResults: 500, pageSize: 25, uptimeSecs: 900, nowMs: now, timeoutAt: at(TIMEOUT_RESERVE_SECS) }), true);
  assert.equal(collectionTimeExhausted({ maxResults: 500, pageSize: 25, uptimeSecs: 900, nowMs: now, timeoutAt: 'not a date' }), false);
});

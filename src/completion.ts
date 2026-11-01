import type { SearchState } from './types.js';

/** Reaching an explicit user limit is intentional; missing source coverage is not. */
export function bookingCompletionStatus(states: SearchState[], failedRequests: number, allEmpty: boolean): 'succeeded' | 'partial' | 'succeeded_no_matches' {
  if (failedRequests > 0 || states.some(s => s.coverage?.status === 'failed' || s.coverage?.status === 'pending'
    || (s.coverage?.status === 'limited' && !['max_results', 'spending_limit'].includes(s.coverage.reason ?? '')))) return 'partial';
  return allEmpty ? 'succeeded_no_matches' : 'succeeded';
}

export function shortBatchContinuation(state: SearchState, cardCount: number, newCount: number,
  duplicateCount: number, extractedCount: number, reportedTotal: number | null): 'next' | 'repeated_page' | 'page_cap' | null {
  if (cardCount <= 0 || cardCount >= state.pageSize || extractedCount === 0
    || (reportedTotal !== null && reportedTotal <= state.offset + cardCount)) return null;
  if (newCount === 0 && duplicateCount > 0) return 'repeated_page';
  if (searchPageLimitReached(state)) return 'page_cap';
  return 'next';
}

export function searchPageLimitReached(state: SearchState): boolean {
  return (state.coverage?.successfulPages ?? Math.floor(state.offset / state.pageSize) + 1) >= (state.maxPages ?? 40);
}

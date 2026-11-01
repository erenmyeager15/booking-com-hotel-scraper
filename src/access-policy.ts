import { NonRetryableError } from 'crawlee';
import type { SearchState } from './types.js';

export function isBookingAccessDenied(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /BOOKING_(?:DETAIL_)?BLOCKED|access denied|(?:HTTP(?: status(?: code)?)?|status(?: code)?|response code)\s*:?\s*(?:401|403|429)\b|\b(?:401|403|429)\s+status code\b/i.test(message);
}

export function markBookingAccessDenied(state: SearchState): void {
  state.hasMore = false;
  if (state.coverage) { state.coverage.status = 'failed'; state.coverage.reason = 'source_access_blocked'; }
}

export function rejectBookingAccess(
  request: { noRetry?: boolean }, state: SearchState, message: string,
): never {
  request.noRetry = true;
  markBookingAccessDenied(state);
  throw new NonRetryableError(message);
}

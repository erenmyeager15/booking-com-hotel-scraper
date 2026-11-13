/** Chromium network errors raised when the proxy connection itself fails, before
 * Booking.com answered. Live 13 Nov 2026: Apify's QA run got
 * ERR_TUNNEL_CONNECTION_FAILED on three back-to-back fresh sessions within
 * 3 seconds, while a retry ~30 s later in another run loaded results. */
const TRANSIENT_NETWORK_ERROR = /net::ERR_(?:TUNNEL_CONNECTION_FAILED|PROXY_CONNECTION_FAILED|NETWORK_CHANGED|CONNECTION_(?:RESET|CLOSED|REFUSED|TIMED_OUT|FAILED)|TIMED_OUT|EMPTY_RESPONSE|SOCKS_CONNECTION_FAILED|NAME_NOT_RESOLVED|INTERNET_DISCONNECTED|ADDRESS_UNREACHABLE)\b/;

export function isTransientNetworkError(message: string): boolean {
  return TRANSIENT_NETWORK_ERROR.test(message);
}

/** Fresh-session retries for page-level failures (redirect, challenge, unrendered search). */
export const MAX_FRESH_SESSION_RETRIES = 2;
/** Connection-only failures get more retries, spaced out so a short proxy outage can pass. */
export const MAX_NETWORK_RETRIES = 4;
const NETWORK_BACKOFF_SECS = [5, 10, 20, 30];
/** One attempt normally takes 30-80 s; never start one after this uptime (5-minute QA limit). */
export const FRESH_RETRY_DEADLINE_SECS = 150;

export interface RetryDecision { retry: boolean; delaySecs: number }

export function freshRetryDecision(options: { networkOnly: boolean; retriesUsed: number; uptimeSecs: number }): RetryDecision {
  const { networkOnly, retriesUsed, uptimeSecs } = options;
  const limit = networkOnly ? MAX_NETWORK_RETRIES : MAX_FRESH_SESSION_RETRIES;
  if (retriesUsed >= limit) return { retry: false, delaySecs: 0 };
  const delaySecs = networkOnly ? NETWORK_BACKOFF_SECS[Math.min(retriesUsed, NETWORK_BACKOFF_SECS.length - 1)] : 0;
  if (uptimeSecs + delaySecs >= FRESH_RETRY_DEADLINE_SECS) return { retry: false, delaySecs: 0 };
  return { retry: true, delaySecs };
}

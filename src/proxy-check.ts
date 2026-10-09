import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { ProxyConfiguration } from 'apify';

export class ProxyConfigurationError extends Error {
  constructor(message: string) { super(message); this.name = 'ProxyConfigurationError'; }
}

export function proxyConfigurationProblem(error: unknown, country?: string): string | null {
  const message = error instanceof Error ? error.message : String(error);
  const unavailable = message.match(/no usable proxies from country\s+['"]([A-Z]{2})['"]/i);
  if (unavailable) return `No configured proxy is available from ${unavailable[1].toUpperCase()}. Choose a country available to your account, or remove the country for ordinary non-comparable collection. The Actor will not silently change markets or switch to Residential.`;
  const status = (error as { response?: { statusCode?: number } } | null)?.response?.statusCode;
  if (status === 407 || /(?:proxy|tunnel)[\s\S]{0,150}(?:407|authentication required)|407[\s\S]{0,150}(?:proxy|tunnel)/i.test(message)) {
    return `The configured proxy${country ? ` country ${country}` : ''} is unavailable or access was denied. Check your proxy groups, available countries and credentials. No expensive fallback will be enabled automatically.`;
  }
  return null;
}

type ProxyProbe = (url: string) => Promise<{ statusCode: number }>;
/** Check CONNECT authorization only. The old got-scraping HEAD probe could stall
 * during proxy/TLS negotiation before its request timeout started. No Booking
 * document, TLS negotiation, browser or billable result is needed for this check. */
export function probeProxyTunnel(proxyUrl: string, timeoutMillis = 8000): Promise<{ statusCode: number }> {
  const proxy = new URL(proxyUrl);
  if (!['http:', 'https:'].includes(proxy.protocol)) return Promise.reject(new Error('Unsupported proxy preflight protocol'));
  if (!Number.isFinite(timeoutMillis) || timeoutMillis <= 0) return Promise.reject(new Error('Invalid proxy preflight timeout'));
  return new Promise((resolve, reject) => {
    const request = (proxy.protocol === 'https:' ? httpsRequest : httpRequest)({
      protocol: proxy.protocol, hostname: proxy.hostname, port: proxy.port || (proxy.protocol === 'https:' ? 443 : 80),
      method: 'CONNECT', path: 'www.booking.com:443', agent: false,
      headers: { Host: 'www.booking.com:443', ...(proxy.username || proxy.password ? {
        'Proxy-Authorization': `Basic ${Buffer.from(`${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`).toString('base64')}`,
      } : {}) },
    });
    let settled = false;
    const finish = (statusCode?: number) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.destroy();
      if (statusCode) resolve({ statusCode });
      else reject(new Error('Proxy tunnel preflight did not complete within its bounded connection check'));
    };
    // Covers DNS, TCP connection and the CONNECT response, not just response data.
    const timer = setTimeout(() => finish(), timeoutMillis);
    request.once('connect', (response, socket) => { socket.destroy(); finish(response.statusCode); });
    request.once('response', response => { response.destroy(); finish(response.statusCode); });
    request.once('error', () => finish());
    request.end();
  });
}
const defaultProbe: ProxyProbe = proxyUrl => probeProxyTunnel(proxyUrl);

/** A successful CONNECT proves proxy access, not Booking source availability. */
export async function assertProxyAvailable(proxy: Pick<ProxyConfiguration, 'newUrl'> | undefined,
  country?: string, probe: ProxyProbe = defaultProbe): Promise<void> {
  if (!proxy) return;
  try {
    const proxyUrl = await proxy.newUrl('booking_access_check');
    if (!proxyUrl) return;
    const response = await probe(proxyUrl);
    if (response.statusCode === 407) throw new ProxyConfigurationError(proxyConfigurationProblem('Proxy responded with 407', country)!);
    // A destination 403/429 is not proof that the proxy configuration is invalid.
    // Let bounded session retries handle source-specific blocking.
  } catch (error) {
    if (error instanceof ProxyConfigurationError) throw error;
    const problem = proxyConfigurationProblem(error, country);
    if (problem) throw new ProxyConfigurationError(problem);
    console.warn('Proxy tunnel preflight was inconclusive; continuing with bounded source retries.');
  }
}

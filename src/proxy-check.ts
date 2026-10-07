import { gotScraping } from 'crawlee';
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
const defaultProbe: ProxyProbe = proxyUrl => gotScraping({
  url: 'https://www.booking.com/robots.txt', method: 'HEAD', proxyUrl,
  timeout: { request: 10000 }, retry: { limit: 0 }, throwHttpErrors: false,
});

/** Verify the configured tunnel cheaply before starting a browser or charging setup. */
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

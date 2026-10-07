import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyConfiguration } from 'apify';
import { assertProxyAvailable, proxyConfigurationProblem, ProxyConfigurationError } from './proxy-check.js';

const proxy = { newUrl: async () => 'http://proxy.invalid:8000' };
test('preflight uses an SDK-valid session and reaches the transport', async () => {
  const actual = new ProxyConfiguration({ countryCode: 'US', password: 'local-test-placeholder' });
  let calls = 0;
  await assertProxyAvailable(actual, 'US', async url => {
    calls++;
    const parsed = new URL(url);
    assert.match(parsed.username, /country-US/);
    assert.match(parsed.username, /session-booking_access_check/);
    return { statusCode: 200 };
  });
  assert.equal(calls, 1);
});
test('rejects a genuinely unavailable proxy country without changing it', async () => {
  const error = new Error("Proxy responded with 407: Selected proxy groups have no usable proxies from country 'GB'.");
  assert.match(proxyConfigurationProblem(error)!, /No configured proxy is available from GB/);
  let calls = 0;
  await assert.rejects(assertProxyAvailable(proxy, 'GB', async () => { calls++; throw error; }), ProxyConfigurationError);
  assert.equal(calls, 1);
});
test('407 fails before browser setup, while target blocking is not mislabeled as proxy setup', async () => {
  await assert.rejects(assertProxyAvailable(proxy, 'US', async () => ({ statusCode: 407 })), /country US/);
  await assert.doesNotReject(assertProxyAvailable(proxy, 'US', async () => ({ statusCode: 403 })));
  assert.equal(proxyConfigurationProblem(new Error('Booking.com captcha')), null);
  assert.equal(proxyConfigurationProblem(new Error('page.goto: net::ERR_TUNNEL_CONNECTION_FAILED')), null);
});
test('configuration diagnostics never echo credential-bearing errors', () => {
  const message = proxyConfigurationProblem(new Error('Proxy http://name:private-password@host:8000 responded with 407'), 'US')!;
  assert.ok(message); assert.equal(message.includes('private-password'), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { ProxyConfiguration } from 'apify';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { assertProxyAvailable, proxyConfigurationProblem, ProxyConfigurationError, probeProxyTunnel } from './proxy-check.js';

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

async function localProxy(status: number | null, run: (url: string, requests: Array<{method?: string; path?: string; auth?: string}>) => Promise<void>) {
  const requests: Array<{method?: string; path?: string; auth?: string}> = [];
  const sockets = new Set<Socket>();
  const server = createServer();
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('connect', (request, socket) => {
    requests.push({method:request.method,path:request.url,auth:request.headers['proxy-authorization']});
    if (status) socket.write(`HTTP/1.1 ${status} Proxy reply\r\n\r\n`);
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  try { await run(`http://test:placeholder@127.0.0.1:${address.port}`, requests); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

test('native tunnel probe checks one authenticated CONNECT, not a source HEAD/page', async () => {
  await localProxy(200, async (url, requests) => {
    assert.deepEqual(await probeProxyTunnel(url, 1000), {statusCode:200});
    assert.equal(requests.length, 1);
    assert.equal(requests[0].method, 'CONNECT');
    assert.equal(requests[0].path, 'www.booking.com:443');
    assert.equal(requests[0].auth, `Basic ${Buffer.from('test:placeholder').toString('base64')}`);
  });
});

test('native denied tunnel is rejected without browser fallback or credential exposure', async () => {
  await localProxy(407, async url => {
    await assert.rejects(assertProxyAvailable({newUrl:async()=>url}, 'US'), error => {
      assert.ok(error instanceof ProxyConfigurationError);
      assert.doesNotMatch(error.message, /placeholder|127\.0\.0\.1/);
      return true;
    });
  });
});

test('an unresponsive proxy is actively disconnected within its deadline', async () => {
  await localProxy(null, async (url, requests) => {
    const started = Date.now();
    await assert.rejects(probeProxyTunnel(url, 50), /bounded connection check/);
    assert.ok(Date.now() - started < 1500);
    assert.equal(requests.length, 1);
    // A transient/inconclusive check is not mislabeled as bad credentials.
    await assert.doesNotReject(assertProxyAvailable({newUrl:async()=>url}, 'US', u => probeProxyTunnel(u, 50)));
  });
});

test('invalid tunnel protocols and deadlines fail without a network request', async () => {
  await assert.rejects(probeProxyTunnel('file:///tmp/proxy'), /Unsupported/);
  await assert.rejects(probeProxyTunnel('http://127.0.0.1', 0), /Invalid/);
});

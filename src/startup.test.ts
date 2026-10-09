import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { StartupGuard } from './startup.js';

const moduleUrl = new URL('./startup.js', import.meta.url).href;
function child(script: string): Promise<{ code: number | null; output: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, ['--input-type=module', '-e',
      `import { StartupGuard } from ${JSON.stringify(moduleUrl)}; ${script}`], { stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    proc.stdout.on('data', value => { output += value; });
    proc.stderr.on('data', value => { output += value; });
    const deadline = setTimeout(() => { proc.kill(); reject(new Error('Startup subprocess failed to terminate')); }, 5000);
    proc.on('error', error => { clearTimeout(deadline); reject(error); });
    proc.on('exit', code => { clearTimeout(deadline); resolve({ code, output }); });
  });
}

test('healthy startup returns results and clears deadlines', async () => {
  const result = await child(`const guard = new StartupGuard(1000);
    console.log(await guard.run('sdk_init', async () => 'ready', 100));
    await new Promise(resolve => setTimeout(resolve, 150));`);
  assert.equal(result.code, 0);
  assert.match(result.output, /booking_startup_complete/);
  assert.doesNotMatch(result.output, /booking_startup_timeout/);
});

test('each stalled startup stage exits before late billing or browsing', async () => {
  for (const phase of ['sdk_init','load_input','search_budget','proxy_setup','proxy_preflight','history_setup','detail_budget','failure_reporting']) {
    const result = await child(`const guard = new StartupGuard(1000);
      await guard.run('${phase}', async () => {
        await new Promise(resolve => setTimeout(resolve, 300));
        console.log('UNSAFE_LATE_SIDE_EFFECT');
      }, 30);
      console.log('UNSAFE_CONTINUATION');`);
    assert.equal(result.code, 1, phase);
    assert.match(result.output, /booking_startup_timeout/);
    assert.ok(result.output.includes(`"phase":"${phase}"`));
    assert.doesNotMatch(result.output, /UNSAFE/);
  }
});

test('overall startup deadline bounds individually permitted operations', async () => {
  const result = await child(`const guard = new StartupGuard(100);
    await guard.run('sdk_init', () => new Promise(resolve => setTimeout(resolve, 60)), 500);
    await guard.run('load_input', () => new Promise(resolve => setTimeout(resolve, 150)), 500);`);
  assert.equal(result.code, 1);
  assert.match(result.output, /"phase":"load_input"/);
  assert.match(result.output, /booking_startup_timeout/);
});

test('ordinary failure preserves the error without logging its secret payload', async () => {
  const result = await child(`const guard = new StartupGuard();
    try { await guard.run('proxy_setup', async () => { throw Error('SECRET_TOKEN'); }, 30); }
    catch { console.log('handled'); }
    await new Promise(resolve => setTimeout(resolve, 60));`);
  assert.equal(result.code, 0);
  assert.match(result.output, /booking_startup_failed/);
  assert.doesNotMatch(result.output, /SECRET_TOKEN|booking_startup_timeout/);
});

test('invalid budgets and overlapping phases are rejected', async () => {
  for (const n of [0, -1, NaN, Infinity]) assert.throws(() => new StartupGuard(n));
  const guard = new StartupGuard();
  await assert.rejects(guard.run('sdk_init', async () => null, 0), /Invalid phase/);
  let release!: () => void;
  const first = guard.run('sdk_init', () => new Promise<void>(resolve => { release = resolve; }));
  await assert.rejects(guard.run('load_input', async () => null), /sequential/);
  release(); await first;
});

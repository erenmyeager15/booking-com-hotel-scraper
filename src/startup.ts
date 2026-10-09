/** Only fixed labels are logged: never input URLs, tokens or proxy credentials. */
export type StartupPhase = 'sdk_init' | 'load_input' | 'search_budget' | 'proxy_setup'
  | 'proxy_preflight' | 'history_setup' | 'detail_budget' | 'failure_reporting';

/** An abandoned Promise is not cancellation. Terminate on expiry so a late SDK
 * response cannot resume navigation, billing or history writes after timeout. */
export class StartupGuard {
  private readonly deadline: number;
  private running = false;
  constructor(totalMillis = 60_000) {
    if (!Number.isFinite(totalMillis) || totalMillis <= 0) throw new Error('Invalid startup deadline');
    this.deadline = Date.now() + totalMillis;
  }

  async run<T>(phase: StartupPhase, operation: () => Promise<T>, limitMillis = 20_000): Promise<T> {
    if (this.running) throw new Error('Startup phases must be sequential');
    if (!Number.isFinite(limitMillis) || limitMillis <= 0) throw new Error('Invalid phase deadline');
    const allowed = Math.min(limitMillis, this.deadline - Date.now());
    const timeout = (): never => {
      console.error(JSON.stringify({ event: 'booking_startup_timeout', phase,
        message: 'Startup stopped before crawling. No automatic retry or proxy fallback. Review the failing stage before retrying.' }));
      // SDK/browser handles can otherwise keep the process alive after exitCode=1.
      process.exit(1);
    };
    if (allowed <= 0) timeout();
    this.running = true;
    const started = Date.now();
    console.info(JSON.stringify({ event: 'booking_startup_begin', phase }));
    const timer = setTimeout(timeout, allowed);
    try {
      const result = await operation();
      console.info(JSON.stringify({ event: 'booking_startup_complete', phase, elapsedMillis: Date.now() - started }));
      return result;
    } catch (error) {
      console.error(JSON.stringify({ event: 'booking_startup_failed', phase }));
      throw error;
    } finally {
      clearTimeout(timer);
      this.running = false;
    }
  }
}

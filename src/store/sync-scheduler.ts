import { logCaught, logged } from '@config/src/logging.js';
import type { SyncEngine, SyncResult } from '@config/src/store/sync-engine.js';

/** Timer/debounce policy kept separate from synchronization for deterministic tests. */
export class SyncScheduler {
  private timer: NodeJS.Timeout | null = null;
  private idle: NodeJS.Timeout | null = null;
  private autoSync = false;

  constructor(
    private readonly engine: Pick<SyncEngine, 'syncNow'>,
    private readonly intervalMs = 600_000,
    private readonly idleMs = 1_000,
    private readonly onError: (error: Error) => void = () => {},
  ) {}

  isAutoSync(): boolean {
    return this.autoSync;
  }

  setAutoSync(enabled: boolean): void {
    this.autoSync = enabled;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.run('timer'), this.intervalMs);
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    if (this.idle) clearTimeout(this.idle);
    this.timer = null;
    this.idle = null;
  }

  notifyWrite(): void {
    if (!this.autoSync) return;
    if (this.idle) clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      this.idle = null;
      void this.run('idle');
    }, this.idleMs);
  }

  async syncNow(): Promise<SyncResult> {
    return logged(undefined, 'config.sync.now', { logger: 'store.sync-scheduler' }, () =>
      this.engine.syncNow('manual'),
    );
  }

  private async run(trigger: 'timer' | 'idle'): Promise<void> {
    if (!this.autoSync) return;
    try {
      await this.engine.syncNow(trigger);
    } catch (error) {
      logCaught(error, 'config.sync.scheduler.failed', { logger: 'store.sync-scheduler', trigger });
      this.onError(error as Error);
    }
  }
}

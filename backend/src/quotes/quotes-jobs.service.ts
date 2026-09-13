import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { QuotesLifecycleService } from './quotes-lifecycle.service';
import { quotesEnabled } from './quotes-enabled';

@Injectable()
export class QuotesJobsService implements OnModuleInit, OnModuleDestroy {
  private timers: NodeJS.Timeout[] = [];
  private busy = new Set<string>();
  private readonly logger = new Logger(QuotesJobsService.name);
  constructor(
    private readonly config: ConfigService,
    private readonly lifecycle: QuotesLifecycleService,
  ) {}
  onModuleInit() {
    if (!quotesEnabled(this.config.get<string>('QUOTES_ENABLED'))) return;
    for (const [name, every, run] of [
      ['approval', 60_000, () => this.lifecycle.reconcile()],
      ['expiry', 86_400_000, () => this.lifecycle.expire()],
    ] as const) {
      const timer = setInterval(async () => {
        if (this.busy.has(name)) return;
        this.busy.add(name);
        try {
          await run();
        } catch {
          this.logger.warn(`Quote ${name} reconciliation failed; retry scheduled`);
        } finally {
          this.busy.delete(name);
        }
      }, every);
      timer.unref();
      this.timers.push(timer);
    }
  }
  onModuleDestroy() {
    for (const timer of this.timers) clearInterval(timer);
    this.timers = [];
  }
}

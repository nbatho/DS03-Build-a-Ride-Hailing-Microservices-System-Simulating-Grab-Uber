import { Injectable } from '@nestjs/common';
@Injectable()
export class ReadinessRegistry {
  private readonly checks: Array<() => Promise<void>> = [];
  add(check: () => Promise<void>): void { this.checks.push(check); }
  async verify(): Promise<void> {
    for (const check of this.checks) await check();
  }
}

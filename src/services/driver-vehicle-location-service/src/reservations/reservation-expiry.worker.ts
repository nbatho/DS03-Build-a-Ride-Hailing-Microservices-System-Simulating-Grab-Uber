import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { DataSource } from 'typeorm';
import { runInTransaction } from '@app/runtime';
import { DriverStateService } from '../drivers/driver-state.service';

@Injectable()
export class ReservationExpiryWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: NodeJS.Timeout;
  private running?: Promise<void>;

  constructor(
    private readonly database: DataSource,
    private readonly state: DriverStateService,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => {
      if (this.running) {
        return;
      }

      this.running = this.expireHeldReservations()
        .catch(() =>
          Logger.warn('Reservation expiry failed; will retry on the next tick', 'DriverExpiry'),
        )
        .finally(() => {
          this.running = undefined;
        });
    }, 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  async expireHeldReservations(): Promise<void> {
    const rows = (await this.database.query(`
      SELECT driver_id AS "driverId" FROM driver_schema.reservations
      WHERE status = 'HELD' AND expires_at <= clock_timestamp()
      ORDER BY driver_id LIMIT 100
    `)) as Array<{ driverId: string }>;

    for (const row of rows) {
      await runInTransaction(this.database, async manager => {
        const driver = await this.state.lockDriver(manager, row.driverId);

        await this.state.expireHeld(manager, driver);
      });
    }
  }
}

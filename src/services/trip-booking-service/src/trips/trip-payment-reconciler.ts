import { randomUUID } from 'node:crypto';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import type { Trip } from './entities/trip.entity';
import { PaymentClient } from './payment.client';
import { TripPaymentsService } from './trip-payments.service';

const DEFAULT_INTERVAL_MS = 30_000;
const BATCH_SIZE = 20;

@Injectable()
export class TripPaymentReconciler implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TripPaymentReconciler');

  private timer?: NodeJS.Timeout;

  private running?: Promise<void>;

  private stopping = false;

  constructor(
    private readonly payments: TripPaymentsService,
    private readonly client: PaymentClient,
  ) {}

  onApplicationBootstrap(): void {
    const interval = Number(process.env.TRIP_PAYMENT_RECONCILE_INTERVAL_MS) || DEFAULT_INTERVAL_MS;

    this.timer = setInterval(() => this.tick(), interval);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    clearInterval(this.timer);
    await this.running;
  }

  private tick(): void {
    if (this.running || this.stopping) {
      return;
    }

    this.running = this.poll()
      .catch((error: unknown) => this.logger.warn('Reconcile failed: ' + describe(error)))
      .finally(() => {
        this.running = undefined;
      });
  }

  private async poll(): Promise<void> {
    for (const trip of await this.payments.findUnsettled(BATCH_SIZE)) {
      if (this.stopping) {
        return;
      }

      await this.check(trip).catch((error: unknown) =>
        this.logger.warn('Reconcile of trip ' + trip.id + ' failed: ' + describe(error)),
      );
    }
  }

  private async check(trip: Pick<Trip, 'id' | 'paymentId'>): Promise<void> {
    const payment = await this.client.getPayment(trip.paymentId!, randomUUID());

    if (!payment) {
      this.logger.warn('Trip ' + trip.id + ' waits for payment ' + trip.paymentId);

      return;
    }

    const decision = await this.payments.reconcile(trip.id, payment);

    if (decision === 'MISMATCH') {
      this.logger.error('PAYMENT_MISMATCH: trip ' + trip.id + ' differs from payment ' + payment.id);
    } else if (decision === 'KEEP') {
      this.logger.warn('Trip ' + trip.id + ' keeps waiting, payment is ' + payment.status);
    } else {
      this.logger.log('Trip ' + trip.id + ' reconciled to ' + decision);
    }
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

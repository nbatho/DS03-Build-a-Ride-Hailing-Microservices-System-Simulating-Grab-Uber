import { Injectable } from '@nestjs/common';
import { ApiError } from '@app/runtime';
import { FareRuleEntity } from './entities/fare-rule.entity';

@Injectable()
export class FareCalculator {
  calculateAmount(distanceMeters: number, durationSeconds: number, rule: FareRuleEntity): string {
    if (
      !Number.isInteger(distanceMeters) ||
      distanceMeters < 1 ||
      distanceMeters > 100000 ||
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 1 ||
      durationSeconds > 14400
    ) {
      throw new ApiError(
        400,
        'INVALID_ESTIMATE',
        'Distance must be 1–100000 meters and duration 1–14400 seconds',
      );
    }

    // ceil(a / b) với số nguyên không âm: (a + b - 1) / b.
    const distanceFee = (BigInt(distanceMeters) * BigInt(rule.perKm) + 999n) / 1000n;
    const durationFee = (BigInt(durationSeconds) * BigInt(rule.perMin) + 59n) / 60n;

    return (BigInt(rule.baseFee) + distanceFee + durationFee).toString();
  }
}

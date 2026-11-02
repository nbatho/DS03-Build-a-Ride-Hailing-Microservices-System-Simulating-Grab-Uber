import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import type { Quote } from '@app/contracts';
import { ApiError, withIdempotencyKey } from '@app/runtime';
import { CreateQuoteDto } from './dto/create-quote.dto';
import { FareCalculator } from './fare-calculator';
import { FareRuleEntity } from './entities/fare-rule.entity';
import { QuoteEntity, toQuote } from './entities/quote.entity';

@Injectable()
export class PricingService {
  constructor(
    private readonly database: DataSource,
    private readonly calculator: FareCalculator,
  ) {}

  async createQuote(
    passengerId: string,
    dto: CreateQuoteDto,
    idempotencyKey: string,
  ): Promise<Quote> {
    try {
      const result = await withIdempotencyKey(
        this.database,
        {
          schema: 'pricing_schema',
          actorId: passengerId,
          method: 'POST',
          path: '/api/v1/quotes',
          key: idempotencyKey,
        },
        dto,
        async manager => {
          const rule = await manager.getRepository(FareRuleEntity).findOne({
            where: { vehicleType: 'CAR' },
            order: { createdAt: 'DESC', ruleVersion: 'DESC' },
          });

          if (!rule) {
            throw new ApiError(503, 'PRICING_RULE_UNAVAILABLE', 'No fare rule is available');
          }

          const amount = this.calculator.calculateAmount(
            dto.distanceMeters,
            dto.durationSeconds,
            rule,
          );
          const [time] = (await manager.query(
            `SELECT now() AS "createdAt", now() + interval '300 seconds' AS "expiresAt"`,
          )) as Array<{ createdAt: Date; expiresAt: Date }>;
          const quotes = manager.getRepository(QuoteEntity);
          const quote = quotes.create({
            id: randomUUID(),
            passengerId,
            pickupLat: String(dto.pickup.lat),
            pickupLng: String(dto.pickup.lng),
            pickupZoneId: dto.pickup.zoneId,
            dropoffLat: String(dto.dropoff.lat),
            dropoffLng: String(dto.dropoff.lng),
            dropoffZoneId: dto.dropoff.zoneId,
            distanceMeters: dto.distanceMeters,
            durationSeconds: dto.durationSeconds,
            amount,
            currency: rule.currency,
            ruleVersion: rule.ruleVersion,
            createdAt: time.createdAt,
            expiresAt: time.expiresAt,
          });

          await quotes.insert(quote);

          // Đọc lại giá trị DB đã lưu, gồm tọa độ được làm tròn về 6 chữ số thập phân.
          const saved = await quotes.findOneByOrFail({ id: quote.id });

          return { status: 201, body: toQuote(saved) };
        },
      );

      return result.body;
    } catch (error) {
      if (error instanceof ApiError) {
        throw error;
      }

      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Pricing database unavailable');
    }
  }

  async getMyQuote(passengerId: string, quoteId: string): Promise<Quote> {
    const quote = await this.findQuote(quoteId);

    if (quote.passengerId !== passengerId) {
      throw new ApiError(403, 'RESOURCE_FORBIDDEN', 'This quote belongs to another passenger');
    }

    return toQuote(quote);
  }

  async getQuoteForTrip(quoteId: string): Promise<Quote> {
    return toQuote(await this.findQuote(quoteId));
  }

  private async findQuote(quoteId: string): Promise<QuoteEntity> {
    let quote: QuoteEntity | null;

    try {
      quote = await this.database.getRepository(QuoteEntity).findOneBy({ id: quoteId });
    } catch {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Pricing database unavailable');
    }

    if (!quote) {
      throw new ApiError(404, 'QUOTE_NOT_FOUND', 'Quote not found');
    }

    return quote;
  }
}

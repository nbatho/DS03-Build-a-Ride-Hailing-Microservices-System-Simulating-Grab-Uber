import { Injectable } from '@nestjs/common';
import { DataSource } from 'typeorm';
import {
  ZONE_IDS,
  type Candidate,
  type Candidates,
  type Location,
  type ZoneId,
} from '@app/contracts';
import { ApiError, runInTransaction } from '@app/runtime';
import { DriverStateService } from '../drivers/driver-state.service';
import { throwDriverError } from '../common/database-error';
import { LatestLocationEntity, toLocation, toSequence } from './entities/latest-location.entity';
import { LocationDto } from './dto/location.dto';
import { CandidatesQueryDto } from './dto/candidates-query.dto';

@Injectable()
export class LocationsService {
  constructor(
    private readonly database: DataSource,
    private readonly state: DriverStateService,
  ) {}

  async updateLocation(driverId: string, dto: LocationDto): Promise<Location> {
    if (Math.abs(dto.position.lat) > 90 || Math.abs(dto.position.lng) > 180) {
      throw new ApiError(
        400,
        'INVALID_COORDINATE',
        'Latitude or longitude is outside the valid range',
      );
    }

    const lat = dto.position.lat.toFixed(6);
    const lng = dto.position.lng.toFixed(6);
    const recordedAt = new Date(dto.recordedAt);

    try {
      return await runInTransaction(this.database, async manager => {
        const driver = await this.state.lockDriver(manager, driverId, 409);
        const locations = manager.getRepository(LatestLocationEntity);
        const current = await locations.findOneBy({ driverId: driver.id });

        if (current && dto.sequence < current.sequence) {
          throw new ApiError(
            409,
            'STALE_LOCATION',
            'Location sequence is older than the saved location',
          );
        }

        if (current && dto.sequence === current.sequence) {
          if (
            Number(current.lat) !== Number(lat) ||
            Number(current.lng) !== Number(lng) ||
            current.zoneId !== dto.position.zoneId ||
            current.recordedAt.getTime() !== recordedAt.getTime()
          ) {
            throw new ApiError(
              409,
              'SEQUENCE_CONFLICT',
              'This sequence was already used with another location',
            );
          }

          // Replay trước kiểm tra clock skew; không làm mới receivedAt của GPS cũ.
          return toLocation(current);
        }

        const now = await this.state.now(manager);

        if (Math.abs(now.getTime() - recordedAt.getTime()) > 60000) {
          throw new ApiError(
            400,
            'CLOCK_SKEW',
            'Client time differs from database time by more than 60 seconds',
          );
        }

        const location = locations.create({
          driverId: driver.id,
          lat,
          lng,
          zoneId: dto.position.zoneId,
          sequence: dto.sequence,
          recordedAt,
          receivedAt: now,
        });

        await locations.save(location);

        // GPS không thay đổi version của hồ sơ tài xế.
        return toLocation(location);
      });
    } catch (error) {
      throwDriverError(error);
    }
  }

  async findCandidates(query: CandidatesQueryDto): Promise<Candidates> {
    if (!ZONE_IDS.includes(query.zoneId as ZoneId)) {
      throw new ApiError(400, 'INVALID_ZONE', 'Unknown zone');
    }

    try {
      const now = await this.state.now(this.database.manager);
      const rows = (await this.database.query(
        `
        SELECT d.id AS "driverId", v.id AS "vehicleId", l.zone_id AS "zoneId",
          l.sequence AS "locationSequence", l.received_at AS "locationReceivedAt"
        FROM driver_schema.drivers d
        JOIN driver_schema.vehicles v ON v.driver_id = d.id
        JOIN driver_schema.latest_locations l ON l.driver_id = d.id
        WHERE d.online AND l.zone_id = $1
          AND l.received_at BETWEEN $2::timestamptz - interval '60 seconds' AND $2::timestamptz
          AND NOT EXISTS (
            SELECT 1 FROM driver_schema.reservations r WHERE r.driver_id = d.id
              AND (r.status = 'CONFIRMED' OR (r.status = 'HELD' AND r.expires_at > $2::timestamptz))
          )
        ORDER BY d.id ASC LIMIT $3
      `,
        [query.zoneId, now, query.limit ?? 5],
      )) as Array<
        Omit<Candidate, 'locationSequence' | 'locationReceivedAt'> & {
          locationSequence: string;
          locationReceivedAt: Date;
        }
      >;

      return {
        items: rows.map(row => ({
          ...row,
          locationSequence: toSequence(row.locationSequence),
          locationReceivedAt: row.locationReceivedAt.toISOString(),
        })),
      };
    } catch (error) {
      throwDriverError(error);
    }
  }
}

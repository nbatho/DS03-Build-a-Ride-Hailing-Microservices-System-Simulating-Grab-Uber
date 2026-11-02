import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { Vehicle } from '@app/contracts';

@Entity({ schema: 'driver_schema', name: 'vehicles' })
export class VehicleEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'driver_id', type: 'uuid' })
  driverId!: string;

  @Column({ name: 'plate_number', type: 'varchar', length: 20 })
  plateNumber!: string;

  @Column({ type: 'varchar', length: 80 })
  model!: string;

  @Column({ type: 'varchar', length: 30 })
  color!: string;

  @Column({ name: 'vehicle_type', type: 'text', default: 'CAR' })
  vehicleType!: 'CAR';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export function toVehicle(entity: VehicleEntity): Vehicle {
  return {
    id: entity.id,
    driverId: entity.driverId,
    plateNumber: entity.plateNumber,
    model: entity.model,
    color: entity.color,
    vehicleType: entity.vehicleType,
  };
}

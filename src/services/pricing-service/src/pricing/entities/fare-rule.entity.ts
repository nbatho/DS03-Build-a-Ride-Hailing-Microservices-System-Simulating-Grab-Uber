import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'pricing_schema', name: 'fare_rules' })
export class FareRuleEntity {
  @PrimaryColumn({ name: 'rule_version', type: 'varchar', length: 40 })
  ruleVersion!: string;

  @Column({ name: 'vehicle_type', type: 'text' })
  vehicleType!: 'CAR';

  @Column({ name: 'base_fee', type: 'bigint' })
  baseFee!: string;

  @Column({ name: 'per_km', type: 'bigint' })
  perKm!: string;

  @Column({ name: 'per_min', type: 'bigint' })
  perMin!: string;

  @Column({ type: 'text' })
  currency!: 'VND';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

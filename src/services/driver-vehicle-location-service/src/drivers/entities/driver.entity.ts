import { Column, CreateDateColumn, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'driver_schema', name: 'drivers' })
export class DriverEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ name: 'license_number', type: 'varchar', length: 40 })
  licenseNumber!: string;

  @Column({ type: 'boolean', default: false })
  online!: boolean;

  @Column({ type: 'integer', default: 1 })
  version!: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt!: Date;
}

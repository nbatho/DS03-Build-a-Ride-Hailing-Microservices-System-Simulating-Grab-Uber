import { Column, CreateDateColumn, Entity, PrimaryColumn } from 'typeorm';
import type { User, UserRole } from '@app/contracts';

@Entity({ schema: 'identity_schema', name: 'users' })
export class UserEntity {
  @PrimaryColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 254 })
  email!: string;

  @Column({ name: 'password_hash', type: 'text', select: false })
  passwordHash!: string;

  @Column({ name: 'display_name', type: 'varchar', length: 80 })
  displayName!: string;

  @Column({ type: 'text' })
  role!: UserRole;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}

export function toUser(entity: UserEntity): User {
  return {
    id: entity.id,
    email: entity.email,
    displayName: entity.displayName,
    role: entity.role,
    createdAt: entity.createdAt.toISOString(),
  };
}

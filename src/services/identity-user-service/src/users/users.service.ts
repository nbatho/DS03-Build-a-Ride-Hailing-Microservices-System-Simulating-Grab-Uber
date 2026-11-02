import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, QueryFailedError } from 'typeorm';
import { ApiError } from '@app/runtime';
import type { UserRole } from '@app/contracts';
import { UserEntity } from './entities/user.entity';

@Injectable()
export class UsersService {
  constructor(@InjectRepository(UserEntity) private readonly users: Repository<UserEntity>) {}

  async create(
    email: string,
    displayName: string,
    role: UserRole,
    passwordHash: string,
  ): Promise<UserEntity> {
    const user = this.users.create({
      id: randomUUID(),
      email,
      displayName,
      role,
      passwordHash,
      createdAt: new Date(),
    });

    try {
      await this.users.insert(user);

      return user;
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        (error.driverError as { code?: string; constraint?: string }).code === '23505' &&
        (error.driverError as { constraint?: string }).constraint === 'uq_users_email'
      ) {
        throw new ApiError(409, 'EMAIL_EXISTS', 'Email is already registered');
      }

      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Identity database unavailable');
    }
  }

  async findForLogin(email: string): Promise<UserEntity | null> {
    try {
      return await this.users
        .createQueryBuilder('user')
        .addSelect('user.passwordHash')
        .where('user.email = :email', { email })
        .getOne();
    } catch {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Identity database unavailable');
    }
  }

  async findById(id: string): Promise<UserEntity | null> {
    try {
      return await this.users.findOneBy({ id });
    } catch {
      throw new ApiError(503, 'DEPENDENCY_UNAVAILABLE', 'Identity database unavailable');
    }
  }
}

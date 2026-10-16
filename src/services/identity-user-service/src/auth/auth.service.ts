import { randomUUID } from 'node:crypto';
import { Injectable, OnModuleInit } from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';
import * as bcrypt from 'bcrypt';
import { ApiError } from '@app/runtime';
import type { LoginResponse, User } from '@app/contracts';
import { signingOptions } from '@app/auth';
import { UsersService } from '../users/users.service';
import { toUser } from '../users/entities/user.entity';
import { LoginRequest, RegisterRequest } from './dto/auth.dto';

@Injectable()
export class AuthService implements OnModuleInit {
  private dummyHash!: string;

  private readonly rounds = Number(process.env.BCRYPT_ROUNDS ?? '10');

  private readonly options = signingOptions(process.env);

  constructor(
    private readonly users: UsersService,
    private readonly jwt: JwtService,
  ) {
    if (!Number.isInteger(this.rounds) || this.rounds < 10 || this.rounds > 14) {
      throw new Error('BCRYPT_ROUNDS must be an integer from 10 to 14');
    }
  }

  async onModuleInit(): Promise<void> {
    this.dummyHash = await bcrypt.hash(randomUUID(), this.rounds);
  }

  async register(body: RegisterRequest): Promise<User> {
    const hash = await bcrypt.hash(body.password, this.rounds);

    return toUser(await this.users.create(body.email, body.displayName, body.role, hash));
  }

  async login(body: LoginRequest): Promise<LoginResponse> {
    const user = await this.users.findForLogin(body.email);
    const matches = await bcrypt.compare(body.password, user?.passwordHash ?? this.dummyHash);

    if (!user || !matches) {
      throw new ApiError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
    }

    const accessToken = await this.jwt.signAsync(
      { role: user.role },
      {
        privateKey: this.options.privateKey,
        algorithm: 'RS256',
        issuer: this.options.issuer,
        audience: this.options.audience,
        subject: user.id,
        expiresIn: this.options.ttl,
      },
    );

    return { accessToken, tokenType: 'Bearer', expiresIn: this.options.ttl, user: toUser(user) };
  }
}

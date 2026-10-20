import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '@app/auth';
import type { LoginResponse, User } from '@app/contracts';
import { AuthService } from './auth.service';
import { LoginRequest, RegisterRequest } from './dto/auth.dto';

@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  // API-01: email chuẩn hóa và duy nhất; đăng ký DRIVER chỉ tạo tài khoản, chưa tạo hồ sơ tài xế.
  @Public()
  @Post('register')
  register(@Body() body: RegisterRequest): Promise<User> {
    return this.auth.register(body);
  }

  // API-02: JWT RS256 hạn 3600 giây; giới hạn 10 lần/60 giây/IP, tính cả thành công và thất bại.
  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000, blockDuration: 60000 } })
  login(@Body() body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body);
  }
}

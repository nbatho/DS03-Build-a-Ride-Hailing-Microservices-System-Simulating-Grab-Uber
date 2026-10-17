import { Body, Controller, HttpCode, Post, UseGuards } from '@nestjs/common';
import {
  ApiBody,
  ApiCreatedResponse,
  ApiExtraModels,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  getSchemaPath,
} from '@nestjs/swagger';
import { Throttle, ThrottlerGuard } from '@nestjs/throttler';
import { Public } from '@app/auth';
import type { LoginResponse, User } from '@app/contracts';
import { ApiIdentityError } from '../docs/api-error.decorator';
import { AuthService } from './auth.service';
import { LoginRequest, RegisterRequest } from './dto/auth.dto';

@ApiTags('Auth')
@ApiExtraModels(RegisterRequest, LoginRequest)
@Controller('auth')
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Public()
  @Post('register')
  @ApiOperation({
    operationId: 'API-01',
    summary: 'Đăng ký tài khoản PASSENGER hoặc DRIVER',
    security: [],
    description:
      'Email được chuẩn hóa và phải duy nhất. Field ngoài DTO bị từ chối. Đăng ký DRIVER chỉ tạo tài khoản Identity, chưa tạo hồ sơ tài xế hoặc xe.',
  })
  @ApiBody({
    required: true,
    schema: { $ref: getSchemaPath(RegisterRequest) },
    examples: {
      passenger: {
        summary: 'Tài khoản hành khách',
        value: {
          email: 'passenger.manual01@example.com',
          password: 'ManualTest!2026',
          displayName: 'Hành khách test',
          role: 'PASSENGER',
        },
      },
      driver: {
        summary: 'Tài khoản tài xế',
        value: {
          email: 'driver.manual01@example.com',
          password: 'ManualTest!2026',
          displayName: 'Tài xế test',
          role: 'DRIVER',
        },
      },
    },
  })
  @ApiCreatedResponse({
    description: 'Tạo tài khoản thành công; không trả password hoặc hash.',
    schema: { $ref: '#/components/schemas/User' },
  })
  @ApiIdentityError(400, 'VALIDATION_ERROR', 'Dữ liệu đăng ký hoặc X-Correlation-Id không hợp lệ.')
  @ApiIdentityError(409, 'EMAIL_EXISTS', 'Email đã được đăng ký.')
  @ApiIdentityError(413, 'PAYLOAD_TOO_LARGE', 'JSON body vượt quá 64 KiB.')
  @ApiIdentityError(503, 'DEPENDENCY_UNAVAILABLE', 'Database Identity không truy cập được.')
  register(@Body() body: RegisterRequest): Promise<User> {
    return this.auth.register(body);
  }

  @Public()
  @Post('login')
  @HttpCode(200)
  @UseGuards(ThrottlerGuard)
  @Throttle({ default: { limit: 10, ttl: 60000, blockDuration: 60000 } })
  @ApiOperation({
    operationId: 'API-02',
    summary: 'Đăng nhập và nhận JWT',
    security: [],
    description:
      'JWT RS256 có thời hạn 3600 giây. Copy accessToken vào Authorize, không thêm chữ Bearer. Giới hạn 10 lần/60 giây/IP, tính cả thành công và thất bại.',
  })
  @ApiBody({ required: true, type: LoginRequest })
  @ApiOkResponse({
    description: 'Đăng nhập thành công: accessToken, tokenType, expiresIn và user.',
    schema: { $ref: '#/components/schemas/LoginResponse' },
  })
  @ApiIdentityError(400, 'VALIDATION_ERROR', 'Email, password hoặc X-Correlation-Id không hợp lệ.')
  @ApiIdentityError(401, 'INVALID_CREDENTIALS', 'Email hoặc password sai.')
  @ApiIdentityError(413, 'PAYLOAD_TOO_LARGE', 'JSON body vượt quá 64 KiB.')
  @ApiIdentityError(429, 'RATE_LIMITED', 'Vượt quá 10 lần đăng nhập/60 giây/IP.')
  @ApiIdentityError(503, 'DEPENDENCY_UNAVAILABLE', 'Database Identity không truy cập được.')
  login(@Body() body: LoginRequest): Promise<LoginResponse> {
    return this.auth.login(body);
  }
}

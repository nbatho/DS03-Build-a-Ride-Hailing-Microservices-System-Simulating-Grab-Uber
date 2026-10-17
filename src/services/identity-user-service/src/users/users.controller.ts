import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '@app/auth';
import type { Actor, User } from '@app/contracts';
import { ApiError } from '@app/runtime';
import { UsersService } from './users.service';
import { toUser } from './entities/user.entity';
import { EmptyQueryDto } from './dto/empty-query.dto';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { ApiIdentityError } from '../docs/api-error.decorator';

@ApiTags('Users')
@ApiBearerAuth('bearerAuth')
@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @Get('me')
  @ApiOperation({
    operationId: 'API-03',
    summary: 'Lấy tài khoản đang đăng nhập',
    description:
      'Chấp nhận JWT của PASSENGER và DRIVER. User được xác định từ sub trong JWT; không nhận query userId hoặc field query khác. Response không chứa password/hash.',
  })
  @ApiOkResponse({
    description: 'Thông tin tài khoản hiện tại.',
    schema: { $ref: '#/components/schemas/User' },
  })
  @ApiIdentityError(400, 'VALIDATION_ERROR', 'Không nhận query hoặc X-Correlation-Id không hợp lệ.')
  @ApiIdentityError(401, 'INVALID_TOKEN', 'JWT thiếu, sai, hết hạn hoặc user không tồn tại.')
  @ApiIdentityError(503, 'DEPENDENCY_UNAVAILABLE', 'Database Identity không truy cập được.')
  async me(@CurrentUser() actor: Actor, @Query() _query: EmptyQueryDto): Promise<User> {
    const user = await this.users.findById(actor.userId);

    if (!user) {
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid access token');
    }

    return toUser(user);
  }
}

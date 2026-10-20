import { Controller, Get, Query } from '@nestjs/common';
import { CurrentUser } from '@app/auth';
import type { Actor, User } from '@app/contracts';
import { ApiError } from '@app/runtime';
import { UsersService } from './users.service';
import { toUser } from './entities/user.entity';
import { EmptyQueryDto } from './dto/empty-query.dto';

@Controller('users')
export class UsersController {
  constructor(private readonly users: UsersService) {}

  // API-03: user lấy từ sub trong JWT; không nhận query userId hay field query khác.
  @Get('me')
  async me(@CurrentUser() actor: Actor, @Query() _query: EmptyQueryDto): Promise<User> {
    const user = await this.users.findById(actor.userId);

    if (!user) {
      throw new ApiError(401, 'INVALID_TOKEN', 'Invalid access token');
    }

    return toUser(user);
  }
}

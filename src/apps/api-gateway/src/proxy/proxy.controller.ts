import { All, Controller, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@app/auth';
import { ProxyService } from './proxy.service';

// Gateway kiểm tra JWT trước khi chuyển tiếp (trừ đăng ký/đăng nhập); service phía sau vẫn tự kiểm tra JWT và quyền chủ.
@Controller()
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}

  @Public()
  @Post('auth/register')
  register(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward(req, res);
  }

  @Public()
  @Post('auth/login')
  login(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward(req, res);
  }

  /** Mọi đường khác dưới /api/v1: chỉ chuyển tiếp nếu có trong GATEWAY_ROUTES. */
  @All('*path')
  any(@Req() req: Request, @Res() res: Response): Promise<void> {
    return this.proxy.forward(req, res);
  }
}

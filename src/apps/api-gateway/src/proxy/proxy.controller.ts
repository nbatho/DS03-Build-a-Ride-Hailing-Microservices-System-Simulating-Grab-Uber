import { Controller, Get, Post, Req, Res } from '@nestjs/common';
import type { Request, Response } from 'express';
import { Public } from '@app/auth';
import { ProxyService } from './proxy.service';
@Controller()
export class ProxyController {
  constructor(private readonly proxy: ProxyService) {}
  @Public() @Post('auth/register')
  register(@Req() req: Request, @Res() res: Response) { return this.proxy.identity(req, res); }
  @Public() @Post('auth/login')
  login(@Req() req: Request, @Res() res: Response) { return this.proxy.identity(req, res); }
  @Get('users/me')
  me(@Req() req: Request, @Res() res: Response) { return this.proxy.identity(req, res); }
}

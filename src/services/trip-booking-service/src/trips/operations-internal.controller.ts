import { Body, Controller, HttpCode, Param, Post, Req } from '@nestjs/common';
import type { Operation } from '@app/contracts';
import { CurrentCaller, InternalRoute, uuidParam, type ContextRequest } from '@app/runtime';
import type { InternalCaller } from '@app/shared-types';
import { RetryOperationDto } from './dto/retry-operation.dto';
import { OperationRetryService } from './operation-retry.service';

@InternalRoute('OPS')
@Controller('internal/v1/operations')
export class OperationsInternalController {
  constructor(private readonly retries: OperationRetryService) {}

  @Post(':operationId/retry')
  @HttpCode(202)
  retry(
    @Param('operationId', uuidParam('operationId')) operationId: string,
    @Body() dto: RetryOperationDto,
    @CurrentCaller() caller: InternalCaller,
    @Req() req: ContextRequest,
  ): Promise<Operation> {
    return this.retries.retry(operationId.toLowerCase(), dto, caller, req.correlationId);
  }
}

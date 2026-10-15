import { Injectable, NotImplementedException } from '@nestjs/common';
import { FareRuleEntity } from './entities/fare-rule.entity';

@Injectable()
export class FareCalculator {
  calculateAmount(distanceMeters: number, durationSeconds: number, rule: FareRuleEntity): never {
    // TODO: Tính giá bằng BigInt, làm tròn lên từng thành phần và trả tiền dưới dạng chuỗi.
    throw new NotImplementedException('FareCalculator.calculateAmount TODO');
  }
}

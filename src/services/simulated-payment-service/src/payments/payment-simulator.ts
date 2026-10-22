import { randomInt } from 'node:crypto';

// Mô phỏng cổng thanh toán (BA mục 2.1, 9.2 "mô phỏng thanh toán lỗi"). Không thu tiền thật.
// PAYMENT_SIMULATION_MODE:
//   SUCCEED     mọi lần thử thành công (mặc định)
//   FAIL_ONCE   lần thử 1 lỗi tạm thời, các lần sau thành công (demo thử lại)
//   TEMPORARY   mọi lần thử lỗi tạm thời (hết 3 lần thì thất bại)
//   FINAL       lỗi cuối ngay lần đầu, không thử lại
//   RANDOM      lỗi tạm thời với xác suất PAYMENT_FAILURE_RATE (0–1)

export const PAYMENT_SIMULATION_MODES = ['SUCCEED', 'FAIL_ONCE', 'TEMPORARY', 'FINAL', 'RANDOM'] as const;
export type PaymentSimulationMode = (typeof PAYMENT_SIMULATION_MODES)[number];

export type SimulatedOutcome = 'SUCCESS' | 'TEMPORARY_FAILURE' | 'FINAL_FAILURE';

export interface SimulatorConfig {
  mode: PaymentSimulationMode;
  failureRate: number;
}

export function loadSimulatorConfig(env: NodeJS.ProcessEnv): SimulatorConfig {
  const mode = (env.PAYMENT_SIMULATION_MODE?.trim() || 'SUCCEED').toUpperCase();

  if (!(PAYMENT_SIMULATION_MODES as readonly string[]).includes(mode)) {
    throw new Error('PAYMENT_SIMULATION_MODE must be one of ' + PAYMENT_SIMULATION_MODES.join(', '));
  }

  const failureRate = Number(env.PAYMENT_FAILURE_RATE?.trim() || '0.2');

  if (!Number.isFinite(failureRate) || failureRate < 0 || failureRate > 1) {
    throw new Error('PAYMENT_FAILURE_RATE must be a number between 0 and 1');
  }

  return { mode: mode as PaymentSimulationMode, failureRate };
}

export function simulateCharge(
  config: SimulatorConfig,
  attemptNo: number,
  random: () => number = () => randomInt(1_000_000) / 1_000_000,
): SimulatedOutcome {
  switch (config.mode) {
    case 'SUCCEED':
      return 'SUCCESS';
    case 'FAIL_ONCE':
      return attemptNo === 1 ? 'TEMPORARY_FAILURE' : 'SUCCESS';
    case 'TEMPORARY':
      return 'TEMPORARY_FAILURE';
    case 'FINAL':
      return 'FINAL_FAILURE';
    case 'RANDOM':
      return random() < config.failureRate ? 'TEMPORARY_FAILURE' : 'SUCCESS';
  }
}

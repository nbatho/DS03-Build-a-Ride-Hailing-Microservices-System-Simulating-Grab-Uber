// Kiểu miền của Payment dùng chung cho entity, bộ mô phỏng và quy tắc (cột payment_attempts.result).
export type AttemptOutcome = 'SUCCESS' | 'TEMPORARY_FAILURE' | 'FINAL_FAILURE';

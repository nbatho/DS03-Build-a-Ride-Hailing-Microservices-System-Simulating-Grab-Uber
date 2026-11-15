/** Lỗi PostgreSQL 23505 trên đúng unique constraint `constraint` (TypeORM bọc lỗi gốc trong driverError). */
export function isUniqueViolation(error: unknown, constraint: string): boolean {
  const failure = error as { driverError?: { code?: string; constraint?: string } };

  return failure.driverError?.code === '23505' && failure.driverError.constraint === constraint;
}

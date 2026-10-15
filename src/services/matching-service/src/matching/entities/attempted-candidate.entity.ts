// TODO: Ánh xạ matching_schema.attempted_candidates bằng ORM và đăng ký với kết nối DB.
// TODO: PK(jobId,driverId); không mời lại; giới hạn 5 kiểm tra trong transaction khóa job.
export class AttemptedCandidateEntity {
  declare jobId: string;
  declare driverId: string;
  declare attemptedAt: Date;
}

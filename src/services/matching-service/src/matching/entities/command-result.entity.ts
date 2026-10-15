// TODO: Ánh xạ matching_schema.command_results bằng ORM và đăng ký với kết nối DB.
// TODO: DECISION dùng assignmentId; CANCEL/RESOLUTION dùng commandId; lưu resource trong hash.
export class CommandResultEntity {
  declare callerService: string;
  declare commandType: string;
  declare commandId: string;
  declare resourceId: string;
  declare requestHash: string;
  declare responseStatus: number;
  declare responseBody: unknown;
  declare correlationId: string;
  declare createdAt: Date;
}

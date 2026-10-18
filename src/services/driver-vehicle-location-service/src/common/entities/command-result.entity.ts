// TODO: Ánh xạ driver_schema.command_results bằng ORM và đăng ký với kết nối DB.
// TODO: unique caller/type/commandId; cùng ID khác payload conflict; RESERVE dùng reservationId.
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

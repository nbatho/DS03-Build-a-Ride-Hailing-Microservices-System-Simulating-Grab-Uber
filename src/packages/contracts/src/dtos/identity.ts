export const USER_ROLES = ['PASSENGER', 'DRIVER'] as const;
export type UserRole = typeof USER_ROLES[number];
export interface User {
  id: string;
  email: string;
  displayName: string;
  role: UserRole;
  createdAt: string;
}
export interface LoginResponse {
  accessToken: string;
  tokenType: 'Bearer';
  expiresIn: number;
  user: User;
}
export interface Actor { userId: string; role: UserRole }

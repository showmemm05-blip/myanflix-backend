import type { Role, User, UserStatus } from '../../generated/prisma/client';

export class StaffResponseDto {
  id: string;
  username: string;
  role: Role;
  status: UserStatus;
  lastLoginAt: Date | null;
  createdAt: Date;

  static fromEntity(user: User): StaffResponseDto {
    const dto = new StaffResponseDto();
    dto.id = user.id;
    dto.username = user.username;
    dto.role = user.role;
    dto.status = user.status;
    dto.lastLoginAt = user.lastLoginAt;
    dto.createdAt = user.createdAt;
    return dto;
  }
}

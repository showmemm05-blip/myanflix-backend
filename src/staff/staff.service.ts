import {
  ConflictException,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Role, UserStatus, type User } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { STAFF_ROLES, type CreateStaffDto } from './dto/create-staff.dto';
import type { UpdateStaffDto } from './dto/update-staff.dto';
import type { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import type { UpdateStaffStatusDto } from './dto/update-staff-status.dto';

const PASSWORD_SALT_ROUNDS = 10;

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
  ) {}

  async findAll(): Promise<User[]> {
    return this.prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(dto: CreateStaffDto): Promise<User> {
    const existing = await this.usersService.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException('Username is already taken');
    }

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    return this.usersService.create({
      username: dto.username,
      password: passwordHash,
      role: dto.role,
    });
  }

  async updateStaffFields(
    id: string,
    dto: UpdateStaffDto,
    currentUser: AuthenticatedUser,
  ): Promise<User> {
    const target = await this.usersService.findByIdOrThrow(id);

    if (dto.role !== undefined && id === currentUser.id) {
      throw new ForbiddenException(
        'You cannot change your own role. Ask another Super Admin to do this.',
      );
    }

    if (
      dto.role !== undefined &&
      dto.role !== Role.SUPER_ADMIN &&
      target.role === Role.SUPER_ADMIN
    ) {
      await this.assertNotLastActiveSuperAdmin(id);
    }

    if (dto.username !== undefined && dto.username !== target.username) {
      const existing = await this.usersService.findByUsername(dto.username);
      if (existing) {
        throw new ConflictException('Username is already taken');
      }
    }

    return this.prisma.user.update({
      where: { id },
      data: {
        ...(dto.username !== undefined && { username: dto.username }),
        ...(dto.role !== undefined && { role: dto.role }),
      },
    });
  }

  async resetPassword(id: string, dto: ResetStaffPasswordDto): Promise<void> {
    await this.usersService.findByIdOrThrow(id);
    const passwordHash = await bcrypt.hash(
      dto.newPassword,
      PASSWORD_SALT_ROUNDS,
    );
    await this.prisma.user.update({
      where: { id },
      data: { password: passwordHash },
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateStaffStatusDto,
    currentUser: AuthenticatedUser,
  ): Promise<User> {
    if (id === currentUser.id) {
      throw new ForbiddenException('You cannot deactivate your own account.');
    }

    const target = await this.usersService.findByIdOrThrow(id);

    if (
      dto.status === UserStatus.SUSPENDED &&
      target.role === Role.SUPER_ADMIN
    ) {
      await this.assertNotLastActiveSuperAdmin(id);
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
    });
  }

  async remove(id: string, currentUser: AuthenticatedUser): Promise<void> {
    if (id === currentUser.id) {
      throw new ForbiddenException('You cannot delete your own account.');
    }

    const target = await this.usersService.findByIdOrThrow(id);

    if (target.role === Role.SUPER_ADMIN) {
      await this.assertNotLastActiveSuperAdmin(id);
    }

    await this.prisma.user.delete({ where: { id } });
  }

  /** Guards against removing/demoting/deactivating the only remaining active Super Admin. */
  private async assertNotLastActiveSuperAdmin(
    excludeId: string,
  ): Promise<void> {
    const otherActiveSuperAdmins = await this.prisma.user.count({
      where: {
        role: Role.SUPER_ADMIN,
        status: UserStatus.ACTIVE,
        NOT: { id: excludeId },
      },
    });
    if (otherActiveSuperAdmins === 0) {
      throw new ConflictException(
        'At least one active Super Admin must remain.',
      );
    }
  }
}

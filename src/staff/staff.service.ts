import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Role, UserStatus } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from '../users/users.service';
import { AuthorityService } from '../roles/authority.service';
import { isSystemRoleKey } from '../roles/system-roles.seed';
import type { AuthenticatedUser } from '../auth/types/authenticated-user.type';
import { STAFF_ROLES, type CreateStaffDto } from './dto/create-staff.dto';
import type { UpdateStaffDto } from './dto/update-staff.dto';
import type { ResetStaffPasswordDto } from './dto/reset-staff-password.dto';
import type { UpdateStaffStatusDto } from './dto/update-staff-status.dto';
import type { StaffUser } from './dto/staff-response.dto';

const PASSWORD_SALT_ROUNDS = 10;

/** Every staff read carries the assigned AppRole so the list can name it. */
const STAFF_INCLUDE = {
  appRole: { select: { id: true, key: true, name: true } },
} as const;

/** What an assignment change resolves to: the enum kind AND the AppRole id. */
interface StaffRoleAssignment {
  role: (typeof STAFF_ROLES)[number];
  appRoleId: string | null;
}

@Injectable()
export class StaffService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly usersService: UsersService,
    private readonly authority: AuthorityService,
  ) {}

  async findAll(): Promise<StaffUser[]> {
    return this.prisma.user.findMany({
      where: { role: { in: [...STAFF_ROLES] } },
      orderBy: { createdAt: 'desc' },
      include: STAFF_INCLUDE,
    });
  }

  /**
   * F1: STAFF.CREATE on its own used to be a route to Super Admin — create the
   * account, log in as it. The new account's authority now goes through the
   * same two gates as any other assignment: only a Super Admin can mint a
   * Super Admin-tier account (P2), and nobody can hand the new account
   * permissions they do not hold themselves (P1).
   */
  async create(
    dto: CreateStaffDto,
    actor: AuthenticatedUser,
  ): Promise<StaffUser> {
    const existing = await this.usersService.findByUsername(dto.username);
    if (existing) {
      throw new ConflictException('Username is already taken');
    }

    const assignment = await this.resolveAssignment(
      dto.appRoleId,
      dto.role,
      dto.role,
    );
    await this.authority.assertCanAssignRole(actor, assignment);

    const passwordHash = await bcrypt.hash(dto.password, PASSWORD_SALT_ROUNDS);
    const created = await this.usersService.create({
      username: dto.username,
      password: passwordHash,
      role: assignment.role,
      ...(assignment.appRoleId && { appRoleId: assignment.appRoleId }),
    });
    return this.findStaffOrThrow(created.id);
  }

  async updateStaffFields(
    id: string,
    dto: UpdateStaffDto,
    currentUser: AuthenticatedUser,
  ): Promise<StaffUser> {
    const target = await this.findStaffOrThrow(id);
    const changesRole = dto.role !== undefined || dto.appRoleId !== undefined;

    if (changesRole && id === currentUser.id) {
      throw new ForbiddenException(
        'You cannot change your own role. Ask another Super Admin to do this.',
      );
    }

    const assignment = changesRole
      ? await this.resolveAssignment(dto.appRoleId, dto.role, target.role)
      : null;

    if (assignment) {
      // F3: a Super Admin's role is only another Super Admin's to change.
      if (await this.authority.isSuperAdminTier(target)) {
        await this.authority.assertActorIsSuperAdmin(currentUser);
      }
      // F1/P1 + P2: you cannot hand out a tier or a permission set you lack.
      await this.authority.assertCanAssignRole(currentUser, assignment);

      // F6: on the EFFECTIVE axis — a move onto a custom AppRole takes the
      // protected role away just as surely as a change of the enum does.
      if (
        (await this.authority.isEffectiveSuperAdmin(target)) &&
        !(await this.authority.isEffectiveSuperAdmin(assignment))
      ) {
        await this.authority.assertNotLastActiveSuperAdmin(id);
      }

      // F8: the same lockout guard on the roles-manager axis.
      await this.authority.assertNotLastRoleManagerAccount(
        { id, role: target.role, appRoleId: target.appRoleId },
        assignment,
      );
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
        ...(assignment && {
          role: assignment.role,
          appRoleId: assignment.appRoleId,
        }),
      },
      include: STAFF_INCLUDE,
    });
  }

  /**
   * F3: resetting a password is a full account takeover, so a Super Admin's
   * password is only another Super Admin's to reset — STAFF.EDIT alone used to
   * be enough to log in as one.
   */
  async resetPassword(
    id: string,
    dto: ResetStaffPasswordDto,
    currentUser: AuthenticatedUser,
  ): Promise<void> {
    const target = await this.usersService.findByIdOrThrow(id);
    if (await this.authority.isSuperAdminTier(target)) {
      await this.authority.assertActorIsSuperAdmin(currentUser);
    }
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
  ): Promise<StaffUser> {
    if (id === currentUser.id) {
      throw new ForbiddenException('You cannot deactivate your own account.');
    }

    const target = await this.usersService.findByIdOrThrow(id);

    if (await this.authority.isSuperAdminTier(target)) {
      // F3: suspending a Super Admin is modifying one.
      await this.authority.assertActorIsSuperAdmin(currentUser);
    }

    if (dto.status === UserStatus.SUSPENDED) {
      if (await this.authority.isEffectiveSuperAdmin(target)) {
        await this.authority.assertNotLastActiveSuperAdmin(id);
      }
      // F8: suspending the last roles manager locks everyone out just as
      // effectively as stripping the permission would.
      await this.authority.assertNotLastRoleManagerAccount(
        { id, role: target.role, appRoleId: target.appRoleId },
        null,
      );
    }

    return this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
      include: STAFF_INCLUDE,
    });
  }

  async remove(id: string, currentUser: AuthenticatedUser): Promise<void> {
    if (id === currentUser.id) {
      throw new ForbiddenException('You cannot delete your own account.');
    }

    const target = await this.usersService.findByIdOrThrow(id);

    if (await this.authority.isSuperAdminTier(target)) {
      // P2: deleting a Super Admin is the most complete modification there is.
      await this.authority.assertActorIsSuperAdmin(currentUser);
    }

    if (await this.authority.isEffectiveSuperAdmin(target)) {
      await this.authority.assertNotLastActiveSuperAdmin(id);
    }
    // F8: same lockout on the roles-manager axis.
    await this.authority.assertNotLastRoleManagerAccount(
      { id, role: target.role, appRoleId: target.appRoleId },
      null,
    );

    await this.prisma.user.delete({ where: { id } });
  }

  private async findStaffOrThrow(id: string): Promise<StaffUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: STAFF_INCLUDE,
    });
    if (!user) throw new NotFoundException('User not found');
    return user;
  }

  /**
   * Resolves a role change into both axes at once.
   *
   * An explicit `appRoleId` wins: if it names one of the built-in roles the
   * legacy enum moves with it, and if it names a custom role the enum stays
   * where it was (custom roles are staff-tier by definition, and nothing
   * outside RBAC knows about them). With no `appRoleId`, changing the enum
   * moves the assignment onto that built-in role — which is exactly what the
   * enum meant before AppRoles existed.
   */
  private async resolveAssignment(
    appRoleId: string | undefined,
    role: (typeof STAFF_ROLES)[number] | undefined,
    fallbackRole: Role,
  ): Promise<StaffRoleAssignment> {
    if (appRoleId) {
      const appRole = await this.prisma.appRole.findUnique({
        where: { id: appRoleId },
        select: { id: true, key: true },
      });
      if (!appRole) throw new NotFoundException('Role not found');
      if (appRole.key === Role.USER) {
        throw new BadRequestException(
          'Staff accounts cannot be assigned the end-user role.',
        );
      }
      const nextRole = isSystemRoleKey(appRole.key)
        ? (appRole.key as (typeof STAFF_ROLES)[number])
        : ((role ?? fallbackRole) as (typeof STAFF_ROLES)[number]);
      return { role: nextRole, appRoleId: appRole.id };
    }

    const nextRole = (role ?? fallbackRole) as (typeof STAFF_ROLES)[number];
    const systemRole = await this.prisma.appRole.findUnique({
      where: { key: nextRole },
      select: { id: true },
    });
    return { role: nextRole, appRoleId: systemRole?.id ?? null };
  }
}

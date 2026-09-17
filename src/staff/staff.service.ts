import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import * as bcrypt from 'bcrypt';
import { Role } from '../generated/prisma/client';
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
import { AuditService } from '../audit/audit.service';
import { userSnapshot } from '../audit/audit-snapshots';

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
    private readonly audit: AuditService,
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
    const staff = await this.findStaffOrThrow(created.id);

    // The snapshot picker never reads the password hash — only the account
    // identity and its assignment reach the log.
    await this.audit.record({
      action: 'staff.create',
      actor,
      target: { type: 'staff', id: staff.id, label: `@${staff.username}` },
      after: userSnapshot(staff),
    });
    return staff;
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
      // F1/P1 + P2: you cannot hand out a tier or a permission set you lack —
      // nor (F-004) take away one you lack by moving the account off it.
      await this.authority.assertCanAssignRole(currentUser, assignment, {
        role: target.role,
        appRoleId: target.appRoleId,
      });

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

    const updated = await this.prisma.user.update({
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

    // A change on either axis is a role change; anything else (a rename) is
    // a plain update, which the log skips when nothing actually differs.
    const roleChanged =
      updated.role !== target.role || updated.appRoleId !== target.appRoleId;
    await this.audit.record({
      action: roleChanged ? 'staff.role_change' : 'staff.update',
      actor: currentUser,
      target: { type: 'staff', id, label: `@${updated.username}` },
      before: userSnapshot(target),
      after: userSnapshot(updated),
    });
    // Their own next audit rows must carry the new role name, not the cached one.
    this.audit.invalidateActorCache(id);
    return updated;
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
    const target = await this.findStaffOrThrow(id);
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

    // Pure event: the fact of the reset is what matters — no values, ever.
    await this.audit.record({
      action: 'staff.password_reset',
      actor: currentUser,
      target: { type: 'staff', id, label: `@${target.username}` },
    });
  }

  async updateStatus(
    id: string,
    dto: UpdateStaffStatusDto,
    currentUser: AuthenticatedUser,
  ): Promise<StaffUser> {
    const target = await this.findStaffOrThrow(id);

    // F3/F8: self, Super Admin tier (P2) and both lockout guards — the same
    // gate PATCH /users/:id/status runs, so the two routes cannot drift.
    await this.authority.assertCanChangeStatus(
      currentUser,
      { id, role: target.role, appRoleId: target.appRoleId },
      dto.status,
    );

    const updated = await this.prisma.user.update({
      where: { id },
      data: { status: dto.status },
      include: STAFF_INCLUDE,
    });

    // A status change never touches the assignment, so the AppRole loaded
    // with the update names the "before" side too.
    await this.audit.record({
      action: 'staff.status_change',
      actor: currentUser,
      target: { type: 'staff', id, label: `@${updated.username}` },
      before: userSnapshot({ ...target, appRole: updated.appRole }),
      after: userSnapshot(updated),
    });
    return updated;
  }

  async remove(id: string, currentUser: AuthenticatedUser): Promise<void> {
    if (id === currentUser.id) {
      throw new ForbiddenException('You cannot delete your own account.');
    }

    const target = await this.findStaffOrThrow(id);

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

    // Deleting the row leaves the avatar bytes behind, and nothing else will
    // ever reach them: the key lived only in the column that just went away.
    // Best-effort by design (it never throws) — the deletion is the
    // user-facing action, orphaned objects are a storage concern.
    await this.usersService.deleteAvatarObjects(id);

    // The row was loaded with its AppRole, so the "before" side still names
    // the assignment the delete just took away.
    await this.audit.record({
      action: 'staff.delete',
      actor: currentUser,
      target: { type: 'staff', id, label: `@${target.username}` },
      before: userSnapshot(target),
    });
  }

  /**
   * The single gate every /staff/:id mutation loads its target through. A row
   * outside the staff tier (a subscriber) answers 404 exactly as it does on
   * the read side (`findAll` filters on the same list) — F-005: STAFF.EDIT used
   * to be enough to reset any subscriber's password, and STAFF.DELETE to
   * cascade-delete a subscriber and their ledger. Keyed off the `role` enum
   * on purpose: assigning a custom AppRole to a subscriber must not widen it.
   */
  private async findStaffOrThrow(id: string): Promise<StaffUser> {
    const user = await this.prisma.user.findUnique({
      where: { id },
      include: STAFF_INCLUDE,
    });
    if (!user || !(STAFF_ROLES as readonly Role[]).includes(user.role)) {
      throw new NotFoundException('Staff account not found');
    }
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

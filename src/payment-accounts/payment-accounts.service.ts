import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, Role } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { Permission } from '../roles/permission.enum';
import { roleHasPermission } from '../roles/role-permissions.map';
import type { CreatePaymentAccountDto } from './dto/create-payment-account.dto';
import type { UpdatePaymentAccountDto } from './dto/update-payment-account.dto';
import type { CreatePaymentMethodTypeDto } from './dto/create-payment-method-type.dto';
import type { UpdatePaymentMethodTypeDto } from './dto/update-payment-method-type.dto';

const ADMIN_INCLUDE = {
  createdBy: { select: { id: true, username: true } },
  updatedBy: { select: { id: true, username: true } },
} satisfies Prisma.PaymentAccountInclude;

type AdminRow = Prisma.PaymentAccountGetPayload<{
  include: typeof ADMIN_INCLUDE;
}>;
type PublicRow = Pick<
  AdminRow,
  'id' | 'type' | 'accountName' | 'accountNumber' | 'bankName' | 'note'
>;

@Injectable()
export class PaymentAccountsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Same "one endpoint, row+field-shaped by viewer role" idiom already used
   * by subscription plans / movies / series: a caller without
   * PAYMENT_ACCOUNT_MANAGE only ever sees active accounts, and only the
   * fields they actually need to send a deposit to — never audit metadata
   * (who created/edited it, when, or its active/inactive history).
   */
  async findAll(viewerRole: Role) {
    const canManage = roleHasPermission(
      viewerRole,
      Permission.PAYMENT_ACCOUNT_MANAGE,
    );

    if (!canManage) {
      const accounts = await this.prisma.paymentAccount.findMany({
        where: { isActive: true },
        orderBy: { createdAt: 'asc' },
      });
      return accounts.map((a) => this.toPublicResponse(a));
    }

    const accounts = await this.prisma.paymentAccount.findMany({
      orderBy: { createdAt: 'asc' },
      include: ADMIN_INCLUDE,
    });
    return accounts.map((a) => this.toAdminResponse(a));
  }

  async getTypes() {
    const types = await this.prisma.paymentMethodType.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return types.map((t) => this.toTypeResponse(t));
  }

  async createType(dto: CreatePaymentMethodTypeDto) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { label: dto.label },
    });
    if (existing) {
      throw new ConflictException(
        'A payment method with this name already exists',
      );
    }
    const created = await this.prisma.paymentMethodType.create({
      data: {
        label: dto.label,
        requiresBankName: dto.requiresBankName ?? false,
        logoUrl: dto.logoUrl,
      },
    });
    return this.toTypeResponse(created);
  }

  async updateType(id: string, dto: UpdatePaymentMethodTypeDto) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Payment method not found');

    const nextLabel = dto.label !== undefined ? dto.label : existing.label;
    if (nextLabel !== existing.label) {
      const clash = await this.prisma.paymentMethodType.findUnique({
        where: { label: nextLabel },
      });
      if (clash) {
        throw new ConflictException(
          'A payment method with this name already exists',
        );
      }
    }

    if (nextLabel !== existing.label) {
      // Renaming propagates to every account currently on this method, so
      // the catalog and existing accounts never drift out of sync — the
      // whole point of "label is the single source of truth" (see the
      // PaymentAccount.type doc comment in schema.prisma).
      const updated = await this.prisma.$transaction(async (tx) => {
        await tx.paymentAccount.updateMany({
          where: { type: existing.label },
          data: { type: nextLabel },
        });
        return tx.paymentMethodType.update({
          where: { id },
          data: {
            label: nextLabel,
            requiresBankName: dto.requiresBankName,
            logoUrl: dto.logoUrl,
          },
        });
      });
      return this.toTypeResponse(updated);
    }

    const updated = await this.prisma.paymentMethodType.update({
      where: { id },
      data: { requiresBankName: dto.requiresBankName, logoUrl: dto.logoUrl },
    });
    return this.toTypeResponse(updated);
  }

  async removeType(id: string) {
    const existing = await this.prisma.paymentMethodType.findUnique({
      where: { id },
    });
    if (!existing) throw new NotFoundException('Payment method not found');

    const accountsInUse = await this.prisma.paymentAccount.count({
      where: { type: existing.label },
    });
    if (accountsInUse > 0) {
      throw new ConflictException(
        `${accountsInUse} payment account(s) still use this method. Delete or reassign them first.`,
      );
    }

    await this.prisma.paymentMethodType.delete({ where: { id } });
    return { deleted: true };
  }

  async findOne(id: string) {
    const account = await this.prisma.paymentAccount.findUnique({
      where: { id },
      include: ADMIN_INCLUDE,
    });
    if (!account) throw new NotFoundException('Payment account not found');
    return this.toAdminResponse(account);
  }

  async create(dto: CreatePaymentAccountDto, actorUserId: string) {
    const account = await this.prisma.paymentAccount.create({
      data: {
        ...dto,
        createdByUserId: actorUserId,
        updatedByUserId: actorUserId,
      },
      include: ADMIN_INCLUDE,
    });
    return this.toAdminResponse(account);
  }

  async update(id: string, dto: UpdatePaymentAccountDto, actorUserId: string) {
    await this.assertExists(id);
    const account = await this.prisma.paymentAccount.update({
      where: { id },
      data: { ...dto, updatedByUserId: actorUserId },
      include: ADMIN_INCLUDE,
    });
    return this.toAdminResponse(account);
  }

  async remove(id: string) {
    await this.assertExists(id);
    await this.prisma.paymentAccount.delete({ where: { id } });
    return { deleted: true };
  }

  private async assertExists(id: string) {
    const exists = await this.prisma.paymentAccount.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!exists) throw new NotFoundException('Payment account not found');
  }

  private toPublicResponse(a: PublicRow) {
    return {
      id: a.id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      note: a.note,
    };
  }

  private toAdminResponse(a: AdminRow) {
    return {
      id: a.id,
      type: a.type,
      accountName: a.accountName,
      accountNumber: a.accountNumber,
      bankName: a.bankName,
      note: a.note,
      isActive: a.isActive,
      createdAt: a.createdAt,
      updatedAt: a.updatedAt,
      createdBy: a.createdBy,
      updatedBy: a.updatedBy,
    };
  }

  /**
   * `value` is kept alongside `label` purely for client-shape backward
   * compatibility (types.find(t => t.value === account.type)) — the two
   * are always identical, since `label` itself is what's stored in
   * PaymentAccount.type. Every mutation (create/update) must go through
   * this too, not just getTypes() — returning a raw Prisma row instead
   * silently drops `value`, which breaks selecting the freshly
   * created/renamed method in the admin UI until the next refetch.
   */
  private toTypeResponse(t: {
    id: string;
    label: string;
    requiresBankName: boolean;
    logoUrl: string | null;
  }) {
    return {
      id: t.id,
      value: t.label,
      label: t.label,
      requiresBankName: t.requiresBankName,
      logoUrl: t.logoUrl,
    };
  }
}

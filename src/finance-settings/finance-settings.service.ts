import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { decimalToNumber } from '../common/utils/decimal.util';
import type { UpdateFinanceSettingsDto } from './dto/update-finance-settings.dto';

const DEFAULT_MIN_DEPOSIT = 1000;
const DEFAULT_MAX_DEPOSIT = 5_000_000;
const DEFAULT_MIN_WITHDRAWAL = 1000;
const DEFAULT_MAX_WITHDRAWAL = 5_000_000;

@Injectable()
export class FinanceSettingsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Lazily creates the single global settings row with sensible defaults on
   * first read — mirrors how WalletService.getByUserId lazily creates a
   * wallet, so callers never have to special-case "not configured yet".
   */
  async getOrCreate() {
    const existing = await this.prisma.financeSettings.findFirst();
    if (existing) return existing;

    return this.prisma.financeSettings.create({
      data: {
        minDepositAmount: DEFAULT_MIN_DEPOSIT,
        maxDepositAmount: DEFAULT_MAX_DEPOSIT,
        minWithdrawalAmount: DEFAULT_MIN_WITHDRAWAL,
        maxWithdrawalAmount: DEFAULT_MAX_WITHDRAWAL,
      },
    });
  }

  async update(dto: UpdateFinanceSettingsDto, adminId: string) {
    if (dto.minDepositAmount > dto.maxDepositAmount) {
      throw new BadRequestException(
        'Minimum deposit amount cannot be greater than maximum deposit amount',
      );
    }
    if (dto.minWithdrawalAmount > dto.maxWithdrawalAmount) {
      throw new BadRequestException(
        'Minimum withdrawal amount cannot be greater than maximum withdrawal amount',
      );
    }

    const current = await this.getOrCreate();

    return this.prisma.financeSettings.update({
      where: { id: current.id },
      data: {
        minDepositAmount: dto.minDepositAmount,
        maxDepositAmount: dto.maxDepositAmount,
        minWithdrawalAmount: dto.minWithdrawalAmount,
        maxWithdrawalAmount: dto.maxWithdrawalAmount,
        updatedByUserId: adminId,
      },
      include: {
        updatedBy: { select: { id: true, username: true } },
      },
    });
  }

  /** Convenience helper for deposits/withdrawals `create()` — plain numbers, not Decimal. */
  async getLimits() {
    const settings = await this.getOrCreate();
    return {
      minDepositAmount: decimalToNumber(settings.minDepositAmount),
      maxDepositAmount: decimalToNumber(settings.maxDepositAmount),
      minWithdrawalAmount: decimalToNumber(settings.minWithdrawalAmount),
      maxWithdrawalAmount: decimalToNumber(settings.maxWithdrawalAmount),
    };
  }
}

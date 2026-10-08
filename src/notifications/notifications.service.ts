import { Injectable, NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { PaginationQueryDto } from '../common/dto/pagination-query.dto';
import type { Notification } from '../generated/prisma/client';

@Injectable()
export class NotificationsService {
  constructor(private readonly prisma: PrismaService) {}

  async findAllForUser(userId: string, pagination: PaginationQueryDto) {
    const page = pagination.page ?? 1;
    const limit = pagination.limit ?? 20;

    const [items, total] = await this.prisma.$transaction([
      this.prisma.notification.findMany({
        where: { userId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.notification.count({ where: { userId } }),
    ]);

    return { items, total, page, limit };
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({ where: { userId, isRead: false } });
  }

  async markAsRead(id: string, userId: string): Promise<Notification> {
    // Scoped to the caller: an id that exists but belongs to someone else is
    // indistinguishable from one that does not exist, so the response never
    // confirms whether a notification id is real.
    const { count } = await this.prisma.notification.updateMany({
      where: { id, userId },
      data: { isRead: true },
    });
    if (count === 0) throw new NotFoundException('Notification not found');

    // Re-read scoped to the caller as well, so every query in this service
    // carries the userId and nothing is ever fetched by id alone.
    const notification = await this.prisma.notification.findFirst({
      where: { id, userId },
    });
    if (!notification) throw new NotFoundException('Notification not found');
    return notification;
  }

  async markAllAsRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true },
    });
  }
}

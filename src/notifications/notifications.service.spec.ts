import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { NotificationsService } from './notifications.service';

describe('NotificationsService', () => {
  let service: NotificationsService;
  let prisma: {
    notification: {
      findFirst: jest.Mock;
      findUnique: jest.Mock;
      update: jest.Mock;
      updateMany: jest.Mock;
      findMany: jest.Mock;
      count: jest.Mock;
    };
    $transaction: jest.Mock;
  };

  beforeEach(async () => {
    prisma = {
      notification: {
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
      $transaction: jest.fn(async (queries: unknown[]) =>
        Promise.all(queries as Promise<unknown>[]),
      ),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(NotificationsService);
  });

  describe('markAsRead', () => {
    it('marks a notification the caller owns as read', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.findFirst.mockResolvedValue({
        id: 'n1',
        userId: 'user-1',
        isRead: true,
      });

      const result = await service.markAsRead('n1', 'user-1');

      expect(result.isRead).toBe(true);
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'user-1' },
        data: { isRead: true },
      });
      // The follow-up read is scoped to the caller too: no query in this
      // service ever fetches a notification by id alone.
      expect(prisma.notification.findFirst).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'user-1' },
      });
      expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    });

    it('answers 404 if the row vanishes between the write and the scoped re-read', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 1 });
      prisma.notification.findFirst.mockResolvedValue(null);

      await expect(service.markAsRead('n1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it('answers 404, not 403, when the notification belongs to a different user', async () => {
      // The write is scoped to the caller, so someone else's row is untouched.
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markAsRead('n1', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
      expect(prisma.notification.updateMany).toHaveBeenCalledWith({
        where: { id: 'n1', userId: 'user-1' },
        data: { isRead: true },
      });
      expect(prisma.notification.update).not.toHaveBeenCalled();
      expect(prisma.notification.findFirst).not.toHaveBeenCalled();
      expect(prisma.notification.findUnique).not.toHaveBeenCalled();
    });

    it('throws NotFoundException for a nonexistent notification', async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      await expect(service.markAsRead('missing', 'user-1')).rejects.toThrow(
        NotFoundException,
      );
    });

    it("gives the same 404 message for an unknown id and for another user's id", async () => {
      prisma.notification.updateMany.mockResolvedValue({ count: 0 });

      const errors = await Promise.all(
        ['missing', 'someone-elses-id'].map((id) =>
          service.markAsRead(id, 'user-1').catch((e: Error) => e),
        ),
      );

      expect(errors[0]).toBeInstanceOf(NotFoundException);
      expect(errors[1]).toBeInstanceOf(NotFoundException);
      expect((errors[0] as Error).message).toBe((errors[1] as Error).message);
    });
  });

  describe('getUnreadCount', () => {
    it("counts only this user's unread notifications", async () => {
      prisma.notification.count.mockResolvedValue(3);

      const count = await service.getUnreadCount('user-1');

      expect(count).toBe(3);
      expect(prisma.notification.count).toHaveBeenCalledWith({
        where: { userId: 'user-1', isRead: false },
      });
    });
  });
});

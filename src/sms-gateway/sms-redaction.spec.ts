import { SmsMessageStatus, type Prisma } from '../generated/prisma/client';
import { SMS_REDACTED } from '../sms/sms.config';
import {
  FINAL_SMS_STATUSES,
  redactFinalSmsBodies,
  redactSmsForClosedAccount,
} from './sms-redaction';

const PHONE = '+959123456789';

describe('sms-redaction', () => {
  let tx: { smsMessage: { updateMany: jest.Mock } };
  const client = () => tx as unknown as Prisma.TransactionClient;

  beforeEach(() => {
    tx = {
      smsMessage: {
        updateMany: jest
          .fn()
          .mockResolvedValueOnce({ count: 1 })
          .mockResolvedValueOnce({ count: 4 }),
      },
    };
  });

  it('privacy extra: redactFinalSmsBodies blanks every final row still holding a body at once (no age), and leaves the phone number alone', async () => {
    const now = new Date('2026-09-30T10:00:00.000Z');

    await redactFinalSmsBodies(client(), now);

    const [{ where, data }] = tx.smsMessage.updateMany.mock.calls[0] as [
      { where: Record<string, unknown>; data: Record<string, unknown> },
    ];
    expect(where).toEqual({
      redactedAt: null,
      status: { in: [...FINAL_SMS_STATUSES] },
    });
    expect(data).toEqual({ body: SMS_REDACTED, redactedAt: now });
  });

  describe('redactSmsForClosedAccount (account close)', () => {
    it('first cancels the QUEUED SMS for that phone, so the gateway never sends them', async () => {
      await redactSmsForClosedAccount(client(), PHONE);

      expect(tx.smsMessage.updateMany).toHaveBeenNthCalledWith(1, {
        where: { phone: PHONE, status: SmsMessageStatus.QUEUED },
        data: { status: SmsMessageStatus.CANCELLED },
      });
    });

    it('then redacts the number and the body of every row for it, whatever its status or age', async () => {
      const now = new Date('2026-09-30T10:00:00.000Z');

      await expect(
        redactSmsForClosedAccount(client(), PHONE, now),
      ).resolves.toEqual({ cancelled: 1, redacted: 4 });

      expect(tx.smsMessage.updateMany).toHaveBeenNthCalledWith(2, {
        where: { phone: PHONE },
        data: { phone: SMS_REDACTED, body: SMS_REDACTED, redactedAt: now },
      });
    });
  });
});

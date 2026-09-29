import { UserStatus } from '../generated/prisma/client';
import { lockAccountStatus } from './account-status-lock';

describe('lockAccountStatus (H-16: money inserts vs closing the account)', () => {
  const sqlOf = (call: unknown[]) =>
    (call[0] as TemplateStringsArray).join('?');

  it("share-locks the account row in the caller's transaction and returns its status", async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ status: UserStatus.CLOSED }]),
    };

    await expect(lockAccountStatus(tx as never, 'user-1')).resolves.toBe(
      UserStatus.CLOSED,
    );

    const call = tx.$queryRaw.mock.calls[0] as unknown[];
    // FOR SHARE conflicts with DELETE /users/me's FOR UPDATE (and with any
    // status UPDATE): whichever comes second waits for the first to commit,
    // then reads its result.
    expect(sqlOf(call)).toBe(
      'SELECT "status" FROM "users" WHERE "id" = ? FOR SHARE',
    );
    expect(call.slice(1)).toEqual(['user-1']);
  });

  it('returns null when the account row does not exist', async () => {
    const tx = { $queryRaw: jest.fn().mockResolvedValue([]) };

    await expect(lockAccountStatus(tx as never, 'nobody')).resolves.toBeNull();
  });
});

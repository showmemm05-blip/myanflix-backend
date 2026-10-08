import * as bcrypt from 'bcrypt';
import { WithdrawalCodeHasher } from './withdrawal-code.hasher';

// Cheap hashes keep the suite fast; the cost itself is the shared constant.
jest.mock('../auth/password.constants', () => ({ PASSWORD_SALT_ROUNDS: 4 }));

const PEPPER = 'unit-test-withdrawal-code-pepper-0123456789';
const OTHER_PEPPER = 'another-withdrawal-code-pepper-9876543210xyz';
const CODE = '582904';

describe('WithdrawalCodeHasher', () => {
  describe('with a pepper', () => {
    const hasher = new WithdrawalCodeHasher(PEPPER);

    it('stores wcp1$<pepper id>$<bcrypt> — never the code, never the pepper', async () => {
      const stored = await hasher.hash(CODE);

      expect(stored).toMatch(/^wcp1\$[0-9a-f]{8}\$\$2[aby]\$04\$.{53}$/);
      expect(stored).not.toContain(CODE);
      expect(stored).not.toContain(PEPPER);
      expect(hasher.hasPepper).toBe(true);
    });

    it('the bcrypt part is NOT a hash of the bare code: a leaked database alone cannot be brute-forced', async () => {
      const stored = await hasher.hash(CODE);
      const bcryptPart = stored.split('$').slice(2).join('$');

      await expect(bcrypt.compare(CODE, bcryptPart)).resolves.toBe(false);
    });

    it('judges its own hashes: right and wrong', async () => {
      const stored = await hasher.hash(CODE);

      await expect(hasher.compare(CODE, stored)).resolves.toBe('right');
      await expect(hasher.compare('582905', stored)).resolves.toBe('wrong');
    });

    it('a hash saved before the pepper was set still works, and asks to be upgraded', async () => {
      const legacy = await bcrypt.hash(CODE, 4);

      await expect(hasher.compare(CODE, legacy)).resolves.toBe('right_rehash');
      await expect(hasher.compare('000001', legacy)).resolves.toBe('wrong');
    });

    it('a hash made with a different pepper cannot be judged at all (never read as "wrong")', async () => {
      const stored = await new WithdrawalCodeHasher(OTHER_PEPPER).hash(CODE);

      await expect(hasher.compare(CODE, stored)).resolves.toBe('unavailable');
      await expect(hasher.compare('000001', stored)).resolves.toBe(
        'unavailable',
      );
    });

    it('the same pepper always gets the same id, so a restart changes nothing', async () => {
      const stored = await hasher.hash(CODE);

      await expect(
        new WithdrawalCodeHasher(PEPPER).compare(CODE, stored),
      ).resolves.toBe('right');
    });
  });

  describe('without a pepper', () => {
    const hasher = new WithdrawalCodeHasher(undefined);

    it('stores a plain bcrypt hash, as before', async () => {
      const stored = await hasher.hash(CODE);

      expect(hasher.hasPepper).toBe(false);
      expect(bcrypt.getRounds(stored)).toBe(4);
      await expect(bcrypt.compare(CODE, stored)).resolves.toBe(true);
      await expect(hasher.compare(CODE, stored)).resolves.toBe('right');
      await expect(hasher.compare('000001', stored)).resolves.toBe('wrong');
    });

    it('a peppered hash (the pepper was removed) cannot be judged', async () => {
      const stored = await new WithdrawalCodeHasher(PEPPER).hash(CODE);

      await expect(hasher.compare(CODE, stored)).resolves.toBe('unavailable');
    });
  });
});

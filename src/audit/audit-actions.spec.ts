import { AuditCategory } from '../generated/prisma/client';
import {
  AUDIT_ACTION_KEYS,
  AUDIT_ACTIONS,
  AUDIT_TARGET_TYPES,
  getAuditActionDefinition,
  getAuditCatalogue,
  isAuditAction,
} from './audit-actions';

describe('audit action catalogue', () => {
  it('has no duplicate keys', () => {
    expect(new Set(AUDIT_ACTION_KEYS).size).toBe(AUDIT_ACTIONS.length);
  });

  it('files every action under a known category and target type', () => {
    const categories = new Set(Object.values(AuditCategory));
    for (const action of AUDIT_ACTIONS) {
      expect(categories.has(action.category)).toBe(true);
      expect(AUDIT_TARGET_TYPES).toContain(action.targetType);
    }
  });

  it('prefixes every key with its own targetType (`<targetType>.<verb>`)', () => {
    for (const action of AUDIT_ACTIONS) {
      const [prefix, verb, ...rest] = action.key.split('.');
      expect({ key: action.key, prefix }).toEqual({
        key: action.key,
        prefix: action.targetType,
      });
      expect(verb).toMatch(/^[a-z_]+$/);
      expect(rest).toHaveLength(0);
    }
  });

  it('lists every target type in snake_case, without duplicates', () => {
    expect(new Set(AUDIT_TARGET_TYPES).size).toBe(AUDIT_TARGET_TYPES.length);
    for (const type of AUDIT_TARGET_TYPES) {
      expect(type).toMatch(/^[a-z_]+$/);
    }
  });

  it('covers the spec §4 catalogue exactly', () => {
    const expected = [
      // CONTENT
      'movie.create',
      'movie.upload',
      'movie.update',
      'movie.publish',
      'movie.reprocess',
      'movie.unpublish',
      'movie.status_change',
      'movie.delete',
      'movie.durations_backfill',
      'series.create',
      'series.update',
      'series.publish',
      'series.unpublish',
      'series.status_change',
      'series.delete',
      'subtitle.upload',
      'subtitle.update',
      'subtitle.set_default',
      'subtitle.delete',
      'category.create',
      'category.update',
      'category.delete',
      'actor.create',
      'actor.update',
      'actor.delete',
      'book.create',
      'book.update',
      'book.delete',
      'book_edition.create',
      'book_edition.update',
      'book_edition.publish',
      'book_edition.unpublish',
      'book_edition.status_change',
      'book_edition.delete',
      'book_part.create',
      'book_part.update',
      'book_part.delete',
      'book_part.reorder',
      'book_chapter.create',
      'book_chapter.update',
      'book_chapter.delete',
      'book_chapter.reorder',
      'book_chapter.process',
      'book_chapter.status_change',
      'book_section.create',
      'book_section.update',
      'book_section.delete',
      'book_section.reorder',
      'book_author.create',
      'book_author.update',
      'book_author.delete',
      'book_category.create',
      'book_category.update',
      'book_category.delete',
      // USERS
      'user.status_change',
      'user.role_change',
      'user.wallet_adjust',
      // STAFF
      'staff.create',
      'staff.update',
      'staff.role_change',
      'staff.status_change',
      'staff.password_reset',
      'staff.delete',
      'role.create',
      'role.update',
      'role.permissions_change',
      'role.delete',
      'level.create',
      'level.update',
      'level.delete',
      'level.reorder',
      // FINANCE
      'deposit.manual_create',
      'deposit.approve',
      'deposit.reject',
      'deposit.receiving_account_update',
      'withdrawal.approve',
      'withdrawal.reject',
      'withdrawal.transfer_account_update',
      'payment_account.create',
      'payment_account.update',
      'payment_account.delete',
      'payment_account.ledger_entry',
      'payment_method_type.create',
      'payment_method_type.update',
      'payment_method_type.delete',
      'finance_settings.update',
      'subscription_plan.create',
      'subscription_plan.update',
      // SYSTEM
      'peak_users.update',
      'comment.moderate',
      'comment.delete',
      'feedback.status_change',
    ];
    expect([...AUDIT_ACTION_KEYS].sort()).toEqual([...expected].sort());
  });

  it('assigns the spec categories per target family', () => {
    const categoryOf = (key: string) =>
      AUDIT_ACTIONS.find((a) => a.key === key)?.category;
    expect(categoryOf('movie.update')).toBe(AuditCategory.CONTENT);
    expect(categoryOf('book_category.delete')).toBe(AuditCategory.CONTENT);
    expect(categoryOf('user.wallet_adjust')).toBe(AuditCategory.USERS);
    expect(categoryOf('staff.password_reset')).toBe(AuditCategory.STAFF);
    expect(categoryOf('role.permissions_change')).toBe(AuditCategory.STAFF);
    expect(categoryOf('level.reorder')).toBe(AuditCategory.STAFF);
    expect(categoryOf('deposit.approve')).toBe(AuditCategory.FINANCE);
    expect(categoryOf('subscription_plan.update')).toBe(AuditCategory.FINANCE);
    expect(categoryOf('peak_users.update')).toBe(AuditCategory.SYSTEM);
    expect(categoryOf('comment.delete')).toBe(AuditCategory.SYSTEM);
    expect(categoryOf('feedback.status_change')).toBe(AuditCategory.SYSTEM);
  });

  it('isAuditAction / getAuditActionDefinition agree with the list', () => {
    expect(isAuditAction('movie.update')).toBe(true);
    expect(isAuditAction('movie.read')).toBe(false);
    expect(getAuditActionDefinition('deposit.approve')).toEqual({
      key: 'deposit.approve',
      category: AuditCategory.FINANCE,
      targetType: 'deposit',
    });
    expect(() =>
      getAuditActionDefinition('nope.nope' as unknown as 'movie.update'),
    ).toThrow('Unknown audit action');
  });

  it('getAuditCatalogue serves categories, actions and target types', () => {
    const catalogue = getAuditCatalogue();
    expect(catalogue.categories).toEqual([
      'CONTENT',
      'USERS',
      'FINANCE',
      'STAFF',
      'SYSTEM',
    ]);
    expect(catalogue.actions).toHaveLength(AUDIT_ACTIONS.length);
    expect(catalogue.actions[0]).toEqual({
      key: 'movie.create',
      category: 'CONTENT',
      targetType: 'movie',
    });
    expect(catalogue.targetTypes).toEqual([...AUDIT_TARGET_TYPES]);
    // A fresh array each call — a caller mutating it cannot poison the next.
    expect(catalogue.targetTypes).not.toBe(AUDIT_TARGET_TYPES);
  });
});

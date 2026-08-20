import { Role, UserStatus } from '../../generated/prisma/client';
import { StaffResponseDto, type StaffUser } from './staff-response.dto';

/**
 * The mapper every staff response goes through (list/create/update/status).
 * StaffService selects whole User rows, so anything this DTO does not copy
 * across is silently dropped on the way to the admin — which is exactly what
 * used to happen to `displayName`.
 */
describe('StaffResponseDto.fromEntity', () => {
  const staff = {
    id: 'admin-1',
    username: 'admin.blake',
    displayName: null,
    password: 'hashed-secret',
    phone: null,
    role: Role.ADMIN,
    appRoleId: 'role-admin',
    status: UserStatus.ACTIVE,
    lastLoginAt: new Date('2026-08-18T00:00:00.000Z'),
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    appRole: { id: 'role-admin', key: 'ADMIN', name: 'Admin' },
  } as unknown as StaffUser;

  it('carries displayName next to the raw username', () => {
    const dto = StaffResponseDto.fromEntity({
      ...staff,
      displayName: 'Blake',
    } as StaffUser);

    expect(dto.username).toBe('admin.blake');
    expect(dto.displayName).toBe('Blake');
  });

  it('emits displayName as null rather than omitting it when unset', () => {
    const dto = StaffResponseDto.fromEntity(staff);

    // Null for every staff account today — the field still has to be present
    // so the admin resolves one label rule for staff and subscribers alike.
    expect(dto).toHaveProperty('displayName', null);
    expect(dto.username).toBe('admin.blake');
  });

  it('never leaks the password hash', () => {
    const dto = StaffResponseDto.fromEntity(staff);

    expect(dto).not.toHaveProperty('password');
  });
});

import { Role } from '../generated/prisma/client';
import { Permission } from './permission.enum';
import { roleHasPermission } from './role-permissions.map';

describe('ROLE_PERMISSIONS — CONTENT_UPLOADER', () => {
  it.each([
    Permission.MOVIE_CREATE,
    Permission.MOVIE_UPDATE,
    Permission.VIDEO_UPLOAD,
    Permission.SUBTITLE_MANAGE,
    Permission.SERIES_MANAGE,
  ])('grants %s', (permission) => {
    expect(roleHasPermission(Role.CONTENT_UPLOADER, permission)).toBe(true);
  });

  it.each([
    Permission.MOVIE_DELETE,
    Permission.USER_MANAGE,
    Permission.FINANCE_VIEW,
    Permission.DEPOSIT_MANAGE,
    Permission.STAFF_MANAGE,
  ])('does not grant %s', (permission) => {
    expect(roleHasPermission(Role.CONTENT_UPLOADER, permission)).toBe(false);
  });
});

describe('ROLE_PERMISSIONS — STAFF_MANAGE', () => {
  it('is granted to SUPER_ADMIN', () => {
    expect(roleHasPermission(Role.SUPER_ADMIN, Permission.STAFF_MANAGE)).toBe(true);
  });

  it('is not granted to ADMIN', () => {
    expect(roleHasPermission(Role.ADMIN, Permission.STAFF_MANAGE)).toBe(false);
  });

  it('is not granted to CONTENT_UPLOADER', () => {
    expect(roleHasPermission(Role.CONTENT_UPLOADER, Permission.STAFF_MANAGE)).toBe(false);
  });

  it('is not granted to USER', () => {
    expect(roleHasPermission(Role.USER, Permission.STAFF_MANAGE)).toBe(false);
  });
});

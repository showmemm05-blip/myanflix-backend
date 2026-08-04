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
  ])('does not grant %s', (permission) => {
    expect(roleHasPermission(Role.CONTENT_UPLOADER, permission)).toBe(false);
  });
});

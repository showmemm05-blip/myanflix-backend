import type { Role } from '../../generated/prisma/client';

export interface AuthenticatedUser {
  id: string;
  username: string;
  /** Coarse account kind (USER vs staff) — still what content visibility keys off. */
  role: Role;
  /**
   * Granular RBAC assignment. NULL means "fall back to the system AppRole
   * whose key equals `role`" — see PermissionResolverService.
   */
  appRoleId: string | null;
  /**
   * The refresh session this request's access token belongs to (the `sid`
   * claim). Only set on HTTP requests authenticated by JwtStrategy; used to
   * keep the caller signed in when they change their own password.
   */
  sessionId?: string;
}

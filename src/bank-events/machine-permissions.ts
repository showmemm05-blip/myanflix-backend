import { SetMetadata } from '@nestjs/common';

/**
 * What a MACHINE caller (the phone-monitor desktop app, authenticated by
 * MachineTokenGuard with the shared BANK_EVENTS_TOKEN) is allowed to do.
 *
 * Deliberately NOT part of roles/permission-catalogue.ts: that catalogue is
 * what STAFF roles can be granted, and no staff role may ever hold the
 * ingestion permission — so no JWT holder can reach the bank-events routes
 * even by editing a role. The two worlds never share a permission string.
 */
export const MACHINE_PERMISSIONS = ['BANK_EVENTS.INGEST'] as const;

export type MachinePermission = (typeof MACHINE_PERMISSIONS)[number];

export const MACHINE_PERMISSION_KEY = 'machinePermission';

/** The identity MachineTokenGuard attaches to `request.machine`. */
export interface MachinePrincipal {
  kind: 'phone-monitor';
  permissions: readonly MachinePermission[];
}

/** Restricts a route to a machine principal holding the given permission. */
export const RequireMachinePermission = (permission: MachinePermission) =>
  SetMetadata(MACHINE_PERMISSION_KEY, permission);

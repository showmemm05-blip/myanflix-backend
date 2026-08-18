import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * The hostname the current HTTP request used to reach this API, captured by
 * middleware in main.ts. Playback URLs are derived from it (see
 * MinioService.playbackUrl) so streams always point at whatever address the
 * client is already talking to — localhost on the host machine, the LAN IP
 * on phones — instead of a hard-coded IP that goes stale every time the
 * machine hosting this stack changes networks.
 */
export const requestHostContext = new AsyncLocalStorage<{ hostname: string }>();

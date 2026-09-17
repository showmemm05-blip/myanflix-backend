/**
 * Prints the `(?<scope>...)` alternation that BOTH signed locations in
 * cacheserver/nginx/templates/default.conf.template must contain, generated
 * from MEDIA_CLASSES so there is no third hand-maintained copy of it.
 *
 * Usage:
 *   npx ts-node scripts/print-stream-scopes.ts
 *
 * Paste the output verbatim into both locations. nginx-scopes.spec.ts fails
 * when the checked-in template no longer contains it exactly twice, which is
 * the whole point: changing one location and forgetting the other does not
 * break playback loudly — it breaks playlists but not segments, or the
 * reverse, which reads as flaky streaming rather than a config error.
 */
import { NGINX_SCOPE_ALTERNATION } from '../src/common/storage/media-taxonomy';

process.stdout.write(`${NGINX_SCOPE_ALTERNATION}\n`);

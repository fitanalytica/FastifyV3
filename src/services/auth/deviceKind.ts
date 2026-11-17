import type { Kind } from '../../types/index.js';

// v3 supports the phone and the watch (decided 2026-11-15). A tablet runs the phone app, so it is the phone side.
// Anything else (`chrome`, `mac`, no type at all) has no v3 routes and is refused on both sides.
const KIND: ReadonlyMap<string, Kind> = new Map<string, Kind>([['phone', 'phone'], ['tablet', 'phone'], ['watch', 'watch']]);

/** Which side a `downloads.device_type` belongs to, or `null` if v3 does not serve it. */
export function kindOfDevice(deviceType: string | null | undefined): Kind | null {
  return (deviceType && KIND.get(deviceType)) || null;
}

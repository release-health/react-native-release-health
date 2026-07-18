import NativeReleaseHealth from './NativeReleaseHealth';
import type { BuildInfo, PendingUpdate } from './NativeReleaseHealth';

export type { BuildInfo, PendingUpdate };

/**
 * Low-level native accessors: build info, the clean-exit heuristic, and the
 * persisted flags a future health engine will read and write.
 *
 * This is the phase 1 surface. The public `ReleaseHealth.init()` /
 * `markHealthy()` API arrives once the health engine and adapters exist.
 */
export const ReleaseHealthNative = {
  /** Native app version, build number, and bundle identifier. */
  getBuildInfo(): BuildInfo {
    return NativeReleaseHealth.getBuildInfo();
  },

  /**
   * Whether the previous launch exited gracefully. Captured once at native
   * module init, before this launch resets the persisted flag: call early.
   */
  getPreviousCleanExit(): boolean {
    return NativeReleaseHealth.getPreviousCleanExit();
  },

  /** The update currently on probation, or null if none is pending. */
  getPendingUpdate(): PendingUpdate | null {
    return NativeReleaseHealth.getPendingUpdate();
  },

  setPendingUpdate(updateId: string, downloadedAt: number): void {
    NativeReleaseHealth.setPendingUpdate(updateId, downloadedAt);
  },

  clearPendingUpdate(): void {
    NativeReleaseHealth.clearPendingUpdate();
  },

  getLaunchCountSinceUpdate(): number {
    return NativeReleaseHealth.getLaunchCountSinceUpdate();
  },

  incrementLaunchCountSinceUpdate(): number {
    return NativeReleaseHealth.incrementLaunchCountSinceUpdate();
  },

  resetLaunchCountSinceUpdate(): void {
    NativeReleaseHealth.resetLaunchCountSinceUpdate();
  },
};

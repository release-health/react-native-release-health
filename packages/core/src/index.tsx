import { useSyncExternalStore } from 'react';
import { Platform } from 'react-native';
import NativeReleaseHealth from './NativeReleaseHealth';
import type { BuildInfo, PendingUpdate } from './NativeReleaseHealth';
import { HealthEngine } from './engine';
import type {
  HealthStatus,
  ReleaseHealthOptions,
  RollbackRecommendation,
  Unsubscribe,
} from './types';

export type { BuildInfo, PendingUpdate };
export type {
  Clock,
  HealthStatus,
  HealthStorage,
  OtaAdapter,
  OtaAdapterEvent,
  ReleaseHealthEvent,
  ReleaseHealthOptions,
  RollbackReason,
  RollbackRecommendation,
  Sink,
  Unsubscribe,
} from './types';
export { HealthEngine } from './engine';
export type { EngineDeps, EngineSnapshot } from './engine';

/**
 * Low-level native accessors: build info, the clean-exit heuristic, and the
 * persisted flags the health engine reads and writes. Most apps only need
 * `ReleaseHealth`; this surface exists for adapters and diagnostics.
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

/** State returned by `useReleaseHealth()`. */
export type ReleaseHealthState = {
  status: HealthStatus;
  activeUpdateId: string | null;
  nativeVersion: string;
  cohort: string | undefined;
};

type GlobalErrorHandler = (error: unknown, isFatal?: boolean) => void;
type ErrorUtilsLike = {
  getGlobalHandler(): GlobalErrorHandler;
  setGlobalHandler(handler: GlobalErrorHandler): void;
};

let engine: HealthEngine | null = null;
let initPromise: Promise<void> | null = null;
let cohort: string | undefined;
let nativeVersion = '';

let snapshot: ReleaseHealthState = {
  status: 'starting',
  activeUpdateId: null,
  nativeVersion: '',
  cohort: undefined,
};
const storeListeners = new Set<() => void>();

const rollbackListeners = new Set<(r: RollbackRecommendation) => void>();
let lastRecommendation: RollbackRecommendation | null = null;

function refreshSnapshot(): void {
  const engineSnapshot = engine?.getSnapshot();
  snapshot = {
    status: engineSnapshot?.status ?? 'starting',
    activeUpdateId: engineSnapshot?.activeUpdateId ?? null,
    nativeVersion,
    cohort,
  };
  for (const listener of storeListeners) {
    listener();
  }
}

function handleRecommendation(recommendation: RollbackRecommendation): void {
  lastRecommendation = recommendation;
  for (const listener of rollbackListeners) {
    listener(recommendation);
  }
}

function installJsFatalHook(target: HealthEngine): void {
  const errorUtils = (globalThis as { ErrorUtils?: ErrorUtilsLike }).ErrorUtils;
  if (errorUtils === undefined) {
    return;
  }
  const previousHandler = errorUtils.getGlobalHandler();
  errorUtils.setGlobalHandler((error, isFatal) => {
    if (isFatal === true) {
      target.recordJsFatal(
        error instanceof Error ? error.message : String(error)
      );
    }
    previousHandler(error, isFatal);
  });
}

function reactNativeSdkVersion(): string {
  const version = Platform.constants.reactNativeVersion;
  const base = `${version.major}.${version.minor}.${version.patch}`;
  return version.prerelease != null ? `${base}-${version.prerelease}` : base;
}

/**
 * Vendor-neutral OTA rollout health. Call `init()` once at app startup with
 * an adapter for your OTA vendor, then `markHealthy()` when your first
 * screen is interactive.
 */
export const ReleaseHealth = {
  /**
   * Initialize release-health tracking for this session. Emits
   * `session_start` to the configured sinks and, when the active update is
   * still on probation, starts the healthy-timeout countdown.
   *
   * Call exactly once, as early as possible in app startup; a second call
   * warns and is ignored.
   */
  init(options: ReleaseHealthOptions): Promise<void> {
    if (initPromise !== null) {
      console.warn(
        'ReleaseHealth.init() was called more than once; ignoring this call. ' +
          'Initialize once at app startup, before your root component mounts.'
      );
      return initPromise;
    }

    const buildInfo = ReleaseHealthNative.getBuildInfo();
    cohort = options.cohort;
    nativeVersion = buildInfo.version;

    engine = new HealthEngine({
      adapter: options.adapter,
      storage: ReleaseHealthNative,
      clock: {
        now: () => Date.now(),
        setTimeout: (callback, ms) => setTimeout(callback, ms),
        clearTimeout: (handle) =>
          clearTimeout(handle as ReturnType<typeof setTimeout>),
      },
      sinks: options.sinks ?? [],
      isDev: __DEV__,
      healthyTimeoutMs: options.healthyTimeoutMs ?? 15000,
      crashLoopThreshold: options.crashLoopThreshold ?? 2,
      autoRollback: options.autoRollback ?? false,
      ...(options.cohort !== undefined ? { cohort: options.cohort } : {}),
      context: {
        nativeVersion: buildInfo.version,
        buildNumber: buildInfo.buildNumber,
        platform: Platform.OS,
        sdkVersion: reactNativeSdkVersion(),
      },
    });

    engine.onStatusChange(refreshSnapshot);
    engine.onRollbackRecommended(handleRecommendation);
    installJsFatalHook(engine);

    initPromise = engine.start().then(refreshSnapshot);
    refreshSnapshot();
    return initPromise;
  },

  /**
   * Tell the engine the app reached an interactive state. During probation
   * this accepts the pending update; calling it every launch is safe and
   * expected (idempotent per session).
   */
  markHealthy(): void {
    if (engine === null) {
      console.warn(
        'ReleaseHealth.markHealthy() was called before init(). Call ' +
          'ReleaseHealth.init() at app startup first; this call did nothing.'
      );
      return;
    }
    engine.markHealthy();
  },

  /**
   * Subscribe to rollback recommendations. If a recommendation already fired
   * this session, the callback is invoked immediately with it. Safe to call
   * before `init()`.
   */
  onRollbackRecommended(
    cb: (recommendation: RollbackRecommendation) => void
  ): Unsubscribe {
    rollbackListeners.add(cb);
    if (lastRecommendation !== null) {
      cb(lastRecommendation);
    }
    return () => {
      rollbackListeners.delete(cb);
    };
  },

  /**
   * Tell the engine a JS reload happened (e.g. after `reloadAsync`). A reload
   * during probation restarts the probation timer and never counts as a
   * failure. Adapters call this; apps normally do not need to.
   */
  notifyReload(): void {
    engine?.notifyReload();
  },
};

function subscribeStore(listener: () => void): Unsubscribe {
  storeListeners.add(listener);
  return () => {
    storeListeners.delete(listener);
  };
}

function getStoreSnapshot(): ReleaseHealthState {
  return snapshot;
}

/**
 * React hook exposing the current release-health state. Before `init()`
 * resolves, `status` is `'starting'`.
 */
export function useReleaseHealth(): ReleaseHealthState {
  return useSyncExternalStore(subscribeStore, getStoreSnapshot);
}

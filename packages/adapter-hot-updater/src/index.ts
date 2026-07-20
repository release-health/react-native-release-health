/**
 * hot-updater adapter for react-native-release-health.
 *
 * Maps hot-updater (`@hot-updater/react-native`) onto the vendor-neutral
 * `OtaAdapter` contract: the active bundle id, the embedded app version, and
 * `downloaded`/`error` events derived from hot-updater's update lifecycle.
 *
 * Unlike expo-updates, hot-updater exposes no update-event stream that carries
 * a bundle id (its only public event, `onProgress`, has none). The bundle id of
 * a completed update only reaches JS through the `onUpdateProcessCompleted`
 * callback passed to `HotUpdater.wrap`/`HotUpdater.init`. This adapter therefore
 * exposes `onUpdateProcessCompleted`, `onError`, and `onNotifyAppReady` methods
 * that the host wires into those options; they translate hot-updater's
 * lifecycle into adapter events.
 *
 * The hot-updater module is consumed through a small structural type and loaded
 * lazily, so this package has no hard dependency on hot-updater and never throws
 * into the host app when the module is missing.
 *
 * Verified against @hot-updater/react-native 0.35.4.
 */

import type {
  OtaAdapter,
  OtaAdapterEvent,
  Unsubscribe,
} from 'react-native-release-health';

/**
 * Structural form of the response hot-updater passes to
 * `onUpdateProcessCompleted` (its `RunUpdateProcessResponse`).
 */
export type HotUpdaterUpdateResponseLike = {
  /** Outcome of the update process at app entry. */
  status: 'UPDATE' | 'ROLLBACK' | 'UP_TO_DATE';
  /** Bundle id the process resolved to. Present on every status. */
  id: string;
  /** True when the update is a mandatory update. */
  shouldForceUpdate?: boolean;
  /** Human-readable detail, when the server supplied one. */
  message?: string | null;
};

/**
 * Structural form of hot-updater's `NotifyAppReadyResult`, delivered to
 * `onNotifyAppReady` after the first frame.
 */
export type HotUpdaterNotifyAppReadyResultLike = {
  /**
   * `RECOVERED` when hot-updater's native crash guard reverted a bundle that
   * failed before the first frame; `STABLE` otherwise.
   */
  status: 'RECOVERED' | 'STABLE';
  /** The reverted bundle id; present only when `status` is `RECOVERED`. */
  crashedBundleId?: string | null;
};

/**
 * Structural form of the params hot-updater's `updateBundle` accepts. Only the
 * fields this adapter sets when rolling back are listed; hot-updater accepts
 * more.
 */
export type HotUpdaterUpdateBundleParamsLike = {
  /** Target bundle id. */
  bundleId: string;
  /** Download URL, or null to revert without downloading. */
  fileUrl: string | null;
  /** Integrity hash of the target file, or null when not applicable. */
  fileHash: string | null;
  /** `ROLLBACK` reverts to the target bundle; `UPDATE` installs it. */
  status: 'ROLLBACK' | 'UPDATE';
};

/**
 * Structural subset of the `HotUpdater` singleton this adapter consumes.
 * Matches `import { HotUpdater } from '@hot-updater/react-native'` on 0.35.x.
 */
export type HotUpdaterModuleLike = {
  /** Current bundle id; resolves to the embedded id when no update is active. */
  getBundleId: () => string;
  /** Build-time id of the bundle embedded in the native binary. */
  getMinBundleId: () => string;
  /** Current app (native) version, or null when unavailable. */
  getAppVersion: () => string | null;
  /**
   * Applies (or reverts to) a bundle. Optional here: when absent, the adapter
   * omits `rollback()` and the engine runs in recommendation-only mode.
   */
  updateBundle?: (params: HotUpdaterUpdateBundleParamsLike) => Promise<boolean>;
};

/** Options accepted by {@link hotUpdaterAdapter}. */
export type HotUpdaterAdapterOptions = {
  /**
   * Alternative module implementation (tests, custom wrappers). Passing the
   * real `HotUpdater` here also gives the host app a compile-time check that
   * the installed hot-updater version still matches the shape this adapter
   * expects. Default: `require('@hot-updater/react-native').HotUpdater`.
   */
  hotUpdater?: HotUpdaterModuleLike;
  /** Warning channel; defaults to `console.warn`. */
  warn?: (message: string) => void;
};

/**
 * An {@link OtaAdapter} for hot-updater, extended with the callback methods the
 * host wires into `HotUpdater.wrap`/`HotUpdater.init`. All three callbacks are
 * safe to pass detached and never throw.
 */
export interface HotUpdaterAdapter extends OtaAdapter {
  /**
   * Wire into `HotUpdater.wrap({ onUpdateProcessCompleted })`. A completed
   * `UPDATE` becomes a `downloaded` event carrying the new bundle id; a
   * `ROLLBACK` or `UP_TO_DATE` emits nothing.
   */
  onUpdateProcessCompleted(response: HotUpdaterUpdateResponseLike): void;
  /**
   * Wire into `HotUpdater.wrap({ onError })`. Becomes an `error` event so the
   * engine can attribute a failed download/apply to the pending update.
   */
  onError(error: unknown): void;
  /**
   * Wire into `HotUpdater.wrap({ onNotifyAppReady })`. A `RECOVERED` result
   * (hot-updater reverted a bundle that crashed before the first frame)
   * becomes an `error` event for the reverted bundle; `STABLE` emits nothing.
   */
  onNotifyAppReady(result: HotUpdaterNotifyAppReadyResultLike): void;
}

declare const require: ((moduleId: string) => unknown) | undefined;

const noopUnsubscribe: Unsubscribe = () => {};

/** Bundle id hot-updater uses for "no bundle" before resolving to embedded. */
const NIL_UUID = '00000000-0000-0000-0000-000000000000';

/**
 * Events dispatched before the engine subscribes are queued up to this many,
 * then flushed to the first subscriber. `wrap` callbacks can fire before
 * `init()`'s `start()` reaches `onEvent`; this closes that race.
 */
const EARLY_EVENT_BUFFER_CAP = 32;

const normalizeUpdateId = (id: string | null | undefined): string | null => {
  if (typeof id !== 'string') {
    return null;
  }
  const lower = id.toLowerCase();
  return lower.length === 0 || lower === NIL_UUID ? null : lower;
};

const errorMessage = (error: unknown): string => {
  if (error instanceof Error && typeof error.message === 'string') {
    return error.message;
  }
  return String(error);
};

function resolveHotUpdaterModule(
  options: HotUpdaterAdapterOptions,
  warn: (message: string) => void
): HotUpdaterModuleLike | null {
  let candidate: unknown = options.hotUpdater;
  if (candidate == null) {
    try {
      candidate =
        typeof require === 'function'
          ? (
              require('@hot-updater/react-native') as {
                HotUpdater?: HotUpdaterModuleLike;
              }
            ).HotUpdater
          : undefined;
    } catch (error) {
      warn(
        `ReleaseHealth: @hot-updater/react-native could not be loaded (${String(
          error
        )}). The adapter is running in embedded-only mode: no update ids and ` +
          'no update events. Install @hot-updater/react-native in the host app ' +
          'to enable OTA health tracking.'
      );
      return null;
    }
  }
  const module = candidate as HotUpdaterModuleLike | null | undefined;
  if (
    module == null ||
    typeof module.getBundleId !== 'function' ||
    typeof module.getMinBundleId !== 'function'
  ) {
    warn(
      'ReleaseHealth: the @hot-updater/react-native module is missing ' +
        'getBundleId/getMinBundleId, so the adapter is running in embedded-only ' +
        'mode. This adapter was verified against @hot-updater/react-native ' +
        '0.35.x; check that the installed version is compatible.'
    );
    return null;
  }
  return module;
}

/**
 * Creates a {@link HotUpdaterAdapter} backed by hot-updater.
 *
 * Behavior notes:
 * - **Events are host-wired.** hot-updater has no update-event stream that
 *   carries a bundle id, so the adapter cannot self-subscribe. Wire
 *   `onUpdateProcessCompleted`, `onError`, and `onNotifyAppReady` into
 *   `HotUpdater.wrap`/`HotUpdater.init`; they feed the engine.
 * - **`downloaded` fires once per new bundle id.** A completed `UPDATE` is
 *   emitted once; a repeat of the same id in one session is suppressed so the
 *   engine's crash-loop counter is not reset. `ROLLBACK` and `UP_TO_DATE`
 *   emit nothing.
 * - **Rollbacks are discriminated, not spurious.** hot-updater reports a
 *   fleet rollback as `status: 'ROLLBACK'` (never as a download), so a rollback
 *   never shows up in the event stream as a phantom `update_downloaded`.
 * - **`rollback()` reverts to the embedded bundle**, when hot-updater exposes
 *   `updateBundle`. It stages the revert (it does not reload); trigger the
 *   reload yourself, telling the engine first with `ReleaseHealth.notifyReload()`.
 * - **Degrades gracefully.** When hot-updater is missing or its native module
 *   is unavailable, the adapter reports the embedded bundle, emits no events,
 *   and logs a single warning. It never throws into the host app.
 */
export function hotUpdaterAdapter(
  options: HotUpdaterAdapterOptions = {}
): HotUpdaterAdapter {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const updates = resolveHotUpdaterModule(options, warn);

  if (updates == null) {
    return {
      getActiveUpdateId: async () => null,
      getEmbeddedVersion: async () => 'unknown',
      onEvent: () => noopUnsubscribe,
      onUpdateProcessCompleted: () => {},
      onError: () => {},
      onNotifyAppReady: () => {},
    };
  }

  const listeners = new Set<(event: OtaAdapterEvent) => void>();
  let earlyBuffer: OtaAdapterEvent[] = [];
  let lastAnnouncedId: string | null = null;

  const deliver = (
    listener: (event: OtaAdapterEvent) => void,
    event: OtaAdapterEvent
  ): void => {
    try {
      listener(event);
    } catch (error) {
      warn(`ReleaseHealth: an update event listener threw: ${String(error)}`);
    }
  };

  const dispatch = (event: OtaAdapterEvent): void => {
    if (listeners.size === 0) {
      if (earlyBuffer.length < EARLY_EVENT_BUFFER_CAP) {
        earlyBuffer.push(event);
      }
      return;
    }
    for (const listener of [...listeners]) {
      deliver(listener, event);
    }
  };

  const adapter: HotUpdaterAdapter = {
    async getActiveUpdateId() {
      try {
        const bundleId = normalizeUpdateId(updates.getBundleId());
        const minBundleId = normalizeUpdateId(updates.getMinBundleId());
        return bundleId === minBundleId ? null : bundleId;
      } catch (error) {
        warn(
          'ReleaseHealth: hot-updater getBundleId()/getMinBundleId() threw ' +
            `(${String(error)}); treating this session as the embedded bundle.`
        );
        return null;
      }
    },

    async getEmbeddedVersion() {
      try {
        const version = updates.getAppVersion();
        return typeof version === 'string' && version.length > 0
          ? version
          : 'unknown';
      } catch {
        return 'unknown';
      }
    },

    onEvent(cb: (event: OtaAdapterEvent) => void): Unsubscribe {
      listeners.add(cb);
      if (earlyBuffer.length > 0) {
        const queued = earlyBuffer;
        earlyBuffer = [];
        for (const event of queued) {
          deliver(cb, event);
        }
      }
      return () => {
        listeners.delete(cb);
      };
    },

    onUpdateProcessCompleted(response: HotUpdaterUpdateResponseLike): void {
      if (response == null || response.status !== 'UPDATE') {
        // ROLLBACK and UP_TO_DATE are not downloads. A fleet rollback is
        // reported as ROLLBACK here, so it never becomes a phantom download.
        return;
      }
      const updateId = normalizeUpdateId(response.id);
      if (updateId === null) {
        warn(
          "ReleaseHealth: hot-updater reported a completed 'UPDATE' without a " +
            'bundle id; ignoring it. The engine needs the id to match the next ' +
            'launch to this update.'
        );
        return;
      }
      if (updateId === lastAnnouncedId) {
        return;
      }
      lastAnnouncedId = updateId;
      dispatch({ type: 'downloaded', updateId });
    },

    onError(error: unknown): void {
      dispatch({ type: 'error', message: errorMessage(error) });
    },

    onNotifyAppReady(result: HotUpdaterNotifyAppReadyResultLike): void {
      if (result == null || result.status !== 'RECOVERED') {
        return;
      }
      const updateId = normalizeUpdateId(result.crashedBundleId);
      dispatch({
        type: 'error',
        message:
          'hot-updater recovered from a crash in this bundle and rolled it back',
        ...(updateId !== null ? { updateId } : {}),
      });
    },
  };

  if (typeof updates.updateBundle === 'function') {
    const updateBundle = updates.updateBundle.bind(updates);
    adapter.rollback = async () => {
      try {
        const minBundleId = updates.getMinBundleId();
        return await updateBundle({
          bundleId: minBundleId,
          fileUrl: null,
          fileHash: null,
          status: 'ROLLBACK',
        });
      } catch (error) {
        warn(
          `ReleaseHealth: hot-updater rollback to the embedded bundle failed: ${String(
            error
          )}`
        );
        return false;
      }
    };
  }

  return adapter;
}

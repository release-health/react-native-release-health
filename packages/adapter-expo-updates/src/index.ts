/**
 * expo-updates adapter for react-native-release-health.
 *
 * Maps the expo-updates native state machine onto the vendor-neutral
 * `OtaAdapter` contract: the active update id, the embedded runtime version,
 * and edge-triggered `downloaded`/`error` events derived from state change
 * snapshots. expo-updates has no client-side rollback API, so the adapter
 * omits `rollback()` and the engine runs in recommendation-only mode.
 *
 * The expo-updates module is consumed through a small structural type and
 * loaded lazily, so this package has no hard dependency on expo-updates and
 * never throws into the host app when the module is missing or disabled.
 *
 * Verified against expo-updates 55.0.26 (Expo SDK 55).
 */

import type {
  OtaAdapter,
  OtaAdapterEvent,
  Unsubscribe,
} from 'react-native-release-health';

/**
 * Structural subset of an expo-updates manifest. Only the update id is
 * consumed; both `ExpoUpdatesManifest` and `EmbeddedManifest` satisfy it.
 */
export type ExpoUpdatesManifestLike = {
  /** Canonical UUID of the update the manifest describes. */
  id: string;
};

/**
 * Structural subset of the expo-updates state machine context
 * (`UpdatesNativeStateMachineContext`) this adapter reads. Every field is
 * optional so any context snapshot, full or partial, is accepted.
 */
export type ExpoUpdatesStateContextLike = {
  /** Manifest of the most recently downloaded (pending) update, if any. */
  downloadedManifest?: ExpoUpdatesManifestLike;
  /** Error from the last check for updates, if it failed. */
  checkError?: { message: string };
  /** Error from the last update download, if it failed. */
  downloadError?: { message: string };
};

/** Structural form of an expo-updates state change event. */
export type ExpoUpdatesStateChangeEventLike = {
  /** Full context snapshot after the transition. */
  context: ExpoUpdatesStateContextLike;
};

/** Structural form of the subscription returned by the state change listener. */
export type ExpoUpdatesSubscriptionLike = {
  /** Removes the listener. */
  remove(): void;
};

/**
 * Structural subset of the expo-updates module this adapter consumes.
 * Matches `import * as Updates from 'expo-updates'` on Expo SDK 55.
 */
export type ExpoUpdatesModuleLike = {
  /** Canonical lowercase UUID of the running update, null when disabled. */
  updateId: string | null;
  /** True when the embedded bundle (not a downloaded update) is running. */
  isEmbeddedLaunch: boolean;
  /** False in development, Expo Go, or misconfigured builds. */
  isEnabled: boolean;
  /** Runtime version of the current build, when configured. */
  runtimeVersion: string | null;
  /** Subscribes to state change events; returns a removable subscription. */
  addUpdatesStateChangeListener: (
    listener: (event: ExpoUpdatesStateChangeEventLike) => void
  ) => ExpoUpdatesSubscriptionLike;
  /**
   * Most recent state machine context, seeded from the native side at module
   * load. Optional: older expo-updates versions may not export it.
   */
  latestContext?: ExpoUpdatesStateContextLike;
};

/** Options accepted by {@link expoUpdatesAdapter}. */
export type ExpoUpdatesAdapterOptions = {
  /**
   * Alternative module implementation (tests, custom wrappers). Passing
   * `import * as Updates from 'expo-updates'` here also gives the host app a
   * compile-time check that the installed expo-updates version still matches
   * the shape this adapter expects. Default: `require('expo-updates')`.
   */
  updatesModule?: ExpoUpdatesModuleLike;
  /** Warning channel; defaults to `console.warn`. */
  warn?: (message: string) => void;
};

declare const require: ((moduleId: string) => unknown) | undefined;

const noopUnsubscribe: Unsubscribe = () => {};

const normalizeUpdateId = (id: string | null | undefined): string | null =>
  id == null ? null : id.toLowerCase();

type ContextSnapshot = {
  downloadedId: string | null;
  checkError: string | null;
  downloadError: string | null;
};

const readContext = (
  context: ExpoUpdatesStateContextLike
): ContextSnapshot => ({
  downloadedId: normalizeUpdateId(context.downloadedManifest?.id),
  checkError: context.checkError?.message ?? null,
  downloadError: context.downloadError?.message ?? null,
});

function resolveUpdatesModule(
  options: ExpoUpdatesAdapterOptions,
  warn: (message: string) => void
): ExpoUpdatesModuleLike | null {
  let candidate: unknown = options.updatesModule;
  if (candidate == null) {
    try {
      candidate =
        typeof require === 'function' ? require('expo-updates') : undefined;
    } catch (error) {
      warn(
        `ReleaseHealth: expo-updates could not be loaded (${String(error)}). ` +
          'The adapter is running in embedded-only mode: no update ids and no ' +
          'update events. Install expo-updates in the host app to enable OTA ' +
          'health tracking.'
      );
      return null;
    }
  }
  const module = candidate as ExpoUpdatesModuleLike | null | undefined;
  if (
    module == null ||
    typeof module.addUpdatesStateChangeListener !== 'function'
  ) {
    warn(
      'ReleaseHealth: the expo-updates module is missing ' +
        'addUpdatesStateChangeListener, so the adapter is running in ' +
        'embedded-only mode. This adapter was verified against expo-updates ' +
        '55.x; check that the installed expo-updates version is compatible.'
    );
    return null;
  }
  return module;
}

/**
 * Creates an {@link OtaAdapter} backed by expo-updates.
 *
 * Behavior notes:
 * - No `rollback()`: expo-updates only supports server-side rollbacks
 *   (`eas update:roll-back-to-embedded`), so the engine stays in
 *   recommendation-only mode and `autoRollback` has no effect.
 * - `downloaded` fires once per newly downloaded update id; `error` fires
 *   once per new check/download error message. A download already present
 *   when the adapter subscribes (a previous session's pending update) is
 *   treated as baseline and not re-announced, because re-announcing it every
 *   launch would reset the engine's launch counter and defeat crash-loop
 *   detection.
 * - `applied` is never emitted: expo-updates applies updates on the next
 *   launch (or explicit reload), which the engine detects by comparing the
 *   active update id against the pending marker.
 * - When expo-updates is missing or disabled (development builds, Expo Go),
 *   the adapter degrades to embedded-only mode with a single warning and
 *   never throws into the host app.
 */
export function expoUpdatesAdapter(
  options: ExpoUpdatesAdapterOptions = {}
): OtaAdapter {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const updates = resolveUpdatesModule(options, warn);

  if (updates == null) {
    return {
      getActiveUpdateId: async () => null,
      getEmbeddedVersion: async () => 'unknown',
      onEvent: () => noopUnsubscribe,
    };
  }

  return {
    async getActiveUpdateId() {
      if (updates.isEnabled === false || updates.isEmbeddedLaunch === true) {
        return null;
      }
      return normalizeUpdateId(updates.updateId);
    },

    async getEmbeddedVersion() {
      const version = updates.runtimeVersion;
      return typeof version === 'string' && version.length > 0
        ? version
        : 'unknown';
    },

    onEvent(cb: (event: OtaAdapterEvent) => void): Unsubscribe {
      if (updates.isEnabled === false) {
        warn(
          'ReleaseHealth: expo-updates is disabled in this build ' +
            '(development, Expo Go, or missing updates configuration), so no ' +
            'update events will be reported. Use a release build with an ' +
            'updates URL configured to track OTA health.'
        );
        return noopUnsubscribe;
      }

      let last: ContextSnapshot = {
        downloadedId: null,
        checkError: null,
        downloadError: null,
      };
      let baselineSeeded = false;

      if (updates.latestContext != null) {
        last = readContext(updates.latestContext);
        baselineSeeded = true;
      }

      const handler = (event: ExpoUpdatesStateChangeEventLike): void => {
        const context = event?.context;
        if (context == null) {
          return;
        }
        const snapshot = readContext(context);
        if (!baselineSeeded) {
          // No initial context was available at subscribe time, so the first
          // snapshot stands in for it: record without emitting, otherwise a
          // pending download from a previous session would be re-announced.
          last = snapshot;
          baselineSeeded = true;
          return;
        }
        const events: OtaAdapterEvent[] = [];
        if (
          snapshot.downloadedId != null &&
          snapshot.downloadedId !== last.downloadedId
        ) {
          events.push({ type: 'downloaded', updateId: snapshot.downloadedId });
        }
        if (
          snapshot.checkError != null &&
          snapshot.checkError !== last.checkError
        ) {
          events.push({
            type: 'error',
            message: snapshot.checkError,
            updateId: snapshot.downloadedId ?? undefined,
          });
        }
        if (
          snapshot.downloadError != null &&
          snapshot.downloadError !== last.downloadError
        ) {
          events.push({
            type: 'error',
            message: snapshot.downloadError,
            updateId: snapshot.downloadedId ?? undefined,
          });
        }
        last = snapshot;
        for (const adapterEvent of events) {
          try {
            cb(adapterEvent);
          } catch (error) {
            warn(
              `ReleaseHealth: an update event listener threw: ${String(error)}`
            );
          }
        }
      };

      let subscription: ExpoUpdatesSubscriptionLike | null = null;
      try {
        subscription = updates.addUpdatesStateChangeListener(handler);
      } catch (error) {
        warn(
          'ReleaseHealth: could not subscribe to expo-updates state changes ' +
            `(${String(error)}), so no update events will be reported. This ` +
            'adapter was verified against expo-updates 55.x; check that the ' +
            'installed expo-updates version is compatible.'
        );
        return noopUnsubscribe;
      }
      return () => {
        try {
          subscription?.remove();
        } catch (error) {
          warn(
            `ReleaseHealth: removing the expo-updates listener failed: ${String(error)}`
          );
        }
        subscription = null;
      };
    },
  };
}

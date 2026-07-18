/**
 * Shared public types for the release-health engine, adapters, and sinks.
 *
 * Everything in this file is vendor-neutral and free of react-native imports
 * so the health engine stays pure TypeScript and unit-testable in isolation.
 */

/** Returned by subscription methods; call to remove the listener. */
export type Unsubscribe = () => void;

/**
 * Event emitted by an OTA adapter when the vendor SDK reports activity.
 *
 * - `downloaded`: a new update finished downloading and will apply on a
 *   future launch (or explicit reload). `updateId` is required for the
 *   engine to arm probation.
 * - `applied`: the vendor reports the update is now the active bundle.
 * - `error`: the vendor reported a download/apply failure.
 */
export type OtaAdapterEvent = {
  type: 'downloaded' | 'applied' | 'error';
  updateId?: string;
  message?: string;
};

/**
 * The contract an OTA vendor integration must implement.
 *
 * Adapters degrade gracefully: `rollback` is optional, and when absent the
 * engine runs in recommendation-only mode instead of failing.
 */
export interface OtaAdapter {
  /** The active OTA update id, or null when running the embedded bundle. */
  getActiveUpdateId(): Promise<string | null>;
  /** The version of the bundle embedded in the native binary. */
  getEmbeddedVersion(): Promise<string>;
  /** Subscribe to vendor update activity. */
  onEvent(cb: (event: OtaAdapterEvent) => void): Unsubscribe;
  /**
   * Roll back to the previous bundle, where the vendor supports client-side
   * rollback. Resolves true when the rollback was accepted.
   */
  rollback?(): Promise<boolean>;
}

/** Why a rollback was recommended. */
export type RollbackReason = 'crash-loop' | 'apply-failed';

/** Payload passed to `onRollbackRecommended` listeners. */
export type RollbackRecommendation = {
  updateId: string;
  reason: RollbackReason;
};

/** Fields common to every exported event. */
type EventEnvelope = {
  /** Random id generated once per app session. */
  sessionId: string;
  /** Epoch milliseconds at emit time. */
  timestamp: number;
};

/**
 * The event stream delivered to sinks.
 *
 * `updateId` is null when the embedded bundle is running; on update-scoped
 * events it names the update the event is about.
 */
export type ReleaseHealthEvent = EventEnvelope &
  (
    | {
        type: 'session_start';
        updateId: string | null;
        nativeVersion: string;
        buildNumber: string;
        platform: string;
        sdkVersion: string;
        cohort?: string;
      }
    | { type: 'update_downloaded'; updateId: string }
    | { type: 'update_apply_success'; updateId: string; msToHealthy: number }
    | { type: 'update_apply_failed'; updateId: string; reason: string }
    | {
        type: 'crash';
        updateId: string | null;
        fatal: boolean;
        jsMessage?: string;
      }
    | { type: 'healthy'; updateId: string | null; msToHealthy: number }
    | { type: 'rollback_recommended'; updateId: string; reason: RollbackReason }
    | { type: 'rollback_executed'; updateId: string; success: boolean }
  );

/**
 * Receives the event stream. Sink failures are swallowed by the engine and
 * must never take the host app down.
 */
export interface Sink {
  onEvent(event: ReleaseHealthEvent): void;
  /** Force buffered events out, e.g. right before a fatal crash. */
  flush?(): Promise<void>;
}

/** Overall health of the currently running bundle. */
export type HealthStatus =
  /** `init()` has not been called (or has not finished starting). */
  | 'starting'
  /** No update on probation; embedded or previously accepted bundle. */
  | 'stable'
  /** A fresh update is active and waiting for `markHealthy()`. */
  | 'probation'
  /** The active update was marked healthy. */
  | 'healthy'
  /** `healthyTimeoutMs` elapsed without `markHealthy()`; not yet failed. */
  | 'suspect'
  /** Crash loop or apply failure detected; rollback recommended. */
  | 'failed';

/**
 * Persisted flags the engine reads and writes across launches. The shape
 * matches the native module surface exactly; tests substitute an in-memory
 * implementation.
 */
export interface HealthStorage {
  getPreviousCleanExit(): boolean;
  getPendingUpdate(): { updateId: string; downloadedAt: number } | null;
  setPendingUpdate(updateId: string, downloadedAt: number): void;
  clearPendingUpdate(): void;
  getLaunchCountSinceUpdate(): number;
  incrementLaunchCountSinceUpdate(): number;
  resetLaunchCountSinceUpdate(): void;
}

/** Time source; tests substitute a manually advanced fake. */
export interface Clock {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

/** Options accepted by `ReleaseHealth.init()`. */
export type ReleaseHealthOptions = {
  /** OTA vendor integration; see `OtaAdapter`. */
  adapter: OtaAdapter;
  /** Where events go. Defaults to no sinks (state machine still runs). */
  sinks?: Sink[];
  /**
   * How long after launching a fresh update the app has to call
   * `markHealthy()` before the update is considered suspect.
   * Default: 15000.
   */
  healthyTimeoutMs?: number;
  /**
   * Number of consecutive launches of a fresh update that may end without
   * `markHealthy()` (crashing or exiting abnormally) before the update is
   * declared failed and a rollback is recommended. Default: 2, meaning one
   * crashed launch plus one relaunch triggers the recommendation.
   */
  crashLoopThreshold?: number;
  /**
   * When true and the adapter implements `rollback()`, a failed update
   * triggers an automatic rollback. Otherwise recommendation-only.
   * Default: false.
   */
  autoRollback?: boolean;
  /** Optional rollout cohort label attached to `session_start`. */
  cohort?: string;
};

import type {
  Clock,
  HealthStatus,
  HealthStorage,
  OtaAdapter,
  OtaAdapterEvent,
  ReleaseHealthEvent,
  RollbackReason,
  RollbackRecommendation,
  Sink,
  Unsubscribe,
} from './types';

/** Snapshot of engine state exposed to `useReleaseHealth()`. */
export type EngineSnapshot = {
  status: HealthStatus;
  activeUpdateId: string | null;
  sessionId: string;
};

/** Everything the engine needs, injected so tests can fake all of it. */
export type EngineDeps = {
  adapter: OtaAdapter;
  storage: HealthStorage;
  clock: Clock;
  sinks: Sink[];
  /** True under `__DEV__`: probation and failure counting are disabled. */
  isDev: boolean;
  healthyTimeoutMs: number;
  crashLoopThreshold: number;
  autoRollback: boolean;
  cohort?: string;
  /** Session context stamped onto `session_start`. */
  context: {
    nativeVersion: string;
    buildNumber: string;
    platform: string;
    sdkVersion: string;
  };
  /** Random session id generator; injectable for deterministic tests. */
  generateSessionId?: () => string;
  /** Warning channel; defaults to console.warn. */
  warn?: (message: string) => void;
};

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown
  ? Omit<T, K>
  : never;

function defaultSessionId(): string {
  let id = '';
  for (let i = 0; i < 32; i++) {
    id += Math.floor(Math.random() * 16).toString(16);
  }
  return id;
}

/**
 * The pure-TS health state machine.
 *
 * Lifecycle per launch: `start()` reads the persisted pending-update marker
 * and decides whether the active bundle is on probation. During probation the
 * app must call `markHealthy()` within `healthyTimeoutMs`; a launch that ends
 * abnormally instead is counted, and `crashLoopThreshold` consecutive
 * launches without health declare the update failed and recommend rollback.
 *
 * The engine never throws into the host app: adapter and sink failures are
 * caught and surfaced through `warn`.
 */
export class HealthEngine {
  private readonly deps: EngineDeps;
  private readonly sessionId: string;
  private readonly sessionStartedAt: number;

  private status: HealthStatus = 'starting';
  private activeUpdateId: string | null = null;
  private probationStartedAt: number | null = null;
  private probationTimer: unknown = null;
  private healthyEmitted = false;
  private earlyHealthy = false;
  private started = false;

  private adapterUnsubscribe: Unsubscribe | null = null;
  private lastRecommendation: RollbackRecommendation | null = null;
  private rollbackListeners = new Set<(r: RollbackRecommendation) => void>();
  private statusListeners = new Set<() => void>();

  constructor(deps: EngineDeps) {
    this.deps = deps;
    this.sessionId = (deps.generateSessionId ?? defaultSessionId)();
    this.sessionStartedAt = deps.clock.now();
  }

  /**
   * Read persisted state, emit `session_start`, and begin probation when the
   * active update matches the pending marker. Call once per launch.
   */
  async start(): Promise<void> {
    if (this.started) {
      this.warn(
        'ReleaseHealth: start() called twice; ignoring. Initialize once at app startup.'
      );
      return;
    }
    this.started = true;

    try {
      this.activeUpdateId = await this.deps.adapter.getActiveUpdateId();
    } catch (error) {
      this.activeUpdateId = null;
      this.warn(
        `ReleaseHealth: adapter.getActiveUpdateId() failed (${String(error)}). ` +
          'Treating this session as the embedded bundle; check the adapter configuration.'
      );
    }

    for (const sink of this.deps.sinks) {
      if (sink.attach === undefined) {
        continue;
      }
      try {
        sink.attach({
          getSnapshot: () => this.getSnapshot(),
          onStatusChange: (cb) => this.onStatusChange(cb),
        });
      } catch (error) {
        this.warn(
          `ReleaseHealth: a sink threw from attach() and will not receive ` +
            `status updates: ${String(error)}`
        );
      }
    }

    this.emit({
      type: 'session_start',
      updateId: this.activeUpdateId,
      nativeVersion: this.deps.context.nativeVersion,
      buildNumber: this.deps.context.buildNumber,
      platform: this.deps.context.platform,
      sdkVersion: this.deps.context.sdkVersion,
      ...(this.deps.cohort !== undefined ? { cohort: this.deps.cohort } : {}),
    });

    this.adapterUnsubscribe = this.deps.adapter.onEvent((event) =>
      this.handleAdapterEvent(event)
    );

    if (this.deps.isDev) {
      // Dev reloads and dev crashes must never arm probation or count as
      // failures; events above still flow so sinks can be tested locally.
      this.setStatus('stable');
    } else {
      this.evaluateLaunch();
    }

    if (this.earlyHealthy) {
      // markHealthy() raced ahead of start(); apply it now that the
      // probation decision is in place.
      this.earlyHealthy = false;
      this.markHealthy();
    }
  }

  private evaluateLaunch(): void {
    const pending = this.deps.storage.getPendingUpdate();

    if (pending === null || pending.updateId !== this.activeUpdateId) {
      // Nothing pending, or the downloaded update has not been applied yet.
      this.setStatus('stable');
      return;
    }

    const attemptsBefore = this.deps.storage.getLaunchCountSinceUpdate();
    const previousCleanExit = this.deps.storage.getPreviousCleanExit();

    if (attemptsBefore >= 1 && previousCleanExit) {
      // The previous probation launch exited gracefully without reaching
      // healthy (user opened and backgrounded the app). Not a failure:
      // restart the consecutive count at this launch.
      this.deps.storage.resetLaunchCountSinceUpdate();
    }

    const attempt = this.deps.storage.incrementLaunchCountSinceUpdate();

    if (attemptsBefore >= 1 && !previousCleanExit) {
      // The previous probation launch of this same update ended abnormally
      // without markHealthy(): it crashed or was killed mid-probation.
      if (attempt >= this.deps.crashLoopThreshold) {
        this.declareFailed(pending.updateId, 'crash-loop');
        return;
      }
    }

    this.startProbation();
  }

  private startProbation(): void {
    this.probationStartedAt = this.deps.clock.now();
    this.setStatus('probation');
    this.armProbationTimer();
  }

  private armProbationTimer(): void {
    this.cancelProbationTimer();
    this.probationTimer = this.deps.clock.setTimeout(() => {
      if (this.status === 'probation') {
        this.warn(
          `ReleaseHealth: markHealthy() was not called within ${this.deps.healthyTimeoutMs}ms ` +
            'of launching a fresh update. Call ReleaseHealth.markHealthy() once your first ' +
            'screen is interactive, or raise healthyTimeoutMs if your startup is slower.'
        );
        this.setStatus('suspect');
      }
    }, this.deps.healthyTimeoutMs);
  }

  private cancelProbationTimer(): void {
    if (this.probationTimer !== null) {
      this.deps.clock.clearTimeout(this.probationTimer);
      this.probationTimer = null;
    }
  }

  /**
   * The app reached an interactive state. During probation this accepts the
   * update: `update_apply_success` is emitted and the pending marker cleared.
   * Arriving after the timeout ('suspect') still recovers the update.
   * Idempotent; only the first call emits.
   */
  markHealthy(): void {
    if (this.status === 'starting') {
      this.earlyHealthy = true;
      return;
    }
    if (this.healthyEmitted || this.status === 'failed') {
      return;
    }
    this.healthyEmitted = true;

    const now = this.deps.clock.now();
    const msToHealthy =
      now - (this.probationStartedAt ?? this.sessionStartedAt);

    this.emit({
      type: 'healthy',
      updateId: this.activeUpdateId,
      msToHealthy,
    });

    if (this.status === 'probation' || this.status === 'suspect') {
      const pending = this.deps.storage.getPendingUpdate();
      this.cancelProbationTimer();
      this.deps.storage.clearPendingUpdate();
      this.deps.storage.resetLaunchCountSinceUpdate();
      if (pending !== null) {
        this.emit({
          type: 'update_apply_success',
          updateId: pending.updateId,
          msToHealthy,
        });
      }
      this.setStatus('healthy');
    }
  }

  /**
   * Record a fatal JS error. Emits a `crash` event and asks sinks to flush
   * before the process likely dies. Failure counting happens on the next
   * launch via the abnormal-exit heuristic, so this never double-counts.
   */
  recordJsFatal(message: string | undefined): void {
    this.emit({
      type: 'crash',
      updateId: this.activeUpdateId,
      fatal: true,
      ...(message !== undefined ? { jsMessage: message } : {}),
    });
    for (const sink of this.deps.sinks) {
      try {
        sink.flush?.()?.catch(() => {
          // Crashing already; nothing useful left to do.
        });
      } catch {
        // Same: never let a sink turn a crash report into a second crash.
      }
    }
  }

  /**
   * A JS reload happened mid-session (e.g. `reloadAsync`). Per spec a reload
   * during probation restarts the probation timer and never counts as a
   * failure.
   */
  notifyReload(): void {
    if (this.status === 'probation' || this.status === 'suspect') {
      this.startProbation();
    }
  }

  /**
   * Subscribe to rollback recommendations. If one already fired this session
   * (init-order races), the listener is called immediately with it.
   */
  onRollbackRecommended(
    cb: (recommendation: RollbackRecommendation) => void
  ): Unsubscribe {
    this.rollbackListeners.add(cb);
    if (this.lastRecommendation !== null) {
      cb(this.lastRecommendation);
    }
    return () => {
      this.rollbackListeners.delete(cb);
    };
  }

  /** Subscribe to snapshot changes (drives `useReleaseHealth()`). */
  onStatusChange(cb: () => void): Unsubscribe {
    this.statusListeners.add(cb);
    return () => {
      this.statusListeners.delete(cb);
    };
  }

  getSnapshot(): EngineSnapshot {
    return {
      status: this.status,
      activeUpdateId: this.activeUpdateId,
      sessionId: this.sessionId,
    };
  }

  /** Detach timers and the adapter subscription (tests and teardown). */
  stop(): void {
    this.cancelProbationTimer();
    this.adapterUnsubscribe?.();
    this.adapterUnsubscribe = null;
  }

  private handleAdapterEvent(event: OtaAdapterEvent): void {
    if (event.type === 'downloaded') {
      if (event.updateId === undefined) {
        this.warn(
          "ReleaseHealth: adapter emitted 'downloaded' without an updateId; " +
            'ignoring it. The adapter must supply the update id so the next ' +
            'launch can be matched to this download.'
        );
        return;
      }
      this.deps.storage.setPendingUpdate(event.updateId, this.deps.clock.now());
      this.deps.storage.resetLaunchCountSinceUpdate();
      this.emit({ type: 'update_downloaded', updateId: event.updateId });
      return;
    }

    if (event.type === 'error') {
      const pending = this.deps.storage.getPendingUpdate();
      const updateId = event.updateId ?? pending?.updateId ?? null;
      if (updateId === null) {
        this.warn(
          `ReleaseHealth: adapter reported an update error with no update in flight: ${
            event.message ?? 'no message'
          }`
        );
        return;
      }
      this.emit({
        type: 'update_apply_failed',
        updateId,
        reason: event.message ?? 'adapter reported an update error',
      });
      if (pending !== null && pending.updateId === updateId) {
        // The pending update can no longer apply cleanly; stop tracking it
        // and tell the app.
        this.deps.storage.clearPendingUpdate();
        this.deps.storage.resetLaunchCountSinceUpdate();
        this.recommendRollback(updateId, 'apply-failed');
      }
      return;
    }

    // 'applied': informational. Probation starts on the next launch, when the
    // active update id actually matches the pending marker.
  }

  private declareFailed(updateId: string, reason: RollbackReason): void {
    this.deps.storage.clearPendingUpdate();
    this.deps.storage.resetLaunchCountSinceUpdate();
    this.emit({ type: 'update_apply_failed', updateId, reason });
    this.setStatus('failed');
    this.recommendRollback(updateId, reason);
  }

  private recommendRollback(updateId: string, reason: RollbackReason): void {
    const recommendation: RollbackRecommendation = { updateId, reason };
    this.lastRecommendation = recommendation;
    this.emit({ type: 'rollback_recommended', updateId, reason });
    for (const listener of this.rollbackListeners) {
      try {
        listener(recommendation);
      } catch (error) {
        this.warn(
          `ReleaseHealth: an onRollbackRecommended listener threw: ${String(error)}`
        );
      }
    }
    this.maybeAutoRollback(updateId);
  }

  private maybeAutoRollback(updateId: string): void {
    if (!this.deps.autoRollback) {
      return;
    }
    const rollback = this.deps.adapter.rollback?.bind(this.deps.adapter);
    if (rollback === undefined) {
      this.warn(
        'ReleaseHealth: autoRollback is enabled but this adapter does not ' +
          'implement rollback(); running in recommendation-only mode. Handle ' +
          'onRollbackRecommended yourself or use an adapter with rollback support.'
      );
      return;
    }
    rollback().then(
      (success) => {
        this.emit({ type: 'rollback_executed', updateId, success });
      },
      (error) => {
        this.emit({ type: 'rollback_executed', updateId, success: false });
        this.warn(`ReleaseHealth: adapter.rollback() failed: ${String(error)}`);
      }
    );
  }

  private setStatus(status: HealthStatus): void {
    if (this.status === status) {
      return;
    }
    this.status = status;
    for (const listener of this.statusListeners) {
      try {
        listener();
      } catch (error) {
        this.warn(`ReleaseHealth: a status listener threw: ${String(error)}`);
      }
    }
  }

  private emit(
    event: DistributiveOmit<ReleaseHealthEvent, 'sessionId' | 'timestamp'>
  ): void {
    const full = {
      ...event,
      sessionId: this.sessionId,
      timestamp: this.deps.clock.now(),
    } as ReleaseHealthEvent;
    for (const sink of this.deps.sinks) {
      try {
        sink.onEvent(full);
      } catch (error) {
        this.warn(
          `ReleaseHealth: a sink threw while handling '${full.type}' and the ` +
            `event was dropped for that sink: ${String(error)}`
        );
      }
    }
  }

  private warn(message: string): void {
    (this.deps.warn ?? console.warn)(message);
  }
}

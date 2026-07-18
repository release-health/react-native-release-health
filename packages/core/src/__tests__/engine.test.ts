import { describe, expect, it, jest } from '@jest/globals';
import { HealthEngine } from '../engine';
import type { EngineDeps } from '../engine';
import type {
  Clock,
  HealthStorage,
  OtaAdapter,
  OtaAdapterEvent,
  ReleaseHealthEvent,
  Sink,
} from '../types';

class FakeClock implements Clock {
  time = 1_000_000;
  private timers = new Map<number, { callback: () => void; due: number }>();
  private nextId = 1;

  now(): number {
    return this.time;
  }

  setTimeout(callback: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { callback, due: this.time + ms });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  advance(ms: number): void {
    this.time += ms;
    for (const [id, timer] of [...this.timers]) {
      if (timer.due <= this.time) {
        this.timers.delete(id);
        timer.callback();
      }
    }
  }

  /** Steal a pending callback so tests can fire it even after clearTimeout. */
  stealPendingCallback(): () => void {
    const first = [...this.timers.values()][0];
    if (first === undefined) {
      throw new Error('no pending timer to steal');
    }
    return first.callback;
  }

  get pendingTimerCount(): number {
    return this.timers.size;
  }
}

class FakeStorage implements HealthStorage {
  previousCleanExit = true;
  pending: { updateId: string; downloadedAt: number } | null = null;
  launchCount = 0;

  getPreviousCleanExit(): boolean {
    return this.previousCleanExit;
  }
  getPendingUpdate(): { updateId: string; downloadedAt: number } | null {
    return this.pending;
  }
  setPendingUpdate(updateId: string, downloadedAt: number): void {
    this.pending = { updateId, downloadedAt };
  }
  clearPendingUpdate(): void {
    this.pending = null;
  }
  getLaunchCountSinceUpdate(): number {
    return this.launchCount;
  }
  incrementLaunchCountSinceUpdate(): number {
    this.launchCount += 1;
    return this.launchCount;
  }
  resetLaunchCountSinceUpdate(): void {
    this.launchCount = 0;
  }
}

type AdapterHarness = {
  adapter: OtaAdapter;
  emit: (event: OtaAdapterEvent) => void;
  unsubscribe: jest.Mock;
};

function makeAdapter(
  activeUpdateId: string | null | Error,
  rollback?: OtaAdapter['rollback']
): AdapterHarness {
  let listener: ((event: OtaAdapterEvent) => void) | null = null;
  const unsubscribe = jest.fn();
  const adapter: OtaAdapter = {
    getActiveUpdateId: () =>
      activeUpdateId instanceof Error
        ? Promise.reject(activeUpdateId)
        : Promise.resolve(activeUpdateId),
    getEmbeddedVersion: () => Promise.resolve('1.0.0'),
    onEvent: (cb) => {
      listener = cb;
      return unsubscribe as unknown as () => void;
    },
  };
  if (rollback !== undefined) {
    adapter.rollback = rollback;
  }
  return {
    adapter,
    emit: (event) => {
      if (listener === null) {
        throw new Error('engine has not subscribed to the adapter yet');
      }
      listener(event);
    },
    unsubscribe,
  };
}

type CaptureSink = Sink & { events: ReleaseHealthEvent[] };

function makeSink(): CaptureSink {
  const events: ReleaseHealthEvent[] = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    },
  };
}

type Harness = {
  engine: HealthEngine;
  clock: FakeClock;
  storage: FakeStorage;
  sink: CaptureSink;
  warn: jest.Mock;
  adapterHarness: AdapterHarness;
};

function makeEngine(
  overrides: Partial<EngineDeps> & {
    activeUpdateId?: string | null | Error;
    storage?: FakeStorage;
    clock?: FakeClock;
    rollbackImpl?: OtaAdapter['rollback'];
  } = {}
): Harness {
  const clock = overrides.clock ?? new FakeClock();
  const storage = overrides.storage ?? new FakeStorage();
  const sink = makeSink();
  const warn = jest.fn();
  const adapterHarness = makeAdapter(
    overrides.activeUpdateId ?? null,
    overrides.rollbackImpl
  );

  const deps: EngineDeps = {
    adapter: overrides.adapter ?? adapterHarness.adapter,
    storage,
    clock,
    sinks: overrides.sinks ?? [sink],
    isDev: overrides.isDev ?? false,
    healthyTimeoutMs: overrides.healthyTimeoutMs ?? 15000,
    crashLoopThreshold: overrides.crashLoopThreshold ?? 2,
    autoRollback: overrides.autoRollback ?? false,
    context: overrides.context ?? {
      nativeVersion: '1.2.3',
      buildNumber: '42',
      platform: 'ios',
      sdkVersion: '0.83.10',
    },
    generateSessionId:
      'generateSessionId' in overrides
        ? overrides.generateSessionId
        : () => 'session-1',
    warn: 'warn' in overrides ? overrides.warn : (warn as (m: string) => void),
  };
  if (overrides.cohort !== undefined) {
    deps.cohort = overrides.cohort;
  }

  return {
    engine: new HealthEngine(deps),
    clock,
    storage,
    sink,
    warn,
    adapterHarness,
  };
}

function eventTypes(sink: CaptureSink): string[] {
  return sink.events.map((event) => event.type);
}

function lastEvent(sink: CaptureSink): ReleaseHealthEvent {
  const event = sink.events[sink.events.length - 1];
  if (event === undefined) {
    throw new Error('no events were emitted');
  }
  return event;
}

describe('session start', () => {
  it('emits session_start with full context and the active update id', async () => {
    const h = makeEngine({ activeUpdateId: 'update-1', cohort: 'beta' });
    await h.engine.start();

    expect(h.sink.events[0]).toEqual({
      type: 'session_start',
      sessionId: 'session-1',
      timestamp: h.clock.time,
      updateId: 'update-1',
      nativeVersion: '1.2.3',
      buildNumber: '42',
      platform: 'ios',
      sdkVersion: '0.83.10',
      cohort: 'beta',
    });
  });

  it('omits cohort when not configured', async () => {
    const h = makeEngine();
    await h.engine.start();

    expect(h.sink.events[0]).not.toHaveProperty('cohort');
  });

  it('generates a 32-char hex session id by default', async () => {
    const h = makeEngine({ generateSessionId: undefined });
    await h.engine.start();

    const event = h.sink.events[0]!;
    expect(event.sessionId).toMatch(/^[0-9a-f]{32}$/);
  });

  it('warns and ignores a second start()', async () => {
    const h = makeEngine();
    await h.engine.start();
    await h.engine.start();

    expect(eventTypes(h.sink)).toEqual(['session_start']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('start() called twice')
    );
  });

  it('falls back to console.warn when no warn channel is injected', async () => {
    const consoleWarn = jest
      .spyOn(console, 'warn')
      .mockImplementation(() => {});
    const h = makeEngine({ warn: undefined });
    await h.engine.start();
    await h.engine.start();

    expect(consoleWarn).toHaveBeenCalledWith(
      expect.stringContaining('start() called twice')
    );
    consoleWarn.mockRestore();
  });

  it('treats an adapter failure as the embedded bundle and warns', async () => {
    const h = makeEngine({ activeUpdateId: new Error('vendor exploded') });
    await h.engine.start();

    expect(h.sink.events[0]).toMatchObject({
      type: 'session_start',
      updateId: null,
    });
    expect(h.engine.getSnapshot().status).toBe('stable');
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('getActiveUpdateId() failed')
    );
  });
});

describe('probation decision at launch', () => {
  it('is stable with no pending update', async () => {
    const h = makeEngine({ activeUpdateId: 'update-1' });
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('stable');
    expect(h.clock.pendingTimerCount).toBe(0);
  });

  it('is stable while a downloaded update has not been applied yet', async () => {
    const h = makeEngine({ activeUpdateId: 'update-1' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('stable');
    expect(h.storage.pending).toEqual({
      updateId: 'update-2',
      downloadedAt: 999,
    });
    expect(h.storage.launchCount).toBe(0);
  });

  it('starts probation on the first launch of a pending update', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('probation');
    expect(h.storage.launchCount).toBe(1);
  });

  it('does not blame the update for an abnormal exit before its first launch', async () => {
    // The launch that downloaded the update may have been killed to apply it;
    // that exit belongs to the old bundle.
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    h.storage.previousCleanExit = false;
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('probation');
    expect(eventTypes(h.sink)).toEqual(['session_start']);
  });

  it('short-circuits probation in dev mode', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2', isDev: true });
    h.storage.setPendingUpdate('update-2', 999);
    h.storage.previousCleanExit = false;
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('stable');
    expect(h.storage.launchCount).toBe(0);
    expect(h.clock.pendingTimerCount).toBe(0);
  });
});

describe('markHealthy', () => {
  async function startProbationLaunch(): Promise<Harness> {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();
    return h;
  }

  it('accepts the update within the timeout', async () => {
    const h = await startProbationLaunch();
    h.clock.advance(3000);
    h.engine.markHealthy();

    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'healthy',
      'update_apply_success',
    ]);
    expect(h.sink.events[1]).toMatchObject({ msToHealthy: 3000 });
    expect(h.sink.events[2]).toMatchObject({
      updateId: 'update-2',
      msToHealthy: 3000,
    });
    expect(h.storage.pending).toBeNull();
    expect(h.storage.launchCount).toBe(0);
    expect(h.engine.getSnapshot().status).toBe('healthy');

    // The probation timer must not fire afterwards.
    h.clock.advance(60000);
    expect(h.engine.getSnapshot().status).toBe('healthy');
  });

  it('is idempotent', async () => {
    const h = await startProbationLaunch();
    h.engine.markHealthy();
    h.engine.markHealthy();

    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'healthy',
      'update_apply_success',
    ]);
  });

  it('moves to suspect after the timeout and warns', async () => {
    const h = await startProbationLaunch();
    h.clock.advance(15000);

    expect(h.engine.getSnapshot().status).toBe('suspect');
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('markHealthy() was not called within 15000ms')
    );
  });

  it('recovers a suspect update when markHealthy arrives late', async () => {
    const h = await startProbationLaunch();
    h.clock.advance(20000);
    h.engine.markHealthy();

    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'healthy',
      'update_apply_success',
    ]);
    expect(h.engine.getSnapshot().status).toBe('healthy');
    expect(h.storage.pending).toBeNull();
  });

  it('emits healthy without apply_success outside probation', async () => {
    const h = makeEngine({ activeUpdateId: null });
    await h.engine.start();
    h.clock.advance(500);
    h.engine.markHealthy();

    expect(eventTypes(h.sink)).toEqual(['session_start', 'healthy']);
    expect(lastEvent(h.sink)).toMatchObject({
      updateId: null,
      msToHealthy: 500,
    });
    expect(h.engine.getSnapshot().status).toBe('stable');
  });

  it('buffers a markHealthy that arrives before start() finishes', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    h.engine.markHealthy();
    expect(h.sink.events).toEqual([]);

    await h.engine.start();

    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'healthy',
      'update_apply_success',
    ]);
    expect(h.engine.getSnapshot().status).toBe('healthy');
  });

  it('skips apply_success when the marker was already cleared mid-probation', async () => {
    const h = await startProbationLaunch();
    // Vendor reports the pending update failed while probation is running.
    h.adapterHarness.emit({ type: 'error', updateId: 'update-2' });
    h.engine.markHealthy();

    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'update_apply_failed',
      'rollback_recommended',
      'healthy',
    ]);
    expect(h.engine.getSnapshot().status).toBe('healthy');
  });

  it('does nothing once the update is declared failed', async () => {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = false;
    const h = makeEngine({ activeUpdateId: 'update-2', storage });
    await h.engine.start();
    expect(h.engine.getSnapshot().status).toBe('failed');

    h.engine.markHealthy();
    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'update_apply_failed',
      'rollback_recommended',
    ]);
  });

  it('ignores a stale probation timer that fires after cancellation', async () => {
    const h = await startProbationLaunch();
    const staleCallback = h.clock.stealPendingCallback();
    h.engine.markHealthy();
    staleCallback();

    expect(h.engine.getSnapshot().status).toBe('healthy');
  });
});

describe('crash-loop detection across launches', () => {
  it('declares failure on the second launch after an abnormal exit (default threshold)', async () => {
    const storage = new FakeStorage();

    // Launch 1: probation, then the app dies without markHealthy.
    const first = makeEngine({ activeUpdateId: 'update-2', storage });
    storage.setPendingUpdate('update-2', 999);
    await first.engine.start();
    expect(first.engine.getSnapshot().status).toBe('probation');

    // Launch 2: the native layer reports the abnormal exit.
    storage.previousCleanExit = false;
    const second = makeEngine({ activeUpdateId: 'update-2', storage });
    await second.engine.start();

    expect(second.engine.getSnapshot().status).toBe('failed');
    expect(eventTypes(second.sink)).toEqual([
      'session_start',
      'update_apply_failed',
      'rollback_recommended',
    ]);
    expect(second.sink.events[1]).toMatchObject({
      updateId: 'update-2',
      reason: 'crash-loop',
    });
    expect(second.sink.events[2]).toMatchObject({
      updateId: 'update-2',
      reason: 'crash-loop',
    });
    expect(storage.pending).toBeNull();
    expect(storage.launchCount).toBe(0);
  });

  it('keeps probation going below the threshold', async () => {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = false;
    const h = makeEngine({
      activeUpdateId: 'update-2',
      storage,
      crashLoopThreshold: 3,
    });
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('probation');
    expect(storage.launchCount).toBe(2);
  });

  it('resets the consecutive count after a graceful exit without healthy', async () => {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = true;
    const h = makeEngine({ activeUpdateId: 'update-2', storage });
    await h.engine.start();

    expect(h.engine.getSnapshot().status).toBe('probation');
    expect(storage.launchCount).toBe(1);
  });

  it('notifies rollback listeners and replays for late subscribers', async () => {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = false;
    const h = makeEngine({ activeUpdateId: 'update-2', storage });

    const early = jest.fn();
    h.engine.onRollbackRecommended(early);
    await h.engine.start();

    const late = jest.fn();
    const unsubscribe = h.engine.onRollbackRecommended(late);

    const expected = { updateId: 'update-2', reason: 'crash-loop' };
    expect(early).toHaveBeenCalledWith(expected);
    expect(late).toHaveBeenCalledWith(expected);

    unsubscribe();
  });

  it('warns when a rollback listener throws', async () => {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = false;
    const h = makeEngine({ activeUpdateId: 'update-2', storage });
    h.engine.onRollbackRecommended(() => {
      throw new Error('listener bug');
    });
    await h.engine.start();

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('onRollbackRecommended listener threw')
    );
  });
});

describe('auto rollback', () => {
  async function declareFailure(
    rollbackImpl: OtaAdapter['rollback'] | undefined,
    autoRollback = true
  ): Promise<Harness> {
    const storage = new FakeStorage();
    storage.setPendingUpdate('update-2', 999);
    storage.launchCount = 1;
    storage.previousCleanExit = false;
    const h = makeEngine({
      activeUpdateId: 'update-2',
      storage,
      autoRollback,
      rollbackImpl,
    });
    await h.engine.start();
    // Let the rollback promise settle.
    await Promise.resolve();
    await Promise.resolve();
    return h;
  }

  it('executes rollback when enabled and supported', async () => {
    const rollback = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const h = await declareFailure(rollback);

    expect(rollback).toHaveBeenCalled();
    expect(lastEvent(h.sink)).toMatchObject({
      type: 'rollback_executed',
      updateId: 'update-2',
      success: true,
    });
  });

  it('reports an unsuccessful rollback', async () => {
    const rollback = jest.fn<() => Promise<boolean>>().mockResolvedValue(false);
    const h = await declareFailure(rollback);

    expect(lastEvent(h.sink)).toMatchObject({
      type: 'rollback_executed',
      success: false,
    });
  });

  it('reports and warns when rollback rejects', async () => {
    const rollback = jest
      .fn<() => Promise<boolean>>()
      .mockRejectedValue(new Error('vendor refused'));
    const h = await declareFailure(rollback);

    expect(lastEvent(h.sink)).toMatchObject({
      type: 'rollback_executed',
      success: false,
    });
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('adapter.rollback() failed')
    );
  });

  it('warns and stays recommendation-only when the adapter lacks rollback', async () => {
    const h = await declareFailure(undefined);

    expect(eventTypes(h.sink)).not.toContain('rollback_executed');
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('does not implement rollback()')
    );
  });

  it('does not roll back when autoRollback is off', async () => {
    const rollback = jest.fn<() => Promise<boolean>>().mockResolvedValue(true);
    const h = await declareFailure(rollback, false);

    expect(rollback).not.toHaveBeenCalled();
    expect(eventTypes(h.sink)).not.toContain('rollback_executed');
  });
});

describe('adapter events', () => {
  it('arms the pending marker on download', async () => {
    const h = makeEngine({ activeUpdateId: null });
    await h.engine.start();
    h.storage.launchCount = 3;
    h.adapterHarness.emit({ type: 'downloaded', updateId: 'update-9' });

    expect(h.storage.pending).toEqual({
      updateId: 'update-9',
      downloadedAt: h.clock.time,
    });
    expect(h.storage.launchCount).toBe(0);
    expect(lastEvent(h.sink)).toMatchObject({
      type: 'update_downloaded',
      updateId: 'update-9',
    });
  });

  it('warns and ignores a download without an update id', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.adapterHarness.emit({ type: 'downloaded' });

    expect(h.storage.pending).toBeNull();
    expect(eventTypes(h.sink)).toEqual(['session_start']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("'downloaded' without an updateId")
    );
  });

  it('fails the pending update on a matching error event', async () => {
    const h = makeEngine({ activeUpdateId: null });
    await h.engine.start();
    h.adapterHarness.emit({ type: 'downloaded', updateId: 'update-9' });
    h.adapterHarness.emit({
      type: 'error',
      updateId: 'update-9',
      message: 'signature mismatch',
    });

    expect(h.storage.pending).toBeNull();
    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'update_downloaded',
      'update_apply_failed',
      'rollback_recommended',
    ]);
    expect(h.sink.events[2]).toMatchObject({
      updateId: 'update-9',
      reason: 'signature mismatch',
    });
    expect(lastEvent(h.sink)).toMatchObject({ reason: 'apply-failed' });
  });

  it('attributes an error without an id to the pending update', async () => {
    const h = makeEngine({ activeUpdateId: null });
    await h.engine.start();
    h.adapterHarness.emit({ type: 'downloaded', updateId: 'update-9' });
    h.adapterHarness.emit({ type: 'error' });

    expect(h.storage.pending).toBeNull();
    expect(h.sink.events[2]).toMatchObject({
      type: 'update_apply_failed',
      updateId: 'update-9',
      reason: 'adapter reported an update error',
    });
  });

  it('reports an error for a different update without touching the marker', async () => {
    const h = makeEngine({ activeUpdateId: null });
    await h.engine.start();
    h.adapterHarness.emit({ type: 'downloaded', updateId: 'update-9' });
    h.adapterHarness.emit({ type: 'error', updateId: 'update-8' });

    expect(h.storage.pending).toEqual(
      expect.objectContaining({ updateId: 'update-9' })
    );
    expect(eventTypes(h.sink)).toEqual([
      'session_start',
      'update_downloaded',
      'update_apply_failed',
    ]);
  });

  it('only warns on an error with no update in flight', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.adapterHarness.emit({ type: 'error', message: 'network down' });

    expect(eventTypes(h.sink)).toEqual(['session_start']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('no update in flight: network down')
    );
  });

  it('describes a message-less orphan error too', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.adapterHarness.emit({ type: 'error' });

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('no update in flight: no message')
    );
  });

  it('treats applied as informational', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.adapterHarness.emit({ type: 'applied', updateId: 'update-9' });

    expect(eventTypes(h.sink)).toEqual(['session_start']);
  });
});

describe('js fatals', () => {
  it('emits a crash event and flushes sinks', async () => {
    const flush = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
    const flushingSink: CaptureSink & { flush: () => Promise<void> } = {
      events: [],
      onEvent(event) {
        this.events.push(event);
      },
      flush,
    };
    const h = makeEngine({ activeUpdateId: 'update-2', sinks: [flushingSink] });
    await h.engine.start();
    h.engine.recordJsFatal('boom at startup');

    expect(lastEvent(flushingSink)).toMatchObject({
      type: 'crash',
      updateId: 'update-2',
      fatal: true,
      jsMessage: 'boom at startup',
    });
    expect(flush).toHaveBeenCalled();
  });

  it('tolerates sinks whose flush rejects or throws', async () => {
    const rejecting: Sink = {
      onEvent() {},
      flush: () => Promise.reject(new Error('offline')),
    };
    const throwing: Sink = {
      onEvent() {},
      flush: () => {
        throw new Error('sync bug');
      },
    };
    const untouched = makeSink();
    const h = makeEngine({ sinks: [rejecting, throwing, untouched] });
    await h.engine.start();

    expect(() => h.engine.recordJsFatal(undefined)).not.toThrow();
    expect(eventTypes(untouched)).toEqual(['session_start', 'crash']);
  });

  it('keeps the crash event free of a jsMessage key when undefined', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.engine.recordJsFatal(undefined);

    expect(lastEvent(h.sink)).toEqual({
      type: 'crash',
      sessionId: 'session-1',
      timestamp: h.clock.time,
      updateId: null,
      fatal: true,
    });
  });
});

describe('reload guard', () => {
  it('restarts the probation timer without counting a failure', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();

    h.clock.advance(10000);
    h.engine.notifyReload();
    h.clock.advance(10000);
    // 20s since launch, but only 10s since the reload: still probation.
    expect(h.engine.getSnapshot().status).toBe('probation');
    expect(h.storage.launchCount).toBe(1);

    h.clock.advance(5000);
    expect(h.engine.getSnapshot().status).toBe('suspect');
  });

  it('re-arms probation from suspect', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();
    h.clock.advance(15000);
    expect(h.engine.getSnapshot().status).toBe('suspect');

    h.engine.notifyReload();
    expect(h.engine.getSnapshot().status).toBe('probation');
  });

  it('does nothing outside probation', async () => {
    const h = makeEngine();
    await h.engine.start();
    h.engine.notifyReload();

    expect(h.engine.getSnapshot().status).toBe('stable');
    expect(h.clock.pendingTimerCount).toBe(0);
  });
});

describe('listeners and teardown', () => {
  it('notifies status listeners and honors unsubscribe', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    const listener = jest.fn();
    const unsubscribe = h.engine.onStatusChange(listener);
    await h.engine.start();

    expect(listener).toHaveBeenCalled();
    const calls = listener.mock.calls.length;

    unsubscribe();
    h.engine.markHealthy();
    expect(listener).toHaveBeenCalledTimes(calls);
  });

  it('warns when a status listener throws', async () => {
    const h = makeEngine();
    h.engine.onStatusChange(() => {
      throw new Error('render bug');
    });
    await h.engine.start();

    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining('status listener threw')
    );
  });

  it('keeps later sinks working when an earlier sink throws', async () => {
    const bad: Sink = {
      onEvent() {
        throw new Error('sink bug');
      },
    };
    const good = makeSink();
    const h = makeEngine({ sinks: [bad, good] });
    await h.engine.start();

    expect(eventTypes(good)).toEqual(['session_start']);
    expect(h.warn).toHaveBeenCalledWith(
      expect.stringContaining("a sink threw while handling 'session_start'")
    );
  });

  it('stop() cancels the probation timer and detaches from the adapter', async () => {
    const h = makeEngine({ activeUpdateId: 'update-2' });
    h.storage.setPendingUpdate('update-2', 999);
    await h.engine.start();
    expect(h.clock.pendingTimerCount).toBe(1);

    h.engine.stop();
    expect(h.clock.pendingTimerCount).toBe(0);
    expect(h.adapterHarness.unsubscribe).toHaveBeenCalled();
  });

  it('stop() before start() is safe', () => {
    const h = makeEngine();
    expect(() => h.engine.stop()).not.toThrow();
  });

  it('exposes a stable snapshot', async () => {
    const h = makeEngine({ activeUpdateId: 'update-1' });
    await h.engine.start();

    expect(h.engine.getSnapshot()).toEqual({
      status: 'stable',
      activeUpdateId: 'update-1',
      sessionId: 'session-1',
    });
  });
});

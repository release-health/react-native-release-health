import { describe, expect, it, jest } from '@jest/globals';
import { HealthEngine } from '../../../core/src/engine';
import type {
  Clock,
  HealthStorage,
  ReleaseHealthEvent,
  Sink,
  SinkContext,
} from 'react-native-release-health';
import { sentrySink } from '../index';
import type {
  SentryBreadcrumbLike,
  SentryLike,
  SentrySeverityLike,
} from '../index';

type FakeSentry = SentryLike & {
  tags: Record<string, string>;
  breadcrumbs: SentryBreadcrumbLike[];
  messages: { message: string; level: SentrySeverityLike | undefined }[];
  flushTimeouts: (number | undefined)[];
};

function makeSentry(): FakeSentry {
  const fake: FakeSentry = {
    tags: {},
    breadcrumbs: [],
    messages: [],
    flushTimeouts: [],
    setTag(key, value) {
      fake.tags[key] = value;
    },
    addBreadcrumb(breadcrumb) {
      fake.breadcrumbs.push(breadcrumb);
    },
    captureMessage(message, level) {
      fake.messages.push({ message, level });
      return 'event-id';
    },
    flush(timeout) {
      fake.flushTimeouts.push(timeout);
      return Promise.resolve(true);
    },
  };
  return fake;
}

type ContextHarness = {
  context: SinkContext;
  set: (next: {
    status?: ReturnType<SinkContext['getSnapshot']>['status'];
    activeUpdateId?: string | null;
  }) => void;
  listenerCount: () => number;
};

function makeContext(
  initial: Partial<ReturnType<SinkContext['getSnapshot']>> = {}
): ContextHarness {
  let snapshot: ReturnType<SinkContext['getSnapshot']> = {
    status: 'starting',
    activeUpdateId: null,
    sessionId: 'session-1',
    ...initial,
  };
  const listeners = new Set<() => void>();
  return {
    context: {
      getSnapshot: () => snapshot,
      onStatusChange: (cb) => {
        listeners.add(cb);
        return () => {
          listeners.delete(cb);
        };
      },
    },
    set: (next) => {
      snapshot = { ...snapshot, ...next };
      for (const listener of listeners) {
        listener();
      }
    },
    listenerCount: () => listeners.size,
  };
}

const envelope = { sessionId: 'session-1', timestamp: 12345 };

describe('tags via attach', () => {
  it('sets ota.update_id and ota.status from the snapshot at attach time', () => {
    const sentry = makeSentry();
    const sink = sentrySink({ sentry });
    const harness = makeContext({ status: 'starting', activeUpdateId: 'u-1' });

    sink.attach!(harness.context);
    expect(sentry.tags).toEqual({
      'ota.update_id': 'u-1',
      'ota.status': 'starting',
    });
  });

  it('tags the embedded bundle as "embedded"', () => {
    const sentry = makeSentry();
    const sink = sentrySink({ sentry });
    sink.attach!(makeContext({ activeUpdateId: null }).context);
    expect(sentry.tags['ota.update_id']).toBe('embedded');
  });

  it('re-tags on every status transition', () => {
    const sentry = makeSentry();
    const sink = sentrySink({ sentry });
    const harness = makeContext({ status: 'starting', activeUpdateId: 'u-1' });
    sink.attach!(harness.context);

    harness.set({ status: 'probation' });
    expect(sentry.tags['ota.status']).toBe('probation');

    harness.set({ status: 'failed' });
    expect(sentry.tags['ota.status']).toBe('failed');
    expect(sentry.tags['ota.update_id']).toBe('u-1');
  });
});

describe('breadcrumbs', () => {
  function crumbFor(event: ReleaseHealthEvent): SentryBreadcrumbLike {
    const sentry = makeSentry();
    sentrySink({ sentry }).onEvent(event);
    expect(sentry.breadcrumbs).toHaveLength(1);
    return sentry.breadcrumbs[0]!;
  }

  it('records session_start as an info breadcrumb without the envelope', () => {
    const crumb = crumbFor({
      ...envelope,
      type: 'session_start',
      updateId: 'u-1',
      nativeVersion: '1.2.3',
      buildNumber: '42',
      platform: 'ios',
      sdkVersion: '0.83.10',
      cohort: 'beta',
    });
    expect(crumb).toEqual({
      category: 'ota',
      message: 'OTA session started on update u-1',
      level: 'info',
      data: {
        updateId: 'u-1',
        nativeVersion: '1.2.3',
        buildNumber: '42',
        platform: 'ios',
        sdkVersion: '0.83.10',
        cohort: 'beta',
      },
    });
  });

  it('describes embedded sessions without an update id', () => {
    const crumb = crumbFor({
      ...envelope,
      type: 'session_start',
      updateId: null,
      nativeVersion: '1.2.3',
      buildNumber: '42',
      platform: 'ios',
      sdkVersion: '0.83.10',
    });
    expect(crumb.message).toBe('OTA session started on the embedded bundle');
  });

  it.each<[ReleaseHealthEvent, string, SentrySeverityLike]>([
    [
      { ...envelope, type: 'update_downloaded', updateId: 'u-2' },
      'OTA update u-2 downloaded',
      'info',
    ],
    [
      {
        ...envelope,
        type: 'update_apply_success',
        updateId: 'u-2',
        msToHealthy: 800,
      },
      'OTA update u-2 applied and healthy after 800ms',
      'info',
    ],
    [
      {
        ...envelope,
        type: 'update_apply_failed',
        updateId: 'u-2',
        reason: 'crash-loop',
      },
      'OTA update u-2 failed to apply (crash-loop)',
      'warning',
    ],
    [
      {
        ...envelope,
        type: 'crash',
        updateId: 'u-2',
        fatal: true,
        jsMessage: 'boom',
      },
      'Fatal error on update u-2',
      'warning',
    ],
    [
      { ...envelope, type: 'healthy', updateId: null, msToHealthy: 500 },
      'App healthy on the embedded bundle after 500ms',
      'info',
    ],
    [
      {
        ...envelope,
        type: 'rollback_recommended',
        updateId: 'u-2',
        reason: 'crash-loop',
      },
      'OTA rollback recommended for update u-2 (crash-loop)',
      'warning',
    ],
    [
      {
        ...envelope,
        type: 'rollback_executed',
        updateId: 'u-2',
        success: true,
      },
      'OTA rollback executed for update u-2',
      'info',
    ],
    [
      {
        ...envelope,
        type: 'rollback_executed',
        updateId: 'u-2',
        success: false,
      },
      'OTA rollback failed for update u-2',
      'warning',
    ],
  ])('maps %s to a breadcrumb', (event, message, level) => {
    const crumb = crumbFor(event);
    expect(crumb.category).toBe('ota');
    expect(crumb.message).toBe(message);
    expect(crumb.level).toBe(level);
    expect(crumb.data).not.toHaveProperty('sessionId');
    expect(crumb.data).not.toHaveProperty('timestamp');
    expect(crumb.data).not.toHaveProperty('type');
  });
});

describe('captured messages', () => {
  it('captures rollback_recommended as an error message', () => {
    const sentry = makeSentry();
    sentrySink({ sentry }).onEvent({
      ...envelope,
      type: 'rollback_recommended',
      updateId: 'u-2',
      reason: 'crash-loop',
    });
    expect(sentry.messages).toEqual([
      {
        message: 'OTA rollback recommended for update u-2 (crash-loop)',
        level: 'error',
      },
    ]);
  });

  it('does not capture messages for other events', () => {
    const sentry = makeSentry();
    const sink = sentrySink({ sentry });
    sink.onEvent({
      ...envelope,
      type: 'crash',
      updateId: 'u-2',
      fatal: true,
    });
    sink.onEvent({
      ...envelope,
      type: 'update_apply_failed',
      updateId: 'u-2',
      reason: 'crash-loop',
    });
    expect(sentry.messages).toEqual([]);
  });

  it('honors captureRecommendations: false', () => {
    const sentry = makeSentry();
    sentrySink({ sentry, captureRecommendations: false }).onEvent({
      ...envelope,
      type: 'rollback_recommended',
      updateId: 'u-2',
      reason: 'apply-failed',
    });
    expect(sentry.messages).toEqual([]);
    expect(sentry.breadcrumbs).toHaveLength(1);
  });
});

describe('flush', () => {
  it('delegates to Sentry.flush when present', async () => {
    const sentry = makeSentry();
    await sentrySink({ sentry }).flush!();
    expect(sentry.flushTimeouts).toEqual([2000]);
  });

  it('resolves when the Sentry module has no flush', async () => {
    const sentry = makeSentry();
    delete (sentry as Partial<SentryLike>).flush;
    await expect(sentrySink({ sentry }).flush!()).resolves.toBeUndefined();
  });
});

describe('graceful degradation', () => {
  const crashEvent: ReleaseHealthEvent = {
    ...envelope,
    type: 'crash',
    updateId: null,
    fatal: true,
  };

  it('degrades to an inert sink when @sentry/react-native is not installed', () => {
    // This workspace deliberately has no @sentry/react-native dependency, so
    // the bare factory exercises the real require failure.
    const warn = jest.fn();
    const sink = sentrySink({ warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('could not be loaded')
    );
    expect(sink.attach).toBeUndefined();
    expect(sink.flush).toBeUndefined();
    expect(() => sink.onEvent(crashEvent)).not.toThrow();
  });

  it('degrades with one warning when the module is missing methods', () => {
    const warn = jest.fn();
    const broken = { setTag: () => {} } as unknown as SentryLike;
    const sink = sentrySink({ sentry: broken, warn });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('missing setTag, addBreadcrumb')
    );
    expect(() => sink.onEvent(crashEvent)).not.toThrow();
  });
});

describe('integration with the health engine', () => {
  function fakeStorage(overrides: {
    pending?: { updateId: string; downloadedAt: number } | null;
    launchCount?: number;
    previousCleanExit?: boolean;
  }): HealthStorage {
    let pending = overrides.pending ?? null;
    let launchCount = overrides.launchCount ?? 0;
    return {
      getPreviousCleanExit: () => overrides.previousCleanExit ?? true,
      getPendingUpdate: () => pending,
      setPendingUpdate: (updateId, downloadedAt) => {
        pending = { updateId, downloadedAt };
      },
      clearPendingUpdate: () => {
        pending = null;
      },
      getLaunchCountSinceUpdate: () => launchCount,
      incrementLaunchCountSinceUpdate: () => ++launchCount,
      resetLaunchCountSinceUpdate: () => {
        launchCount = 0;
      },
    };
  }

  const clock: Clock = {
    now: () => 1000,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  };

  function engineFor(sink: Sink, storage: HealthStorage): HealthEngine {
    return new HealthEngine({
      adapter: {
        getActiveUpdateId: () => Promise.resolve('u-1'),
        getEmbeddedVersion: () => Promise.resolve('1.0.0'),
        onEvent: () => () => {},
      },
      storage,
      clock,
      sinks: [sink],
      isDev: false,
      healthyTimeoutMs: 15000,
      crashLoopThreshold: 2,
      autoRollback: false,
      context: {
        nativeVersion: '1.0.0',
        buildNumber: '1',
        platform: 'test',
        sdkVersion: '0.0.0',
      },
    });
  }

  it('tags a probation launch so a crash is segmented by update and status', async () => {
    const sentry = makeSentry();
    const storage = fakeStorage({
      pending: { updateId: 'u-1', downloadedAt: 500 },
    });
    const engine = engineFor(sentrySink({ sentry }), storage);
    await engine.start();

    expect(sentry.tags).toEqual({
      'ota.update_id': 'u-1',
      'ota.status': 'probation',
    });

    // A fatal during probation: the breadcrumb trail is flushed with the
    // tags above already on the scope.
    engine.recordJsFatal('boom');
    expect(sentry.flushTimeouts).toEqual([2000]);
    expect(sentry.breadcrumbs.map((crumb) => crumb.message)).toEqual([
      'OTA session started on update u-1',
      'Fatal error on update u-1',
    ]);
  });

  it('captures the rollback recommendation on the crash-loop launch', async () => {
    const sentry = makeSentry();
    const storage = fakeStorage({
      pending: { updateId: 'u-1', downloadedAt: 500 },
      launchCount: 1,
      previousCleanExit: false,
    });
    const engine = engineFor(sentrySink({ sentry }), storage);
    await engine.start();

    expect(sentry.tags['ota.status']).toBe('failed');
    expect(sentry.messages).toEqual([
      {
        message: 'OTA rollback recommended for update u-1 (crash-loop)',
        level: 'error',
      },
    ]);
  });
});

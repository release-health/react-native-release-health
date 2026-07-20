import { describe, expect, it, jest } from '@jest/globals';
import type {
  Clock,
  HealthStorage,
  OtaAdapterEvent,
  ReleaseHealthEvent,
  Sink,
} from 'react-native-release-health';
import { HealthEngine } from '../../../core/src/engine';
import type {
  HotUpdaterModuleLike,
  HotUpdaterUpdateBundleParamsLike,
} from '../index';
import { hotUpdaterAdapter } from '../index';

const MIN_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const UPDATE_ID = '11111111-2222-3333-4444-555555555555';
const OTHER_ID = '99999999-8888-7777-6666-555555555555';

type FakeModule = {
  module: HotUpdaterModuleLike;
  updateBundleCalls: () => HotUpdaterUpdateBundleParamsLike[];
};

function fakeHotUpdater(
  overrides: Partial<HotUpdaterModuleLike> = {}
): FakeModule {
  const calls: HotUpdaterUpdateBundleParamsLike[] = [];
  const module: HotUpdaterModuleLike = {
    getBundleId: () => MIN_ID,
    getMinBundleId: () => MIN_ID,
    getAppVersion: () => '1.0.0',
    updateBundle: async (params) => {
      calls.push(params);
      return true;
    },
    ...overrides,
  };
  return { module, updateBundleCalls: () => calls };
}

function collect(module: HotUpdaterModuleLike, warn = jest.fn()) {
  const adapter = hotUpdaterAdapter({ hotUpdater: module, warn });
  const events: OtaAdapterEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  return { adapter, events, unsubscribe, warn };
}

describe('getActiveUpdateId', () => {
  it('returns null when the embedded bundle is running', async () => {
    const { module } = fakeHotUpdater({
      getBundleId: () => MIN_ID,
      getMinBundleId: () => MIN_ID,
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });

  it('returns the lowercased active bundle id when an update is running', async () => {
    const { module } = fakeHotUpdater({
      getBundleId: () => UPDATE_ID.toUpperCase(),
      getMinBundleId: () => MIN_ID,
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    expect(await adapter.getActiveUpdateId()).toBe(UPDATE_ID);
  });

  it('treats a case-different embedded id as embedded', async () => {
    const { module } = fakeHotUpdater({
      getBundleId: () => MIN_ID.toUpperCase(),
      getMinBundleId: () => MIN_ID,
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });

  it('returns null when getBundleId throws', async () => {
    const warn = jest.fn();
    const { module } = fakeHotUpdater({
      getBundleId: () => {
        throw new Error('native module gone');
      },
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module, warn });
    expect(await adapter.getActiveUpdateId()).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('native module gone');
  });
});

describe('getEmbeddedVersion', () => {
  it('returns the app version', async () => {
    const { module } = fakeHotUpdater({ getAppVersion: () => '2.3.4' });
    expect(
      await hotUpdaterAdapter({ hotUpdater: module }).getEmbeddedVersion()
    ).toBe('2.3.4');
  });

  it('falls back to "unknown" for null or empty versions', async () => {
    const nullVersion = fakeHotUpdater({ getAppVersion: () => null });
    expect(
      await hotUpdaterAdapter({
        hotUpdater: nullVersion.module,
      }).getEmbeddedVersion()
    ).toBe('unknown');

    const emptyVersion = fakeHotUpdater({ getAppVersion: () => '' });
    expect(
      await hotUpdaterAdapter({
        hotUpdater: emptyVersion.module,
      }).getEmbeddedVersion()
    ).toBe('unknown');
  });

  it('falls back to "unknown" when getAppVersion throws', async () => {
    const { module } = fakeHotUpdater({
      getAppVersion: () => {
        throw new Error('no native');
      },
    });
    expect(
      await hotUpdaterAdapter({ hotUpdater: module }).getEmbeddedVersion()
    ).toBe('unknown');
  });
});

describe('onUpdateProcessCompleted', () => {
  it('emits a downloaded event for a completed UPDATE', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([{ type: 'downloaded', updateId: UPDATE_ID }]);
  });

  it('lowercases the downloaded bundle id', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID.toUpperCase(),
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([{ type: 'downloaded', updateId: UPDATE_ID }]);
  });

  it('deduplicates a repeated UPDATE of the same id in one session', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    const response = {
      status: 'UPDATE' as const,
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    };
    adapter.onUpdateProcessCompleted(response);
    adapter.onUpdateProcessCompleted(response);
    adapter.onUpdateProcessCompleted(response);
    expect(events).toHaveLength(1);
  });

  it('emits again for a different bundle id', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    });
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: OTHER_ID,
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([
      { type: 'downloaded', updateId: UPDATE_ID },
      { type: 'downloaded', updateId: OTHER_ID },
    ]);
  });

  it('emits nothing and warns for an UPDATE without a bundle id', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events, warn } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: '',
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([]);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('without a bundle id');
  });

  it('emits nothing for a UP_TO_DATE result', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'UP_TO_DATE',
      id: MIN_ID,
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([]);
  });

  it('emits nothing for a ROLLBACK result (rollbacks are not downloads)', () => {
    // A fleet rollback reaches the client as ROLLBACK, never as a download.
    // This is the deliberate fix for the phantom update_downloaded that a
    // server rollback-to-embedded produces on the expo-updates adapter.
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onUpdateProcessCompleted({
      status: 'ROLLBACK',
      id: MIN_ID,
      shouldForceUpdate: false,
      message: 'rolled back',
    });
    expect(events).toEqual([]);
  });
});

describe('onError', () => {
  it('emits an error event carrying the Error message', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onError(new Error('download failed'));
    expect(events).toEqual([{ type: 'error', message: 'download failed' }]);
  });

  it('stringifies a non-Error value', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onError('boom');
    expect(events).toEqual([{ type: 'error', message: 'boom' }]);
  });
});

describe('onNotifyAppReady', () => {
  it('emits nothing for a STABLE result', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onNotifyAppReady({ status: 'STABLE' });
    expect(events).toEqual([]);
  });

  it('emits an error for a RECOVERED bundle', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onNotifyAppReady({
      status: 'RECOVERED',
      crashedBundleId: UPDATE_ID.toUpperCase(),
    });
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'hot-updater recovered from a crash in this bundle and rolled it back',
        updateId: UPDATE_ID,
      },
    ]);
  });

  it('emits an error without an id when crashedBundleId is absent', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events } = collect(module);
    adapter.onNotifyAppReady({ status: 'RECOVERED' });
    expect(events).toEqual([
      {
        type: 'error',
        message:
          'hot-updater recovered from a crash in this bundle and rolled it back',
      },
    ]);
  });
});

describe('early-event buffer', () => {
  it('flushes events dispatched before subscribe to the first subscriber, in order', () => {
    const { module } = fakeHotUpdater();
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    });
    adapter.onError(new Error('later error'));
    const events: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    expect(events).toEqual([
      { type: 'downloaded', updateId: UPDATE_ID },
      { type: 'error', message: 'later error' },
    ]);
  });

  it('does not replay the buffer to a second subscriber', () => {
    const { module } = fakeHotUpdater();
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    });
    const first: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => first.push(event));
    const second: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => second.push(event));
    expect(first).toHaveLength(1);
    expect(second).toEqual([]);
  });

  it('caps the buffer and drops the overflow', () => {
    const { module } = fakeHotUpdater();
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    for (let i = 0; i < 40; i++) {
      adapter.onError(new Error(`error ${i}`));
    }
    const events: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => events.push(event));
    expect(events).toHaveLength(32);
    expect(events[0]).toEqual({ type: 'error', message: 'error 0' });
    expect(events[31]).toEqual({ type: 'error', message: 'error 31' });
  });
});

describe('subscription lifecycle', () => {
  it('stops delivering after unsubscribe', () => {
    const { module } = fakeHotUpdater();
    const { adapter, events, unsubscribe } = collect(module);
    unsubscribe();
    adapter.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID,
      shouldForceUpdate: false,
      message: null,
    });
    expect(events).toEqual([]);
  });

  it('delivers to multiple live subscribers', () => {
    const { module } = fakeHotUpdater();
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    const a: OtaAdapterEvent[] = [];
    const b: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => a.push(event));
    adapter.onEvent((event) => b.push(event));
    adapter.onError(new Error('shared'));
    expect(a).toEqual([{ type: 'error', message: 'shared' }]);
    expect(b).toEqual([{ type: 'error', message: 'shared' }]);
  });

  it('catches a throwing consumer and keeps delivering later events', () => {
    const { module } = fakeHotUpdater();
    const warn = jest.fn();
    const adapter = hotUpdaterAdapter({ hotUpdater: module, warn });
    const seen: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => {
      seen.push(event);
      throw new Error('consumer exploded');
    });
    adapter.onError(new Error('first'));
    adapter.onError(new Error('second'));
    expect(seen.map((event) => event.message)).toEqual(['first', 'second']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('consumer exploded');
  });
});

describe('rollback', () => {
  it('reverts to the embedded bundle through updateBundle', async () => {
    const fake = fakeHotUpdater();
    const adapter = hotUpdaterAdapter({ hotUpdater: fake.module });
    await expect(adapter.rollback?.()).resolves.toBe(true);
    expect(fake.updateBundleCalls()).toEqual([
      { bundleId: MIN_ID, fileUrl: null, fileHash: null, status: 'ROLLBACK' },
    ]);
  });

  it('resolves false and warns when updateBundle rejects', async () => {
    const warn = jest.fn();
    const { module } = fakeHotUpdater({
      updateBundle: async () => {
        throw new Error('revert refused');
      },
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module, warn });
    await expect(adapter.rollback?.()).resolves.toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('revert refused');
  });

  it('resolves false when getMinBundleId throws during rollback', async () => {
    const warn = jest.fn();
    let bundleIdCalls = 0;
    const { module } = fakeHotUpdater({
      // First call (adapter construction check) is not made; getMinBundleId is
      // only called inside rollback here. Throw to exercise the catch.
      getMinBundleId: () => {
        bundleIdCalls += 1;
        throw new Error('no min id');
      },
    });
    const adapter = hotUpdaterAdapter({ hotUpdater: module, warn });
    await expect(adapter.rollback?.()).resolves.toBe(false);
    expect(bundleIdCalls).toBeGreaterThan(0);
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('is absent when the module does not expose updateBundle', () => {
    const { module } = fakeHotUpdater({ updateBundle: undefined });
    const adapter = hotUpdaterAdapter({ hotUpdater: module });
    expect('rollback' in adapter).toBe(false);
    expect(adapter.rollback).toBeUndefined();
  });
});

describe('missing hot-updater module', () => {
  it('degrades without throwing when require fails', async () => {
    // @hot-updater/react-native is deliberately not a dependency of this
    // workspace, so the bare factory exercises the real require failure path.
    const warn = jest.fn();
    const adapter = hotUpdaterAdapter({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('embedded-only');
    expect(await adapter.getActiveUpdateId()).toBeNull();
    expect(await adapter.getEmbeddedVersion()).toBe('unknown');
    const events: OtaAdapterEvent[] = [];
    const unsubscribe = adapter.onEvent((event) => events.push(event));
    // The pass-through methods are present and inert on the degraded adapter.
    expect(() => {
      adapter.onUpdateProcessCompleted({
        status: 'UPDATE',
        id: UPDATE_ID,
        shouldForceUpdate: false,
        message: null,
      });
      adapter.onError(new Error('ignored'));
      adapter.onNotifyAppReady({
        status: 'RECOVERED',
        crashedBundleId: UPDATE_ID,
      });
    }).not.toThrow();
    expect(events).toEqual([]);
    expect(adapter.rollback).toBeUndefined();
    expect(() => unsubscribe()).not.toThrow();
  });

  it('rejects a module missing getBundleId', async () => {
    const warn = jest.fn();
    const broken = {
      getMinBundleId: () => MIN_ID,
    } as unknown as HotUpdaterModuleLike;
    const adapter = hotUpdaterAdapter({ hotUpdater: broken, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('getBundleId');
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });
});

describe('integration with the health engine', () => {
  function fakeStorage(
    previousCleanExit = true
  ): HealthStorage & { pending: () => string | null } {
    let pending: { updateId: string; downloadedAt: number } | null = null;
    let launchCount = 0;
    return {
      getPreviousCleanExit: () => previousCleanExit,
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
      pending: () => pending?.updateId ?? null,
    };
  }

  const clock: Clock = {
    now: () => 1000,
    setTimeout: () => ({}),
    clearTimeout: () => {},
  };

  function engineFor(
    adapter: ReturnType<typeof hotUpdaterAdapter>,
    storage: HealthStorage,
    sinks: Sink[] = [],
    autoRollback = false
  ) {
    return new HealthEngine({
      adapter,
      storage,
      clock,
      sinks,
      isDev: false,
      healthyTimeoutMs: 15000,
      crashLoopThreshold: 2,
      autoRollback,
      context: {
        nativeVersion: '1.0.0',
        buildNumber: '1',
        platform: 'test',
        sdkVersion: '0.0.0',
      },
    });
  }

  it('arms probation on the launch after a download, with matching ids', async () => {
    const storage = fakeStorage();

    // Launch 1: embedded bundle; an update completes downloading mid-session.
    const launch1 = fakeHotUpdater({
      getBundleId: () => MIN_ID,
      getMinBundleId: () => MIN_ID,
    });
    const adapter1 = hotUpdaterAdapter({
      hotUpdater: launch1.module,
      warn: () => {},
    });
    const engine1 = engineFor(adapter1, storage);
    await engine1.start();
    expect(engine1.getSnapshot().status).toBe('stable');
    adapter1.onUpdateProcessCompleted({
      status: 'UPDATE',
      id: UPDATE_ID.toUpperCase(),
      shouldForceUpdate: false,
      message: null,
    });
    expect(storage.pending()).toBe(UPDATE_ID);

    // Launch 2: the downloaded update is now active; ids line up so the engine
    // recognizes it and starts probation.
    const launch2 = fakeHotUpdater({
      getBundleId: () => UPDATE_ID,
      getMinBundleId: () => MIN_ID,
    });
    const adapter2 = hotUpdaterAdapter({
      hotUpdater: launch2.module,
      warn: () => {},
    });
    const engine2 = engineFor(adapter2, storage);
    await engine2.start();
    expect(engine2.getSnapshot().status).toBe('probation');
    expect(engine2.getSnapshot().activeUpdateId).toBe(UPDATE_ID);
  });

  it('recommends rollback and auto-reverts on a crash loop', async () => {
    const events: ReleaseHealthEvent[] = [];
    const sink: Sink = { onEvent: (event) => events.push(event) };
    const fake = fakeHotUpdater({
      getBundleId: () => UPDATE_ID,
      getMinBundleId: () => MIN_ID,
    });
    const adapter = hotUpdaterAdapter({
      hotUpdater: fake.module,
      warn: () => {},
    });

    // Storage already reflects one crashed probation launch of UPDATE_ID: the
    // marker is armed, the launch count is 1, and the previous exit was
    // abnormal. This launch is attempt 2, which trips the threshold.
    let pending: { updateId: string; downloadedAt: number } | null = {
      updateId: UPDATE_ID,
      downloadedAt: 0,
    };
    let launchCount = 1;
    const storage: HealthStorage = {
      getPreviousCleanExit: () => false,
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

    const engine = engineFor(adapter, storage, [sink], true);
    await engine.start();

    expect(engine.getSnapshot().status).toBe('failed');
    const types = events.map((event) => event.type);
    expect(types).toContain('update_apply_failed');
    expect(types).toContain('rollback_recommended');
    // Let the auto-rollback promise settle.
    await Promise.resolve();
    await Promise.resolve();
    expect(fake.updateBundleCalls()).toEqual([
      { bundleId: MIN_ID, fileUrl: null, fileHash: null, status: 'ROLLBACK' },
    ]);
    const executed = events.find((event) => event.type === 'rollback_executed');
    expect(executed).toMatchObject({ success: true, updateId: UPDATE_ID });
  });
});

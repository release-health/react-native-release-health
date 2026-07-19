import { describe, expect, it, jest } from '@jest/globals';
import type {
  Clock,
  HealthStorage,
  OtaAdapterEvent,
} from 'react-native-release-health';
import { HealthEngine } from '../../../core/src/engine';
import type {
  ExpoUpdatesModuleLike,
  ExpoUpdatesStateContextLike,
} from '../index';
import { expoUpdatesAdapter } from '../index';

type FakeModule = {
  module: ExpoUpdatesModuleLike;
  emit: (context: ExpoUpdatesStateContextLike) => void;
  listenerCount: () => number;
  removeCalls: () => number;
};

function fakeModule(
  overrides: Partial<ExpoUpdatesModuleLike> = {}
): FakeModule {
  const listeners = new Set<
    (event: { context: ExpoUpdatesStateContextLike }) => void
  >();
  let removeCalls = 0;
  const module: ExpoUpdatesModuleLike = {
    updateId: null,
    isEmbeddedLaunch: false,
    isEnabled: true,
    runtimeVersion: '1.0.0',
    addUpdatesStateChangeListener: (listener) => {
      listeners.add(listener);
      return {
        remove() {
          removeCalls += 1;
          listeners.delete(listener);
        },
      };
    },
    ...overrides,
  };
  return {
    module,
    emit: (context) => {
      for (const listener of [...listeners]) {
        listener({ context });
      }
    },
    listenerCount: () => listeners.size,
    removeCalls: () => removeCalls,
  };
}

function collect(module: ExpoUpdatesModuleLike, warn = jest.fn()) {
  const adapter = expoUpdatesAdapter({ updatesModule: module, warn });
  const events: OtaAdapterEvent[] = [];
  const unsubscribe = adapter.onEvent((event) => events.push(event));
  return { adapter, events, unsubscribe, warn };
}

describe('getActiveUpdateId', () => {
  it('returns null for an embedded launch', async () => {
    const { module } = fakeModule({
      isEmbeddedLaunch: true,
      updateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });

  it('lowercases the running update id', async () => {
    const { module } = fakeModule({
      updateId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    });
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect(await adapter.getActiveUpdateId()).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
  });

  it('returns null when expo-updates reports no update id', async () => {
    const { module } = fakeModule({ updateId: null });
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });

  it('returns null when expo-updates is disabled', async () => {
    const { module } = fakeModule({
      isEnabled: false,
      updateId: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    });
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });
});

describe('getEmbeddedVersion', () => {
  it('returns the runtime version', async () => {
    const { module } = fakeModule({ runtimeVersion: '2.3.4' });
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect(await adapter.getEmbeddedVersion()).toBe('2.3.4');
  });

  it('falls back to "unknown" when the runtime version is missing', async () => {
    const nullVersion = fakeModule({ runtimeVersion: null });
    expect(
      await expoUpdatesAdapter({
        updatesModule: nullVersion.module,
      }).getEmbeddedVersion()
    ).toBe('unknown');

    const emptyVersion = fakeModule({ runtimeVersion: '' });
    expect(
      await expoUpdatesAdapter({
        updatesModule: emptyVersion.module,
      }).getEmbeddedVersion()
    ).toBe('unknown');
  });
});

describe('downloaded events', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const otherId = '11111111-2222-3333-4444-555555555555';

  it('suppresses a download already present in the first snapshot', () => {
    // A pending download from a previous session must not be re-announced:
    // the engine already recorded it, and a repeated `downloaded` event would
    // reset the launch counter and defeat crash-loop detection.
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({ downloadedManifest: { id } });
    expect(events).toEqual([]);
  });

  it('emits exactly once when a download appears after a null baseline', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({});
    emit({ downloadedManifest: { id } });
    expect(events).toEqual([{ type: 'downloaded', updateId: id }]);
  });

  it('does not re-emit for repeated identical snapshots', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({});
    emit({ downloadedManifest: { id } });
    emit({ downloadedManifest: { id } });
    emit({ downloadedManifest: { id } });
    expect(events).toHaveLength(1);
  });

  it('emits again when a different update id is downloaded', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({});
    emit({ downloadedManifest: { id } });
    emit({ downloadedManifest: { id: otherId } });
    expect(events).toEqual([
      { type: 'downloaded', updateId: id },
      { type: 'downloaded', updateId: otherId },
    ]);
  });

  it('re-emits the same id after the context reset to no download', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({});
    emit({ downloadedManifest: { id } });
    emit({});
    emit({ downloadedManifest: { id } });
    expect(events).toEqual([
      { type: 'downloaded', updateId: id },
      { type: 'downloaded', updateId: id },
    ]);
  });

  it('normalizes downloaded ids to lowercase', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({});
    emit({ downloadedManifest: { id: id.toUpperCase() } });
    expect(events).toEqual([{ type: 'downloaded', updateId: id }]);
  });

  it('seeds the baseline from latestContext when available', () => {
    // With an initial context exported by expo-updates there is no baseline
    // heuristic: the very first listener event is already a real change.
    const { module, emit } = fakeModule({
      latestContext: { downloadedManifest: { id } },
    });
    const { events } = collect(module);
    emit({ downloadedManifest: { id } });
    expect(events).toEqual([]);
    emit({ downloadedManifest: { id: otherId } });
    expect(events).toEqual([{ type: 'downloaded', updateId: otherId }]);
  });

  it('emits on the first event when latestContext had no download', () => {
    const { module, emit } = fakeModule({ latestContext: {} });
    const { events } = collect(module);
    emit({ downloadedManifest: { id } });
    expect(events).toEqual([{ type: 'downloaded', updateId: id }]);
  });
});

describe('error events', () => {
  const id = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

  it('emits once per new check error', () => {
    const { module, emit } = fakeModule({ latestContext: {} });
    const { events } = collect(module);
    emit({ checkError: { message: 'server unreachable' } });
    emit({ checkError: { message: 'server unreachable' } });
    expect(events).toEqual([
      { type: 'error', message: 'server unreachable', updateId: undefined },
    ]);
  });

  it('emits separately for a distinct download error', () => {
    const { module, emit } = fakeModule({ latestContext: {} });
    const { events } = collect(module);
    emit({ checkError: { message: 'check failed' } });
    emit({
      checkError: { message: 'check failed' },
      downloadError: { message: 'download failed' },
    });
    expect(events).toEqual([
      { type: 'error', message: 'check failed', updateId: undefined },
      { type: 'error', message: 'download failed', updateId: undefined },
    ]);
  });

  it('suppresses errors already present in the first snapshot', () => {
    const { module, emit } = fakeModule();
    const { events } = collect(module);
    emit({ checkError: { message: 'stale error' } });
    expect(events).toEqual([]);
  });

  it('attaches the downloaded update id when the snapshot carries one', () => {
    const { module, emit } = fakeModule({ latestContext: {} });
    const { events } = collect(module);
    emit({
      downloadedManifest: { id },
      downloadError: { message: 'asset failed' },
    });
    expect(events).toEqual([
      { type: 'downloaded', updateId: id },
      { type: 'error', message: 'asset failed', updateId: id },
    ]);
  });
});

describe('event stream shape', () => {
  it('never emits applied', () => {
    const { module, emit } = fakeModule({ latestContext: {} });
    const { events } = collect(module);
    emit({ downloadedManifest: { id: 'aaaa' } });
    emit({});
    emit({});
    expect(events.map((event) => event.type)).toEqual(['downloaded']);
  });

  it('does not implement rollback', () => {
    const { module } = fakeModule();
    const adapter = expoUpdatesAdapter({ updatesModule: module });
    expect('rollback' in adapter).toBe(false);
    expect(adapter.rollback).toBeUndefined();
  });
});

describe('subscription lifecycle', () => {
  it('removes the native listener on unsubscribe', () => {
    const fake = fakeModule();
    const { unsubscribe, events } = collect(fake.module);
    expect(fake.listenerCount()).toBe(1);
    unsubscribe();
    expect(fake.removeCalls()).toBe(1);
    expect(fake.listenerCount()).toBe(0);
    fake.emit({ downloadedManifest: { id: 'aaaa' } });
    expect(events).toEqual([]);
  });

  it('does not subscribe when expo-updates is disabled', () => {
    const fake = fakeModule({ isEnabled: false });
    const warn = jest.fn();
    const { unsubscribe, events } = collect(fake.module, warn);
    expect(fake.listenerCount()).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('disabled');
    expect(() => unsubscribe()).not.toThrow();
    fake.emit({ downloadedManifest: { id: 'aaaa' } });
    expect(events).toEqual([]);
  });

  it('degrades to a noop subscription when the listener registration throws', () => {
    const { module } = fakeModule({
      addUpdatesStateChangeListener: () => {
        throw new Error('native module gone');
      },
    });
    const warn = jest.fn();
    const { unsubscribe, events } = collect(module, warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('native module gone');
    expect(() => unsubscribe()).not.toThrow();
    expect(events).toEqual([]);
  });

  it('catches a throwing consumer and keeps processing later snapshots', () => {
    const fake = fakeModule({ latestContext: {} });
    const warn = jest.fn();
    const adapter = expoUpdatesAdapter({ updatesModule: fake.module, warn });
    const seen: OtaAdapterEvent[] = [];
    adapter.onEvent((event) => {
      seen.push(event);
      throw new Error('consumer exploded');
    });
    fake.emit({ downloadedManifest: { id: 'aaaa' } });
    fake.emit({ downloadedManifest: { id: 'bbbb' } });
    expect(seen.map((event) => event.updateId)).toEqual(['aaaa', 'bbbb']);
    expect(warn).toHaveBeenCalledTimes(2);
    expect(String(warn.mock.calls[0]?.[0])).toContain('consumer exploded');
  });
});

describe('missing expo-updates module', () => {
  it('degrades without throwing when require fails', async () => {
    // expo-updates is deliberately not a dependency of this workspace, so the
    // bare factory exercises the real require failure path.
    const warn = jest.fn();
    const adapter = expoUpdatesAdapter({ warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('embedded-only');
    expect(await adapter.getActiveUpdateId()).toBeNull();
    expect(await adapter.getEmbeddedVersion()).toBe('unknown');
    const unsubscribe = adapter.onEvent(() => {});
    expect(() => unsubscribe()).not.toThrow();
  });

  it('rejects a module without addUpdatesStateChangeListener', async () => {
    const warn = jest.fn();
    const broken = { updateId: null } as unknown as ExpoUpdatesModuleLike;
    const adapter = expoUpdatesAdapter({ updatesModule: broken, warn });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain(
      'addUpdatesStateChangeListener'
    );
    expect(await adapter.getActiveUpdateId()).toBeNull();
  });
});

describe('integration with the health engine', () => {
  function fakeStorage(): HealthStorage & { pending: () => string | null } {
    let pending: { updateId: string; downloadedAt: number } | null = null;
    let launchCount = 0;
    return {
      getPreviousCleanExit: () => true,
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

  function engineFor(module: ExpoUpdatesModuleLike, storage: HealthStorage) {
    return new HealthEngine({
      adapter: expoUpdatesAdapter({ updatesModule: module, warn: () => {} }),
      storage,
      clock,
      sinks: [],
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

  it('arms probation on the launch after a download, with matching ids', async () => {
    const id = 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE';
    const storage = fakeStorage();

    // Launch 1: embedded bundle, update downloads mid-session.
    const launch1 = fakeModule({ latestContext: {}, updateId: null });
    const engine1 = engineFor(launch1.module, storage);
    await engine1.start();
    expect(engine1.getSnapshot().status).toBe('stable');
    launch1.emit({ downloadedManifest: { id } });
    expect(storage.pending()).toBe(id.toLowerCase());

    // Launch 2: the downloaded update is now active; ids must line up so the
    // engine recognizes it and starts probation.
    const launch2 = fakeModule({
      latestContext: { downloadedManifest: { id } },
      updateId: id,
    });
    const engine2 = engineFor(launch2.module, storage);
    await engine2.start();
    expect(engine2.getSnapshot().status).toBe('probation');
    expect(engine2.getSnapshot().activeUpdateId).toBe(id.toLowerCase());
  });
});

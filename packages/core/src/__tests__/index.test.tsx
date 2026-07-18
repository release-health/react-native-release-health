import { beforeEach, describe, expect, it, jest } from '@jest/globals';
import type { OtaAdapter, ReleaseHealthEvent, Sink } from '../types';

type NativeMock = {
  getBuildInfo: jest.Mock;
  getPreviousCleanExit: jest.Mock;
  getPendingUpdate: jest.Mock;
  setPendingUpdate: jest.Mock;
  clearPendingUpdate: jest.Mock;
  getLaunchCountSinceUpdate: jest.Mock;
  incrementLaunchCountSinceUpdate: jest.Mock;
  resetLaunchCountSinceUpdate: jest.Mock;
};

function makeNativeMock(): NativeMock {
  return {
    getBuildInfo: jest.fn().mockReturnValue({
      version: '1.2.3',
      buildNumber: '42',
      bundleIdentifier: 'com.example.app',
    }),
    getPreviousCleanExit: jest.fn().mockReturnValue(true),
    getPendingUpdate: jest.fn().mockReturnValue(null),
    setPendingUpdate: jest.fn(),
    clearPendingUpdate: jest.fn(),
    getLaunchCountSinceUpdate: jest.fn().mockReturnValue(0),
    incrementLaunchCountSinceUpdate: jest.fn().mockReturnValue(1),
    resetLaunchCountSinceUpdate: jest.fn(),
  };
}

function makeAdapter(activeUpdateId: string | null = null): OtaAdapter {
  return {
    getActiveUpdateId: () => Promise.resolve(activeUpdateId),
    getEmbeddedVersion: () => Promise.resolve('1.0.0'),
    onEvent: () => () => {},
  };
}

function makeSink(): Sink & { events: ReleaseHealthEvent[] } {
  const events: ReleaseHealthEvent[] = [];
  return {
    events,
    onEvent(event) {
      events.push(event);
    },
  };
}

let nativeMock: NativeMock;

// The facade keeps module-level state (engine, init promise), so every test
// loads a fresh copy of the module.
function loadModule(): typeof import('../index') {
  let loaded: typeof import('../index') | undefined;
  jest.isolateModules(() => {
    jest.doMock('../NativeReleaseHealth', () => ({
      __esModule: true,
      default: nativeMock,
    }));
    loaded = require('../index');
  });
  return loaded!;
}

beforeEach(() => {
  nativeMock = makeNativeMock();
});

describe('ReleaseHealthNative', () => {
  it('reads build info from the native module', () => {
    const { ReleaseHealthNative } = loadModule();
    expect(ReleaseHealthNative.getBuildInfo()).toEqual({
      version: '1.2.3',
      buildNumber: '42',
      bundleIdentifier: 'com.example.app',
    });
  });

  it('reads the previous clean-exit flag', () => {
    const { ReleaseHealthNative } = loadModule();
    nativeMock.getPreviousCleanExit.mockReturnValue(false);
    expect(ReleaseHealthNative.getPreviousCleanExit()).toBe(false);
  });

  it('passes pending-update writes through unchanged', () => {
    const { ReleaseHealthNative } = loadModule();
    ReleaseHealthNative.setPendingUpdate('update-1', 1700000000000);
    expect(nativeMock.setPendingUpdate).toHaveBeenCalledWith(
      'update-1',
      1700000000000
    );
  });

  it('returns null when there is no pending update', () => {
    const { ReleaseHealthNative } = loadModule();
    expect(ReleaseHealthNative.getPendingUpdate()).toBeNull();
  });

  it('clears the pending update', () => {
    const { ReleaseHealthNative } = loadModule();
    ReleaseHealthNative.clearPendingUpdate();
    expect(nativeMock.clearPendingUpdate).toHaveBeenCalled();
  });

  it('increments and resets the launch counter', () => {
    const { ReleaseHealthNative } = loadModule();
    expect(ReleaseHealthNative.incrementLaunchCountSinceUpdate()).toBe(1);
    ReleaseHealthNative.resetLaunchCountSinceUpdate();
    expect(nativeMock.resetLaunchCountSinceUpdate).toHaveBeenCalled();
  });
});

describe('ReleaseHealth facade', () => {
  it('emits session_start with native build info and platform context', async () => {
    const { ReleaseHealth } = loadModule();
    const sink = makeSink();
    await ReleaseHealth.init({
      adapter: makeAdapter('update-1'),
      sinks: [sink],
    });

    expect(sink.events[0]).toMatchObject({
      type: 'session_start',
      updateId: 'update-1',
      nativeVersion: '1.2.3',
      buildNumber: '42',
      platform: 'ios',
    });
    expect((sink.events[0] as { sdkVersion: string }).sdkVersion).toMatch(
      /^\d+\.\d+\.\d+/
    );
  });

  it('warns on a second init() and returns the original promise', async () => {
    const { ReleaseHealth } = loadModule();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    const first = ReleaseHealth.init({ adapter: makeAdapter() });
    const second = ReleaseHealth.init({ adapter: makeAdapter() });

    expect(second).toBe(first);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('init() was called more than once')
    );
    await first;
    warn.mockRestore();
  });

  it('warns when markHealthy() is called before init()', () => {
    const { ReleaseHealth } = loadModule();
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});

    expect(() => ReleaseHealth.markHealthy()).not.toThrow();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('markHealthy() was called before init()')
    );
    warn.mockRestore();
  });

  it('emits healthy through the engine after init', async () => {
    const { ReleaseHealth } = loadModule();
    const sink = makeSink();
    await ReleaseHealth.init({ adapter: makeAdapter(), sinks: [sink] });
    ReleaseHealth.markHealthy();

    expect(sink.events.map((e) => e.type)).toEqual([
      'session_start',
      'healthy',
    ]);
  });

  it('delivers rollback recommendations to listeners subscribed before init', async () => {
    // Simulate the second launch of a crashing update. __DEV__ is true under
    // jest, so temporarily flip it to let probation logic run.
    const globalWithDev = globalThis as { __DEV__?: boolean };
    const previousDev = globalWithDev.__DEV__;
    globalWithDev.__DEV__ = false;
    try {
      nativeMock.getPendingUpdate.mockReturnValue({
        updateId: 'update-2',
        downloadedAt: 999,
      });
      nativeMock.getLaunchCountSinceUpdate.mockReturnValue(1);
      nativeMock.getPreviousCleanExit.mockReturnValue(false);
      nativeMock.incrementLaunchCountSinceUpdate.mockReturnValue(2);

      const { ReleaseHealth } = loadModule();
      const listener = jest.fn();
      ReleaseHealth.onRollbackRecommended(listener);
      await ReleaseHealth.init({ adapter: makeAdapter('update-2') });

      expect(listener).toHaveBeenCalledWith({
        updateId: 'update-2',
        reason: 'crash-loop',
      });

      const late = jest.fn();
      const unsubscribe = ReleaseHealth.onRollbackRecommended(late);
      expect(late).toHaveBeenCalledWith({
        updateId: 'update-2',
        reason: 'crash-loop',
      });
      unsubscribe();
    } finally {
      globalWithDev.__DEV__ = previousDev;
    }
  });

  it('records fatal JS errors through the global handler', async () => {
    type Handler = (error: unknown, isFatal?: boolean) => void;
    const previousCalls: unknown[] = [];
    let installed: Handler = () => {};
    (globalThis as Record<string, unknown>).ErrorUtils = {
      getGlobalHandler: (): Handler => (error) => previousCalls.push(error),
      setGlobalHandler: (handler: Handler) => {
        installed = handler;
      },
    };
    try {
      const { ReleaseHealth } = loadModule();
      const sink = makeSink();
      await ReleaseHealth.init({ adapter: makeAdapter(), sinks: [sink] });

      installed(new Error('boom'), true);
      installed(new Error('minor'), false);

      const crashEvents = sink.events.filter((e) => e.type === 'crash');
      expect(crashEvents).toHaveLength(1);
      expect(crashEvents[0]).toMatchObject({
        fatal: true,
        jsMessage: 'boom',
      });
      // The pre-existing handler still runs for both errors.
      expect(previousCalls).toHaveLength(2);
    } finally {
      delete (globalThis as Record<string, unknown>).ErrorUtils;
    }
  });

  it('notifyReload is a safe no-op before init', () => {
    const { ReleaseHealth } = loadModule();
    expect(() => ReleaseHealth.notifyReload()).not.toThrow();
  });
});

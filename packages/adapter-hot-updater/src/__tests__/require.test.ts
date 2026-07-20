/**
 * Kept separate from index.test.ts: `jest.mock` applies to the whole file,
 * and the main suite needs the real "@hot-updater/react-native is not
 * installed" require failure, while this file proves the bare factory picks
 * the module up via `require('@hot-updater/react-native')` when it resolves.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { hotUpdaterAdapter } from '../index';

jest.mock(
  '@hot-updater/react-native',
  () => ({
    HotUpdater: {
      getBundleId: () => '11111111-2222-3333-4444-555555555555'.toUpperCase(),
      getMinBundleId: () => 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
      getAppVersion: () => '9.9.9',
      updateBundle: async () => true,
    },
  }),
  { virtual: true }
);

describe('module resolution', () => {
  it('loads hot-updater through require when no module is injected', async () => {
    const warn = jest.fn();
    const adapter = hotUpdaterAdapter({ warn });
    expect(warn).not.toHaveBeenCalled();
    expect(await adapter.getActiveUpdateId()).toBe(
      '11111111-2222-3333-4444-555555555555'
    );
    expect(await adapter.getEmbeddedVersion()).toBe('9.9.9');
    expect(typeof adapter.rollback).toBe('function');
  });

  it('works with no options at all', async () => {
    const adapter = hotUpdaterAdapter();
    expect(await adapter.getEmbeddedVersion()).toBe('9.9.9');
  });
});

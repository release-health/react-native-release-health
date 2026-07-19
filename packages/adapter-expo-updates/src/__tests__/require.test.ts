/**
 * Kept separate from index.test.ts: `jest.mock` applies to the whole file,
 * and the main suite needs the real "expo-updates is not installed" require
 * failure, while this file proves the bare factory picks the module up via
 * `require('expo-updates')` when it resolves.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { expoUpdatesAdapter } from '../index';

jest.mock(
  'expo-updates',
  () => ({
    updateId: 'AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE',
    isEmbeddedLaunch: false,
    isEnabled: true,
    runtimeVersion: '9.9.9',
    addUpdatesStateChangeListener: () => ({ remove() {} }),
  }),
  { virtual: true }
);

describe('module resolution', () => {
  it('loads expo-updates through require when no module is injected', async () => {
    const warn = jest.fn();
    const adapter = expoUpdatesAdapter({ warn });
    expect(warn).not.toHaveBeenCalled();
    expect(await adapter.getActiveUpdateId()).toBe(
      'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
    );
    expect(await adapter.getEmbeddedVersion()).toBe('9.9.9');
  });
});

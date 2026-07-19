/**
 * Kept separate from index.test.ts: `jest.mock` applies to the whole file,
 * and the main suite needs the real "@sentry/react-native is not installed"
 * require failure, while this file proves the bare factory picks the module
 * up via `require('@sentry/react-native')` when it resolves.
 */
import { describe, expect, it, jest } from '@jest/globals';
import { sentrySink } from '../index';

const tags: Record<string, string> = {};

jest.mock(
  '@sentry/react-native',
  () => ({
    setTag: (key: string, value: string) => {
      tags[key] = value;
    },
    addBreadcrumb: () => {},
    captureMessage: () => 'event-id',
  }),
  { virtual: true }
);

describe('module resolution', () => {
  it('loads @sentry/react-native through require when no module is injected', () => {
    const warn = jest.fn();
    const sink = sentrySink({ warn });

    expect(warn).not.toHaveBeenCalled();
    sink.attach!({
      getSnapshot: () => ({
        status: 'probation',
        activeUpdateId: 'u-1',
        sessionId: 'session-1',
      }),
      onStatusChange: () => () => {},
    });
    expect(tags).toEqual({
      'ota.update_id': 'u-1',
      'ota.status': 'probation',
    });
  });
});

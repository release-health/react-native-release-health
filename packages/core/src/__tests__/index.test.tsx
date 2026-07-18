import { describe, expect, it, jest } from '@jest/globals';

const mockNativeModule = {
  getBuildInfo: jest.fn(),
  getPreviousCleanExit: jest.fn(),
  getPendingUpdate: jest.fn(),
  setPendingUpdate: jest.fn(),
  clearPendingUpdate: jest.fn(),
  getLaunchCountSinceUpdate: jest.fn(),
  incrementLaunchCountSinceUpdate: jest.fn(),
  resetLaunchCountSinceUpdate: jest.fn(),
};

jest.mock('../NativeReleaseHealth', () => ({
  __esModule: true,
  default: mockNativeModule,
}));

const { ReleaseHealthNative } = require('../index');

describe('ReleaseHealthNative', () => {
  it('reads build info from the native module', () => {
    const buildInfo = {
      version: '1.2.3',
      buildNumber: '42',
      bundleIdentifier: 'com.example.app',
    };
    mockNativeModule.getBuildInfo.mockReturnValue(buildInfo);

    expect(ReleaseHealthNative.getBuildInfo()).toEqual(buildInfo);
  });

  it('reads the previous clean-exit flag', () => {
    mockNativeModule.getPreviousCleanExit.mockReturnValue(false);

    expect(ReleaseHealthNative.getPreviousCleanExit()).toBe(false);
  });

  it('passes pending-update writes through unchanged', () => {
    ReleaseHealthNative.setPendingUpdate('update-1', 1700000000000);

    expect(mockNativeModule.setPendingUpdate).toHaveBeenCalledWith(
      'update-1',
      1700000000000
    );
  });

  it('returns null when there is no pending update', () => {
    mockNativeModule.getPendingUpdate.mockReturnValue(null);

    expect(ReleaseHealthNative.getPendingUpdate()).toBeNull();
  });

  it('clears the pending update', () => {
    ReleaseHealthNative.clearPendingUpdate();

    expect(mockNativeModule.clearPendingUpdate).toHaveBeenCalled();
  });

  it('increments and resets the launch counter', () => {
    mockNativeModule.incrementLaunchCountSinceUpdate.mockReturnValue(1);

    expect(ReleaseHealthNative.incrementLaunchCountSinceUpdate()).toBe(1);

    ReleaseHealthNative.resetLaunchCountSinceUpdate();
    expect(mockNativeModule.resetLaunchCountSinceUpdate).toHaveBeenCalled();
  });
});

import { TurboModuleRegistry, type TurboModule } from 'react-native';

export type BuildInfo = {
  version: string;
  buildNumber: string;
  bundleIdentifier: string;
};

export type PendingUpdate = {
  updateId: string;
  downloadedAt: number;
};

export interface Spec extends TurboModule {
  getBuildInfo(): BuildInfo;

  getPreviousCleanExit(): boolean;

  getPendingUpdate(): PendingUpdate | null;
  setPendingUpdate(updateId: string, downloadedAt: number): void;
  clearPendingUpdate(): void;

  getLaunchCountSinceUpdate(): number;
  incrementLaunchCountSinceUpdate(): number;
  resetLaunchCountSinceUpdate(): void;
}

export default TurboModuleRegistry.getEnforcing<Spec>('ReleaseHealth');

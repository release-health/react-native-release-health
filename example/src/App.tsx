import { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Platform,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
import {
  ReleaseHealth,
  ReleaseHealthNative,
  useReleaseHealth,
  type BuildInfo,
  type PendingUpdate,
  type RollbackRecommendation,
} from 'react-native-release-health';
import { httpSink } from '@release-health/sink-http';
import { expoUpdatesAdapter } from '@release-health/adapter-expo-updates';
import * as Updates from 'expo-updates';

// Local event receiver (start it with `yarn receiver` at the repo root).
// The Android emulator reaches the host machine at 10.0.2.2; iOS simulator
// and web can use localhost. On a physical device, use your machine's LAN IP.
const RECEIVER_URL = Platform.select({
  android: 'http://10.0.2.2:8787/events',
  default: 'http://localhost:8787/events',
});

// Flip to true before publishing the intentionally-broken update used by
// docs/demo.md. The 4 second delay lets init() record the launch and the
// http sink flush (2s interval) before the crash lands, and keeps the
// rollback banner visible on screen during the demo recording.
const DEMO_CRASH = false;

// Passing the module explicitly gives a compile-time check that the
// installed expo-updates still matches the shape the adapter expects.
ReleaseHealth.init({
  adapter: expoUpdatesAdapter({ updatesModule: Updates }),
  sinks: [httpSink({ url: RECEIVER_URL, flushIntervalMs: 2000 })],
  cohort: 'example-app',
}).catch((error) => {
  console.warn(`ReleaseHealth failed to initialize: ${String(error)}`);
});

export default function App() {
  const health = useReleaseHealth();
  const [recommendation, setRecommendation] =
    useState<RollbackRecommendation | null>(null);
  const [otaMessage, setOtaMessage] = useState<string | null>(null);

  useEffect(() => ReleaseHealth.onRollbackRecommended(setRecommendation), []);

  useEffect(() => {
    if (!DEMO_CRASH) {
      return;
    }
    const timer = setTimeout(() => {
      throw new Error('release-health demo: intentional startup crash');
    }, 4000);
    return () => clearTimeout(timer);
  }, []);

  const [buildInfo] = useState<BuildInfo>(() =>
    ReleaseHealthNative.getBuildInfo()
  );
  const [previousCleanExit] = useState<boolean>(() =>
    ReleaseHealthNative.getPreviousCleanExit()
  );
  const [pendingUpdate, setPendingUpdateState] = useState<PendingUpdate | null>(
    () => ReleaseHealthNative.getPendingUpdate()
  );
  const [launchCount, setLaunchCount] = useState<number>(() =>
    ReleaseHealthNative.getLaunchCountSinceUpdate()
  );

  const refresh = useCallback(() => {
    setPendingUpdateState(ReleaseHealthNative.getPendingUpdate());
    setLaunchCount(ReleaseHealthNative.getLaunchCountSinceUpdate());
  }, []);

  const checkForUpdate = useCallback(async () => {
    try {
      const result = await Updates.checkForUpdateAsync();
      if (result.isAvailable) {
        setOtaMessage(`Update available: ${result.manifest.id}`);
      } else if (result.isRollBackToEmbedded) {
        setOtaMessage('Server requests a rollback to the embedded bundle');
      } else {
        setOtaMessage(`No update available (${result.reason})`);
      }
    } catch (error) {
      setOtaMessage(`Check failed: ${String(error)}`);
    }
  }, []);

  const downloadUpdate = useCallback(async () => {
    try {
      const result = await Updates.fetchUpdateAsync();
      if (result.isNew) {
        setOtaMessage(`Downloaded ${result.manifest.id}`);
      } else {
        setOtaMessage('Nothing new to download');
      }
      refresh();
    } catch (error) {
      setOtaMessage(`Download failed: ${String(error)}`);
    }
  }, [refresh]);

  const applyUpdate = useCallback(async () => {
    try {
      // Tell the engine first: a reload during probation restarts the
      // probation timer instead of counting against the update.
      ReleaseHealth.notifyReload();
      await Updates.reloadAsync();
    } catch (error) {
      setOtaMessage(`Reload failed: ${String(error)}`);
    }
  }, []);

  const crashNow = useCallback(() => {
    setTimeout(() => {
      throw new Error('release-health example: manual crash');
    }, 0);
  }, []);

  const simulateDownload = useCallback(() => {
    ReleaseHealthNative.setPendingUpdate(`update-${Date.now()}`, Date.now());
    ReleaseHealthNative.resetLaunchCountSinceUpdate();
    refresh();
  }, [refresh]);

  const incrementLaunch = useCallback(() => {
    ReleaseHealthNative.incrementLaunchCountSinceUpdate();
    refresh();
  }, [refresh]);

  const clearUpdate = useCallback(() => {
    ReleaseHealthNative.clearPendingUpdate();
    ReleaseHealthNative.resetLaunchCountSinceUpdate();
    refresh();
  }, [refresh]);

  return (
    <ScrollView contentContainerStyle={styles.container}>
      <Text style={styles.heading}>Release health</Text>
      <Text>Status: {health.status}</Text>
      <Text>Active update: {health.activeUpdateId ?? 'embedded bundle'}</Text>
      <Text>Cohort: {health.cohort ?? 'none'}</Text>
      {recommendation ? (
        <Text style={styles.alert}>
          Rollback recommended for {recommendation.updateId} (
          {recommendation.reason})
        </Text>
      ) : null}
      <Text style={styles.hint}>
        Events stream to {RECEIVER_URL}; run "yarn receiver" at the repo root to
        watch them.
      </Text>
      <View style={styles.buttonRow}>
        <Button
          title="Mark healthy"
          onPress={() => ReleaseHealth.markHealthy()}
        />
      </View>

      <Text style={styles.heading}>OTA updates (expo-updates)</Text>
      <Text>Enabled: {String(Updates.isEnabled)}</Text>
      <Text>Update id: {Updates.updateId ?? 'none (embedded)'}</Text>
      <Text>Embedded launch: {String(Updates.isEmbeddedLaunch)}</Text>
      <Text>Runtime version: {Updates.runtimeVersion ?? 'unset'}</Text>
      <Text>Channel: {Updates.channel ?? 'unset'}</Text>
      {otaMessage ? <Text style={styles.hint}>{otaMessage}</Text> : null}
      <Text style={styles.hint}>
        Check/download/apply need a release build with an updates URL
        configured; in development they report that updates are disabled.
      </Text>
      <View style={styles.buttonRow}>
        <Button title="Check for update" onPress={checkForUpdate} />
      </View>
      <View style={styles.buttonRow}>
        <Button title="Download update" onPress={downloadUpdate} />
      </View>
      <View style={styles.buttonRow}>
        <Button
          title="Apply downloaded update (reload)"
          onPress={applyUpdate}
        />
      </View>
      <View style={styles.buttonRow}>
        <Button title="Crash now" color="#b00020" onPress={crashNow} />
      </View>

      <Text style={styles.heading}>Build info</Text>
      <Text>Version: {buildInfo.version}</Text>
      <Text>Build number: {buildInfo.buildNumber}</Text>
      <Text>Bundle identifier: {buildInfo.bundleIdentifier}</Text>

      <Text style={styles.heading}>Clean-exit heuristic</Text>
      <Text>
        Previous launch exited{' '}
        {previousCleanExit ? 'cleanly' : 'ABNORMALLY (crash or kill)'}
      </Text>
      <Text style={styles.hint}>
        Background the app (home button) then relaunch to see "cleanly".
        Force-kill it (swipe up from the app switcher, or stop it from
        Xcode/Android Studio) then relaunch to see "ABNORMALLY".
      </Text>

      <Text style={styles.heading}>Pending update</Text>
      <Text>
        {pendingUpdate
          ? `${pendingUpdate.updateId} (downloaded ${new Date(
              pendingUpdate.downloadedAt
            ).toLocaleString()})`
          : 'None'}
      </Text>
      <Text>Launch count since update: {launchCount}</Text>

      <View style={styles.buttonRow}>
        <Button title="Simulate update download" onPress={simulateDownload} />
      </View>
      <View style={styles.buttonRow}>
        <Button title="Increment launch count" onPress={incrementLaunch} />
      </View>
      <View style={styles.buttonRow}>
        <Button title="Clear pending update" onPress={clearUpdate} />
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flexGrow: 1,
    alignItems: 'stretch',
    justifyContent: 'center',
    padding: 24,
    gap: 8,
  },
  heading: {
    marginTop: 16,
    fontWeight: '700',
    fontSize: 16,
  },
  hint: {
    fontSize: 12,
    color: '#666',
  },
  alert: {
    color: '#b00020',
    fontWeight: '700',
  },
  buttonRow: {
    marginTop: 12,
  },
});

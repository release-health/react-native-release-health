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
import { hotUpdaterAdapter } from '@release-health/adapter-hot-updater';
import { HotUpdater } from '@hot-updater/react-native';

// Local event receiver (start it with `yarn receiver` at the repo root).
// The Android emulator reaches the host machine at 10.0.2.2; the iOS
// simulator can use localhost. On a physical device, use your machine's LAN IP.
const RECEIVER_URL = Platform.select({
  android: 'http://10.0.2.2:8787/events',
  default: 'http://localhost:8787/events',
});

// Local hot-updater server (start it with `yarn hot-updater-server` at the
// repo root). Same host mapping as the receiver.
const UPDATE_SERVER_URL = Platform.select({
  android: 'http://10.0.2.2:3000/hot-updater',
  default: 'http://localhost:3000/hot-updater',
});

// Flip to true before deploying the intentionally-broken update used by
// docs/demo-hot-updater.md. The 4 second delay lets init() record the launch
// and the http sink flush (2s interval) before the crash lands, keeps the
// rollback banner visible during the demo recording, and lands well after the
// first frame so hot-updater's own crash guard does not intervene; this is
// exactly the window release-health owns.
const DEMO_CRASH = false;

// Flip to true to let the engine revert to the embedded bundle automatically
// when it detects a crash loop, using the adapter's rollback() support.
const AUTO_ROLLBACK = false;

// Passing HotUpdater explicitly gives a compile-time check that the installed
// hot-updater version still matches the shape the adapter expects.
const adapter = hotUpdaterAdapter({ hotUpdater: HotUpdater });

ReleaseHealth.init({
  adapter,
  sinks: [httpSink({ url: RECEIVER_URL, flushIntervalMs: 2000 })],
  cohort: 'example-hot-updater',
  autoRollback: AUTO_ROLLBACK,
}).catch((error) => {
  console.warn(`ReleaseHealth failed to initialize: ${String(error)}`);
});

function App() {
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
      const updateInfo = await HotUpdater.checkForUpdate({
        updateStrategy: 'appVersion',
      });
      if (updateInfo) {
        setOtaMessage(`${updateInfo.status}: ${updateInfo.id}`);
      } else {
        setOtaMessage('App is up to date');
      }
    } catch (error) {
      setOtaMessage(`Check failed: ${String(error)}`);
    }
  }, []);

  const applyUpdate = useCallback(async () => {
    try {
      // Tell the engine first: a reload during probation restarts the
      // probation timer instead of counting against the update.
      ReleaseHealth.notifyReload();
      await HotUpdater.reload();
    } catch (error) {
      setOtaMessage(`Reload failed: ${String(error)}`);
    }
  }, []);

  const rollbackNow = useCallback(async () => {
    if (adapter.rollback === undefined) {
      setOtaMessage('rollback() unavailable (hot-updater module missing)');
      return;
    }
    const accepted = await adapter.rollback();
    setOtaMessage(
      accepted
        ? 'Reverted to the embedded bundle; relaunch to apply'
        : 'Rollback was not accepted'
    );
  }, []);

  const crashNow = useCallback(() => {
    setTimeout(() => {
      throw new Error('release-health example: manual crash');
    }, 0);
  }, []);

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

      <Text style={styles.heading}>OTA updates (hot-updater)</Text>
      <Text>Bundle id: {HotUpdater.getBundleId()}</Text>
      <Text>Embedded bundle id: {HotUpdater.getMinBundleId()}</Text>
      <Text>App version: {HotUpdater.getAppVersion() ?? 'unknown'}</Text>
      <Text>Channel: {HotUpdater.getChannel()}</Text>
      {otaMessage ? <Text style={styles.hint}>{otaMessage}</Text> : null}
      <Text style={styles.hint}>
        Updates need a release build and the local update server (run "yarn
        hot-updater-server" at the repo root); development builds always run the
        embedded bundle.
      </Text>
      <View style={styles.buttonRow}>
        <Button title="Check for update" onPress={checkForUpdate} />
      </View>
      <View style={styles.buttonRow}>
        <Button
          title="Apply downloaded update (reload)"
          onPress={applyUpdate}
        />
      </View>
      <View style={styles.buttonRow}>
        <Button title="Roll back to embedded bundle" onPress={rollbackNow} />
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
        <Button title="Refresh" onPress={refresh} />
      </View>
    </ScrollView>
  );
}

// The adapter's callbacks are wired into HotUpdater.wrap so completed updates
// and hot-updater's own crash recoveries feed the health engine.
export default HotUpdater.wrap({
  baseURL: UPDATE_SERVER_URL ?? 'http://localhost:3000/hot-updater',
  updateStrategy: 'appVersion',
  reloadOnForceUpdate: false,
  onUpdateProcessCompleted: adapter.onUpdateProcessCompleted,
  onError: adapter.onError,
  onNotifyAppReady: adapter.onNotifyAppReady,
})(App);

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

import { useCallback, useState } from 'react';
import { Button, ScrollView, StyleSheet, Text, View } from 'react-native';
import {
  ReleaseHealthNative,
  type BuildInfo,
  type PendingUpdate,
} from 'react-native-release-health';

export default function App() {
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
  buttonRow: {
    marginTop: 12,
  },
});

/**
 * Sentry sink for react-native-release-health.
 *
 * Keeps two Sentry tags in sync with the health engine so every issue is
 * segmented by OTA rollout state: `ota.update_id` (the active update, or
 * `embedded`) and `ota.status` (the engine's health status, updated on every
 * transition). Every release-health event is also recorded as an `ota`
 * breadcrumb, and a rollback recommendation is captured as its own Sentry
 * message so a failed rollout produces an issue even when no crash reaches
 * Sentry.
 *
 * The Sentry SDK is consumed through a small structural type and loaded
 * lazily, so this package has no hard dependency on @sentry/react-native and
 * never throws into the host app when the module is missing.
 *
 * Verified against @sentry/react-native 7.11.0 (Expo SDK 55); the consumed
 * surface (`setTag`, `addBreadcrumb`, `captureMessage`, `flush`) is
 * re-exported unchanged from @sentry/core across current SDK majors.
 */

import type {
  ReleaseHealthEvent,
  Sink,
  SinkContext,
} from 'react-native-release-health';

/** Severity levels this sink emits; a subset of Sentry's `SeverityLevel`. */
export type SentrySeverityLike = 'info' | 'warning' | 'error';

/** Structural subset of a Sentry breadcrumb this sink produces. */
export type SentryBreadcrumbLike = {
  /** Breadcrumb grouping key; always `ota` for this sink. */
  category?: string;
  /** Human-readable description of the event. */
  message?: string;
  /** Severity of the breadcrumb. */
  level?: SentrySeverityLike;
  /** Event payload minus the session envelope. */
  data?: Record<string, unknown>;
};

/**
 * Structural subset of the Sentry SDK this sink consumes. Matches
 * `import * as Sentry from '@sentry/react-native'`; @sentry/browser and
 * @sentry/node satisfy it too.
 */
export type SentryLike = {
  /** Sets a tag on the current scope; applied to every future event. */
  setTag(key: string, value: string): void;
  /** Records a breadcrumb attached to future events. */
  addBreadcrumb(breadcrumb: SentryBreadcrumbLike): void;
  /** Captures a standalone message event. */
  captureMessage(message: string, level?: SentrySeverityLike): unknown;
  /**
   * Flushes buffered Sentry events. Optional: called on fatal crashes when
   * present so breadcrumbs and tags reach Sentry before the process dies.
   */
  flush?(timeout?: number): PromiseLike<boolean>;
};

/** Options accepted by {@link sentrySink}. */
export type SentrySinkOptions = {
  /**
   * Alternative Sentry implementation (tests, custom wrappers). Passing
   * `import * as Sentry from '@sentry/react-native'` here also gives the
   * host app a compile-time check that the installed Sentry version still
   * matches the shape this sink expects.
   * Default: `require('@sentry/react-native')`.
   */
  sentry?: SentryLike;
  /**
   * Capture each `rollback_recommended` event as a Sentry message (level
   * `error`), so failed rollouts surface as issues even when the crash
   * itself never reaches Sentry. Default: true.
   */
  captureRecommendations?: boolean;
  /** Warning channel; defaults to `console.warn`. */
  warn?: (message: string) => void;
};

declare const require: ((moduleId: string) => unknown) | undefined;

/** Tag value used when the embedded bundle (no OTA update) is running. */
const EMBEDDED = 'embedded';

function resolveSentryModule(
  options: SentrySinkOptions,
  warn: (message: string) => void
): SentryLike | null {
  let candidate: unknown = options.sentry;
  if (candidate == null) {
    try {
      candidate =
        typeof require === 'function'
          ? require('@sentry/react-native')
          : undefined;
    } catch (error) {
      warn(
        `ReleaseHealth: @sentry/react-native could not be loaded (${String(error)}). ` +
          'The Sentry sink is disabled and will drop all events. Install ' +
          '@sentry/react-native in the host app, or pass the module ' +
          'explicitly via sentrySink({ sentry: Sentry }).'
      );
      return null;
    }
  }
  const module = candidate as SentryLike | null | undefined;
  if (
    module == null ||
    typeof module.setTag !== 'function' ||
    typeof module.addBreadcrumb !== 'function' ||
    typeof module.captureMessage !== 'function'
  ) {
    warn(
      'ReleaseHealth: the Sentry module is missing setTag, addBreadcrumb, ' +
        'or captureMessage, so the Sentry sink is disabled. This sink was ' +
        'verified against @sentry/react-native 7.x; check that the installed ' +
        'version is compatible.'
    );
    return null;
  }
  return module;
}

function describeUpdate(updateId: string | null): string {
  return updateId === null ? 'the embedded bundle' : `update ${updateId}`;
}

function breadcrumbMessage(event: ReleaseHealthEvent): string {
  switch (event.type) {
    case 'session_start':
      return `OTA session started on ${describeUpdate(event.updateId)}`;
    case 'update_downloaded':
      return `OTA update ${event.updateId} downloaded`;
    case 'update_apply_success':
      return `OTA update ${event.updateId} applied and healthy after ${event.msToHealthy}ms`;
    case 'update_apply_failed':
      return `OTA update ${event.updateId} failed to apply (${event.reason})`;
    case 'crash':
      return `Fatal error on ${describeUpdate(event.updateId)}`;
    case 'healthy':
      return `App healthy on ${describeUpdate(event.updateId)} after ${event.msToHealthy}ms`;
    case 'rollback_recommended':
      return `OTA rollback recommended for update ${event.updateId} (${event.reason})`;
    case 'rollback_executed':
      return `OTA rollback ${event.success ? 'executed' : 'failed'} for update ${event.updateId}`;
  }
}

function breadcrumbLevel(event: ReleaseHealthEvent): SentrySeverityLike {
  switch (event.type) {
    case 'crash':
    case 'update_apply_failed':
    case 'rollback_recommended':
      return 'warning';
    case 'rollback_executed':
      return event.success ? 'info' : 'warning';
    default:
      return 'info';
  }
}

function breadcrumbData(event: ReleaseHealthEvent): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(event)) {
    if (key !== 'sessionId' && key !== 'timestamp' && key !== 'type') {
      data[key] = value;
    }
  }
  return data;
}

/**
 * Creates a {@link Sink} that mirrors release-health state into Sentry.
 *
 * Behavior notes:
 * - `ota.update_id` and `ota.status` are set as scope tags when the engine
 *   starts and re-set on every status transition, so a crash during
 *   probation is tagged `ota.status: probation` at capture time.
 * - Every event becomes a breadcrumb with category `ota`; failures use
 *   level `warning`, everything else `info`.
 * - `crash` events are breadcrumb-only: the Sentry error handler already
 *   captures the exception itself, and capturing it again here would create
 *   duplicate issues.
 * - `rollback_recommended` is additionally captured as a Sentry message
 *   (disable with `captureRecommendations: false`).
 * - When @sentry/react-native is missing, the sink degrades to a no-op with
 *   a single warning and never throws into the host app.
 */
export function sentrySink(options: SentrySinkOptions = {}): Sink {
  const warn = options.warn ?? ((message: string) => console.warn(message));
  const captureRecommendations = options.captureRecommendations ?? true;
  const sentry = resolveSentryModule(options, warn);

  if (sentry == null) {
    return { onEvent: () => {} };
  }

  return {
    attach(context: SinkContext): void {
      const applyTags = (): void => {
        const snapshot = context.getSnapshot();
        sentry.setTag('ota.update_id', snapshot.activeUpdateId ?? EMBEDDED);
        sentry.setTag('ota.status', snapshot.status);
      };
      applyTags();
      context.onStatusChange(applyTags);
    },

    onEvent(event: ReleaseHealthEvent): void {
      sentry.addBreadcrumb({
        category: 'ota',
        message: breadcrumbMessage(event),
        level: breadcrumbLevel(event),
        data: breadcrumbData(event),
      });
      if (event.type === 'rollback_recommended' && captureRecommendations) {
        sentry.captureMessage(breadcrumbMessage(event), 'error');
      }
    },

    async flush(): Promise<void> {
      await sentry.flush?.(2000);
    },
  };
}

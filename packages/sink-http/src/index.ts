import type { ReleaseHealthEvent, Sink } from 'react-native-release-health';

/** Options accepted by `httpSink()`. */
export type HttpSinkOptions = {
  /** Endpoint that receives `POST` requests with a JSON body. */
  url: string;
  /** Extra request headers, merged over the default `content-type`. */
  headers?: Record<string, string>;
  /** Send as soon as this many events are buffered. Default: 20. */
  batchSize?: number;
  /** Send buffered events at most this often. Default: 5000. */
  flushIntervalMs?: number;
  /**
   * Cap on buffered events while the endpoint is unreachable; the oldest
   * events are dropped first. Default: 500.
   */
  maxBufferedEvents?: number;
  /** Alternative fetch implementation (tests, custom networking). */
  fetchImpl?: typeof fetch;
};

/**
 * Shape of the request body: `{ "events": ReleaseHealthEvent[] }`, one batch
 * per request. Any 2xx response acknowledges the batch; anything else keeps
 * the events buffered for retry.
 */
export type HttpSinkPayload = {
  events: ReleaseHealthEvent[];
};

/**
 * A sink that batches release-health events and posts them as JSON to a URL.
 *
 * Delivery is best-effort: failed requests keep their events buffered (up to
 * `maxBufferedEvents`) and retry on the next flush. Network problems are
 * logged as warnings and never thrown into the host app.
 */
export function httpSink(options: HttpSinkOptions): Sink {
  const batchSize = options.batchSize ?? 20;
  const flushIntervalMs = options.flushIntervalMs ?? 5000;
  const maxBufferedEvents = options.maxBufferedEvents ?? 500;
  const doFetch: typeof fetch =
    options.fetchImpl ?? ((...args) => globalThis.fetch(...args));

  let buffer: ReleaseHealthEvent[] = [];
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;

  function cancelTimer(): void {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  }

  function scheduleFlush(): void {
    if (timer === null) {
      timer = setTimeout(() => {
        timer = null;
        flush().catch(() => {
          // flush() handles its own failures.
        });
      }, flushIntervalMs);
    }
  }

  async function sendBatch(events: ReleaseHealthEvent[]): Promise<void> {
    try {
      const payload: HttpSinkPayload = { events };
      const response = await doFetch(options.url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...options.headers,
        },
        body: JSON.stringify(payload),
      });
      if (!response.ok) {
        throw new Error(`endpoint responded with HTTP ${response.status}`);
      }
    } catch (error) {
      // Put the batch back in front of anything buffered meanwhile, keeping
      // the newest events when over the cap, and retry on the next interval.
      buffer = [...events, ...buffer].slice(-maxBufferedEvents);
      console.warn(
        `release-health httpSink: sending ${events.length} event(s) to ${options.url} ` +
          `failed (${String(error)}). Events stay buffered (${buffer.length} waiting) ` +
          'and will be retried; check that the endpoint is reachable and returns 2xx.'
      );
      scheduleFlush();
    }
  }

  async function flush(): Promise<void> {
    if (inFlight !== null) {
      await inFlight;
    }
    if (buffer.length === 0) {
      return;
    }
    cancelTimer();
    const batch = buffer;
    buffer = [];
    inFlight = sendBatch(batch).finally(() => {
      inFlight = null;
    });
    await inFlight;
  }

  return {
    onEvent(event: ReleaseHealthEvent): void {
      buffer.push(event);
      if (buffer.length > maxBufferedEvents) {
        buffer = buffer.slice(-maxBufferedEvents);
      }
      if (buffer.length >= batchSize) {
        flush().catch(() => {
          // flush() handles its own failures.
        });
      } else {
        scheduleFlush();
      }
    },
    flush,
  };
}

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import type { ReleaseHealthEvent } from 'react-native-release-health';
import { httpSink } from '../index';

function event(id: string): ReleaseHealthEvent {
  return {
    type: 'update_downloaded',
    updateId: id,
    sessionId: 'session-1',
    timestamp: 123,
  };
}

type FetchMock = jest.Mock<typeof fetch>;

function makeFetch(
  responses: Array<{ ok: boolean; status: number }>
): FetchMock {
  const mock = jest.fn<typeof fetch>();
  for (const response of responses) {
    mock.mockResolvedValueOnce(response as Response);
  }
  mock.mockResolvedValue({ ok: true, status: 200 } as Response);
  return mock;
}

function sentEvents(fetchMock: FetchMock, call = 0): string[] {
  const init = fetchMock.mock.calls[call]?.[1];
  const body = JSON.parse(String(init?.body)) as {
    events: ReleaseHealthEvent[];
  };
  return body.events.map((e) => ('updateId' in e ? String(e.updateId) : ''));
}

let warn: ReturnType<typeof jest.spyOn>;

beforeEach(() => {
  jest.useFakeTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(() => {
  jest.useRealTimers();
  warn.mockRestore();
});

describe('httpSink', () => {
  it('posts buffered events as one JSON batch after the flush interval', async () => {
    const fetchMock = makeFetch([]);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    sink.onEvent(event('u1'));
    sink.onEvent(event('u2'));
    expect(fetchMock).not.toHaveBeenCalled();

    await jest.advanceTimersByTimeAsync(5000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://x.test/e', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: expect.any(String),
    });
    expect(sentEvents(fetchMock)).toEqual(['u1', 'u2']);
  });

  it('merges custom headers over the default content type', async () => {
    const fetchMock = makeFetch([]);
    const sink = httpSink({
      url: 'https://x.test/e',
      headers: { authorization: 'Bearer token' },
      fetchImpl: fetchMock,
    });

    sink.onEvent(event('u1'));
    await jest.advanceTimersByTimeAsync(5000);

    expect(fetchMock.mock.calls[0]?.[1]?.headers).toEqual({
      'content-type': 'application/json',
      'authorization': 'Bearer token',
    });
  });

  it('flushes immediately once the batch size is reached', async () => {
    const fetchMock = makeFetch([]);
    const sink = httpSink({
      url: 'https://x.test/e',
      batchSize: 2,
      fetchImpl: fetchMock,
    });

    sink.onEvent(event('u1'));
    sink.onEvent(event('u2'));
    await jest.advanceTimersByTimeAsync(0);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sentEvents(fetchMock)).toEqual(['u1', 'u2']);
  });

  it('sends pending events on explicit flush()', async () => {
    const fetchMock = makeFetch([]);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    sink.onEvent(event('u1'));
    await sink.flush!();

    expect(fetchMock).toHaveBeenCalledTimes(1);

    // The scheduled timer was cancelled; nothing further is sent.
    await jest.advanceTimersByTimeAsync(60000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('does not call fetch when there is nothing to send', async () => {
    const fetchMock = makeFetch([]);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    await sink.flush!();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps events buffered and retries when the endpoint errors', async () => {
    const fetchMock = makeFetch([{ ok: false, status: 500 }]);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    sink.onEvent(event('u1'));
    await jest.advanceTimersByTimeAsync(5000);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('HTTP 500'));

    // The retry succeeds and re-sends the same event.
    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(fetchMock, 1)).toEqual(['u1']);
  });

  it('retries when fetch rejects outright', async () => {
    const fetchMock = jest.fn<typeof fetch>();
    fetchMock.mockRejectedValueOnce(new Error('network down'));
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    sink.onEvent(event('u1'));
    await jest.advanceTimersByTimeAsync(5000);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('network down'));

    await jest.advanceTimersByTimeAsync(5000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(fetchMock, 1)).toEqual(['u1']);
  });

  it('drops the oldest events beyond maxBufferedEvents', async () => {
    const fetchMock = makeFetch([{ ok: false, status: 503 }]);
    const sink = httpSink({
      url: 'https://x.test/e',
      maxBufferedEvents: 2,
      fetchImpl: fetchMock,
    });

    sink.onEvent(event('u1'));
    await jest.advanceTimersByTimeAsync(5000);
    // u1 is requeued; two newer events push it out of the capped buffer.
    sink.onEvent(event('u2'));
    sink.onEvent(event('u3'));
    await jest.advanceTimersByTimeAsync(5000);

    expect(sentEvents(fetchMock, 1)).toEqual(['u2', 'u3']);
  });

  it('serializes overlapping flushes', async () => {
    let resolveFirst: (r: Response) => void = () => {};
    const fetchMock = jest.fn<typeof fetch>();
    fetchMock.mockReturnValueOnce(
      new Promise<Response>((resolve) => {
        resolveFirst = resolve;
      })
    );
    fetchMock.mockResolvedValue({ ok: true, status: 200 } as Response);
    const sink = httpSink({ url: 'https://x.test/e', fetchImpl: fetchMock });

    sink.onEvent(event('u1'));
    const first = sink.flush!();
    sink.onEvent(event('u2'));
    const second = sink.flush!();

    resolveFirst({ ok: true, status: 200 } as Response);
    await first;
    await second;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sentEvents(fetchMock, 0)).toEqual(['u1']);
    expect(sentEvents(fetchMock, 1)).toEqual(['u2']);
  });
});

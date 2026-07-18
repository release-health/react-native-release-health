# @release-health/sink-http

HTTP sink for [react-native-release-health](https://github.com/release-health/react-native-release-health): batches release-health events and posts them as JSON to any endpoint you control.

## Install

```sh
npm install @release-health/sink-http react-native-release-health
```

## Usage

```ts
import { ReleaseHealth } from 'react-native-release-health';
import { httpSink } from '@release-health/sink-http';

ReleaseHealth.init({
  adapter: yourAdapter,
  sinks: [
    httpSink({
      url: 'https://telemetry.example.com/release-health',
      headers: { authorization: 'Bearer <token>' },
    }),
  ],
});
```

Events are buffered and sent as `POST` requests with the body `{ "events": [...] }`. Any 2xx response acknowledges the batch; failed requests keep their events buffered (up to `maxBufferedEvents`, oldest dropped first) and retry on the next flush.

## Options

| Option | Default | Description |
| --- | --- | --- |
| `url` | required | Endpoint receiving the JSON batches |
| `headers` | `{}` | Extra request headers |
| `batchSize` | `20` | Send as soon as this many events are buffered |
| `flushIntervalMs` | `5000` | Send buffered events at most this often |
| `maxBufferedEvents` | `500` | Buffer cap while the endpoint is unreachable |
| `fetchImpl` | global `fetch` | Alternative fetch implementation |

## Local development

The monorepo ships a tiny receiver for local testing:

```sh
yarn receiver
# then point the sink at http://localhost:8787/events
# (Android emulator: http://10.0.2.2:8787/events)
```

## License

MIT

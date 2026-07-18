#!/usr/bin/env node
// Minimal local receiver for @release-health/sink-http.
//
// Usage:
//   node scripts/event-receiver.mjs          # listens on port 8787
//   PORT=9000 node scripts/event-receiver.mjs
//
// Point the sink at it:
//   httpSink({ url: 'http://localhost:8787/events' })
// (from a device or emulator, use your machine's LAN IP instead of localhost;
// the Android emulator reaches the host at http://10.0.2.2:8787)

import { createServer } from 'node:http';

const port = Number(process.env.PORT ?? 8787);

function describe(event) {
  const parts = [`[${new Date(event.timestamp).toISOString()}]`, event.type];
  if ('updateId' in event) {
    parts.push(`update=${event.updateId ?? 'embedded'}`);
  }
  if (event.type === 'session_start') {
    parts.push(
      `platform=${event.platform}`,
      `native=${event.nativeVersion} (${event.buildNumber})`,
      `rn=${event.sdkVersion}`
    );
    if (event.cohort !== undefined) {
      parts.push(`cohort=${event.cohort}`);
    }
  }
  if ('reason' in event) {
    parts.push(`reason=${event.reason}`);
  }
  if ('msToHealthy' in event) {
    parts.push(`msToHealthy=${event.msToHealthy}`);
  }
  if ('success' in event) {
    parts.push(`success=${event.success}`);
  }
  if ('jsMessage' in event) {
    parts.push(`jsMessage=${JSON.stringify(event.jsMessage)}`);
  }
  parts.push(`session=${String(event.sessionId).slice(0, 8)}`);
  return parts.join(' ');
}

const server = createServer((request, response) => {
  if (request.method !== 'POST') {
    response.writeHead(405).end();
    return;
  }

  let body = '';
  request.on('data', (chunk) => {
    body += chunk;
  });
  request.on('end', () => {
    try {
      const payload = JSON.parse(body);
      const events = Array.isArray(payload.events) ? payload.events : [payload];
      for (const event of events) {
        console.log(describe(event));
      }
      response.writeHead(204).end();
    } catch (error) {
      console.error(`could not parse request body: ${error}`);
      response.writeHead(400).end();
    }
  });
});

server.listen(port, () => {
  console.log(`release-health event receiver listening on http://localhost:${port}`);
  console.log('POST batches to any path; each received event is printed below.');
});

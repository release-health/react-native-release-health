# Security policy

## Supported versions

Only the latest published version of each package in this repository receives security fixes.

## Reporting a vulnerability

Please do not open a public issue for security reports. Use GitHub's private vulnerability reporting on this repository (Security tab, "Report a vulnerability"), and include the affected package, a reproduction, and the impact you see.

Reports are acknowledged as quickly as possible, normally within a few days. Fixes are published as patch releases and credited in the release notes unless you prefer otherwise.

## Scope notes

These packages run inside your app and export telemetry to endpoints you configure. Two things worth knowing when assessing exposure:

- The event stream can include OTA update ids, native version and build numbers, session ids, and fatal JS error messages. Error messages can contain anything your code puts in a thrown error, so point sinks only at endpoints you trust with that data.
- The packages never download or execute code. Delivering and applying updates belongs to your OTA vendor; this library only observes and reports.

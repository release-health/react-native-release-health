# Contributing to react-native-release-health

Thanks for your interest in contributing. This project is maintained by a solo maintainer, so a little process goes a long way toward keeping things reviewable.

## Issue first

Please open an issue before starting work on anything non-trivial. It saves both of us time: bugs get confirmed, features get discussed, and you avoid building something that can't be merged. Small fixes (typos, obvious one-liners) can go straight to a PR.

## Scope: what won't be accepted

This library is a rollout health layer that sits alongside your OTA vendor. The project follows a phased roadmap, and some things are deliberately out of scope. PRs in these areas will be closed, regardless of quality:

- **Delivering updates.** Downloading, hosting, or applying OTA bundles is the vendor's job (expo-updates, hot-updater, etc.). We integrate via adapters; we do not ship updates.
- **Crash reporting.** We correlate crashes with releases; we do not capture stack traces or symbolicate. Pair with a real crash SDK (e.g. Sentry) for ground truth.
- **A server or dashboard.** Sinks export events; you bring your own backend. A hosted dashboard is not planned.

## Pull requests

- **Title:** Conventional Commit format, scoped to the package you touched. Examples:
  - `fix(core): reset launch counter after clean exit`
  - `feat(adapter-expo-updates): support reload during probation`
  - `docs(sink-http): document retry behavior`
- **One concern per PR.** Small, focused PRs get reviewed quickly; grab-bag PRs get sent back.
- **Fill in the PR template.** Problem / Solution / Testing / New Dependencies / Checklist. "Testing" should say what you actually ran, on which platform.
- **Changeset:** any user-facing change needs a changeset (`npx changeset`). Internal-only changes (CI, tests, docs) do not.
- **Green locally before pushing:** typecheck, lint, tests, and build must all pass.

## Development setup

This is a yarn 4 workspace monorepo (yarn is vendored; with corepack enabled, plain `yarn` works). Node 20 or newer is required.

```sh
yarn install        # install all workspaces
yarn typecheck      # TypeScript
yarn lint           # ESLint over the whole repo
yarn test           # unit tests (core)
yarn build          # build the core library
yarn example start  # run the example app (Expo dev client)
```

The example app under `example/` uses Expo prebuild: `example/android` and `example/ios` are generated (`yarn example expo prebuild`) and not checked in. To exercise native changes, run `yarn example android` or `yarn example ios`.

## Coding standards

- TypeScript `strict`; no `any` in the public API.
- TSDoc comments on all exported symbols.
- New Architecture only: `react-native >= 0.76`, TurboModules via codegen. No legacy bridge code paths.
- New runtime dependencies need a strong justification in the PR; prefer peer dependencies for anything the host app likely already has.
- Error messages should tell the user what to do, not just what broke.

## License

By contributing, you agree that your contributions are licensed under the MIT License that covers this project.

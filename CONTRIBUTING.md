# Contributing

AgentRouter is early. Contributions are welcome, but the project is still
stabilizing its first public launch surface.

## Good First Contributions

- Reproduce setup issues and improve docs.
- Add focused tests around API, SDK, worker, or credential-boundary behavior.
- Improve examples without adding new external services.
- Report confusing errors or rough developer-experience edges.

## Local Development

Install dependencies:

```sh
pnpm install
```

Copy and fill the environment file:

```sh
cp .env.example .env
```

Run local checks:

```sh
pnpm typecheck
pnpm test:ci
pnpm test:worker
```

External tests require real credentials and may create cloud resources:

```sh
pnpm test:external
pnpm test:e2e:codex
pnpm test:e2e:claude
```

## Pull Request Expectations

- Keep changes scoped.
- Add or update tests for behavior changes.
- Update README or docs when user-facing behavior changes.
- Do not commit secrets, provider keys, `.env`, sandbox IDs, or generated
  artifacts.
- Prefer small PRs that can be reviewed independently.

## Security-Sensitive Changes

Provider keys and sandbox boundaries are sensitive areas. Changes touching
credential handling, command execution, artifacts, logs, or sandbox lifecycle
should include tests that prove secrets are not exposed through logs, events,
general sandbox env, or archived artifacts.

# Security Policy

AgentRouter runs coding agents that can execute commands and edit files inside
sandboxed environments. Please treat credential handling, sandbox lifecycle,
logs, and artifacts as security-sensitive surfaces.

## Supported Versions

AgentRouter is currently alpha. Security fixes target the `main` branch until
the project starts publishing versioned releases.

## Reporting A Vulnerability

Do not open a public issue for a vulnerability.

Until a dedicated security contact is published, please report privately to the
repository owner through GitHub. Include:

- A description of the issue.
- Steps to reproduce.
- Affected commit or version.
- Whether credentials, logs, artifacts, or sandbox isolation are involved.
- Any suggested fix or mitigation.

## Security Boundaries

Current self-hosted assumptions:

- `AGENTROUTER_API_KEY` protects the API.
- Provider keys stay server-side and are passed only to the provider process.
- Provider keys must not be copied into the general sandbox environment.
- Agent commands run inside Daytona sandboxes.
- Logs and artifacts may contain sensitive application data and should be stored
  in private buckets by default.

## Out Of Scope For This Repo

Hosted account management, hosted API keys, billing, hosted BYOK storage, and
Cloud dashboard authentication are not part of this open-source repository.

---
description: "Connect existing SSH and GitHub accounts for bounded read-only access with explicit employee preset grants."
kind: "package-reference"
---

# Connection center

English | [中文](README.zh.md)

## Summary

Save a public GitHub account or SSH destination, test it with a real read, and grant selected employee presets access. GitHub uses the local `gh` account by default or a Host-resolved credential reference. SSH uses the local OpenSSH agent or a specified absolute key path and requires an already trusted host key. Saved settings never establish connectivity by themselves.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount `@deepseek-ai/dsh-host-connections` beside Connection, Subprocess, Credentials, Agents and AgentPresets. Mount `@deepseek-ai/dsh-host-connections/tools` only in presets that may use external connections. Each connection also requires an explicit `allowedPresets` list; empty grants permit no model caller. Browser operations use the existing authenticated Connection router.

Configuration fields select `statePath`, `sshCommand`, `ghCommand`, `timeoutMs`, `outputBytes`, `graceMs` and `maxConcurrent`. Defaults use `$DSH_HOME/qianshou/connections.json`, local `ssh`/`gh`, a 15-second deadline, 256 KiB output, a one-second termination grace and four simultaneous reads. Store token values through the existing Credentials UI/RPC; connection records contain references only.

`GET /api/qianshou/connections` returns public views and capability limits. The `save`, `delete` and `probe` POST routes accept a draft or `{id}`. The `github-repos` GET route accepts `id` and a one-based `page`. Probe results contain `ok`, time, actual authentication method and either identity/detail or a stable error code. Repository pages contain public metadata and optional `nextPage`. There is no arbitrary command endpoint.

SSH tests run the fixed `uname -s && pwd && id -un` command with BatchMode and StrictHostKeyChecking enabled. Unknown host keys, unavailable credentials and inaccessible servers fail visibly; the connector does not accept a fingerprint or ask for a password automatically. GitHub reads `user` and paginated `user/repos` on public github.com. These operations do not create issues, clone repositories, publish code or deploy changes.

<a id="understand-the-implementation"></a>
## Understand the implementation

[registry.ts](src/registry.ts) owns validated non-secret metadata and active operations. Saving or deleting a connection cancels and drains its in-flight reads and invalidates probe evidence. Credential-reference changes invalidate matching probes. Every model read verifies the exact live Agent and its actual composed preset before and after asynchronous work. A preset change or revoked connection cannot return a late success.

[providers.ts](src/providers.ts) performs GitHub HTTP/CLI and OpenSSH reads. [process.ts](src/process.ts) uses the existing Subprocess provider for scrubbed environment, bounded collection, cancellation and process-tree quiescence. Raw stderr and secret values never become public error payloads. [routes.ts](src/routes.ts) exposes authenticated user operations; [tools.ts](src/tools.ts) registers read tools through normal `tools/pre-execute` policy.

The package publishes no `./invariant` companion: one registry owns metadata revisions, grants and pending readers; tests exercise their asynchronous relationships through public methods rather than an independent runtime projection.

<a id="further-exploration"></a>
## Further Exploration

- [Credentials](../../credentials/credentials/README.md) — secret references and storage providers.
- [Subprocess](../../subprocess/subprocess/README.md) — process ownership and bounded output.
- [Agent presets](../../preset/agent-presets/README.md) — actual live composition and employee grants.
- [Tools](../../../docs/subsystems/tools.md) — policy and durable tool-call records.

<a id="model-experience"></a>
## Model Experience

### External connection reads

#### What the model sees

Enabled presets receive four fixed tools: `connection_list`, `connection_probe`, `connection_github_repositories` and `connection_ssh_inspect`. Results contain actual public metadata or stable errors. Secret literals, connection editing and arbitrary SSH commands are not model capabilities. Standard Tool execution retains call arguments and results in the Session log and applies existing permission policy.

#### Token effect

Four schemas add request context for enabled presets. Connection listings and explicitly requested repository pages add bounded tool-result content; request only needed pages.

#### KV Cache effect

Definitions remain fixed when connections change. Connection identities and probe outcomes appear in tool results instead of changing the schema prefix. Enabling or disabling the tool plugin changes the visible schema set.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- One Host process owns each registry file; externally editing or sharing that file between active Hosts is unsupported. Probes are process-local evidence and are not restored after restart. GitHub Enterprise and interactive OAuth/device login are not implemented. SSH supports existing agent/key authentication with trusted known_hosts, not password prompts or interactive host-key enrollment. Arbitrary SSH execution and all remote write operations remain outside this read-only connector and require a separately approved execution path. Model API connections continue to use the Models settings page. Local fixture tests do not establish access to any user's real server or GitHub account.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers</summary>

None.

</details>

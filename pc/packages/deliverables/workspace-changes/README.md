---
description: "Summarize each top-level turn's changed files from git working-tree snapshots and whole-file captures around file-tool edits, announce them with a workspace/changes Session event, and serve the summary and per-file comparisons while the Session lives; configuration, repository requirement, and coverage rules."
kind: "package-reference"
---

# @deepseek-ai/dsh-workspace-changes

English | [中文](README.zh.md)

## Summary

This plugin summarizes which files each top-level turn changed, with per-file line counts, and serves each listed file's turn-start and turn-end comparison. Git snapshots of the working tree at turn start and turn end are diffed; every file a file tool edits is copied whole before its first edit and again at turn end, covering the files git does not. Without a repository or git, only file-tool edits are listed. The Session log receives one `workspace/changes` event naming the turn; summaries and comparisons stay on the Host until the Session is disposed. The Web changed-files card renders them.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

The shipped Web bundle mounts this plugin. Mount it in any composition with the `subprocess` capability and a git executable on the Host:

```yaml
- name: '@deepseek-ai/dsh-workspace-changes'
  config:
    maxFiles: 500
```

| Field | Default | Meaning |
|---|---|---|
| `includeChildren` | `false` | Retain verified child write/edit results under the root Session |
| `childMaxRecords` | `128` | Completed records and recent child index entries per root |
| `childMaxBytes` | `67108864` | Reserved captured bytes across active and completed children per root |
| `childDurableDir` | unset | Absolute directory that keeps completed child evidence across Host restarts; when unset, `includeChildren: true` and an absolute `DSH_HOME` write under `$DSH_HOME/qianshou/child-changes` |
| `timeoutMs` | `30000` | Milliseconds one git command may run before the turn's record is abandoned |
| `outputMaxBytes` | `8388608` | Bytes of git output retained per command; a larger diff listing abandons the record |
| `maxFiles` | `500` | Maximum files carried by one summary; `total` still reports the complete count |
| `maxFileBytes` | `2097152` | Bytes a file may hold to be captured around a file-tool edit or read from a snapshot for its comparison; a larger file gets no comparison, and one captured around a file-tool edit is also listed without counts |
| `diffTimeoutMs` | `100` | Milliseconds a line comparison may run before it degrades to whole-file replacement |

Every Session with a working directory and no subagent origin is recorded. Child recording is opt-in as described below. Snapshots are written through a private index into a temporary object directory owned by the Session, with the repository's own object store attached as a read-only alternate; the repository's index, objects, work tree, and refs stay untouched, and the user's earlier uncommitted changes never enter a summary. Session disposal removes the directory. Nested repositories and submodules inside the working directory are recorded as gitlinks, so their internal changes do not appear. A working directory outside any git repository takes no snapshots. Without git — or, on macOS, with only the developer-tools stub at `/usr/bin/git` — no repository is located either, and the plugin logs that once. Either way the summary lists the file-tool edits alone, as described next, with the working directory as the workspace; shell edits are absent.

Before a `write`, `edit`, or mutating `str_replace_editor` call runs, the recorder copies the file at its path into the Session's temporary directory, once per path per turn, and copies it again at turn end; the copies are named by the SHA-1 of their bytes, so identical content is stored once. This needs no git. Paths the snapshots cover keep their git counts; the copies serve the other paths — files matching an ignore pattern, files outside the repository, and every file-tool edit when there is no snapshot — with counts from a line comparison of the two copies, so repeated edits to one file count once and a shell edit after a file-tool edit is included. A path whose content is unchanged at turn end is not listed. A copy larger than `maxFileBytes` is not stored: the file is listed with `oversized` and no counts, and a path whose both sides are that large is listed too, since unread content is never known to be unchanged. A path whose only difference is a missing final newline compares as unchanged, while git still counts that line. Files under `/tmp` or the platform temporary directory are excluded unless they lie inside the repository. Changes made only through shell commands outside the snapshot coverage are not recorded.

Each file carries a durable `path` — relative to the working directory inside it, absolute elsewhere — and a `display` path used for ordering and labels: the relative path, a `../` path for repository files above the working directory, a `~` path under the home directory, otherwise the absolute path. Files sort by `display` in code-unit order, which lists parent and absolute paths before the working directory's own files. The `workspace/changes` event carries only the turn number; `ctx.workspaceChanges.summary(sessionId, seq)` returns the summary the event with that sequence announced, or undefined once the Session is disposed or when this Host process never recorded it. `ctx.workspaceChanges.diff(sessionId, seq, index, signal)` compares the listed file at that index: hunks with three context lines from the two snapshot trees or the two copies, `binary` for a side git reported as binary or that holds a NUL byte, `oversized` for a side larger than `maxFileBytes`. A line comparison that runs longer than `diffTimeoutMs` degrades to one hunk replacing every line, marked `coarse`. A conversation reopened after a Host restart therefore has no card, and no comparison, for its earlier turns.

The Qianshou Web bundle enables child evidence by profile; other profiles keep it disabled. The Qianshou patch can explicitly tune these limits, and an existing home-level override remains authoritative.

With `includeChildren: true`, a verified child turn keeps its first successful `write`/`edit` provider result's before content and its last successful result's after content. The observer waits for the real structured result after the tool's own permission and sandbox checks; it does not read file contents before authorization or parse model text. An overwrite whose provider reports unknown old content is refused as oversized, never represented as file creation. The child receives its own unchanged `workspace/changes { turn }` event. `children(parentSessionId)` lists only descendants of a verified root that is live in this process or still present in Session storage, with source Session/turn/sequence coordinates. Child disposal detaches live recording; completed evidence stays until the retention limit, plugin disposal without a durable directory, or removal of a stored root that no longer exists. Review reads cancelled by disposal resolve as unavailable and cleanup waits for those reads. When `childDurableDir` is set, or when `DSH_HOME` is an absolute path, completed child evidence is written under that directory and a later Host can serve it while the root still exists. A relative `childDurableDir` fails plugin load.

`childMaxRecords` bounds retained completed records and recent index metadata per root (default 128); `childMaxBytes` bounds reserved captured bytes across active and completed children (default 67108864). Each turn deduplicates stored content; reservations precede storage, intermediate copies are reclaimed at settlement, and older completed evidence is released first. If active work alone consumes the budget, further content is omitted and marked unavailable. Root disposal cancels observation and removes temporary copies without touching workspace files. Same-path operations in overlapping child turns carry a shared-edit warning; the snapshots do not establish exclusive authorship. Child coverage is limited to successful first-party `write` and `edit` results with a verified Host filesystem mapping. Failed/cancelled calls, Shell writes, `str_replace_editor`, external executors, and earlier Host runs do not manufacture missing historical sides. No rollback or cross-workspace merge occurs.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

One `TurnRecorder` per Session serializes its git work. `turn/start` queues the baseline: `rev-parse` locates the repository once per Session and the Session's temporary object directory is created, then `add --all --ignore-errors` into a temporary index seeded from the repository's index and `write-tree` produce the tree id; an unreadable file is skipped and reported through git's exit code 1, which the snapshot accepts. Each turn holds its own state object, so a record still running for an interrupted turn keeps that turn's files when the next turn starts. Every command runs with `GIT_OBJECT_DIRECTORY` pointing at the temporary directory and `GIT_ALTERNATE_OBJECT_DIRECTORIES` at the repository's objects, so committed content is read from the repository and new objects never land there. Every `tools/pre-execute` waits for that queue before a tool runs, so no mutation can precede its baseline; the same step queues the whole-file capture of the path a `write`, `edit`, or mutating `str_replace_editor` call names, so the copy precedes the edit, and `tool/result` events only mark that the turn has results to record. `agent/turn-stopping` records inside the turn: a second snapshot, `diff-tree -r -M --numstat` between the two trees, `check-ignore` for captured paths inside the work tree, a second copy and line comparison of each uncovered path, the appended event, and the summary kept under the event's sequence beside each listed file's two content sources, a path in a snapshot tree or a copy. A comparison is computed when asked for: `ls-tree -l` locates and sizes a snapshot side and `cat-file blob` reads it under `maxFileBytes`, copies are read from disk, and both sides go through the same line comparison with its timeout. `turn/end` records again only when tool results settled after the last record attempt, which covers aborted, failed, and steered turns without repeating a failed attempt; an empty list after an earlier record supersedes it. The repository's index is only read.

Git runs through the `subprocess` capability with a scrubbed environment, `GIT_CONFIG_COUNT=0` (ambient indexed configuration is excluded because the credential scrub removes its key entries), `GIT_TERMINAL_PROMPT=0`, `GIT_OPTIONAL_LOCKS=0`, the configured timeout, and bounded output. A failing step abandons that turn's record with a warning; the next turn starts afresh. Session disposal and plugin disposal abort queued work, forget the summaries, and remove the temporary directory. Completed child evidence, when a durable directory is resolved, is written under that directory by `ChildEvidenceStore` and is not removed by child Session disposal.

**Runtime invariant:** No companion is published. Event listeners are effect-owned and the recorder owns the summaries, the snapshot trees, and the captured copies for its Session's lifetime; no independent observation can diverge from them.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

- [Web deliverables](../../client/ui-deliverables/README.md) — the changed-files card that reads the served summary and opens its files.
- [Subprocess capability](../../subprocess/README.md) — the seam git runs through.
- [Turn changed-files card decision](../../../.agents/notes/implemented/feature/2026-09-11-turn-changed-files-card.md) — snapshot design, coverage rules, the deferred shadow repository, and rejected alternatives.
- [Child evidence across Host restarts](../../../.agents/notes/implemented/feature/2026-09-21-qianshou-child-changes-durable.md) — when completed child comparisons outlive this process, and when they are removed.

<a id="model-experience"></a>
## Model Experience

None, as the recorder appends a log-only `workspace/changes` event that only clients read and registers nothing model-facing.

#### KV Cache effect

Nothing here enters a model request, so provider cache reuse is unaffected.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Root summaries live only as long as their Session in this Host process; earlier root turns of a conversation reopened after a Host restart have no card and no comparison. Completed child evidence is readable after a later Host starts when `childDurableDir` (or `$DSH_HOME/qianshou/child-changes`) holds it and the root Session still exists; it is gone when that root is deleted, the index fails validation, or the retention budget evicted it. Shell writes, remote executors, and cross-root merges are still unrecorded. A card whose content the Host can no longer open is not shown.
- Two git features still write into the repository's own git directory during a snapshot: `core.splitIndex` writes `sharedindex.*` files, and git-lfs runs its clean filter on changed files and stores their objects under `.git/lfs`.
- git 2.13 or later is required for `rev-parse --absolute-git-dir`; an unsupported repository format or another git failure abandons the turn with a warning rather than being treated as a plain directory.
- The first snapshot of a Session writes every untracked, non-ignored file of the work tree into the Session's temporary directory; a repository without a `.gitignore` that carries large build outputs costs that much temporary space until the Session is disposed.
- Edits the user makes during a turn are attributed to that turn.
- A working directory outside any git repository lists file-tool edits only, so shell edits are missing from its card; a shadow repository under the Harness home is deferred until its exclude rules can replace a missing `.gitignore` reliably.
- Outside snapshot coverage only paths a file tool names are captured: a file only a shell command changes there is absent, and a file both changed before its first file-tool call is compared from that call onward.
- Every file-tool edit copies its whole file once per turn, up to `maxFileBytes`, even for paths the snapshots also cover; the copies go with the Session's temporary directory.
- A comparison serves the listed file's complete text to the client, including ignored files, repository files above the working directory, and files outside the workspace; the summary route also serves the source working directory and counts. A deployment that must keep such content on the Host composes this plugin out.
- A comparison that degrades to whole-file replacement carries every line of both sides, up to twice `maxFileBytes`.
- Windows paths keep native separators in `path`; `display` is always slash-separated.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>

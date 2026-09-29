---
description: "Host-owned preflight and no-overwrite installation for one local Qianshou SKILL.md file."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-qianshou-skill-import

English | [中文](README.zh.md)

## Summary

The `qianshouSkillImport` Remote accepts only the complete UTF-8 text of one `SKILL.md`. `inspect(content)` validates it with the same parser as [`skill-filesystem`](../../skill/skill-filesystem/README.md), checks the controlled destination, and returns metadata, a SHA-256 digest, and a short-lived opaque inspection id. `install(inspectionId)` consumes that id once and publishes exactly the inspected bytes to `<installRoot>/<name>/SKILL.md` without replacing an existing directory or flat `<name>.md` file. After an uncertain install response, `verify(name, sha256)` reads only that controlled path and answers `matched`, `different`, or `missing`.


## Table of Contents

- [Installation and receipt](#doc-section-1)
- [Model Experience](#doc-section-2)
- [Known Limitations and Deferred Work](#doc-section-3)
- [Dev Note](#dev-note)

<a id="doc-section-1"></a>
## Installation and receipt

The default `installRoot` is `$DSH_HOME/skills` or `~/.dsh/skills`, matching the filesystem provider's user root. A nonempty Host configuration value must be absolute; clients cannot select a destination path. The Host refuses symbolic links and non-directories in the root path, creates a new skill directory exclusively, writes into a private temporary file, publishes the final file without replacement, and rereads its bytes and parsed name. Inspections expire after ten minutes, are single use, and hold at most sixteen pending files; a Host timer removes expired text and plugin disposal clears all pending text. A request is limited to 256 KiB of valid UTF-8 text; names are at most 64 characters, descriptions at most 1024 characters, and bodies must be nonempty.

The `written` receipt proves only that the named file matched its reviewed digest after publication. `verify` accepts only a kebab-case name of at most 64 characters and a lowercase 64-character SHA-256 digest; it returns `different` for a symbolic link, changed file, or oversized file without following the link. Filesystem discovery watches paths asynchronously, and another project or provider can win the same skill name for a particular Session. The Client separately calls `remote.skills.list({sessionId})` and checks the returned path before describing the skill as callable in that Session. This Remote does not upload to a server, publish a market listing, install a plugin bundle, or accept an HTTPS, Git, ZIP, or local path spec.

The Host-only `authoringContext(name?)` method reports this running service's configured user roots, read-only filesystem readiness, an exact destination for a valid skill name, and existing bundle or flat-file conflicts. It creates no directory and grants no write authority. The skill assistant's existing `qianshou_skill_authoring_template` tool combines these facts with its embedded portable template, so authoring does not need to infer home or watcher configuration from source code. Session discovery remains a separate check.

`listLocal()` includes the instruction digest and whether local archival is allowed. `archiveLocal({source, name, path, sha256})` accepts only a current user-root inventory entry, refuses changed bytes, linked path components, managed installation markers and a currently selected node adapter, and moves the complete directory or flat skill file into a private `.qianshou-skill-archives/<id>` beside its user root. Nested links move as opaque directory entries; their targets are never read. `archiveList()` validates bounded manifests, original paths derived from configured roots, instruction digests, frontmatter names and OS ownership where available. `restoreLocal({source, archiveId, sha256})` takes no destination path and refuses both a same-name directory and flat file. Restoration creates files exclusively, preserves executable bits and link targets without following links, and writes `SKILL.md` last. A failed copy removes only its own unchanged entries and keeps the archive; a successful copy also keeps the backup and marks the entry restored. Local archival and restoration do not withdraw a publication, change an entitlement or owner grant, install a runtime, or erase Session history. Existing order bindings remain governed by order settings; a file receipt alone does not prove current task acceptance.

<a id="native-skill-draft"></a>

The Host-only `installNativeSkillDraft` entry accepts five catalog-built files and current-author verification callbacks, with no remote destination or arbitrary file payload. It creates metadata exclusively, makes `SKILL.md` visible last, verifies actual native source, then rechecks author/context/revision. Failure removes only unchanged transaction-owned files and directories; changed foreign bytes remain. Its receipt is a local draft and never a cloud publication, device authorization or runtime installation.

<a id="doc-section-2"></a>
## Model Experience

### Remote import

#### What the model sees

The `qianshouSkillImport` Remote registers no model tool or prompt text. When the filesystem provider later discovers the file for a Session, that provider and the skill tool own any catalog and body shown to its model.

#### Token effect

None directly. A later Session discovery can add the imported skill's catalog text to model context under the provider's rules.

#### KV Cache effect

None directly. A later catalog change can replace model context under the provider's rules.

## Known Limitations and Deferred Work

<a id="doc-section-3"></a>

- The Remote accepts one instruction file, so relative `references`, `scripts`, and `assets` from a source bundle are absent. A bundle importer needs separate archive validation and atomic directory publication. No link fetch or Git clone is provided by this package.

- The write receipt does not force the provider watcher to refresh or attest that a Session selected this skill. Query that Session's catalog after watcher observation and compare the path; a conflicting name can remain shadowed.

<a id="dev-note"></a>
### Dev Note

None.

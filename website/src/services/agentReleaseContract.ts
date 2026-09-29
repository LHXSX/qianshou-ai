/** Independent Qianshou Agent release feed; ecosystem packages use their own contract. */
export interface AgentArtifact {
  role: "controller" | "companion";
  platform: "darwin" | "win32" | "linux";
  arch: "arm64" | "x64";
  label: string;
  fileName: string;
  url: string;
  size: number;
  sha256: string;
  signature: "adhoc" | "unsigned";
  verified: boolean;
  notes: string[];
}

export interface AgentRelease {
  schemaVersion: 1;
  product: "qianshou-agent";
  version: string;
  channel: "preview";
  releasedAt: string;
  artifacts: AgentArtifact[];
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid release object");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max)
    throw new Error("Invalid release text");
  return value;
}

/** Reject unbound, duplicate or foreign download targets before rendering a link. */
export function parseAgentRelease(raw: unknown): AgentRelease {
  const value = record(raw);
  if (value.schemaVersion !== 1 || value.product !== "qianshou-agent" || value.channel !== "preview")
    throw new Error("Unsupported agent release");
  const version = text(value.version, 64);
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version))
    throw new Error("Invalid agent version");
  const releasedAt = text(value.releasedAt, 64);
  if (!Number.isFinite(Date.parse(releasedAt))) throw new Error("Invalid release date");
  if (!Array.isArray(value.artifacts) || value.artifacts.length > 12)
    throw new Error("Invalid artifact list");
  const seen = new Set<string>();
  const artifacts = value.artifacts.map((rawArtifact): AgentArtifact => {
    const item = record(rawArtifact);
    if (item.role !== "controller" && item.role !== "companion") throw new Error("Invalid artifact role");
    if (item.platform !== "darwin" && item.platform !== "win32" && item.platform !== "linux")
      throw new Error("Invalid artifact platform");
    if (item.arch !== "arm64" && item.arch !== "x64") throw new Error("Invalid artifact architecture");
    if (item.signature !== "adhoc" && item.signature !== "unsigned") throw new Error("Invalid signing status");
    if (typeof item.verified !== "boolean") throw new Error("Missing verification status");
    const key = `${item.role}/${item.platform}/${item.arch}`;
    if (seen.has(key)) throw new Error("Duplicate artifact target");
    seen.add(key);
    const fileName = text(item.fileName, 180);
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]+$/.test(fileName) || fileName.includes(".."))
      throw new Error("Invalid artifact filename");
    const url = text(item.url, 512);
    if (!url.startsWith(`/downloads/qianshou-agent/${version}/`) || /[?#\\%]/.test(url)
      || url.split("/").some(part => part === "." || part === "..")
      || url.slice(url.lastIndexOf("/") + 1) !== fileName)
      throw new Error("Download is outside the agent release directory");
    if (typeof item.size !== "number" || !Number.isSafeInteger(item.size) || item.size < 1 || item.size > 8 * 1024 ** 3)
      throw new Error("Invalid artifact size");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error("Invalid artifact checksum");
    if (!Array.isArray(item.notes) || item.notes.length > 12) throw new Error("Invalid release notes");
    return {
      role: item.role, platform: item.platform, arch: item.arch,
      label: text(item.label, 120), fileName, url, size: item.size,
      sha256: item.sha256, signature: item.signature, verified: item.verified,
      notes: item.notes.map(note => text(note, 600)),
    };
  });
  return { schemaVersion: 1, product: "qianshou-agent", version, channel: "preview", releasedAt, artifacts };
}

export function agentPlatformLabel(artifact: Pick<AgentArtifact, "platform" | "arch">): string {
  const platform = { darwin: "macOS", win32: "Windows", linux: "Linux" }[artifact.platform];
  return `${platform} · ${artifact.platform === "darwin" && artifact.arch === "arm64" ? "Apple Silicon" : artifact.arch === "arm64" ? "ARM64" : "x64"}`;
}

export function agentFileSize(bytes: number): string {
  return bytes >= 1024 ** 3 ? `${(bytes / 1024 ** 3).toFixed(2)} GB` : `${(bytes / 1024 ** 2).toFixed(1)} MB`;
}

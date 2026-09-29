/** The new PC release is independent of every historic V3 / Agent feed. */
export type PcPlatform = "windows-x64" | "macos-arm64";

export interface PcArtifact {
  platform: PcPlatform;
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  buildId: string;
  signature: "trusted";
  verified: true;
  installTested: true;
}

export interface PcRelease {
  schemaVersion: 1;
  product: "qianshou-pc";
  version: string;
  channel: "preview" | "stable";
  releasedAt: string;
  artifacts: PcArtifact[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid PC release object");
  return value as Record<string, unknown>;
}

/** Refuse stale or unrelated packages, platform swaps and untested installers. */
export function parsePcRelease(raw: unknown): PcRelease {
  const value = object(raw);
  if (value.schemaVersion !== 1 || value.product !== "qianshou-pc")
    throw new Error("Wrong PC release product");
  if (value.channel !== "preview" && value.channel !== "stable")
    throw new Error("Invalid PC channel");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(value.version))
    throw new Error("Invalid PC version");
  if (typeof value.releasedAt !== "string" || !Number.isFinite(Date.parse(value.releasedAt)))
    throw new Error("Invalid PC release date");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 2)
    throw new Error("Invalid PC artifact set");

  const seen = new Set<PcPlatform>();
  const artifacts = value.artifacts.map((rawArtifact): PcArtifact => {
    const item = object(rawArtifact);
    if (item.platform !== "windows-x64" && item.platform !== "macos-arm64")
      throw new Error("Unsupported PC platform");
    const platform = item.platform;
    if (seen.has(platform)) throw new Error("Duplicate PC platform");
    seen.add(platform);
    if (typeof item.fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{1,179}$/.test(item.fileName) || item.fileName.includes(".."))
      throw new Error("Invalid PC filename");
    const extension = platform === "windows-x64" ? ".exe" : ".dmg";
    if (!item.fileName.toLowerCase().endsWith(extension))
      throw new Error("PC installer does not match platform");
    const expectedUrl = `/downloads/qianshou-pc/${value.version}/${item.fileName}`;
    if (item.url !== expectedUrl)
      throw new Error("PC installer URL is outside the release directory");
    if (typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > 4 * 1024 ** 3)
      throw new Error("Invalid PC installer size");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error("Invalid PC installer checksum");
    if (typeof item.buildId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.buildId))
      throw new Error("Missing PC build identity");
    if (item.signature !== "trusted")
      throw new Error("PC installer must have a trusted signature");
    if (item.verified !== true || item.installTested !== true)
      throw new Error("PC installer is not verified on its target system");
    return {
      platform, fileName: item.fileName, url: expectedUrl,
      sizeBytes: item.sizeBytes, sha256: item.sha256, buildId: item.buildId,
      signature: item.signature, verified: true, installTested: true,
    };
  });
  return {
    schemaVersion: 1, product: "qianshou-pc", version: value.version,
    channel: value.channel, releasedAt: value.releasedAt, artifacts,
  };
}

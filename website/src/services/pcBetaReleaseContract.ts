import type { PcPlatform } from "./pcReleaseContract";

/** Publicly downloadable diagnostic builds, kept separate from signed releases. */
export interface PcBetaArtifact {
  platform: PcPlatform;
  fileName: string;
  url: string;
  sizeBytes: number;
  sha256: string;
  buildId: string;
}

export interface PcBetaRelease {
  schemaVersion: 1;
  product: "qianshou-pc";
  channel: "internal-beta";
  version: string;
  releasedAt: string;
  appId: "com.qianshou.desktop.internal";
  signed: false;
  notarized: false;
  installTested: false;
  updateFeed: false;
  artifacts: PcBetaArtifact[];
}

function object(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new Error("Invalid PC beta object");
  return value as Record<string, unknown>;
}

/** Only the exact, same-origin internal-build filenames may be shown. */
export function parsePcBetaRelease(raw: unknown): PcBetaRelease {
  const value = object(raw);
  if (value.schemaVersion !== 1 || value.product !== "qianshou-pc" || value.channel !== "internal-beta")
    throw new Error("Wrong PC beta product or channel");
  if (typeof value.version !== "string" || !/^\d+\.\d+\.\d+(?:-[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*)?$/.test(value.version))
    throw new Error("Invalid PC beta version");
  if (typeof value.releasedAt !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/.test(value.releasedAt) || !Number.isFinite(Date.parse(value.releasedAt)))
    throw new Error("Invalid PC beta release date");
  if (value.appId !== "com.qianshou.desktop.internal" || value.signed !== false || value.notarized !== false || value.installTested !== false || value.updateFeed !== false)
    throw new Error("PC beta status does not match internal unsigned build");
  if (!Array.isArray(value.artifacts) || value.artifacts.length < 1 || value.artifacts.length > 2)
    throw new Error("Invalid PC beta artifact set");

  const seen = new Set<PcPlatform>();
  const artifacts = value.artifacts.map((rawArtifact): PcBetaArtifact => {
    const item = object(rawArtifact);
    if (item.platform !== "windows-x64" && item.platform !== "macos-arm64")
      throw new Error("Unsupported PC beta platform");
    const platform = item.platform;
    if (seen.has(platform)) throw new Error("Duplicate PC beta platform");
    seen.add(platform);
    const fileName = `qianshou-${value.version}-${platform === "windows-x64" ? "win-x64.exe" : "mac-arm64.dmg"}`;
    if (item.fileName !== fileName)
      throw new Error("PC beta installer does not match product, version and platform");
    if (typeof item.buildId !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(item.buildId) || item.buildId.includes(".."))
      throw new Error("Invalid PC beta build identity");
    const url = `/downloads/qianshou-pc/beta/${item.buildId}/${fileName}`;
    if (item.url !== url)
      throw new Error("PC beta installer URL is outside its build directory");
    if (typeof item.sizeBytes !== "number" || !Number.isSafeInteger(item.sizeBytes) || item.sizeBytes < 1 || item.sizeBytes > 4 * 1024 ** 3)
      throw new Error("Invalid PC beta installer size");
    if (typeof item.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.sha256))
      throw new Error("Invalid PC beta installer checksum");
    return { platform, fileName, url, sizeBytes: item.sizeBytes, sha256: item.sha256, buildId: item.buildId };
  });
  return {
    schemaVersion: 1, product: "qianshou-pc", channel: "internal-beta", version: value.version,
    releasedAt: value.releasedAt, appId: "com.qianshou.desktop.internal", signed: false,
    notarized: false, installTested: false, updateFeed: false, artifacts,
  };
}

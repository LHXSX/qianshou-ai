import type { EcoRelease } from "./releaseContract";
export interface ReleaseNote {
  version: string;
  date: string;
  title: string;
  changes: string[];
  action: string;
  knownIssues: string[];
  artifacts: Record<string, string>;
}
export function parseEditorial(raw: unknown): ReleaseNote[] {
  const data = raw as any;
  if (
    data?.schemaVersion !== 1 ||
    data?.product !== "qianshou-eco-v3-preview" ||
    !Array.isArray(data.releases)
  )
    throw new Error("Invalid editorial");
  const versions = new Set<string>();
  return data.releases.map((entry: any) => {
    const text = (value: unknown) =>
      typeof value === "string" &&
      value.trim().length > 0 &&
      value.length <= 1200;
    const lines = (value: unknown) =>
      Array.isArray(value) && value.length <= 20 && value.every(text);
    if (
      !text(entry.version) ||
      !/^3\.\d+\.\d+(?:-[\w.-]+)?$/.test(entry.version) ||
      versions.has(entry.version) ||
      !/^\d{4}-\d{2}-\d{2}$/.test(entry.date) ||
      !text(entry.title) ||
      !text(entry.action) ||
      !lines(entry.changes) ||
      !lines(entry.knownIssues)
    )
      throw new Error("Invalid release note");
    if (
      !entry.artifacts ||
      Object.keys(entry.artifacts).some(
        (p) => !["windows-x64", "macos-arm64"].includes(p),
      ) ||
      !Object.values(entry.artifacts).every(
        (s) => typeof s === "string" && /^[a-f0-9]{64}$/.test(s),
      )
    )
      throw new Error("Invalid editorial binding");
    versions.add(entry.version);
    return {
      version: entry.version,
      date: entry.date,
      title: entry.title,
      changes: entry.changes,
      action: entry.action,
      knownIssues: entry.knownIssues,
      artifacts: entry.artifacts,
    };
  });
}
export function noteForRelease(
  notes: ReleaseNote[],
  release: EcoRelease | null,
): ReleaseNote | undefined {
  if (!release || !release.downloads.length) return;
  return notes.find(
    (note) =>
      note.version === release.version &&
      release.downloads.every((d) => note.artifacts[d.platform] === d.sha256),
  );
}

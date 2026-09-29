/** Canonical bounded MIME metadata. This does not grant preview or execution authority. */
export function isArtifactContentType(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 255
    && /^[a-z0-9][a-z0-9!#$&^_.+-]{0,126}\/[a-z0-9][a-z0-9!#$&^_.+-]{0,126}$/u.test(value)
}

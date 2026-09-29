/** In-flight sends belong to one account and conversation, never to the whole page. */
export function createComposerSubmissions() {
  const pending = new Map<string, symbol>()
  return {
    busy: (scope: string): boolean => pending.has(scope),
    begin(scope: string) {
      if (pending.has(scope)) return null
      const token = Symbol('submission')
      let current = scope
      pending.set(current, token)
      return {
        bind(next: string): boolean {
          if (pending.get(current) !== token || (next !== current && pending.has(next))) return false
          pending.delete(current)
          current = next
          pending.set(current, token)
          return true
        },
        finish(): void { if (pending.get(current) === token) pending.delete(current) },
      }
    },
    forget: (scope: string): void => { pending.delete(scope) },
    clear: (): void => { pending.clear() },
  }
}

/**
 * 标识符生成。
 *
 * ## 为什么不用 `crypto.randomUUID`
 * 它在**非安全上下文**里不可用：手机端是通过 `http://<ip>:<port>` 打开的
 * 局域网/隧道页面，浏览器不会把它当作 secure context，`crypto.randomUUID`
 * 直接不存在。而这个应用恰恰跑在这种页面上，所以必须自适应。
 *
 * ## 降级顺序
 * 1. `crypto.randomUUID()` —— secure context 下最好
 * 2. `crypto.getRandomValues()` 手工拼 UUID v4 —— **在非安全上下文也可用**，
 *    随机性仍来自 CSPRNG
 * 3. `Math.random()` —— 极端兜底；仅用于会话标识这类非安全用途，
 *    不用于任何凭据
 */

/** 生成一个 UUID v4 形态的字符串。 */
export function randomId(): string {
  const cryptoRef = globalThis.crypto

  if (typeof cryptoRef?.randomUUID === 'function') {
    try {
      return cryptoRef.randomUUID()
    } catch {
      // 某些实现存在但不可用（权限或上下文限制），继续降级。
    }
  }

  if (typeof cryptoRef?.getRandomValues === 'function') {
    try {
      const bytes = cryptoRef.getRandomValues(new Uint8Array(16))
      // 按 RFC 4122 打上版本号 4 与变体位 10xx。
      bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40
      bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80
      const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
    } catch {
      // 继续降级。
    }
  }

  const stamp = Date.now().toString(16).padStart(12, '0')
  const tail = Array.from({ length: 3 }, () => Math.random().toString(16).slice(2, 10)).join('')
  return `${stamp.slice(0, 8)}-${stamp.slice(8, 12)}-4${tail.slice(0, 3)}-8${tail.slice(3, 6)}-${tail.slice(6, 18).padEnd(12, '0')}`
}

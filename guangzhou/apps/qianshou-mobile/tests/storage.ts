/**
 * 测试共用的 localStorage 替身。
 *
 * 为什么要有这个文件：手机端自己的存储层对 `globalThis.localStorage` **接口级**地
 * 拿捏——`store.ts` 会调 `getItem/setItem/removeItem`，而用例在 `beforeEach` 里会调
 * `clear()`。早先每个测试文件各写一个桩，有的只实现三个方法，于是：
 *
 * - 单跑那个文件，`clear()` 直接抛 `is not a function`；
 * - 全套一起跑却"通过"了，因为上一个文件把带 `clear()` 的桩**漏**在了全局上
 *   （`vi.stubGlobal` 是按 worker 生效的）。也就是说那些绿灯是执行顺序的巧合。
 *
 * 所以这里只留一份实现、方法齐全，谁用谁显式装，不依赖别的文件先跑过。
 */
import { vi } from 'vitest'

/** 一次测试使用的存储替身。 */
export interface StorageStub {
  /** 直接读底层映射，用来断言"到底写进去没有"。 */
  readonly map: Map<string, string>
}

/**
 * 装一个完整的 localStorage 替身。
 * @param initial - 初始键值（例如预置一份连接设置）。
 * @returns 底层映射，供断言使用。
 */
export function installStorage(initial: Record<string, string> = {}): StorageStub {
  const map = new Map(Object.entries(initial))
  vi.stubGlobal('localStorage', {
    get length(): number { return map.size },
    getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, String(value)) },
    removeItem: (key: string) => { map.delete(key) },
    clear: () => { map.clear() },
    key: (index: number) => [...map.keys()][index] ?? null,
  })
  return { map }
}

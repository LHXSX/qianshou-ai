/**
 * 工单 8 · 第 ④ 步：声明前校验 + 反馈（"核不过 ⇒ 不发 + 明确告警"）。
 *
 * ## 这个测试防的是什么
 *
 * 平台侧有两道**互不相干**的静默闸：
 * 1. `storage/repo.py:1811-1814` 的字段白名单 —— 只留 `WorkerCapabilities` dataclass 声明过的键，
 *    多报的键**无声丢弃**，注册照常成功。`native_bins`（本仓错名）就这样活了两个月，
 *    整块 native 二进制清单从未落库，两侧测试还全绿。
 * 2. `services/capability_shadow.py:252` 的 `hello_union_gate` —— 只放行"健康广告了该**契约名**"
 *    的节点。某在线节点报旧式裸名 `["word_count", …]` ⇒ 被剔除，**节点自己不知道**。
 *
 * 本模块把这两道闸都变成**节点侧可自查的核名**：名字过不了就必须有告警，而不是发出去等别人丢。
 */
import { describe, expect, it } from 'vitest'
import {
  checkDeclarationNames,
  checkOutboundFields,
  localRegistryMirror,
} from '../../src/capability-pipeline/registry-mirror.ts'
import {
  PLATFORM_CAPABILITY_FIXTURE_RECORDED_AT,
  PLATFORM_CAPABILITY_FIXTURE_SOURCE,
  PLATFORM_WORKER_CAPABILITY_KEYS,
} from '../fixtures/platform-worker-capabilities.ts'

const mirror = localRegistryMirror({ now: new Date('2026-09-22T00:00:00.000Z') })

describe('平台注册表镜像：来源、降级模式与风险必须自述', () => {
  it('本仓只能给"本地镜像"，且必须标明这是退化模式（没有平台只读接口）', () => {
    expect(mirror.kind).toBe('local-mirror')
    expect(mirror.risks.length).toBeGreaterThan(0)
    expect(mirror.risks.join('\n')).toContain('镜像')
  })

  it('能力名全集来自契约注册表投影，不是手抄的第二份清单', () => {
    expect(mirror.contract).toBe('qianshou/capabilities/registry/v1')
    expect(mirror.version).toBe('1.0')
    expect(mirror.capabilityIds).toContain('text.transform')
    expect(mirror.capabilityIds).toContain('media.transcode')
    // 26 名注册表里 image.generate / media.compose 这类没有软件实现的也必须在，
    // 否则"平台认这个名字但本机没证据"与"平台根本不认"会被混为一谈。
    expect(mirror.capabilityIds).toContain('media.compose')
    expect([...mirror.capabilityIds].sort()).toEqual([...mirror.capabilityIds])
  })

  it('字段白名单与契约测试夹具逐字一致（重复的清单必须是"被检查的重复"，不是第三份静默副本）', () => {
    expect([...mirror.workerCapabilityFieldKeys].sort()).toEqual([...PLATFORM_WORKER_CAPABILITY_KEYS].sort())
    expect(mirror.captureSource).toContain('AT-08.json')
    expect(mirror.captureSource).toBe(PLATFORM_CAPABILITY_FIXTURE_SOURCE)
    expect(mirror.capturedAt).toBe(PLATFORM_CAPABILITY_FIXTURE_RECORDED_AT)
  })
})

describe('契约名核名：平台不认的名字必须被点名', () => {
  it('注册表里的契约名放行，且不给出多余"建议"', () => {
    const [verdict] = checkDeclarationNames(['media.transcode'], mirror)
    expect(verdict).toEqual({ name: 'media.transcode', accepted: true, reason: null, suggestion: null, detail: expect.any(String) })
  })

  it('回归闸②a：旧式裸名 word_count ⇒ 判为 LEGACY_TASK_TYPE_NAME 并给出正确契约名', () => {
    const [verdict] = checkDeclarationNames(['word_count'], mirror)
    expect(verdict?.accepted).toBe(false)
    expect(verdict?.reason).toBe('LEGACY_TASK_TYPE_NAME')
    expect(verdict?.suggestion).toBe('text.transform')
    expect(verdict?.detail).toContain('hello_union_gate')
  })

  it('回归闸②b：把 native_bins 当成能力名发 ⇒ 判为拼错的平台字段，并指出平台真名', () => {
    const [verdict] = checkDeclarationNames(['native_bins'], mirror)
    expect(verdict?.accepted).toBe(false)
    expect(verdict?.reason).toBe('MISSPELLED_PLATFORM_FIELD')
    expect(verdict?.suggestion).toBe('native_binaries')
  })

  it('拼错的契约名 ⇒ UNKNOWN_CONTRACT_NAME，并给最近的那个契约名当建议', () => {
    const [verdict] = checkDeclarationNames(['text.transfrom'], mirror)
    expect(verdict?.reason).toBe('UNKNOWN_CONTRACT_NAME')
    expect(verdict?.suggestion).toBe('text.transform')
  })

  it('把平台字段名当能力名发 ⇒ 单独一类，不混进"未知名字"', () => {
    const [verdict] = checkDeclarationNames(['native_binaries'], mirror)
    expect(verdict?.reason).toBe('PLATFORM_FIELD_NOT_A_CAPABILITY')
    expect(verdict?.suggestion).toBeNull()
  })

  it('把实现包名当能力名发（faster-whisper）⇒ 指出它属于哪个契约能力', () => {
    const [verdict] = checkDeclarationNames(['faster-whisper'], mirror)
    expect(verdict?.reason).toBe('IMPLEMENTATION_NAME_NOT_A_CAPABILITY')
    expect(verdict?.suggestion).toBe('speech.transcribe')
  })

  it('大小写/空白先归一，再判定（不许因为写法差异而报假警）', () => {
    const [verdict] = checkDeclarationNames(['  Media.Transcode '], mirror)
    expect(verdict?.accepted).toBe(true)
  })

  it('畸形名字（不是 domain.object.action）单独成类', () => {
    const [verdict] = checkDeclarationNames(['not a name'], mirror)
    expect(verdict?.reason).toBe('MALFORMED_CONTRACT_NAME')
    expect(verdict?.suggestion).toBeNull()
  })

  it('空名字不许当成"什么都没声明"糊过去', () => {
    const [verdict] = checkDeclarationNames([''], mirror)
    expect(verdict?.accepted).toBe(false)
    expect(verdict?.reason).toBe('MALFORMED_CONTRACT_NAME')
  })
})

describe('出站字段白名单核验：平台会静默丢弃的键必须可见', () => {
  it('平台声明过的键全部放行', () => {
    expect(checkOutboundFields(['os', 'arch', 'provided_capabilities'], mirror)).toEqual([])
  })

  it('回归闸②（两次事故的那一条）：native_bins 被标为拼错的平台字段并给出真名', () => {
    const drops = checkOutboundFields(['os', 'native_bins', 'provided_capabilities'], mirror)
    expect(drops).toEqual([
      {
        key: 'native_bins',
        reason: 'MISSPELLED_PLATFORM_FIELD',
        suggestion: 'native_binaries',
        detail: expect.stringContaining('native_binaries'),
      },
    ])
  })

  it('平台从来不认的键 ⇒ NOT_DECLARED_BY_PLATFORM_WHITELIST，且说不出建议就是 null（不编造）', () => {
    const drops = checkOutboundFields(['totally_invented_key'], mirror)
    expect(drops).toEqual([
      { key: 'totally_invented_key', reason: 'NOT_DECLARED_BY_PLATFORM_WHITELIST', suggestion: null, detail: expect.any(String) },
    ])
  })

  it('输出按字段名稳定排序，便于两次探测做 diff', () => {
    const drops = checkOutboundFields(['zed_key', 'alpha_key'], mirror)
    expect(drops.map(drop => drop.key)).toEqual(['alpha_key', 'zed_key'])
  })
})

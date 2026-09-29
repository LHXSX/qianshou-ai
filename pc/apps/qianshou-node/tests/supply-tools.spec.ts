/**
 * 节点 `hello` 上报的工具集必须包含宿主唯一来源 `HOST_SUPPLY_TOOLS`，
 * Python 包只来自 `HOST_SUPPLY_PACKAGES`，不得再手写第三份清单。
 * 隔离 runner 拥有的 `text.transform` 必须并进 `provided_capabilities`，`word_count` 不得进入。
 *
 * `node-daemon.mts` 是带顶层 `await` / `process.exit` 的守护脚本，不能在测试里 import，
 * 所以这里复现它的同一条管线，再从源码上钉住它确实把 `HOST_SUPPLY_TOOLS` 传给了探测、
 * 并把 `runnerOwnedCapabilityIds` 并进广告。
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { HOST_SUPPLY_PACKAGES, HOST_SUPPLY_TOOLS, probeLocalSupply, runnerOwnedCapabilityIds } from '@deepseek-ai/dsh-compute-core'
import { mergeProvidedCapabilityAds, projectNodeCapabilities, providedCapabilityAdsForIds } from '@deepseek-ai/dsh-compute-core/node-capability'

/** 目录唯一来源 `SUPPLY_TOOL_CATALOG` 的五个 id；少一项或多一项都必须让本测试变红。 */
const CATALOG_TOOL_IDS = ['node', 'git', 'python3', 'ffmpeg', 'ffprobe']

const DAEMON_SOURCE = readFileSync(fileURLToPath(new URL('../node-daemon.mts', import.meta.url)), 'utf8')

describe('qianshou-node supply tools', () => {
  it('advertises exactly the HOST_SUPPLY_TOOLS ids in hello software', async () => {
    const probe = await probeLocalSupply({
      tools: HOST_SUPPLY_TOOLS,
      readHostActivity: () => ({ foregroundTaskActive: null, voiceActive: null }),
      timeoutMs: 1000,
      maxResponseBytes: 65536,
    }, undefined, async () => 'version 1.0.0')
    const capabilities = projectNodeCapabilities(probe, { mode: 'paused' })

    expect([...capabilities.software].sort()).toEqual(HOST_SUPPLY_TOOLS.map(tool => tool.id).sort())
    expect(HOST_SUPPLY_TOOLS.map(tool => tool.id)).toEqual(CATALOG_TOOL_IDS)
    expect([...capabilities.software].sort()).toEqual([...CATALOG_TOOL_IDS].sort())
  })

  it('node-daemon.mts probes with HOST_SUPPLY_TOOLS and HOST_SUPPLY_PACKAGES and no hand-written list', () => {
    expect(DAEMON_SOURCE).toContain("import { EdgeWorkerConnection, HOST_SUPPLY_PACKAGES, HOST_SUPPLY_TOOLS, probeLocalSupply, runnerOwnedCapabilityIds } from '@deepseek-ai/dsh-compute-core'")
    expect(DAEMON_SOURCE).not.toContain("'@deepseek-ai/dsh-compute-core/edge-worker'")
    expect(DAEMON_SOURCE).toMatch(/probeLocalSupply\(\{\s*tools:\s*HOST_SUPPLY_TOOLS,/)
    expect(DAEMON_SOURCE).toContain('packages: HOST_SUPPLY_PACKAGES')
    expect(DAEMON_SOURCE).not.toContain('PYTHON_PACKAGES')
    expect(DAEMON_SOURCE).not.toContain('probePythonPackages')
    expect(DAEMON_SOURCE.match(/probeLocalSupply\(/g)).toHaveLength(1)
    expect(DAEMON_SOURCE).toContain("loopbackOnly: !String(core).startsWith('https:')")
    expect(DAEMON_SOURCE).toContain("connection.updateMode('running')")
    expect(DAEMON_SOURCE).toContain("args.dry === 'true'")
    expect(HOST_SUPPLY_PACKAGES.map(pkg => pkg.id)).toContain('numpy')
  })

  it('unions runner-owned text.transform into hello and never advertises word_count', () => {
    expect(DAEMON_SOURCE).toContain("import { mergeProvidedCapabilityAds, projectNodeCapabilities, providedCapabilityAdsForIds } from '@deepseek-ai/dsh-compute-core/node-capability'")
    expect(DAEMON_SOURCE).toContain('runnerOwnedCapabilityIds(taskTypes, [])')
    expect(DAEMON_SOURCE).toContain('mergeProvidedCapabilityAds(capabilities.provided_capabilities, runnerAds)')
    // 接线后：执行由**接单专员**接管（行为不变：其默认 worker 仍是内建 runner）。
    expect(DAEMON_SOURCE).toContain("import { createOrderAcceptanceAgent } from './order-agent.ts'")
    // E9：执行入口不变（还是那条唯一的运行器 + 这条连接），但 fed 给它的是**记账过的同一条连接**
    // 与**账上那条任务 signal**——主人中止断的就是它。三行一起钉：任何一处退回去都会红。
    expect(DAEMON_SOURCE).toContain('orderAgent.handleOffer(')
    // 意图不变：执行方拿到的是**被观察过的连接**与**主人中止那条 signal**（不是原始对象）。
    expect(DAEMON_SOURCE).toContain('signal: taskSignal')
    expect(DAEMON_SOURCE).toContain('startedAtMs: Date.now()')
    expect(DAEMON_SOURCE).not.toContain('startedAtMs: performance.now()')
    expect(DAEMON_SOURCE).toContain('observed.complete(offer,')
    expect(DAEMON_SOURCE).toContain('const taskSignal = nodeStatus.offerDelivered(offer, signal)')
    expect(DAEMON_SOURCE).toContain('const observed = observeNodeConnection(connection, nodeStatus)')
    expect(DAEMON_SOURCE).not.toContain('executeNodeOffer(offer, signal, connection)')
    const runnerAds = providedCapabilityAdsForIds(runnerOwnedCapabilityIds(['word_count'], []))
    const provided = mergeProvidedCapabilityAds([], runnerAds)
    expect(provided.map(ad => ad.name)).toEqual(['text.transform'])
    expect(JSON.stringify(provided)).not.toContain('word_count')
    expect(runnerOwnedCapabilityIds(['ocr_image'], [])).toEqual([])
  })
})

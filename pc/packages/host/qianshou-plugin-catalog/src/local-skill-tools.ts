/** One local trial entry for any user-authored portable skill. */
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import { readGenericOrderSource } from './generic-order-adapter.ts'
import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { skillAuthoringTemplate } from './skill-authoring-template.ts'
import { nativeH3AuthoringTemplate } from './native-h3-order-source.ts'
import { comfyVideoAuthoringTemplate } from './comfy-video-order-source.ts'
import type { ComfyVideoPublicContract } from '@deepseek-ai/dsh-compute-core/src/comfy-video-public-contract.ts'
import { nativeH3LogicalBindingSha256, type NativeH3ExecutionBindingV2, type NativeH3PortableExecutionBinding } from '@deepseek-ai/dsh-compute-core/native-h3-binding'
import { localOrderSourceRejection } from './order-source-diagnostics.ts'

export const name = 'qianshou-local-skill-tools'
export const inject = ['tools', 'qianshouPluginCatalog', 'qianshouSkillImport']

export function apply(ctx: Context): void {
  ctx.tools.register(defineTool({
    name: 'qianshou_skill_authoring_template',
    description: '创建技能前先调用。返回当前 Host 的真实用户技能根、写入就绪观测、指定名称的保存位置和同名冲突，以及跨平台 v3 通用运行包完整模板。无需猜 DSH_HOME、扫描或监视配置，不搜索源码目录。按业务修改后直接保存并用 qianshou_try_local_skill 试用。只读，不创建目录、不安装、不发布、不扣费；写能力观测不是授权。',
    parameters: {
      name: { type: 'string', description: '准备创建的 kebab-case 英文命令名；提供后返回真实目标目录和同名冲突' },
      runtime: { type: 'string', enum: ['portable', 'native-h3', 'reviewed-comfy-video'], description: '普通文字/文件算法选 portable；H3 固定原生运行包选 native-h3；五秒首帧 Comfy 出片选 reviewed-comfy-video，须有实际本机包与自测' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const importer = ctx.get('qianshouSkillImport') as {
        authoringContext(name?: string): Promise<unknown>
      } | undefined
      if (importer === undefined || typeof importer.authoringContext !== 'function') {
        throw new Error('当前 Host 缺少用户技能目录信息，不能猜测保存路径；请更新 Host 后重试')
      }
      const authoringContext = await importer.authoringContext(args.name)
      exec.signal.throwIfAborted()
      if (args.runtime === 'reviewed-comfy-video') {
        if (!args.name) throw new Error('请先为五秒视频技能命名')
        const contributor = ctx.get('nodeContributor') as {
          reviewedComfyVideoAuthorBindingCurrent?(): Promise<{
            publicContract: ComfyVideoPublicContract
            packageDigest: string
          }>
        } | undefined
        const readBinding = contributor?.reviewedComfyVideoAuthorBindingCurrent?.bind(contributor)
        if (readBinding === undefined) throw new Error('当前设备尚无通过本机自测的受审 Comfy 视频私有包')
        const account = ctx.get('qianshouAccount') as {
          state?(): Promise<{ phase: string; account: { id: string } | null }>
        } | undefined
        const state = await account?.state?.()
        const ownerId = state?.account?.id
        if (!['authenticated', 'refreshing'].includes(state?.phase ?? '')
          || typeof ownerId !== 'string' || !/^[1-9][0-9]*$/u.test(ownerId)
          || !Number.isSafeInteger(Number(ownerId))) throw new Error('请先登录当前技能作者账号')
        const binding = await readBinding()
        const current = await account?.state?.()
        if (current?.account?.id !== ownerId || !['authenticated', 'refreshing'].includes(current.phase)) {
          throw new Error('作者账号已变化，请重新制作技能')
        }
        exec.signal.throwIfAborted()
        return JSON.stringify({ ...comfyVideoAuthoringTemplate(binding.publicContract,
          binding.packageDigest, args.name), authoringContext })
      }
      if (args.runtime === 'native-h3') {
        if (!args.name) throw new Error('请先为 H3 技能命名')
        const contributor = ctx.get('nodeContributor') as {
          nativeH3AuthorBindingV2?(): Promise<{ binding: NativeH3ExecutionBindingV2; localOwnerConfigDigest: string }>
          nativeH3AuthorBindingCurrent?(): Promise<{ binding: NativeH3PortableExecutionBinding; localOwnerConfigDigest: string }>
        } | undefined
        const readBinding = contributor?.nativeH3AuthorBindingCurrent?.bind(contributor)
          ?? contributor?.nativeH3AuthorBindingV2?.bind(contributor)
        if (readBinding === undefined) throw new Error('当前设备尚未配置 H3 原生出片能力，请先完成本机自测')
        const account = ctx.get('qianshouAccount') as {
          state?(): Promise<{ phase: string; account: { id: string } | null }>
        } | undefined
        const state = await account?.state?.()
        const ownerId = state?.account?.id
        if (!['authenticated', 'refreshing'].includes(state?.phase ?? '')
          || typeof ownerId !== 'string' || !/^[1-9][0-9]*$/u.test(ownerId)
          || !Number.isSafeInteger(Number(ownerId))) throw new Error('请先登录当前技能作者账号')
        const { binding } = await readBinding()
        const current = await account?.state?.()
        if (current?.account?.id !== ownerId || !['authenticated', 'refreshing'].includes(current.phase)) {
          throw new Error('作者账号已变化，请重新制作技能')
        }
        exec.signal.throwIfAborted()
        const taskType = `qianshou_h3_${createHash('sha256').update(`${ownerId}\0`)
          .update(nativeH3LogicalBindingSha256(binding)).digest('hex').slice(0, 32)}_v2`
        return JSON.stringify({ ...nativeH3AuthoringTemplate(binding, args.name, taskType), authoringContext })
      }
      return JSON.stringify({ ...skillAuthoringTemplate, authoringContext })
    },
    presentCall: () => ({ card: 'generic', title: '读取通用技能制作模板', kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'qianshou_skill_complete',
    description: '真正保存 SKILL.md 后调用。Host 在当前用户技能清单核对来源、名称与实际文件，返回保存回执和立即试用、发布接单技能操作卡。只有实际本机试用才报告试用完成，保存不等于审核或可接单。不会改文件、运行、发布、扣费。纯指令技能也调用此工具。',
    parameters: {
      source: { type: 'string', required: true, enum: ['user-dsh', 'user-agents'], description: '模板回执中的用户来源' },
      name: { type: 'string', required: true, description: '真正保存的技能英文命令名' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => (JSON.parse(value) as { actions: Record<string, string | boolean> }).actions },
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      const importer = ctx.get('qianshouSkillImport') as { listLocal(): Promise<{ skills: Array<{
        source: 'user-dsh' | 'user-agents'
        name: string
        path: string
        displayName: string
      }> }> } | undefined
      if (importer === undefined) throw new Error('当前 Host 缺少用户技能目录')
      const inventory = await importer.listLocal()
      const skill = inventory.skills.find(item => item.name === args.name && item.source === args.source)
      if (skill === undefined) throw new Error('尚未取得保存回执：当前用户技能目录不存在这个技能')
      const file = await open(skill.path, constants.O_RDONLY | constants.O_NOFOLLOW)
      let skillSha256: string
      try {
        const stat = await file.stat()
        if (!stat.isFile() || stat.size > 256 * 1024) throw new Error('技能文件不可读取')
        const bytes = await file.readFile()
        if (bytes.byteLength !== stat.size) throw new Error('技能文件已变更，请重试核对')
        skillSha256 = createHash('sha256').update(bytes).digest('hex')
      } finally { await file.close() }
      let portableTrial = false
      try { portableTrial = (await readGenericOrderSource(skill.path)).declaration.schema === 'qianshou.local-adapter-candidate.v3' }
      catch { /* A saved instruction or unsupported runtime has no portable trial declaration. */ }
      exec.signal.throwIfAborted()
      return JSON.stringify({ state: 'saved', path: skill.path, skillSha256, platformContacted: false, actions: {
        protocol: 'qianshou.skill-actions.v1', state: 'saved', source: skill.source, name: skill.name,
        displayName: skill.displayName, skillSha256, portableTrial,
      } })
    },
    presentCall: args => ({ card: 'generic', title: `技能已保存 · ${args.name}`, kind: 'read' }),
  }))
  ctx.tools.register(defineTool({
    name: 'qianshou_try_local_skill',
    description: '试用已保存的千手通用技能。只选择“我的技能”中的来源和命令名，输入 JSON；Host 自动核对运行包、隔离运行样例，再执行本次输入并返回真实结果。无需登录、安装原生插件或开启接单。不会发布、扣费或访问网络及其他文件。创建新可执行能力后，用它完成真实试用。',
    parameters: {
      source: { type: 'string', required: true, enum: ['user-dsh', 'user-agents'], description: '我的技能清单中的来源' },
      name: { type: 'string', required: true, description: '已保存技能的英文命令名' },
      inputJson: { type: 'string', required: true, description: '符合该技能输入说明的 JSON 字符串，最多 64 KiB' },
    },
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }],
      presentationMeta: (_args, value) => (JSON.parse(value) as { actions: Record<string, string | boolean> }).actions },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      exec.signal.throwIfAborted()
      let result: Awaited<ReturnType<typeof ctx.qianshouPluginCatalog.tryInstalledOrderSkill>>
      try {
        result = await ctx.qianshouPluginCatalog.tryInstalledOrderSkill({
          source: args.source, name: args.name, inputJson: args.inputJson,
        })
      } catch (error) {
        const rejection = localOrderSourceRejection(error)
        if (rejection === null) throw error
        throw new Error(JSON.stringify(rejection))
      }
      exec.signal.throwIfAborted()
      const { outputJson, ...receipt } = result
      return JSON.stringify({ ...receipt, output: JSON.parse(outputJson) as unknown, actions: {
        protocol: 'qianshou.skill-actions.v1', state: 'local-trial', source: args.source, name: args.name,
        portableTrial: true, artifactDigest: result.artifactDigest,
      } })
    },
    presentCall: args => ({ card: 'generic', title: `试用技能 · ${args.name}`, kind: 'execute' }),
  }))
}

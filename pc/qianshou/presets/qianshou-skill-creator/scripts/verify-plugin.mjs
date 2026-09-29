/** Verify an authored local tool bundle against its declared contract and golden samples. */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, readFile, realpath } from 'node:fs/promises'
import { basename, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { isDeepStrictEqual } from 'node:util'

const self = fileURLToPath(import.meta.url)
const categories = new Set(['text', 'image', 'video', 'ppt', 'spreadsheet', 'research', 'development', 'automation', 'design', 'data', 'other'])
const types = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key)
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value)
const fail = message => { throw new Error(message) }

function schema(schemaValue, label, depth = 0) {
  if (!object(schemaValue) || depth > 8 || !types.has(schemaValue.type)) fail(`${label}: invalid schema`)
  if (Object.keys(schemaValue).some(key => !['type', 'description', 'properties', 'required', 'additionalProperties', 'items'].includes(key))) fail(`${label}: unsupported schema keyword`)
  if (schemaValue.type === 'object') {
    if (!object(schemaValue.properties) || !Array.isArray(schemaValue.required) || schemaValue.additionalProperties !== false) fail(`${label}: object schema must be closed`)
    if (Object.keys(schemaValue.properties).length > 64 || schemaValue.required.some(key => !own(schemaValue.properties, key))) fail(`${label}: invalid properties`)
    for (const [key, child] of Object.entries(schemaValue.properties)) schema(child, `${label}.${key}`, depth + 1)
  } else if (schemaValue.type === 'array') {
    if (!own(schemaValue, 'items')) fail(`${label}: array items missing`)
    schema(schemaValue.items, `${label}[]`, depth + 1)
  } else if (own(schemaValue, 'properties') || own(schemaValue, 'required') || own(schemaValue, 'items')) fail(`${label}: invalid scalar schema`)
}

function matches(value, shape) {
  switch (shape.type) {
    case 'null': return value === null
    case 'string': return typeof value === 'string'
    case 'boolean': return typeof value === 'boolean'
    case 'number': return typeof value === 'number' && Number.isFinite(value)
    case 'integer': return Number.isSafeInteger(value)
    case 'array': return Array.isArray(value) && value.every(item => matches(item, shape.items))
    case 'object': return object(value) && Object.keys(value).every(key => own(shape.properties, key))
      && shape.required.every(key => own(value, key))
      && Object.entries(value).every(([key, item]) => matches(item, shape.properties[key]))
    default: return false
  }
}

async function inspect(root) {
  if (!isAbsolute(root) || (await lstat(root)).isSymbolicLink()) fail('bundle path must be an absolute, non-symlink directory')
  const directory = await realpath(root)
  const packageText = await readFile(join(directory, 'package.json'), 'utf8')
  const manifest = JSON.parse(packageText)
  if (typeof manifest.name !== 'string' || !/^[a-z0-9@/._-]+$/u.test(manifest.name)
    || typeof manifest.version !== 'string' || manifest.type !== 'module' || typeof manifest.main !== 'string'
    || !manifest.dsh?.bundle?.patch) fail('invalid DSH bundle manifest')
  for (const path of [manifest.main, manifest.dsh.bundle.patch]) {
    if (isAbsolute(path) || path.split('/').some(part => part === '..')) fail('bundle entry escapes its directory')
    const actual = await realpath(join(directory, path))
    if (!actual.startsWith(`${directory}/`)) fail('bundle entry escapes its directory')
  }
  const patchText = await readFile(join(directory, manifest.dsh.bundle.patch), 'utf8')
  if (!patchText.includes(`name: ${manifest.name}`) && !patchText.includes(`name: '${manifest.name}'`)) fail('bundle patch does not insert package')
  const contractText = await readFile(join(directory, 'qianshou.contract.json'), 'utf8')
  const contract = JSON.parse(contractText)
  if (contract.version !== 1 || typeof contract.displayName !== 'string' || !contract.displayName.trim()
    || !categories.has(contract.category) || !Array.isArray(contract.permissions)
    || !Array.isArray(contract.networkOrigins) || !['none', 'workspace', 'task-inputs'].includes(contract.dataScope)
    || !Array.isArray(contract.operations) || contract.operations.length < 1 || contract.operations.length > 12) fail('invalid Qianshou contract')
  const seen = new Set()
  for (const operation of contract.operations) {
    if (!object(operation) || typeof operation.toolName !== 'string' || !/^[a-z][a-z0-9_]{2,100}$/u.test(operation.toolName)
      || seen.has(operation.toolName)) fail('invalid or duplicate toolName')
    seen.add(operation.toolName)
    schema(operation.inputSchema, `${operation.toolName}.input`)
    schema(operation.outputSchema, `${operation.toolName}.output`)
    if (operation.inputSchema.type !== 'object' || operation.outputSchema.type !== 'object'
      || !Number.isSafeInteger(operation.maxInputBytes) || operation.maxInputBytes < 1
      || !Number.isSafeInteger(operation.maxOutputBytes) || operation.maxOutputBytes < 1
      || !Number.isSafeInteger(operation.maxRunMs) || operation.maxRunMs < 1 || operation.maxRunMs > 30_000
      || !Array.isArray(operation.samples) || operation.samples.length < 2 || operation.samples.length > 24
      || operation.samples.some(sample => !object(sample))
      || !operation.samples.some(sample => own(sample, 'expected'))
      || !operation.samples.some(sample => own(sample, 'error'))) fail(`${operation.toolName}: missing bounded success and rejection samples`)
    for (const sample of operation.samples) {
      if (!object(sample) || typeof sample.name !== 'string' || !sample.name.trim() || !own(sample, 'input')
        || own(sample, 'expected') === own(sample, 'error')) fail(`${operation.toolName}: invalid sample`)
      if (own(sample, 'expected') && (!matches(sample.input, operation.inputSchema)
        || !matches(sample.expected, operation.outputSchema))) fail(`${operation.toolName}: sample violates declared schema`)
      if (own(sample, 'error') && (typeof sample.error !== 'string' || !sample.error.trim())) fail(`${operation.toolName}: invalid rejection sample`)
    }
  }
  const source = await readFile(join(directory, manifest.main), 'utf8')
  return { directory, manifest, contract, digest: createHash('sha256').update(packageText).update(patchText).update(contractText).update(source).digest('hex') }
}

async function worker(root) {
  const { directory, manifest, contract, digest } = await inspect(root)
  const module = await import(pathToFileURL(join(directory, manifest.main)).href)
  if (module.name !== manifest.name || !Array.isArray(module.inject) || module.inject.length !== 1
    || module.inject[0] !== 'tools' || typeof module.apply !== 'function') fail('plugin entry does not export a tools-only Host plugin')
  const registered = new Map()
  const ctx = { effect: register => register(), tools: { register: definition => {
    if (!object(definition) || registered.has(definition.name)) fail('invalid or duplicate tool registration')
    registered.set(definition.name, definition)
    return () => registered.delete(definition.name)
  } } }
  await module.apply(ctx)
  if (registered.size !== contract.operations.length) fail('registered tool count differs from contract')
  let count = 0
  for (const operation of contract.operations) {
    const tool = registered.get(operation.toolName)
    if (!tool || typeof tool.execute !== 'function' || !isDeepStrictEqual(tool.parameters, operation.inputSchema)) fail(`${operation.toolName}: tool schema differs from contract`)
    for (const sample of operation.samples) {
      const bytes = Buffer.byteLength(JSON.stringify(sample.input))
      if (bytes > operation.maxInputBytes) fail(`${operation.toolName}/${sample.name}: sample exceeds maxInputBytes`)
      const exec = { signal: new AbortController().signal }
      let raw
      let thrown
      try { raw = await tool.execute(sample.input, exec) } catch (error) { thrown = error }
      if (own(sample, 'error')) {
        if (thrown === undefined || !String(thrown?.message).includes(sample.error)) fail(`${operation.toolName}/${sample.name}: expected rejection ${sample.error}`)
      } else {
        if (thrown !== undefined) throw thrown
        const output = typeof raw === 'string' ? JSON.parse(raw) : raw
        if (Buffer.byteLength(JSON.stringify(output)) > operation.maxOutputBytes
          || !matches(output, operation.outputSchema) || !isDeepStrictEqual(output, sample.expected)) fail(`${operation.toolName}/${sample.name}: output differs from golden sample`)
      }
      count++
    }
  }
  return { status: 'passed', packageName: manifest.name, version: manifest.version,
    toolNames: [...registered.keys()], samplesPassed: count, packageDigest: digest,
    scope: 'local-contract-and-samples' }
}

async function main() {
  if (process.argv[2] === '--worker') {
    process.stdout.write(JSON.stringify(await worker(process.argv[3])) + '\n')
    return
  }
  const bundle = process.argv[2]
  if (!bundle) fail(`usage: node ${basename(self)} <absolute-bundle-directory>`)
  const { directory: root } = await inspect(resolve(bundle))
  const args = ['--permission', `--allow-fs-read=${root}`, `--allow-fs-read=${self}`,
    self, '--worker', root]
  const child = spawn(process.execPath, args, { cwd: root, env: { NODE_ENV: 'test', TZ: 'UTC' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let stdout = ''
  let stderr = ''
  const timeout = setTimeout(() => child.kill('SIGKILL'), 35_000)
  child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk.slice(0, Math.max(0, 64_000 - stdout.length)) })
  child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk.slice(0, Math.max(0, 16_000 - stderr.length)) })
  const code = await new Promise((accept, reject) => { child.on('error', reject); child.on('close', accept) })
  clearTimeout(timeout)
  if (code !== 0) fail(`plugin self-test failed (${code}): ${stderr.trim() || stdout.trim()}`)
  process.stdout.write(stdout)
}

main().catch(error => { process.stderr.write(`${error.message}\n`); process.exitCode = 1 })

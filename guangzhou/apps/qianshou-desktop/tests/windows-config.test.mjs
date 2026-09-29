import assert from 'node:assert/strict'
import test from 'node:test'
import { backendEnvironment, resolveConfig, resolvePackagedConfig } from '../config.mjs'

test('Windows bundle relocation uses node.exe and preserves paths with spaces and Chinese characters', () => {
  const resources = 'D:\\应用程序\\千手智能体\\resources'
  const userHome = 'C:\\Users\\测试 用户'
  const config = resolvePackagedConfig(resources, { sourcePath: 'C:\\old\\source', nodePath: 'C:\\old\\node' }, { Path: 'C:\\Windows\\System32;C:\\Program Files\\Git\\cmd' }, userHome, 'win32')
  assert.equal(config.nodePath, resources + '\\runtime\\node\\node.exe')
  assert.equal(config.cliPath, resources + '\\dsh\\lib\\bin.js')
  assert.equal(config.home, userHome + '\\.local\\share\\qianshou-agent\\home')
  assert.equal(config.workingDirectory, userHome)
  assert.deepEqual(config.path.split(';'), [resources + '\\runtime\\bin', resources + '\\runtime\\node', 'C:\\Windows\\System32', 'C:\\Program Files\\Git\\cmd'])
  assert.equal(config.path.includes('old'), false)
})

test('Windows child has exactly one PATH and cannot inherit differently cased Node switches', () => {
  const config = resolveConfig({}, { Path: 'C:\\Windows\\System32' }, 'C:\\Users\\person', 'win32')
  const env = backendEnvironment(config, { Path: 'C:\\old', PATH: 'C:\\another', SystemRoot: 'C:\\Windows', node_options: '--inspect', Electron_Run_As_Node: '1', api_key: 'fixture' }, 'win32')
  assert.deepEqual(Object.keys(env).filter(key => key.toUpperCase() === 'PATH'), ['PATH'])
  assert.equal(env.PATH, config.path)
  assert.equal(env.SystemRoot, 'C:\\Windows')
  assert.equal(env.node_options, undefined)
  assert.equal(env.Electron_Run_As_Node, undefined)
  assert.equal(env.api_key, undefined)
})

test('Windows bundle rejects relative resources and invalid data directories before spawn', () => {
  assert.throws(() => resolvePackagedConfig('relative\\resources', {}, {}, 'C:\\Users\\person', 'win32'), /INVALID_CONFIG/)
  assert.throws(() => resolvePackagedConfig('C:\\app\\resources', { home: '..\\shared' }, {}, 'C:\\Users\\person', 'win32'), /INVALID_CONFIG/)
})

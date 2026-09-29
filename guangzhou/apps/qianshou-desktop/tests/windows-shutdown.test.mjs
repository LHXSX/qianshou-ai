import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { createServer } from 'node:net'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startBackend } from '../backend.mjs'

// These exercise Windows shutdown sequencing around a real child; taskkill is
// an explicit adapter, so this evidence does not claim native Windows execution.
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'qianshou-windows-stop-'))
  const source = join(root, 'source/apps/cli/lib')
  mkdirSync(source, { recursive: true })
  const listener = createServer()
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve))
  const port = listener.address().port
  await new Promise(resolve => listener.close(resolve))
  writeFileSync(join(source, 'bin.js'), `console.log('dsh web: http://127.0.0.1:${port}/?token=fixture');setInterval(()=>{},1000)`)
  const config = { sourcePath: join(root, 'source'), nodePath: process.execPath, home: join(root, 'home'), host: '127.0.0.1', port, startupTimeoutMs: 2000 }
  return { root, config }
}

for (const result of [0, 5, 'error']) {
  test(`Windows shutdown waits for the tree helper and reports its ${result} outcome`, async () => {
    const value = await fixture()
    let leader
    let helper
    let service
    try {
      service = await startBackend(value.config, () => {}, { platform: 'win32', spawn(command, args, options) {
        if (command === process.execPath) { leader = spawn(command, args, options); return leader }
        assert.ok(command.endsWith('taskkill.exe'))
        assert.deepEqual(args, ['/PID', String(leader.pid), '/T', '/F'])
        assert.equal(options.windowsHide, true)
        helper = new EventEmitter()
        helper.kill = () => true
        if (result === 0) leader.kill('SIGKILL')
        return helper
      } })
      await service.url
      let stopped = false
      const stopping = service.stop().then(() => { stopped = true })
      void stopping.catch(() => {})
      if (result === 0) await service.done
      await new Promise(resolve => setImmediate(resolve))
      assert.equal(stopped, false, 'leader exit must not finish the pending tree helper')
      if (result === 'error') helper.emit('error', new Error('fixture unavailable'))
      else helper.emit('close', result)
      if (result === 0) await stopping
      else {
        await assert.rejects(stopping, /WINDOWS_TREE_STOP_UNCONFIRMED/)
        assert.match(readFileSync(service.logPath, 'utf8'), /WINDOWS_TREE_STOP_UNCONFIRMED/)
      }
      assert.throws(() => process.kill(service.pid, 0), { code: 'ESRCH' })
    } finally {
      await service?.stop().catch(() => {})
      if (leader && leader.exitCode === null && leader.signalCode === null) leader.kill('SIGKILL')
      rmSync(value.root, { recursive: true, force: true })
    }
  })
}

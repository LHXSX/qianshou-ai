import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { expect, it } from 'vitest'

const exec = promisify(execFile)
const pythonCases = [
  'test_configured_output_directory_works_without_any_original_machine_path',
  'test_output_symlink_and_foreign_root_are_refused',
  'test_bound_reads_refuse_empty_oversized_and_symbolic_files',
  'test_fixed_recipe_uses_actual_frame_and_negative_bytes',
  'test_a_done_flag_does_not_substitute_for_this_job_identity',
  'test_real_generation_protocol_uses_expected_tuple_and_own_paths',
  'test_adapter_output_replacement_cannot_change_encoding_source',
  'test_missing_owner_output_root_and_wrong_actual_recipe_never_submit_a_gpu_job',
  'test_buyer_cannot_override_machine_config_or_use_developer_escape',
  'test_local_entry_forwards_only_matching_job_identity',
  'test_loopback_http_is_bounded_and_refuses_redirects_and_remote_endpoints',
  'test_self_test_is_pinned_to_real_runtime_bytes',
] as const

it('executes the entire Python stdlib H3 protocol suite without GPU, external services or owner data', async () => {
  const qaRoot = process.env.QIANSHOU_TEST_TMPDIR ?? tmpdir()
  await mkdir(qaRoot, { recursive: true })
  const temporary = await mkdtemp(join(qaRoot, 'h3-python-protocol-'))
  const script = fileURLToPath(new URL('./h3-runtime-protocol.test.py', import.meta.url))
  const python = process.env.QIANSHOU_TEST_PYTHON ?? (process.platform === 'win32' ? 'python' : 'python3')
  try {
    const { stdout, stderr } = await exec(python, ['-I', '-B', script, '-v'], {
      cwd: temporary, encoding: 'utf8', timeout: 15_000, maxBuffer: 64 * 1024, windowsHide: true,
      env: { PATH: process.env.PATH, SYSTEMROOT: process.env.SYSTEMROOT, LANG: 'C.UTF-8',
        TEMP: temporary, TMP: temporary, TMPDIR: temporary },
    })
    expect(stdout).toBe('')
    for (const name of pythonCases) expect(stderr).toMatch(new RegExp(`^${name} \\(.*\\) \\.\\.\\. ok$`, 'm'))
    const count = /^Ran (\d+) tests in /mu.exec(stderr)
    expect(count).not.toBeNull()
    expect(Number(count?.[1])).toBeGreaterThanOrEqual(pythonCases.length)
    expect(stderr.trim().endsWith('\nOK')).toBe(true)
  } finally { await rm(temporary, { recursive: true, force: true }) }
}, 20_000)

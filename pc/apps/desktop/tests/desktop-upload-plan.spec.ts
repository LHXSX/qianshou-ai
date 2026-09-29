import { createHash, generateKeyPairSync, sign } from 'node:crypto'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { load } from 'js-yaml'
import { createDesktopUploadPlan } from '../scripts/desktop-upload-plan.ts'
import { desktopUpdateMetadataFilename } from '../scripts/desktop-auto-update-environment.mjs'
import { qianshouReleaseAcceptanceMessage } from '../scripts/qianshou-release-acceptance.ts'
import type { DesktopPackageTargetName } from '../scripts/package-target.ts'

const temporaryDirectories: string[] = []
const TEST_ORIGIN = 'https://desktop-updates.example.com'
const TEST_BUCKET = 'test-download-bucket'
const PRODUCTION_BUCKET = 'production-download-bucket'
const require = createRequire(import.meta.url)
const { createBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder.js') as {
  createBlockmap: (file: string, target: object, packager: { info: { emitArtifactBuildCompleted(event: object): Promise<void> } },
    safeArtifactName: string) => Promise<{ size: number; sha512: string }>
}

interface Fixture {
  readonly repositoryRoot: string
  readonly appRoot: string
  readonly artifactsRoot: string
  readonly environment: NodeJS.ProcessEnv
}

function digest(contents: string): string {
  return createHash('sha512').update(contents).digest('base64')
}

async function fixture(
  target: DesktopPackageTargetName,
  version = '1.2.3',
  environment: 'test' | 'production' = 'test',
  product: 'dsh' | 'qianshou' = 'dsh',
): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), 'dsh-desktop-upload-'))
  temporaryDirectories.push(root)
  const repositoryRoot = join(root, 'repository')
  const appRoot = join(repositoryRoot, 'apps', 'desktop')
  const artifactsRoot = join(appRoot, '.desktop-build', 'artifacts')
  await mkdir(artifactsRoot, { recursive: true })
  await writeFile(join(repositoryRoot, 'package.json'), `${JSON.stringify({ version })}\n`)
  await writeFile(join(appRoot, 'package.json'), `${JSON.stringify({ version })}\n`)

  const [os, arch] = target.split('-') as ['mac' | 'win', 'arm64' | 'x64']
  const base = `${product === 'qianshou' ? 'qianshou' : 'deepseek-harness'}-${version}-${os}-${arch}`
  const origin = product === 'qianshou' ? 'https://qianshousuanli.com' : environment === 'test'
    ? TEST_ORIGIN
    : 'https://download.deepseek.com'
  const namespace = product === 'qianshou' ? 'qianshou-desktop' : 'dsh-desk'
  await writeFile(join(artifactsRoot, `${target}-release.json`), `${JSON.stringify({
    schemaVersion: 1,
    target,
    version,
    environment,
    publicUrl: `${origin}/${namespace}/feeds/${target}/`,
  })}\n`)

  if (os === 'mac') {
    const zip = 'signed macOS ZIP fixture'
    await writeFile(join(artifactsRoot, `${base}.zip`), zip)
    await writeFile(join(artifactsRoot, `${base}.zip.blockmap`), 'blockmap')
    await writeFile(join(artifactsRoot, `${base}.dmg`), 'notarized DMG fixture')
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'darwin')), `${JSON.stringify({
      version,
      files: [{ url: `${base}.zip`, size: Buffer.byteLength(zip), sha512: digest(zip) }],
    })}\n`)
  }
  else {
    const executable = 'signed NSIS executable fixture'
    await writeFile(join(artifactsRoot, `${base}.exe`), executable)
    const info = await createBlockmap(join(artifactsRoot, `${base}.exe`), {},
      { info: { emitArtifactBuildCompleted: async () => {} } }, `${base}.exe`)
    expect(Object.hasOwn(info, 'blockMapSize')).toBe(false)
    await writeFile(join(artifactsRoot, desktopUpdateMetadataFilename(version, 'win32')), `${JSON.stringify({
      version,
      files: [{
        url: `${base}.exe`,
        ...info,
      }],
    })}\n`)
  }
  return {
    repositoryRoot,
    appRoot,
    artifactsRoot,
    environment: product === 'qianshou' ? {
      DSH_CLIENT_BUILD_PROFILE: 'qianshou', DSH_DESKTOP_AUTO_UPDATE_ENV: environment,
      ...(environment === 'test' ? {
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: origin,
        QIANSHOU_DESKTOP_UPDATE_TEST_COS_BUCKET: 'qianshou-test',
      } : {
        QIANSHOU_DESKTOP_UPDATE_PROD_ORIGIN: origin,
        QIANSHOU_DESKTOP_UPDATE_PROD_COS_BUCKET: 'qianshou-production',
      }),
    } : environment === 'test'
      ? {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DOWNLOAD_TEST_ORIGIN: TEST_ORIGIN,
        DOWNLOAD_TEST_COS_BUCKET: TEST_BUCKET,
      }
      : {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'production',
        DOWNLOAD_PROD_COS_BUCKET: PRODUCTION_BUCKET,
      },
  }
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(async path => rm(path, {
    recursive: true,
    force: true,
  })))
})

describe('desktop upload plan', () => {
  it('publishes Qianshou installer and fixed feed only in its own namespace', async () => {
    const paths = await fixture('win-x64', '1.2.3', 'test', 'qianshou')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan).toMatchObject({ bucket: 'qianshou-test',
      publicUrl: 'https://qianshousuanli.com/qianshou-desktop/feeds/win-x64/' })
    expect(plan.artifacts.map(artifact => artifact.key)).toEqual([
      'qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe',
      'qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe.blockmap',
      'qianshou-desktop/feeds/win-x64/nightly.yml',
      'qianshou-desktop/feeds/win-x64/latest.yml',
    ])
    expect(load(plan.artifacts[2]!.contents!)).toMatchObject({
      files: [{ url: 'https://qianshousuanli.com/qianshou-desktop/bin/win-x64/qianshou-1.2.3-win-x64.exe' }],
    })
  })

  it('refuses Qianshou production feed publication before a signed installed-device release gate exists', async () => {
    const paths = await fixture('win-x64', '1.2.3', 'production', 'qianshou')
    await expect(createDesktopUploadPlan('win-x64', paths)).rejects.toThrow(/requires signed-installer and installed-device acceptance/u)
    const readback = await createDesktopUploadPlan('win-x64', { ...paths, purpose: 'public-readback' })
    expect(readback).toMatchObject({ environment: 'production', target: 'win-x64', version: '1.2.3' })
  })

  it.each(['win-x64', 'mac-arm64'] as const)('accepts %s production upload only with independent device evidence bound to both release payloads', async (target) => {
    const paths = await fixture(target, '1.2.3', 'production', 'qianshou')
    const { publicKey, privateKey } = generateKeyPairSync('ed25519')
    const evidence = join(paths.artifactsRoot, 'target-device-evidence.json')
    const receipt = join(paths.artifactsRoot, 'acceptance.json')
    const key = join(paths.artifactsRoot, 'reviewer.pub')
    const evidenceBytes = JSON.stringify({ target, version: '1.2.3', result: 'installed and launched on target' })
    await writeFile(evidence, evidenceBytes)
    await writeFile(key, publicKey.export({ format: 'pem', type: 'spki' }))
    const updater = target === 'win-x64' ? 'signed NSIS executable fixture' : 'signed macOS ZIP fixture'
    const installer = target === 'win-x64' ? updater : 'notarized DMG fixture'
    const message = qianshouReleaseAcceptanceMessage({
      target, version: '1.2.3',
      updaterSha512: digest(updater), installerSha512: digest(installer),
      evidenceSha256: createHash('sha256').update(evidenceBytes).digest('hex'),
      verifiedAt: new Date().toISOString(),
    })
    await writeFile(receipt, `${JSON.stringify({
      ...JSON.parse(message.toString('utf8')), signature: sign(null, message, privateKey).toString('base64'),
    })}\n`)
    const options = { ...paths, qianshouAcceptance: { receipt, evidence, publicKey: key } }
    expect((await createDesktopUploadPlan(target, options)).version).toBe('1.2.3')

    const validReceipt = JSON.parse(message.toString('utf8')) as {
      schemaVersion: number
      checks: Record<string, boolean>
    }
    for (const check of ['freshHomeAgentStartup', 'retainedHomeAgentStartup', 'expiredLoginRecovery']) {
      const incomplete = { ...validReceipt, checks: { ...validReceipt.checks, [check]: false } }
      const incompleteMessage = Buffer.from(JSON.stringify(incomplete))
      await writeFile(receipt, JSON.stringify({ ...incomplete,
        signature: sign(null, incompleteMessage, privateKey).toString('base64') }))
      await expect(createDesktopUploadPlan(target, options)).rejects.toThrow(/evidence, or checks do not match/u)
    }
    const oldChecks = Object.fromEntries(Object.entries(validReceipt.checks).filter(([check]) =>
      !['freshHomeAgentStartup', 'retainedHomeAgentStartup', 'expiredLoginRecovery'].includes(check)))
    const legacy = { ...validReceipt, schemaVersion: 1, checks: oldChecks }
    await writeFile(receipt, JSON.stringify({ ...legacy,
      signature: sign(null, Buffer.from(JSON.stringify(legacy)), privateKey).toString('base64') }))
    await expect(createDesktopUploadPlan(target, options)).rejects.toThrow(/evidence, or checks do not match/u)
    await writeFile(receipt, JSON.stringify({ ...validReceipt, signature: sign(null, message, privateKey).toString('base64') }))

    await writeFile(evidence, `${evidenceBytes}modified`)
    await expect(createDesktopUploadPlan(target, options)).rejects.toThrow(/evidence, or checks do not match/u)
    await writeFile(evidence, evidenceBytes)
    const outsider = generateKeyPairSync('ed25519').publicKey
    await writeFile(key, outsider.export({ format: 'pem', type: 'spki' }))
    await expect(createDesktopUploadPlan(target, options)).rejects.toThrow(/reviewer signature is invalid/u)
    await writeFile(key, publicKey.export({ format: 'pem', type: 'spki' }))
    if (target === 'mac-arm64') {
      await writeFile(join(paths.artifactsRoot, 'qianshou-1.2.3-mac-arm64.dmg'), 'different signed DMG')
      await expect(createDesktopUploadPlan(target, options)).rejects.toThrow(/evidence, or checks do not match/u)
    }
  })

  it('rejects a DSH package record when the operator selects Qianshou upload', async () => {
    const paths = await fixture('win-x64')
    await expect(createDesktopUploadPlan('win-x64', { ...paths,
      environment: { DSH_CLIENT_BUILD_PROFILE: 'qianshou',
        QIANSHOU_DESKTOP_UPDATE_TEST_ORIGIN: 'https://qianshousuanli.com',
        QIANSHOU_DESKTOP_UPDATE_TEST_COS_BUCKET: 'qianshou-test' },
    })).rejects.toThrow(/package completion record does not match/u)
  })

  it('publishes fixed feeds referencing versioned binaries without overriding CDN cache policy', async () => {
    const paths = await fixture('win-x64', '1.2.3', 'production')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan.artifacts.map(artifact => artifact.key)).toEqual([
      'dsh-desk/bin/win-x64/deepseek-harness-1.2.3-win-x64.exe',
      'dsh-desk/bin/win-x64/deepseek-harness-1.2.3-win-x64.exe.blockmap',
      'dsh-desk/feeds/win-x64/nightly.yml',
      'dsh-desk/feeds/win-x64/latest.yml',
    ])
    expect(load(plan.artifacts[2]!.contents!)).toMatchObject({
      version: '1.2.3',
      files: [{
        url: 'https://download.deepseek.com/dsh-desk/bin/win-x64/deepseek-harness-1.2.3-win-x64.exe',
        sha512: digest('signed NSIS executable fixture'),
      }],
    })
    expect(plan.artifacts[2]!.contents).toBe(plan.artifacts[3]!.contents)
    expect(plan.artifacts.every(artifact => !('cacheControl' in artifact))).toBe(true)
  })

  it('validates macOS artifacts and puts channel metadata last', async () => {
    const paths = await fixture('mac-arm64')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan).toMatchObject({
      environment: 'test',
      version: '1.2.3',
      publicUrl: 'https://desktop-updates.example.com/dsh-desk/feeds/mac-arm64/',
      bucket: TEST_BUCKET,
    })
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'deepseek-harness-1.2.3-mac-arm64.dmg',
      'deepseek-harness-1.2.3-mac-arm64.zip',
      'deepseek-harness-1.2.3-mac-arm64.zip.blockmap',
      'nightly-mac.yml',
      'latest-mac.yml',
    ])
    expect(plan.artifacts.at(-1)).toMatchObject({
      channelMetadata: true,
    })
  })

  it('uploads the prerelease channel metadata emitted by electron-builder', async () => {
    const paths = await fixture('mac-arm64', '1.2.3-alpha.4')
    const plan = await createDesktopUploadPlan('mac-arm64', paths)
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.dmg',
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.zip',
      'deepseek-harness-1.2.3-alpha.4-mac-arm64.zip.blockmap',
      'nightly-mac.yml',
    ])
  })

  it('validates the Windows installer with the emitted external blockmap and production destination', async () => {
    const paths = await fixture('win-x64', '2.0.0', 'production')
    const plan = await createDesktopUploadPlan('win-x64', paths)
    expect(plan.artifacts.map(artifact => artifact.filename)).toEqual([
      'deepseek-harness-2.0.0-win-x64.exe',
      'deepseek-harness-2.0.0-win-x64.exe.blockmap',
      'nightly.yml',
      'latest.yml',
    ])
    expect(plan).toMatchObject({
      publicUrl: 'https://download.deepseek.com/dsh-desk/feeds/win-x64/',
      bucket: PRODUCTION_BUCKET,
    })
  })

  it.each(['missing', 'empty'])('rejects a %s Windows blockmap before publishing its feed', async (condition) => {
    const paths = await fixture('win-x64')
    const path = join(paths.artifactsRoot, 'deepseek-harness-1.2.3-win-x64.exe.blockmap')
    if (condition === 'missing') await rm(path)
    else await writeFile(path, '')
    await expect(createDesktopUploadPlan('win-x64', paths)).rejects.toThrow(/missing or empty artifact.*\.exe\.blockmap/u)
  })

  it('rejects a completed build from another dsh version or deployment', async () => {
    const paths = await fixture('mac-x64')
    await writeFile(join(paths.repositoryRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await writeFile(join(paths.appRoot, 'package.json'), '{"version":"1.2.4"}\n')
    await expect(createDesktopUploadPlan('mac-x64', paths)).rejects.toThrow(/completion record.*1\.2\.4/u)

    const productionPaths = await fixture('mac-x64', '1.2.3', 'production')
    await expect(createDesktopUploadPlan('mac-x64', {
      ...productionPaths,
      environment: {
        DSH_DESKTOP_AUTO_UPDATE_ENV: 'test',
        DOWNLOAD_TEST_ORIGIN: TEST_ORIGIN,
        DOWNLOAD_TEST_COS_BUCKET: TEST_BUCKET,
      },
    })).rejects.toThrow(/completion record.*test/u)
  })

  it('rejects stale architecture metadata and modified updater bytes', async () => {
    const paths = await fixture('mac-arm64')
    const metadataPath = join(paths.artifactsRoot, 'nightly-mac.yml')
    const zipPath = join(paths.artifactsRoot, 'deepseek-harness-1.2.3-mac-arm64.zip')
    await writeFile(zipPath, 'modified')
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/size.*metadata/u)

    const x64 = 'wrong architecture'
    await writeFile(metadataPath, `${JSON.stringify({
      version: '1.2.3',
      files: [{
        url: 'deepseek-harness-1.2.3-mac-x64.zip',
        size: Buffer.byteLength(x64),
        sha512: digest(x64),
      }],
    })}\n`)
    await expect(createDesktopUploadPlan('mac-arm64', paths)).rejects.toThrow(/mac-arm64\.zip/u)
  })
})

// SPDX-FileCopyrightText: 2025 ayangweb
// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: MIT AND PolyForm-Noncommercial-1.0.0

import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { arch, argv, pid, platform } from 'node:process'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const rootDir = resolve(__dirname, '..')
const targetIndex = argv.indexOf('--target')
const target = targetIndex === -1 ? undefined : argv[targetIndex + 1]
const targetDir = target ? resolve(rootDir, 'target', target) : resolve(rootDir, 'target')
const releaseDir = resolve(targetDir, 'release')
const bundleDir = resolve(releaseDir, 'bundle', 'portable')
const portableConfigPath = resolve(rootDir, 'target', 'portable-tauri.conf.json')
const tauriCliPath = resolve(rootDir, 'node_modules', '.bin', 'tauri.CMD')
const sourceAssetsDir = resolve(rootDir, 'src-tauri', 'assets')
const packageJson = JSON.parse(readFileSync(resolve(rootDir, 'package.json'), 'utf-8'))
const tauriConfig = JSON.parse(readFileSync(resolve(rootDir, 'src-tauri', 'tauri.conf.json'), 'utf-8'))
const productName = tauriConfig.productName ?? packageJson.name
const binaryName = `${productName.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '')}.exe`
const exePath = resolve(releaseDir, binaryName)
const legacyExePath = resolve(releaseDir, `${packageJson.name}.exe`)
const stageRootDir = resolve(tmpdir(), `${packageJson.name}-portable-${pid}`)
const stageDir = resolve(stageRootDir, productName)
const archiveName = `${productName}_${packageJson.version}_windows_${arch}_portable.zip`
const archivePath = resolve(bundleDir, archiveName)
const skipBuild = argv.includes('--skip-build')

if (targetIndex !== -1 && !target) {
  throw new Error('The --target option requires a Rust target triple.')
}

function quotePowerShell(value) {
  return `'${value.replace(/'/g, '\'\'')}'`
}

function quoteCommand(value) {
  return `"${value.replace(/"/g, '\\"')}"`
}

function run(command, options = {}) {
  const result = spawnSync(command, {
    cwd: rootDir,
    shell: true,
    stdio: 'inherit',
  })

  if (result.status && !options.allowFailure) {
    throw new Error(`Command failed with exit code ${result.status}: ${command}`)
  }

  if (result.error && !options.allowFailure) {
    throw result.error
  }

  return result
}

function runPowerShell(command) {
  return runFile('powershell.exe', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-Command',
    command,
  ])
}

function copyIfExists(from, to) {
  if (!existsSync(from)) return

  mkdirSync(dirname(to), { recursive: true })
  runPowerShell(`Copy-Item -LiteralPath ${quotePowerShell(from)} -Destination ${quotePowerShell(to)} -Recurse -Force`)
}

function runFile(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: rootDir,
    stdio: 'inherit',
  })

  if (result.status && !options.allowFailure) {
    throw new Error(`Command failed with exit code ${result.status}: ${command}`)
  }

  if (result.error && !options.allowFailure) {
    throw result.error
  }

  return result
}

if (platform !== 'win32') {
  throw new Error('Portable zip packaging is currently configured for Windows builds only.')
}

mkdirSync(dirname(portableConfigPath), { recursive: true })
writeFileSync(portableConfigPath, JSON.stringify({
  build: {
    beforeBuildCommand: 'pnpm build:vite',
  },
}, null, 2))

if (!skipBuild) {
  rmSync(exePath, { force: true })
  rmSync(legacyExePath, { force: true })
  const targetArg = target ? ` --target ${quoteCommand(target)}` : ''
  run(`${quoteCommand(tauriCliPath)} build --no-bundle${targetArg} --config ${quoteCommand(portableConfigPath)}`)
}

const builtExePath = existsSync(exePath) ? exePath : legacyExePath

if (!existsSync(builtExePath)) {
  throw new Error(`Release executable was not found: ${exePath}`)
}

mkdirSync(bundleDir, { recursive: true })
mkdirSync(stageDir, { recursive: true })

runPowerShell(`Copy-Item -LiteralPath ${quotePowerShell(builtExePath)} -Destination ${quotePowerShell(resolve(stageDir, `${productName}.exe`))} -Force`)
copyIfExists(resolve(sourceAssetsDir, 'tray.png'), resolve(stageDir, 'assets', 'tray.png'))
copyIfExists(resolve(sourceAssetsDir, 'models'), resolve(stageDir, 'assets', 'models'))
copyIfExists(resolve(releaseDir, 'resources'), resolve(stageDir, 'resources'))

if (existsSync(archivePath)) {
  unlinkSync(archivePath)
}

runPowerShell(`Compress-Archive -LiteralPath ${quotePowerShell(stageDir)} -DestinationPath ${quotePowerShell(archivePath)} -Force`)

rmSync(stageRootDir, { recursive: true, force: true })

console.log(`Portable archive created: ${archivePath}`)

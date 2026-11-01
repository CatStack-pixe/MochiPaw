import { spawnSync } from 'node:child_process'
import { cpSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, relative, resolve, sep } from 'node:path'
import { env } from 'node:process'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const dist = resolve(root, 'dist')
const widgetRoot = resolve(root, 'windows/gamebar-widget')
const webRoot = resolve(widgetRoot, 'Web')
const modelRoot = resolve(root, 'src-tauri/assets/models')
const bridgeProject = resolve(widgetRoot, 'Bridge/MochiPaw.GameBarBridge.csproj')
const bridgeOutput = resolve(widgetRoot, 'GameBar/Bridge')
const packageOutput = resolve(widgetRoot, 'GameBar/Packages')
const webRelative = relative(widgetRoot, webRoot)

if (webRelative.startsWith(`..${sep}`) || resolve(widgetRoot, webRelative) !== webRoot) {
  throw new Error('Refusing to write Game Bar web assets outside the widget project.')
}

const gameBarEntry = resolve(dist, 'src/gamebar/index.html')
if (!statSync(dist, { throwIfNoEntry: false })?.isDirectory() || !statSync(gameBarEntry, { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Vite output is missing the Game Bar entry. Run `pnpm build:vite` first.')
}

mkdirSync(webRoot, { recursive: true })
cpSync(dist, webRoot, { recursive: true, force: true })

const packagedModels = resolve(webRoot, 'gamebar-assets/models')
mkdirSync(packagedModels, { recursive: true })

for (const modelId of ['standard', 'keyboard', 'gamepad']) {
  const source = resolve(modelRoot, modelId)
  if (!statSync(source, { throwIfNoEntry: false })?.isDirectory()) {
    throw new Error(`Preset model is missing: ${source}`)
  }
  cpSync(source, resolve(packagedModels, modelId), { recursive: true, force: true })
}

mkdirSync(bridgeOutput, { recursive: true })
const publish = spawnSync('dotnet', [
  'publish',
  bridgeProject,
  '--configuration',
  'Release',
  '--output',
  bridgeOutput,
], { cwd: root, stdio: 'inherit' })
if (publish.error) throw publish.error
if (publish.status !== 0) throw new Error(`Game Bar bridge publish failed with exit code ${publish.status}`)
if (!statSync(resolve(bridgeOutput, 'MochiPaw.GameBarBridge.exe'), { throwIfNoEntry: false })?.isFile()) {
  throw new Error('Game Bar bridge publish did not produce MochiPaw.GameBarBridge.exe.')
}

const vswhere = resolve(
  env['ProgramFiles(x86)'] ?? 'C:/Program Files (x86)',
  'Microsoft Visual Studio/Installer/vswhere.exe',
)
const msbuild = env.MSBUILD_EXE
  ?? (() => {
    if (!statSync(vswhere, { throwIfNoEntry: false })?.isFile()) return undefined

    const result = spawnSync(vswhere, ['-products', '*', '-latest', '-find', 'MSBuild/**/Bin/MSBuild.exe'], {
      encoding: 'utf8',
    })
    return result.stdout?.trim().split(/\r?\n/).find(Boolean)
  })()

if (!msbuild || !statSync(msbuild, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(
    'Visual Studio MSBuild with the Universal Windows Platform workload is required to produce the Game Bar package.',
  )
}

mkdirSync(packageOutput, { recursive: true })
const buildWidget = spawnSync(msbuild, [
  resolve(widgetRoot, 'MochiPaw.GameBarWidget.csproj'),
  '/t:Rebuild',
  '/p:Configuration=Release',
  '/p:Platform=x64',
  '/p:AppxPackage=true',
  '/p:AppxBundle=Never',
  '/p:UapAppxPackageBuildMode=SideloadOnly',
  '/p:AppxPackageSigningEnabled=false',
  `/p:AppxPackageDir=${packageOutput}${sep}`,
], { cwd: root, stdio: 'inherit' })

if (buildWidget.error) throw buildWidget.error
if (buildWidget.status !== 0) {
  throw new Error(`Game Bar widget package build failed with exit code ${buildWidget.status}`)
}

const packageFiles = readdirSync(packageOutput, { recursive: true })
  .map(file => resolve(packageOutput, String(file)))
  .filter(file => /\.(?:appx|msix)$/i.test(file) && statSync(file, { throwIfNoEntry: false })?.isFile())
if (packageFiles.length === 0) {
  throw new Error(`MSBuild succeeded but no .appx/.msix package was found in ${packageOutput}.`)
}

console.log(`Packaged Game Bar web assets to ${webRoot}`)
console.log(`Included preset models: ${readdirSync(packagedModels).join(', ')}`)
console.log(`Published packaged full-trust bridge to ${bridgeOutput}`)
console.log(`Built Game Bar package(s): ${packageFiles.join(', ')}`)

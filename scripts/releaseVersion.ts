// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

function escapeRegularExpression(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function findTomlSection(content: string, header: string) {
  const headerPattern = new RegExp(`^\\[${escapeRegularExpression(header)}\\]\\s*$`, 'm')
  const match = headerPattern.exec(content)

  if (!match) throw new Error(`Missing TOML section [${header}].`)

  const start = match.index + match[0].length
  const remaining = content.slice(start)
  const nextSectionOffset = remaining.search(/^\s*\[/m)
  const end = nextSectionOffset === -1 ? content.length : start + nextSectionOffset

  return { end, start }
}

function readVersionFromBlock(block: string, context: string) {
  const matches = [...block.matchAll(/^version\s*=\s*"([^"]+)"\s*$/gm)]

  if (matches.length !== 1) {
    throw new Error(`Expected exactly one version in ${context}, found ${matches.length}.`)
  }

  return matches[0][1]
}

export function readCargoManifestVersion(content: string, packageName: string) {
  const section = findTomlSection(content, 'package')
  const block = content.slice(section.start, section.end)
  const nameMatches = [...block.matchAll(/^name\s*=\s*"([^"]+)"\s*$/gm)]

  if (nameMatches.length !== 1 || nameMatches[0][1] !== packageName) {
    throw new Error(`Cargo manifest [package] is not ${packageName}.`)
  }

  return readVersionFromBlock(block, `Cargo manifest package ${packageName}`)
}

export function replaceCargoManifestVersion(content: string, packageName: string, version: string) {
  const section = findTomlSection(content, 'package')
  const block = content.slice(section.start, section.end)

  readCargoManifestVersion(content, packageName)

  const updatedBlock = block.replace(
    /^(version\s*=\s*)"[^"]+"\s*$/m,
    `$1"${version}"`,
  )

  return `${content.slice(0, section.start)}${updatedBlock}${content.slice(section.end)}`
}

function findCargoLockPackage(content: string, packageName: string) {
  const blocks = content.split(/(?=^\[\[package\]\]\s*$)/m)
  const matches = blocks.filter((block) => {
    return new RegExp(`^name\\s*=\\s*"${escapeRegularExpression(packageName)}"\\s*$`, 'm').test(block)
  })

  if (matches.length !== 1) {
    throw new Error(`Expected one Cargo.lock package named ${packageName}, found ${matches.length}.`)
  }

  return matches[0]
}

export function readCargoLockVersion(content: string, packageName: string) {
  return readVersionFromBlock(
    findCargoLockPackage(content, packageName),
    `Cargo.lock package ${packageName}`,
  )
}

export function replaceCargoLockVersion(content: string, packageName: string, version: string) {
  const block = findCargoLockPackage(content, packageName)
  const updatedBlock = block.replace(
    /^(version\s*=\s*)"[^"]+"\s*$/m,
    `$1"${version}"`,
  )

  return content.replace(block, updatedBlock)
}

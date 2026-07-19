// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import { existsSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

interface GitHubContributor {
  login: string
  avatar_url: string
  html_url: string
}

const repository = 'CatStack-pixe/MochiPaw'
const outputPath = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'public', 'contributors.json')

async function getContributors() {
  const contributors: GitHubContributor[] = []

  for (let page = 1; ; page += 1) {
    const response = await fetch(`https://api.github.com/repos/${repository}/contributors?per_page=100&page=${page}`, {
      headers: {
        Accept: 'application/vnd.github+json',
      },
    })

    if (!response.ok) throw new Error(`GitHub contributors request failed: ${response.status}`)

    const pageContributors: unknown = await response.json()

    if (!Array.isArray(pageContributors)) throw new Error('GitHub contributors response is not a list')

    contributors.push(...pageContributors.filter(isGitHubContributor))

    if (pageContributors.length < 100) break
  }

  return contributors.map(contributor => ({
    login: contributor.login,
    avatarUrl: contributor.avatar_url,
    profileUrl: contributor.html_url,
  }))
}

function isGitHubContributor(value: unknown): value is GitHubContributor {
  if (!value || typeof value !== 'object') return false

  const contributor = value as Record<string, unknown>

  return typeof contributor.login === 'string'
    && typeof contributor.avatar_url === 'string'
    && typeof contributor.html_url === 'string'
}

try {
  const contributors = await getContributors()

  writeFileSync(outputPath, `${JSON.stringify(contributors, null, 2)}\n`)
} catch (error) {
  if (!existsSync(outputPath)) throw error

  const message = error instanceof Error ? error.message : String(error)

  console.warn(`Could not refresh GitHub contributors; keeping the bundled manifest: ${message}`)
}

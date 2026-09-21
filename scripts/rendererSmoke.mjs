// SPDX-FileCopyrightText: 2026 InfinityXCat
// SPDX-License-Identifier: PolyForm-Noncommercial-1.0.0

import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createServer } from 'vite'

const { chromium } = await import(pathToFileURL(resolve(process.env.BROWSER_TEST_DIR, 'node_modules/playwright/index.mjs')))
const evidence = resolve('renderer-smoke-results')
await mkdir(evidence, { recursive: true })
const server = await createServer({
  configFile: false,
  appType: 'custom',
  optimizeDeps: { entries: ['scripts/rendererSmoke.entry.ts'] },
  resolve: { alias: { '@Framework': resolve('src/vendor/easy-live2d/Framework'), '@': resolve('src') } },
  server: { host: '127.0.0.1', port: 0 },
})
server.middlewares.use('/renderer-smoke', (_request, response) => {
  response.setHeader('Content-Type', 'text/html')
  response.end('<html><body><script type="module" src="/scripts/rendererSmoke.entry.ts"></script></body></html>')
})
await server.listen()
const browser = await chromium.launch({ args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })
const page = await browser.newPage()
const errors = []
page.on('pageerror', error => errors.push(String(error)))
try {
  await page.goto(`${server.resolvedUrls.local[0]}renderer-smoke`)
  await page.waitForFunction(() => typeof window.rendererSmoke === 'function')
  const { results, renderedFrame } = await page.evaluate(() => window.rendererSmoke())
  assert.equal(results.length, 10)
  assert.deepEqual(errors, [])
  await writeFile(resolve(evidence, 'rendered-model.png'), Buffer.from(renderedFrame.split(',')[1], 'base64'))
  await writeFile(resolve(evidence, 'results.json'), JSON.stringify({ backend: 'Chromium SwiftShader (functional smoke, not physical GPU/RAM benchmark)', results, errors }, null, 2))
  console.log(JSON.stringify(results))
} finally {
  await page.screenshot({ path: resolve(evidence, 'final-page.png') })
  await writeFile(resolve(evidence, 'errors.json'), JSON.stringify(errors, null, 2))
  await browser.close()
  await server.close()
}

#!/usr/bin/env node
/**
 * 快捷键文档生成 / 校验脚本（P1-14）。
 *
 * 用法：
 *   node scripts/gen-shortcuts-doc.mjs           # 生成 / 覆盖 docs/SHORTCUTS.md
 *   node scripts/gen-shortcuts-doc.mjs --check   # 只校验，不一致则非零退出
 *
 * 为什么用 esbuild 而不是直接读 TS：
 * `web/src/lib/shortcuts.ts` 是 TS，Node 直接 import 不了；与其在脚本里再手写一份
 * 「按键 → 说明」的复印件（那正是要消灭的东西），不如把真身 bundle 出来跑一次。
 * 打包产物落在 `qa/dist/`（已是构建产物目录，不入库）。
 */
import { createRequire } from 'node:module'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const esbuild = require(resolve(root, 'web', 'node_modules', 'esbuild', 'lib', 'main.js'))

const distDir = resolve(root, 'qa', 'dist')
mkdirSync(distDir, { recursive: true })
const bundlePath = resolve(distDir, 'shortcuts.doc.cjs')

await esbuild.build({
  entryPoints: [resolve(root, 'web', 'src', 'lib', 'shortcuts.ts')],
  outfile: bundlePath,
  bundle: true,
  platform: 'node',
  format: 'cjs',
  logLevel: 'warning',
  target: 'node20',
})

const { renderShortcutsMarkdown, SHORTCUTS, SHORTCUTS_DOC_PATH, detectShortcutConflicts } = require(bundlePath)

const conflicts = detectShortcutConflicts(SHORTCUTS)
if (conflicts.length > 0) {
  console.error('✗ 快捷键注册表存在冲突，先修好再生成文档：')
  for (const c of conflicts) {
    console.error(`  - ${c.kind}: ${c.ids.join(', ')}${c.combo ? ` (${c.scope} / ${c.combo})` : ''}`)
  }
  process.exit(1)
}

const expected = renderShortcutsMarkdown(SHORTCUTS)
const docPath = resolve(root, SHORTCUTS_DOC_PATH)
const checkOnly = process.argv.includes('--check')

if (checkOnly) {
  let actual = ''
  try {
    actual = readFileSync(docPath, 'utf8')
  } catch {
    console.error(`✗ 缺少 ${SHORTCUTS_DOC_PATH}，请先运行 npm run shortcuts:doc`)
    process.exit(1)
  }
  const normalize = (s) => s.replace(/\r\n/g, '\n').replace(/\s+$/, '')
  if (normalize(actual) !== normalize(expected)) {
    console.error(`✗ ${SHORTCUTS_DOC_PATH} 与注册表不一致，请运行 npm run shortcuts:doc`)
    process.exit(1)
  }
  console.log(`✓ ${SHORTCUTS_DOC_PATH} 与注册表一致（${SHORTCUTS.length} 条）`)
} else {
  writeFileSync(docPath, expected, 'utf8')
  console.log(`✓ 已写入 ${SHORTCUTS_DOC_PATH}（${SHORTCUTS.length} 条）`)
}

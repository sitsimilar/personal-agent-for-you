/**
 * 视觉特征/分类探针（开发期标定用，不参与 CI）
 * 运行：npx tsx qa/vision-probe.ts
 *
 * 用途：打印合成样本的特征数值与分类打分，据此调 classify.ts 的权重与
 * quality.ts 的阈值。它把"拍脑袋设阈值"变成"看数再设"。
 */

import { classifyScene } from '../web/src/lib/vision/classify'
import { extractFeatures } from '../web/src/lib/vision/features'
import { assessQuality } from '../web/src/lib/vision/quality'
import * as F from './vision-fixtures'

const samples: Array<{ label: string; expect: string; img: ReturnType<typeof F.codeShot> }> = [
  { label: 'code', expect: 'code', img: F.codeShot() },
  { label: 'document', expect: 'document', img: F.documentShot() },
  { label: 'table', expect: 'table', img: F.tableShot() },
  { label: 'ui', expect: 'ui', img: F.uiShot() },
  { label: 'chart', expect: 'chart', img: F.chartShot() },
  { label: 'photo', expect: 'photo', img: F.photoShot() },
  { label: 'error-dialog', expect: 'error', img: F.errorDialog() },
  { label: 'terminal-red', expect: 'code|error', img: F.errorShot() },
  { label: 'warm-gradient', expect: 'photo', img: F.warmGradient() },
  { label: 'code-blur', expect: 'code', img: F.blur(F.codeShot()) },
  { label: 'document-glare', expect: 'document', img: F.glare(F.documentShot()) },
]

const pad = (s: string | number, n: number) => String(s).padEnd(n)
console.log(pad('sample', 16), pad('expect', 10), pad('got', 10), pad('margin', 8), pad('period', 8), pad('cover', 7), pad('lineH', 7), pad('axis', 7), pad('edge', 7), pad('sat', 7), pad('colorful', 9), pad('distinct', 9), pad('sharp', 8), pad('red', 7), pad('hueE', 7), pad('bClip', 7), pad('dClip', 7), pad('q', 8))
for (const s of samples) {
  const { features, contentBox } = extractFeatures(s.img)
  const d = classifyScene(features)
  const q = assessQuality(features, F.metaOf(s.img), d.scene)
  const ok = s.expect.includes(d.scene) ? '  ' : '!!'
  console.log(
    ok,
    pad(s.label, 14),
    pad(s.expect, 10),
    pad(d.scene, 10),
    pad(d.margin.toFixed(3), 8),
    pad(features.linePeriodicity.toFixed(3), 8),
    pad(features.inkRowCoverage.toFixed(2), 7),
    pad(features.lineHeightPx.toFixed(1), 7),
    pad(features.axisRatio.toFixed(3), 7),
    pad(features.edgeDensity.toFixed(3), 7),
    pad(features.saturationMean.toFixed(3), 7),
    pad(features.colorfulness.toFixed(1), 9),
    pad(features.distinctColorRatio.toFixed(3), 9),
    pad(features.sharpness.toFixed(2), 8),
    pad(features.redRatio.toFixed(4), 7),
    pad(features.hueEntropy.toFixed(3), 7),
    pad(features.brightClipRatio.toFixed(3), 7),
    pad(features.darkClipRatio.toFixed(3), 7),
    pad(`${q.verdict}/${q.score}`, 8),
    contentBox ? `box ${contentBox.w}x${contentBox.h}` : '',
  )
  console.log('   top3:', d.scores.slice(0, 3).map((x) => `${x.scene}:${x.score}`).join(' '), '| issues:', q.issues.map((i) => i.code).join(',') || '-')
}

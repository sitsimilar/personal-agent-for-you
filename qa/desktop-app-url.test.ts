/**
 * 桌面端线上地址拼装与「分享码失效自愈」· 测试。
 *
 * 背景：发布位开启分享码后，缺码整站 403「链接不完整」；而分享码可能随发布更换，
 * 它又被编译进安装包 → 老安装包会白屏。本文件锁定三件事：
 * - 纯函数（提取 / 覆盖 / 拼参）不会把地址拼坏（`?sharecode=A?desktop=1` 这类事故）；
 * - 未配置地址时**必须**返回 ok=false 让调用方走本地兜底页，不能拿空 URL 硬加载；
 * - 剪贴板取码与探测失败（超时/断网）不得抛错，也不得误判成「链接失效」。
 */
import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { __setElectronMock, __resetElectronMock } from './mocks/electron'
import { appendQuery, composeBaseUrl, extractShareCode, withShareCode } from '../desktop/src/shared/app-url'
import {
  appReachableState,
  appUrl,
  ensureAppReachable,
  probeHttpStatus,
  readShareCodeFromClipboard,
  resolveBaseUrl,
} from '../desktop/src/main/app-url'
import { store } from '../desktop/src/main/store'

beforeEach(() => {
  __resetElectronMock()
})

/* ---------------------------- 提取分享码 ---------------------------- */

test('extractShareCode：从完整分享链接里取码（带其它参数/锚点也不影响）', () => {
  assert.equal(extractShareCode('https://personal-agent-08495.app.workbuddy.link/?sharecode=RK3QMHZAJI'), 'RK3QMHZAJI')
  assert.equal(
    extractShareCode('https://x.link/?a=1&sharecode=ABCdef12&b=2#/records'),
    'ABCdef12',
    '参数顺序与锚点不得影响取值',
  )
})

test('extractShareCode：用户从终端复制会带换行/回车，必须先 trim', () => {
  assert.equal(extractShareCode('  https://x.link/?sharecode=RK3QMHZAJI\r\n'), 'RK3QMHZAJI')
  assert.equal(extractShareCode('RK3QMHZAJI\r\n'), 'RK3QMHZAJI')
})

test('extractShareCode：纯码、缺 scheme 的裸串、非法内容分别处理', () => {
  assert.equal(extractShareCode('RK3QMHZAJI'), 'RK3QMHZAJI')
  // 缺 scheme 的裸域名：new URL 抛错 → 字符串扫描兜底
  assert.equal(extractShareCode('x.link/?sharecode=RK3QMHZAJI'), 'RK3QMHZAJI')
  assert.equal(extractShareCode(''), '')
  assert.equal(extractShareCode(null), '')
  assert.equal(extractShareCode('链接不完整'), '', '平台 403 页正文不得被当成码')
  assert.equal(extractShareCode('https://x.link/'), '', '没有 sharecode 参数时返回空串')
  assert.equal(extractShareCode('?sharecode=ab'), '', '过短的码视为无效（不是真码）')
})

/* ---------------------------- 覆盖分享码 ---------------------------- */

test('withShareCode：替换已有码而不是追加第二个', () => {
  const out = withShareCode('https://x.link/?sharecode=OLD', 'NEW1')
  const url = new URL(out)
  assert.equal(url.searchParams.get('sharecode'), 'NEW1')
  assert.equal(url.searchParams.getAll('sharecode').length, 1, '不得出现两个 sharecode')
})

test('withShareCode：原来没有码则新增；传空则清除；空 base 返回空串', () => {
  assert.equal(new URL(withShareCode('https://x.link/', 'NEW1')).searchParams.get('sharecode'), 'NEW1')
  assert.equal(withShareCode('https://x.link/?sharecode=OLD', '').includes('sharecode'), false, '空码表示清除')
  assert.equal(withShareCode('', 'NEW1'), '')
  assert.equal(withShareCode(null, 'NEW1'), '')
})

/* ------------------------------ 拼参 ------------------------------ */

test('appendQuery：保留已有查询串，不拼出 `?a?b` 这种坏地址', () => {
  const out = appendQuery('https://x.link/?sharecode=CODE1', { desktop: '1' })
  const url = new URL(out)
  assert.equal(url.searchParams.get('sharecode'), 'CODE1')
  assert.equal(url.searchParams.get('desktop'), '1')
  assert.equal(out.split('?').length, 2, '整串只能有一个 ?')
})

test('appendQuery：空 base 返回空串（调用方据此走兜底页）', () => {
  assert.equal(appendQuery('', { desktop: '1' }), '')
  assert.equal(appendQuery('   ', { desktop: '1' }), '')
})

/* --------------------------- 基址组合 --------------------------- */

test('composeBaseUrl：无地址就返回空串；有码才覆盖；无码原样返回', () => {
  assert.equal(composeBaseUrl('', 'CODE1'), '', '未配置地址必须返回空串')
  assert.equal(composeBaseUrl('  ', 'CODE1'), '')
  const base = 'https://x.link/?sharecode=ENVCODE'
  assert.equal(new URL(composeBaseUrl(base, 'NEWCODE')).searchParams.get('sharecode'), 'NEWCODE', '本地码优先')
  assert.equal(
    new URL(composeBaseUrl(base, '')).searchParams.get('sharecode'),
    'ENVCODE',
    '本地无码时保留安装包里的那份',
  )
  assert.equal(
    new URL(composeBaseUrl('https://x.link/', ' NEWCODE ')).searchParams.get('sharecode'),
    'NEWCODE',
    '首尾空格要 trim',
  )
})

/* ------------------------- 主进程 glue ------------------------- */

test('resolveBaseUrl/appUrl：测试环境未注入 VITE_WEB_APP_URL → 空（不得抛错）', () => {
  assert.equal(resolveBaseUrl(), '')
  assert.equal(appUrl(), '')
  assert.equal(appUrl({ desktop: '1' }), '')
})

test('ensureAppReachable：地址为空时 ok=false（调用方必须走本地兜底页）', async () => {
  const result = await ensureAppReachable()
  assert.equal(result.ok, false)
  assert.equal(result.url, '')
  assert.equal(appReachableState(), false, '空地址要记为不可达，悬浮窗据此直接走兜底')
})

test('probeHttpStatus：连不上返回 null 而不是抛错（断网不得被当成链接失效）', async () => {
  const status = await probeHttpStatus('https://127.0.0.1:1/version.json', 1500)
  assert.equal(status, null)
})

test('readShareCodeFromClipboard：有链接可取；剪贴板抛错时返回空串', () => {
  __setElectronMock({ clipboardText: 'https://personal-agent-08495.app.workbuddy.link/?sharecode=MMMM1111' })
  assert.equal(readShareCodeFromClipboard(), 'MMMM1111')

  __setElectronMock({ clipboardThrows: true })
  assert.equal(readShareCodeFromClipboard(), '', '剪贴板不可用不得抛错，只是取不到码')
})

test('store：新增的 webShareCode 是字符串字段，可写入并读回（老 preferences.json 也要兜底）', () => {
  assert.equal(typeof store.get('webShareCode'), 'string')
  store.set('webShareCode', 'CODE9')
  assert.equal(store.get('webShareCode'), 'CODE9')
  store.set('webShareCode', '')
  assert.equal(store.get('webShareCode'), '')
  store.flushSync()
})

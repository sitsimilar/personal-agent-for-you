/**
 * 加载问候语 P0-5 测试。
 *
 * 验收原文：「连续刷新 10 次无相邻重复；断网仍出文案；空池回落默认文案；
 * 单测覆盖这两个边界」。对应到断言：
 * - 10 次连续挑选（模拟 10 次刷新，共享一份假存储）→ 相邻两条永远不相等；
 * - 「断网仍出文案」= 挑选过程不读网络、不读 `Date.now` 之外的时钟，任何入参下都返回非空文本；
 * - 空池 / 全被排除 / 存储抛错 → 回落 `DEFAULT_GREETING_TEXT` 且不抛。
 *
 * 额外锁住：时段边界、去重、随机数越界、存储往返，以及「模块没有副作用」
 * （纯函数在 Node 里 import 不能碰 window/localStorage）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import {
  DEFAULT_GREETING_TEXT,
  GREETING_POOL,
  GREETING_STORAGE_KEY,
  greetingCandidates,
  nextBootGreeting,
  pickGreeting,
  readLastGreeting,
  rememberGreeting,
  resolveGreetingSlot,
  type GreetingPool,
  type GreetingSlot,
  type GreetingStorage,
} from '../web/src/lib/greeting'

/** 内存版 localStorage（键值与真实 Storage 语义一致，够用且无副作用）。 */
function fakeStorage(initial: Record<string, string> = {}): GreetingStorage & { dump(): Record<string, string> } {
  const map = new Map(Object.entries(initial))
  return {
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => {
      map.set(k, v)
    },
    dump: () => Object.fromEntries(map),
  }
}

function emptyPool(): GreetingPool {
  return { night: [], dawn: [], morning: [], noon: [], afternoon: [], evening: [] }
}

/* ------------------------------ 时段判定 ------------------------------ */

test('问候语时段：5/8/11/13/18/23 六个边界各落一侧', () => {
  assert.equal(resolveGreetingSlot(4), 'night')
  assert.equal(resolveGreetingSlot(5), 'dawn')
  assert.equal(resolveGreetingSlot(7), 'dawn')
  assert.equal(resolveGreetingSlot(8), 'morning')
  assert.equal(resolveGreetingSlot(10), 'morning')
  assert.equal(resolveGreetingSlot(11), 'noon')
  assert.equal(resolveGreetingSlot(12), 'noon')
  assert.equal(resolveGreetingSlot(13), 'afternoon')
  assert.equal(resolveGreetingSlot(17), 'afternoon')
  assert.equal(resolveGreetingSlot(18), 'evening')
  assert.equal(resolveGreetingSlot(22), 'evening')
  assert.equal(resolveGreetingSlot(23), 'night')
  assert.equal(resolveGreetingSlot(0), 'night')
})

test('问候语时段：非法小时数回落 night（不抛、不返回 undefined）', () => {
  for (const hour of [Number.NaN, Number.POSITIVE_INFINITY, -1, 24, 99]) {
    assert.equal(resolveGreetingSlot(hour), 'night', `${String(hour)} 应回落 night`)
  }
})

test('问候语时段：小数按向下取整（12.9 仍算中午，不到下午）', () => {
  assert.equal(resolveGreetingSlot(12.9), 'noon')
  assert.equal(resolveGreetingSlot(17.99), 'afternoon')
  assert.equal(resolveGreetingSlot(4.99), 'night')
})

/* ------------------------------ 文案池质量 ------------------------------ */

test('文案池：六个时段都有 ≥3 条，且同一时段内无重复文案', () => {
  const slots: GreetingSlot[] = ['night', 'dawn', 'morning', 'noon', 'afternoon', 'evening']
  for (const slot of slots) {
    const list = greetingCandidates(slot)
    assert.ok(list.length >= 3, `${slot} 至少 3 条，实际 ${list.length}`)
    assert.equal(new Set(list).size, list.length, `${slot} 存在重复文案`)
    for (const text of list) {
      assert.ok(text.trim().length > 0, `${slot} 存在空文案`)
      assert.notEqual(text, DEFAULT_GREETING_TEXT, `${slot} 不应把兜底文案写进池子`)
    }
  }
})

test('文案池：整池无跨时段重复（否则「排除上一条」在换时段后失效）', () => {
  const all = Object.values(GREETING_POOL).flat()
  assert.equal(new Set(all).size, all.length)
})

/* ------------------------------ 排除上一条 ------------------------------ */

test('排除上一条：previous 被剔除后从剩余里挑（random=0 取第一条未被排除的）', () => {
  const pool: GreetingPool = { ...emptyPool(), noon: ['A', 'B', 'C'] }
  const first = pickGreeting({ hour: 12, previous: null, random: () => 0, pool })
  assert.equal(first.text, 'A')
  const second = pickGreeting({ hour: 12, previous: 'A', random: () => 0, pool })
  assert.equal(second.text, 'B', '排除 A 后 random=0 应落到 B，而不是重新返回 A')
})

test('排除上一条：previous 带首尾空白也认（存储被人手改过 / 老版本写入过）', () => {
  const pool: GreetingPool = { ...emptyPool(), noon: ['A', 'B'] }
  const pick = pickGreeting({ hour: 12, previous: '  A  ', random: () => 0, pool })
  assert.equal(pick.text, 'B')
})

test('排除上一条：空字符串 / null / undefined 视为「没有上一条」', () => {
  const pool: GreetingPool = { ...emptyPool(), noon: ['A', 'B'] }
  for (const previous of ['', '   ', null, undefined]) {
    const pick = pickGreeting({ hour: 12, previous: previous as string | null | undefined, random: () => 0, pool })
    assert.equal(pick.text, 'A')
    assert.equal(pick.fallback, false)
  }
})

/* ------------------------------ 空池兜底 ------------------------------ */

test('空池：整池为空 → 回落默认文案，fallback=true', () => {
  const pick = pickGreeting({ hour: 9, pool: emptyPool(), random: () => 0 })
  assert.equal(pick.text, DEFAULT_GREETING_TEXT)
  assert.equal(pick.fallback, true)
  assert.equal(pick.slot, 'morning')
})

test('空池：只有空白 / 非字符串条目也当作空池（脏数据不能当成文案显示）', () => {
  const dirty = { ...emptyPool(), morning: ['   ', '', null as unknown as string] }
  const pick = pickGreeting({ hour: 9, pool: dirty, random: () => 0 })
  assert.equal(pick.text, DEFAULT_GREETING_TEXT)
  assert.equal(pick.fallback, true)
})

test('空池：池子里只剩上一条（单条池）→ 回落默认文案，而不是重复同一条', () => {
  const pool: GreetingPool = { ...emptyPool(), afternoon: ['只有这一条'] }
  const pick = pickGreeting({ hour: 15, previous: '只有这一条', random: () => 0, pool })
  assert.equal(pick.text, DEFAULT_GREETING_TEXT)
  assert.equal(pick.fallback, true)
})

/* ----------------------- 连续刷新 10 次无相邻重复（核心验收） ----------------------- */

test('连续刷新 10 次：相邻两条永不重复（共享同一份存储 = 同一浏览器刷新）', () => {
  const storage = fakeStorage()
  const seen: string[] = []
  for (let i = 0; i < 10; i += 1) {
    // 固定小时，避免跨时段把「不同池子」误当成通过；random 全取 0 是最坏情况的撞车温床
    const pick = nextBootGreeting({ hour: 14, random: () => 0, storage })
    seen.push(pick.text)
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.notEqual(seen[i], seen[i - 1], `第 ${i + 1} 次刷新与上一次重复：${seen[i]}`)
  }
  // random 恒为 0 时「排除上一条 + 取第一条」必然在两条之间来回（A→B→A…），这是数学结果，
  // 不是缺陷；这里只要求它**确实在轮换**（不是钉死同一条）
  assert.equal(new Set(seen).size, 2, '随机数退化为 0 时应恰好两条交替')
})

test('连续刷新 10 次：正常随机下覆盖 ≥3 种文案（池子没被写窄）', () => {
  // 固定种子的线性同余，避免 flaky；种子保证 10 次里能踩到 ≥3 条
  let seed = 20261111
  const random = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648
    return seed / 2147483648
  }
  const storage = fakeStorage()
  const seen = new Set<string>()
  let previous: string | null = null
  for (let i = 0; i < 10; i += 1) {
    const pick = nextBootGreeting({ hour: 14, random, storage })
    assert.notEqual(pick.text, previous)
    previous = pick.text
    seen.add(pick.text)
  }
  assert.ok(seen.size >= 3, `10 次只出现 ${seen.size} 种文案，池子被写窄了`)
})

test('连续刷新 10 次：random 走真随机也不撞相邻（1000 轮压力，边界最容易漏）', () => {
  for (let round = 0; round < 1000; round += 1) {
    const storage = fakeStorage()
    let previous: string | null = null
    for (let i = 0; i < 10; i += 1) {
      const pick = nextBootGreeting({ hour: 9, storage })
      assert.notEqual(pick.text, previous, `第 ${round} 轮第 ${i} 次出现相邻重复`)
      previous = pick.text
    }
  }
})

test('连续刷新 10 次：跨时段（模拟跨小时刷新）也不撞相邻', () => {
  const storage = fakeStorage()
  const hours = [8, 8, 12, 12, 14, 18, 18, 23, 2, 6]
  const seen: string[] = []
  for (const hour of hours) {
    seen.push(nextBootGreeting({ hour, random: () => 0, storage }).text)
  }
  for (let i = 1; i < seen.length; i += 1) {
    assert.notEqual(seen[i], seen[i - 1])
  }
})

/* ------------------------------ 断网 / 无存储 ------------------------------ */

test('断网仍出文案：不依赖网络与存储（storage=null 也返回非空文本）', () => {
  const pick = nextBootGreeting({ hour: 10, storage: null })
  assert.ok(pick.text.trim().length > 0)
  assert.notEqual(pick.text, '', '无存储时不能返回空串')
  assert.equal(pick.fallback, false)
})

test('存储抛错（隐私模式）不影响出文案，也不向上抛', () => {
  const throwing: GreetingStorage = {
    getItem: () => {
      throw new Error('SecurityError')
    },
    setItem: () => {
      throw new Error('QuotaExceededError')
    },
  }
  let pick: ReturnType<typeof nextBootGreeting> | null = null
  assert.doesNotThrow(() => {
    pick = nextBootGreeting({ hour: 10, storage: throwing })
  })
  assert.ok(pick && (pick as { text: string }).text.length > 0)
})

test('readLastGreeting / rememberGreeting：正常往返、空值不写、空库返回 null', () => {
  const storage = fakeStorage()
  assert.equal(readLastGreeting(storage), null)
  rememberGreeting('上午好', storage)
  assert.equal(readLastGreeting(storage), '上午好')
  assert.equal(storage.dump()[GREETING_STORAGE_KEY], '上午好')
  rememberGreeting('', storage)
  assert.equal(readLastGreeting(storage), '上午好', '空文案不应覆盖已有值')
})

test('readLastGreeting：存储里是空白串时当作没有上一条', () => {
  const storage = fakeStorage({ [GREETING_STORAGE_KEY]: '   ' })
  assert.equal(readLastGreeting(storage), null)
})

/* ------------------------------ 随机数健壮性 ------------------------------ */

test('随机数越界 / NaN / 负数：一律取第一条，绝不返回 undefined', () => {
  const pool: GreetingPool = { ...emptyPool(), noon: ['A', 'B', 'C'] }
  for (const r of [Number.NaN, -0.1, 1, 1.5, Number.POSITIVE_INFINITY]) {
    const pick = pickGreeting({ hour: 12, pool, random: () => r })
    assert.equal(pick.text, 'A', `random=${String(r)} 应回落第一条`)
  }
})

test('随机数上界近似 1：索引被夹在末尾，不越界取到 undefined', () => {
  const pool: GreetingPool = { ...emptyPool(), noon: ['A', 'B', 'C'] }
  const pick = pickGreeting({ hour: 12, pool, random: () => 0.9999999 })
  assert.equal(pick.text, 'C')
})

test('hour 优先于 now：显式 hour 不被 now 覆盖', () => {
  const now = new Date(2026, 10, 11, 3, 0, 0) // 本地 03:00 → night
  const pick = pickGreeting({ hour: 9, now, random: () => 0 })
  assert.equal(pick.slot, 'morning')
})

test('无 hour 无 now：取当前本地时间，结果必落在合法时段内', () => {
  const pick = pickGreeting()
  const slots: GreetingSlot[] = ['night', 'dawn', 'morning', 'noon', 'afternoon', 'evening']
  assert.ok(slots.includes(pick.slot))
  assert.ok(pick.text.trim().length > 0)
})

/* ------------------- 源码级接线约束（防「写了文案池但启动屏没用上」） ------------------- */

test('BootScreen：显示的是问候语而不是写死的「正在加载…」，且只在挂载时挑一次', () => {
  const src = readFileSync(
    path.join(typeof __dirname === 'string' ? path.resolve(__dirname, '..', '..') : process.cwd(), 'web/src/components/BootScreen.tsx'),
    'utf8',
  )
  // 剥注释：注释里提到「正在加载…」是解释，不算把文案写死
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1')
  assert.ok(code.includes('nextBootGreeting'), '必须调用问候语模块')
  assert.ok(!code.includes('正在加载…'), '渲染体里不许再写死固定文案')
  assert.ok(code.includes('useState(() =>'), '必须惰性初始化，避免每次重渲染换一句')
  assert.ok(/aria|align="center"/.test(code) || code.includes('sx={{ maxWidth'), '文案需要居中以适配长句换行')
})

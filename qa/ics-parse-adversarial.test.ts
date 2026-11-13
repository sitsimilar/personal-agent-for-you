/**
 * P0-1 上半「.ics 解析层」· **对抗性测试**（QA 严过关独立补充，2026-11-02）。
 *
 * 与工程用例 `qa/ics-parse.test.ts`（28 例，按 `qa/fixtures/ics/` 矩阵逐条验收）的分工：
 * 那边守"夹具矩阵对得上"，这边守"**换一台机器 / 换一种合法写法**还对不对"。
 * 本文件**只新增测试，不改被测源码**。
 *
 * 覆盖面（每条 test 的注释写清"守的是什么洞"）：
 *   1. 时区语义：Windows 名 ↔ IANA 同墙钟同绝对时刻、DST 空档/重叠、未知 TZID、EXDATE 多形态；
 *   2. 展开正确性：INTERVAL、UNTIL 边界、**覆盖实例跨天**、多 UID 互不串味、双上限叠加、全天循环；
 *   3. 容错：截断、混用行尾、BOM、折行破坏、缺 UID / 缺 DTSTART、VTODO + RRULE；
 *   4. 纯函数性：两次解析 deepEqual、`Object.freeze(opts)` 不炸不改、`nowIso` 只影响截断；
 *   5. 性能烟测：COUNT=1000 不得退化成 O(n²) 或隐式死循环。
 *
 * **跨机器稳定**原则：带显式 TZID / `Z` 的用例断言绝对时刻（ISO 可写死），
 * DST 与浮动时间的用例一律用 `Intl` 回读墙钟互证，不写死可能随 tzdata 变化的字符串。
 *
 * 末尾 `[缺陷]` 段落是**红灯**用例：写的是"用户需要的正确结果"，当前实现不满足，
 * 已按 QA 报告路由给 Engineer（不改源码、也不放宽断言）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { normalizeTzid, parseIcs, type IcsItem } from '../web/src/lib/ics-parse'

/** 注入的"当前时刻"（固定值：展开窗口与新增上限才可重放）。 */
const NOW = '2026-10-30T12:00:00.000Z'
/** bundle 产物在 `qa/dist/`，向上一级即 `qa/`。 */
const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'ics')

/* ============================== 夹具构造 ============================== */

/** 用行数组拼一段 .ics（CRLF，符合 RFC 5545 §3.1）。 */
function ics(lines: string[]): string {
  return `${lines.join('\r\n')}\r\n`
}

/** 包一层 VCALENDAR。 */
function wrap(body: string[]): string {
  return ics(['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//qa-adversarial//EN', ...body, 'END:VCALENDAR'])
}

/** 包一层 VEVENT。 */
function event(props: string[]): string[] {
  return ['BEGIN:VEVENT', 'DTSTAMP:20261030T000000Z', ...props, 'END:VEVENT']
}

/** 读夹具。 */
function load(name: string): string {
  return readFileSync(resolve(FIXTURE_DIR, name), 'utf8')
}

/** 取第一条 `event`。 */
function firstEvent(items: IcsItem[]): IcsItem {
  const found = items.find((item) => item.kind === 'event')
  assert.ok(found, '应当至少有一个 event')
  return found
}

/** 断言非空 ISO 且可被 `Date.parse` 识别。 */
function assertIso(iso: string | null, message: string): string {
  assert.ok(iso, `${message}：iso 不得为 null`)
  assert.ok(Number.isFinite(Date.parse(iso as string)), `${message}：iso 必须可解析（实际 ${iso}）`)
  return iso as string
}

/* ============================== Intl 互证工具 ============================== */

/**
 * 目标时区在某个**绝对时刻**的偏移（分钟）。
 *
 * 故意用 `timeZoneName: 'longOffset'` 的文本（`GMT+08:00`）解析，
 * 与被测实现（把墙钟字段反算成 UTC 再相减）**不共享代码路径**，
 * 因此两者相符才算真的"与 Intl 自洽"。
 */
function offsetMinutes(iso: string, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    timeZoneName: 'longOffset',
  }).formatToParts(new Date(iso))
  const label = parts.find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
  const matched = /GMT([+-])(\d{2}):(\d{2})/.exec(label)
  if (!matched) return 0 // 'GMT' 本身即 +00:00
  const sign = matched[1] === '-' ? -1 : 1
  return sign * (Number(matched[2]) * 60 + Number(matched[3]))
}

/** 某个**绝对时刻**在目标时区的墙钟（`YYYY-MM-DDTHH:mm:ss`）。 */
function wallClock(iso: string, timeZone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(iso))
  const pick = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00'
  return `${pick('year')}-${pick('month')}-${pick('day')}T${pick('hour')}:${pick('minute')}:${pick('second')}`
}

/** 某个绝对时刻在**运行机器本地**时区的日期（断言浮动时间/全天事件的"本地日期"用）。 */
function machineLocalDate(iso: string | null): string {
  assert.ok(iso, 'iso 不得为 null')
  const date = new Date(iso as string)
  const pad = (value: number): string => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

/* ==========================================================================
 * 1. 时区语义（最高优先）
 * ========================================================================== */

test('时区：TZID=Asia/Shanghai 与 TZID=China Standard Time 同墙钟 → 绝对时刻必须完全相同', () => {
  // 守的洞：Windows 名在 ical.js 里会被**静默当浮动时间**。本机 +08 时"看起来对"，
  // 换到 UTC / UTC-5 的机器就整体偏移 8 小时。这是 P0-1 最致命的一颗雷。
  const ianaText = wrap(
    event([
      'UID:tz-parity@qa',
      'DTSTART;TZID=Asia/Shanghai:20261122T140000',
      'DTEND;TZID=Asia/Shanghai:20261122T150000',
      'RRULE:FREQ=WEEKLY;COUNT=2',
      'SUMMARY:时区对照',
    ]),
  )
  const windowsText = ianaText.replace(/Asia\/Shanghai/g, 'China Standard Time')

  const iana = parseIcs(ianaText, { nowIso: NOW })
  const windows = parseIcs(windowsText, { nowIso: NOW })
  const ianaItem = firstEvent(iana.items)
  const windowsItem = firstEvent(windows.items)

  assert.equal(ianaItem.tzidRaw, 'Asia/Shanghai')
  assert.equal(windowsItem.tzidRaw, 'China Standard Time', '原始 TZID 必须保留，别丢来源信息')
  assert.equal(ianaItem.tzid, 'Asia/Shanghai')
  assert.equal(windowsItem.tzid, 'Asia/Shanghai', 'Windows 名必须归一成 IANA')

  // 核心断言：两条的绝对时刻逐字相等
  assert.equal(windowsItem.startIso, ianaItem.startIso)
  assert.equal(windowsItem.endIso, ianaItem.endIso)
  assert.deepEqual(
    windowsItem.occurrences.map((occurrence) => occurrence.startIso),
    ianaItem.occurrences.map((occurrence) => occurrence.startIso),
  )
  assert.equal(ianaItem.startIso, '2026-11-22T06:00:00.000Z', '14:00 +08 = 06:00Z')

  // 与 Intl 互证：绝对时刻回读该时区墙钟必须仍是 14:00（与运行机器时区无关）
  for (const iso of [ianaItem.startIso, windowsItem.startIso]) {
    assert.equal(wallClock(assertIso(iso, 'startIso'), 'Asia/Shanghai'), '2026-11-22T14:00:00')
  }
})

test('时区：Windows 名跨夏令时展开，每个实例按当日偏移换算（不得全程用同一个偏移）', () => {
  // 守的洞：一旦实现把 Windows 名当"固定偏移"处理，跨 DST 的循环事件会整体偏 1 小时。
  const result = parseIcs(
    wrap(
      event([
        'UID:win-dst@qa',
        'DTSTART;TZID=Eastern Standard Time:20260301T090000',
        'DTEND;TZID=Eastern Standard Time:20260301T100000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:美东周会',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.tzid, 'America/New_York')
  assert.equal(item.occurrences.length, 3)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-03-01', '2026-03-08', '2026-03-15'],
  )
  // 每个实例回读墙钟都必须是 09:00（说明偏移跟着日期走，而不是全程 +?）
  for (const occurrence of item.occurrences) {
    assert.equal(
      wallClock(occurrence.startIso, 'America/New_York'),
      `${occurrence.localDate}T09:00:00`,
      `实例 ${occurrence.localDate} 的墙钟必须仍是 09:00`,
    )
  }
  // 3/1 是 EST(-05:00)，3/8 起是 EDT(-04:00) → 绝对时刻正好差 1 小时
  const firstOffset = offsetMinutes(item.occurrences[0].startIso, 'America/New_York')
  const secondOffset = offsetMinutes(item.occurrences[1].startIso, 'America/New_York')
  assert.equal(firstOffset, -300, '3/1 是 EST(-05:00)')
  assert.equal(secondOffset, -240, '3/8 起是 EDT(-04:00)')
  assert.equal(secondOffset - firstOffset, 60, '跨 DST 后偏移必须东移 1 小时')
})

test('DST 空档：America/New_York 2026-03-08T02:30 不存在，不抛且必须是两个候选偏移之一', () => {
  // 守的洞：墙钟落在"被跳过的一小时"里。有的实现会得到 NaN 或直接抛。
  // 这里只要求"确定 + 落在合法候选里"：要么按切换前偏移（-05:00）解释，要么按切换后（-04:00）。
  const zone = 'America/New_York'
  const text = wrap(
    event(['UID:dst-gap@qa', 'DTSTART;TZID=America/New_York:20260308T023000', 'SUMMARY:空档']),
  )
  const first = parseIcs(text, { nowIso: NOW })
  const second = parseIcs(text, { nowIso: NOW })
  const item = firstEvent(first.items)
  const startIso = assertIso(item.startIso, '空档时刻')

  // 抽样两个**确定无歧义**的时刻拿到切换两侧的偏移（01:30 EST / 03:30 EDT）
  const offsetBefore = offsetMinutes('2026-03-08T06:30:00Z', zone)
  const offsetAfter = offsetMinutes('2026-03-08T07:30:00Z', zone)
  assert.equal(offsetBefore, -300)
  assert.equal(offsetAfter, -240, '抽样时刻必须跨在 DST 切换两侧，否则本用例失去意义')

  const wallAsUtc = Date.parse('2026-03-08T02:30:00Z')
  const candidates = [wallAsUtc - offsetBefore * 60_000, wallAsUtc - offsetAfter * 60_000]
  assert.ok(
    candidates.includes(Date.parse(startIso)),
    `空档墙钟必须落在候选偏移之一（实际 ${startIso}，候选 ${candidates.map((ms) => new Date(ms).toISOString()).join(' / ')}）`,
  )
  assert.equal(item.occurrences[0].localDate, '2026-03-08', '墙钟日期不得跨天')
  assert.deepEqual(second.items, first.items, '同一输入两次解析必须一致（不得依赖机器时钟）')
})

test('DST 重叠：America/New_York 2026-11-01T01:30 出现两次，取值必须落在两个真实时刻之一', () => {
  // 守的洞：重复的一小时里 naive 换算可能落到 ±1 小时的幻觉时刻。
  // 两个合法解：01:30 EDT = 05:30Z、01:30 EST = 06:30Z。
  const zone = 'America/New_York'
  const result = parseIcs(
    wrap(event(['UID:dst-overlap@qa', 'DTSTART;TZID=America/New_York:20261101T013000', 'SUMMARY:重叠'])),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  const startIso = assertIso(item.startIso, '重叠时刻')

  assert.ok(
    ['2026-11-01T05:30:00.000Z', '2026-11-01T06:30:00.000Z'].includes(startIso),
    `重叠墙钟必须落在两个真实时刻之一（实际 ${startIso}）`,
  )
  // 自洽：回读墙钟仍是 01:30
  assert.equal(wallClock(startIso, zone), '2026-11-01T01:30:00')
  assert.equal(item.occurrences[0].localDate, '2026-11-01')
})

test('未知 TZID：不抛、tzid 为 null、按浮动解释，且不得吐"解析失败"级错误', () => {
  // 守的洞：认不出的 TZID 只能退化成浮动（RFC 5545 允许），但**不能**因此炸掉或报成致命错误。
  const result = parseIcs(
    wrap(
      event([
        'UID:mars@qa',
        'DTSTART;TZID=Mars Standard Time:20261122T140000',
        'DTEND;TZID=Mars Standard Time:20261122T150000',
        'SUMMARY:火星会议',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)

  assert.equal(item.tzidRaw, 'Mars Standard Time', '原始值仍要保留，便于上层提示用户')
  assert.equal(item.tzid, null, '认不出的时区不得凭猜测给一个 IANA 名')
  assert.equal(item.startIso, new Date(2026, 10, 22, 14, 0, 0, 0).toISOString(), '按浮动 = 本机本地 14:00')
  const fatal = result.warnings.filter((warning) => warning.includes('失败'))
  assert.deepEqual(fatal, [], `未知时区不是致命错误（实际 ${JSON.stringify(result.warnings)}）`)
  // 现状锁：产品口径由 team-lead 2026-11-02 确认——**本期**不为"认不出的 TZID"产出 warning，
  // 只把 `tzid` 落 null、保留 `tzidRaw` 交给上层。这里锁住"不提示"这个已定口径。
  // 已知风险：非 +08 机器上该条目时间会整体偏移且用户零感知（QA 报告 P2）。
  // 若将来导入 UI 要展示"时区未识别"提示，**本断言需要同步改成正面断言**（`warnings.some(...)`），
  // 而不是删掉它——删掉就丢了这个口径的记录。
  assert.deepEqual(result.warnings, [], '本期口径：未知 TZID 静默按浮动处理，不报错也不提示')
})

test('未知 TZID：名字里带斜杠的伪 IANA 名不得被当成真时区（tzid 必须回落 null）', () => {
  // 守的洞：normalizeTzid 规则 3 是"含 / 就当 IANA 原样放行"，这条要能被 Intl 校验兜住，
  // 否则上层会拿一个不存在的时区名去格式化，轻则 warning、重则抛 RangeError。
  assert.equal(normalizeTzid('Mars/Olympus_Mons'), 'Mars/Olympus_Mons', '归一函数本身按规则 3 放行')

  const result = parseIcs(
    wrap(event(['UID:fake-iana@qa', 'DTSTART;TZID=Mars/Olympus_Mons:20261122T140000', 'SUMMARY:伪 IANA'])),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.tzid, null, 'Intl 不认识的时区必须回落 null，而不是把伪名透给上层')
  assert.equal(item.startIso, new Date(2026, 10, 22, 14, 0, 0, 0).toISOString())
})

test('EXDATE 逗号多值：一条 EXDATE 里的两个时刻都要被剔除', () => {
  // 守的洞：`getFirstPropertyValue('exdate')` 只给第一个值。少剔除 = 用户删掉的会议又冒出来。
  const result = parseIcs(
    wrap(
      event([
        'UID:exdate-multi@qa',
        'DTSTART;TZID=Asia/Shanghai:20261104T140000',
        'DTEND;TZID=Asia/Shanghai:20261104T150000',
        'RRULE:FREQ=WEEKLY;COUNT=5',
        'EXDATE;TZID=Asia/Shanghai:20261111T140000,20261118T140000',
        'SUMMARY:双例外',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.deepEqual(item.exdates.slice().sort(), ['2026-11-11T06:00:00.000Z', '2026-11-18T06:00:00.000Z'])
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-04', '2026-11-25', '2026-12-02'],
  )
})

test('EXDATE;VALUE=DATE：按日期剔除，且 exdates 里保留的是该日（本地）零点', () => {
  // 守的洞：DATE 形态的 EXDATE 走 toJSDate() 会前移一天，导致"没剔对"或"多剔一天"。
  const result = parseIcs(
    wrap(
      event([
        'UID:exdate-date@qa',
        'DTSTART:20261104T140000Z',
        'DTEND:20261104T150000Z',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'EXDATE;VALUE=DATE:20261111',
        'SUMMARY:DATE 例外',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.exdates.length, 1)
  assert.equal(machineLocalDate(item.exdates[0]), '2026-11-11', 'DATE 形态的 EXDATE 不得前移一天')
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-04', '2026-11-18'],
    '11-11 必须被剔除',
  )
})

test('UTC 事件：startIso 正确、tzid 归为 UTC、tzidRaw 为 null（已声明疑点，锁定现状）', () => {
  // 守的洞：`Z` 后缀的时间没有 TZID 参数，若实现误判成"浮动"，跨机器就会整体偏移。
  const result = parseIcs(
    wrap(event(['UID:utc-plain@qa', 'DTSTART:20261122T060000Z', 'DTEND:20261122T070000Z', 'SUMMARY:UTC'])),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.startIso, '2026-11-22T06:00:00.000Z')
  assert.equal(item.endIso, '2026-11-22T07:00:00.000Z')
  assert.equal(item.tzid, 'UTC')
  assert.equal(item.tzidRaw, null, '工程师已声明的现状：UTC 无 TZID 参数，tzidRaw 为 null')
})

/* ==========================================================================
 * 2. 展开正确性
 * ========================================================================== */

test('展开：FREQ=WEEKLY;INTERVAL=2;COUNT=3 必须真跳周（间隔 14 天），不是连周', () => {
  // 守的洞：INTERVAL 被忽略时，用户"每两周"的会议会变成每周，条数翻倍。
  const result = parseIcs(
    wrap(
      event([
        'UID:biweekly@qa',
        'DTSTART;TZID=Asia/Shanghai:20261104T140000',
        'DTEND;TZID=Asia/Shanghai:20261104T150000',
        'RRULE:FREQ=WEEKLY;INTERVAL=2;COUNT=3',
        'SUMMARY:双周会',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-04', '2026-11-18', '2026-12-02'],
  )
  const days = item.occurrences.map((occurrence) => Date.parse(occurrence.startIso) / 86_400_000)
  assert.equal(days[1] - days[0], 14)
  assert.equal(days[2] - days[1], 14)
})

test('展开：DAILY;UNTIL 的边界按 ical.js 实测语义（UNTIL 当天包含在内）', () => {
  // 守的洞：UNTIL 是闭区间还是开区间直接影响"最后一天有没有"。RFC 5545 §3.3.10 规定
  // DTSTART 值类型匹配时 UNTIL 含当刻，ical.js@2.2.1 实测也是**包含**（4 条而非 3 条）。
  // 这个口径一旦变（换库/换版本），本用例会立刻报警。
  const result = parseIcs(
    wrap(
      event([
        'UID:daily-until@qa',
        'DTSTART:20261101T090000Z',
        'DTEND:20261101T100000Z',
        'RRULE:FREQ=DAILY;UNTIL=20261104T090000Z',
        'SUMMARY:到 11-04 为止',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.rrule, 'FREQ=DAILY;UNTIL=20261104T090000Z')
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-01', '2026-11-02', '2026-11-03', '2026-11-04'],
    'UNTIL 当刻那条必须包含（ical.js 实测语义）',
  )
})

test('展开：覆盖实例的 DTSTART 与主事件**跨天**时，条数不变、日期对、recurrenceIdIso 指回原时段', () => {
  // 守的洞：把周会从周二挪到周三。若实现用手写逻辑按"原日期"匹配覆盖，
  // 会既留下原实例又多出一个新实例（条数 +1）或干脆丢掉覆盖。
  const result = parseIcs(
    wrap([
      ...event([
        'UID:cross-day@qa',
        'DTSTART;TZID=Asia/Shanghai:20261125T140000',
        'DTEND;TZID=Asia/Shanghai:20261125T150000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:周二周会',
      ]),
      ...event([
        'UID:cross-day@qa',
        'RECURRENCE-ID;TZID=Asia/Shanghai:20261202T140000',
        'DTSTART;TZID=Asia/Shanghai:20261203T090000',
        'DTEND;TZID=Asia/Shanghai:20261203T100000',
        'SUMMARY:挪到周三上午',
      ]),
    ]),
    { nowIso: NOW },
  )

  assert.equal(result.items.length, 1, '覆盖实例不得单独成为 item')
  const item = firstEvent(result.items)
  assert.equal(item.occurrences.length, 3, '覆盖是"替换"不是"新增"')
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-25', '2026-12-03', '2026-12-09'],
    '12-02 那条必须消失，12-03 出现',
  )
  const moved = item.occurrences[1]
  assert.equal(moved.isOverride, true)
  assert.equal(moved.summary, '挪到周三上午')
  assert.equal(moved.startIso, '2026-12-03T01:00:00.000Z', '09:00 +08 = 01:00Z')
  assert.equal(moved.endIso, '2026-12-03T02:00:00.000Z')
  assert.equal(moved.recurrenceIdIso, '2026-12-02T06:00:00.000Z', 'RECURRENCE-ID 仍指回原定时段 14:00')
})

test('展开：同一文件里两条不同 UID 的循环事件互不串味', () => {
  // 守的洞：iterator / 展开状态若被复用（例如按日历而不是按事件缓存），第二个事件会拿到第一个的实例。
  const result = parseIcs(
    wrap([
      ...event([
        'UID:multi-a@qa',
        'DTSTART:20261101T090000Z',
        'DTEND:20261101T100000Z',
        'RRULE:FREQ=DAILY;COUNT=2',
        'SUMMARY:A',
      ]),
      ...event([
        'UID:multi-b@qa',
        'DTSTART:20261102T120000Z',
        'DTEND:20261102T130000Z',
        'RRULE:FREQ=DAILY;COUNT=3',
        'SUMMARY:B',
      ]),
    ]),
    { nowIso: NOW },
  )
  assert.equal(result.items.length, 2)
  const [a, b] = result.items
  assert.deepEqual(a.occurrences.map((occurrence) => occurrence.localDate), ['2026-11-01', '2026-11-02'])
  assert.deepEqual(b.occurrences.map((occurrence) => occurrence.localDate), [
    '2026-11-02',
    '2026-11-03',
    '2026-11-04',
  ])
  assert.deepEqual(a.occurrences.map((occurrence) => occurrence.summary), ['A', 'A'])
  assert.deepEqual(b.occurrences.map((occurrence) => occurrence.summary), ['B', 'B', 'B'])
})

test('展开：maxOccurrences 与 horizonDays 同时生效时，结果是不重复的"同一序列前缀"', () => {
  // 守的洞：两个上限各自 break 时容易重复 push 或越界（把窗口外那条也塞进来）。
  const infinite = wrap(
    event([
      'UID:double-limit@qa',
      'DTSTART:20261101T090000Z',
      'DTEND:20261101T100000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:无限',
    ]),
  )
  const wide = parseIcs(infinite, { nowIso: NOW, maxOccurrences: 2000, horizonDays: 730 })
  const narrow = parseIcs(infinite, { nowIso: NOW, maxOccurrences: 2000, horizonDays: 3 })

  const wideList = firstEvent(wide.items).occurrences
  const narrowList = firstEvent(narrow.items).occurrences
  assert.ok(wideList.length > narrowList.length, '宽窗口必须比窄窗口多')
  assert.deepEqual(narrowList, wideList.slice(0, narrowList.length), '窄窗口结果必须是宽窗口的前缀')

  // 不重复、单调递增、全部在窗口内
  const starts = narrowList.map((occurrence) => Date.parse(occurrence.startIso))
  assert.equal(new Set(starts).size, starts.length, '不得重复产出同一条实例')
  const horizonMs = Date.parse(NOW) + 3 * 86_400_000
  for (const start of starts) assert.ok(start <= horizonMs, '不得越界产出窗口外的实例')

  const capped = parseIcs(infinite, { nowIso: NOW, maxOccurrences: 4, horizonDays: 730 })
  const cappedList = firstEvent(capped.items).occurrences
  assert.equal(cappedList.length, 4)
  assert.deepEqual(cappedList, wideList.slice(0, 4), 'maxOccurrences 截断同样只能截前缀')
})

test('展开：全天循环（VALUE=DATE + WEEKLY）逐条 localDate 正确、allDay 为真、不带时区', () => {
  // 守的洞：全天事件一旦走 toJSDate() 就会前移一天，循环展开会**每条都**前移。
  const result = parseIcs(
    wrap(
      event([
        'UID:allday-rec@qa',
        'DTSTART;VALUE=DATE:20261106',
        'DTEND;VALUE=DATE:20261107',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:每周五全天',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.allDay, true)
  assert.equal(item.tzid, null)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-06', '2026-11-13', '2026-11-20'],
  )
  for (const occurrence of item.occurrences) {
    assert.equal(occurrence.allDay, true)
    assert.equal(machineLocalDate(occurrence.startIso), occurrence.localDate, '实例 ISO 必须落在同一本地日期')
  }
})

test('展开：全天循环 + VALUE=DATE 的 RECURRENCE-ID 覆盖（挪一天）', () => {
  // 守的洞：DATE 形态的覆盖实例最容易"多一天/少一天"，而且不报错。
  const result = parseIcs(
    wrap([
      ...event([
        'UID:allday-override@qa',
        'DTSTART;VALUE=DATE:20261106',
        'DTEND;VALUE=DATE:20261107',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:每周五全天',
      ]),
      ...event([
        'UID:allday-override@qa',
        'RECURRENCE-ID;VALUE=DATE:20261113',
        'DTSTART;VALUE=DATE:20261114',
        'DTEND;VALUE=DATE:20261115',
        'SUMMARY:改到周六',
      ]),
    ]),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-06', '2026-11-14', '2026-11-20'],
  )
  const moved = item.occurrences[1]
  assert.equal(moved.isOverride, true)
  assert.equal(moved.summary, '改到周六')
  assert.equal(machineLocalDate(moved.recurrenceIdIso), '2026-11-13', 'RECURRENCE-ID 指向原本的 11-13')
})

test('展开：FREQ=HOURLY 同一天的多条实例不得被"按天去重"', () => {
  // 守的洞：若实现把 occurrences 的键写成 localDate，同一天 3 小时会塌成 1 条。
  const result = parseIcs(
    wrap(
      event([
        'UID:hourly@qa',
        'DTSTART:20261101T090000Z',
        'DTEND:20261101T093000Z',
        'RRULE:FREQ=HOURLY;COUNT=3',
        'SUMMARY:每小时',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.startIso),
    ['2026-11-01T09:00:00.000Z', '2026-11-01T10:00:00.000Z', '2026-11-01T11:00:00.000Z'],
  )
})

/* ==========================================================================
 * 3. 容错 / 边界输入
 * ========================================================================== */

test('容错：只有 BEGIN 没有 END 的截断文本不抛，走 warning 而非异常', () => {
  // 守的洞：下载中断 / 编辑器截断的文件不能炸掉整个导入流程。
  const truncated =
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//qa//EN\r\nBEGIN:VEVENT\r\nUID:trunc@qa\r\nDTSTART:20261101T090000Z\r\nSUMMARY:截断'
  const result = parseIcs(truncated, { nowIso: NOW })
  assert.deepEqual(result.items, [], '截断文件解析不出条目（ical.js 严格模式）')
  assert.ok(result.warnings.length >= 1, '必须给出可读 warning，不能静默返回空')
  assert.ok(
    result.warnings.every((warning) => typeof warning === 'string' && warning.trim().length > 0),
    'warning 不得是空串',
  )
})

test('容错：CRLF 与 LF 混用仍能解析（Mac/Linux 客户端导出的常见形态）', () => {
  const mixed =
    'BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//qa//EN\nBEGIN:VEVENT\r\nUID:mixed-eol@qa\nDTSTART:20261101T090000Z\r\nSUMMARY:混用行尾\r\nEND:VEVENT\nEND:VCALENDAR\n'
  const result = parseIcs(mixed, { nowIso: NOW })
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].summary, '混用行尾')
  assert.equal(result.items[0].startIso, '2026-11-01T09:00:00.000Z')
})

test('容错：折行被破坏（续行丢了前导空格）不得静默产出残缺数据', () => {
  // 守的洞：折行还原错位时最坏的结果不是报错，而是把后半行当成新属性、SUMMARY 只剩半截。
  // 这里断言"要么解析出正确条目，要么明确报错"，不接受"悄悄给出残缺标题"。
  const broken = wrap(
    event(['UID:bad-fold@qa', 'DTSTART:20261101T090000Z', 'SUMMARY:被破坏的长标题前半', '后半没有前导空格']),
  )
  const result = parseIcs(broken, { nowIso: NOW })
  if (result.items.length > 0) {
    assert.equal(
      result.items[0].summary,
      '被破坏的长标题前半',
      '若仍给出条目，SUMMARY 不得掺入被当成新行的半截文本',
    )
  } else {
    assert.ok(result.warnings.length >= 1, '整文件放弃时必须明确报错')
  }
})

test('容错：缺 UID 的多条 VEVENT 不得互相合并（实现用 #index 兜底）', () => {
  // 守的洞：分组键若只用 UID，所有"无 UID"的事件会撞到同一个 null 键，被并成 1 条并丢掉其余。
  const result = parseIcs(
    wrap([
      ...event(['DTSTART:20261101T090000Z', 'SUMMARY:无 UID 第一个']),
      ...event(['DTSTART:20261102T090000Z', 'SUMMARY:无 UID 第二个']),
    ]),
    { nowIso: NOW },
  )
  assert.equal(result.items.length, 2, '两条无 UID 事件必须各自成条')
  assert.deepEqual(
    result.items.map((item) => item.uid),
    [null, null],
  )
  assert.deepEqual(
    result.items.map((item) => item.summary),
    ['无 UID 第一个', '无 UID 第二个'],
  )
})

test('容错：无 DTSTART 的 VEVENT 不得抛，item 仍在、startIso 为 null、occurrences 为空', () => {
  // 守的洞：ical.js 的 `event.startDate` getter 在没有 DTSTART 时会抛，不包 try/catch 会炸掉整次导入。
  const result = parseIcs(wrap(event(['UID:no-dtstart@qa', 'SUMMARY:没有开始时间'])), { nowIso: NOW })
  assert.equal(result.items.length, 1, '条目不得丢失（上层要能提示"缺时间"）')
  const item = result.items[0]
  assert.equal(item.uid, 'no-dtstart@qa')
  assert.equal(item.startIso, null)
  assert.equal(item.endIso, null)
  assert.deepEqual(item.occurrences, [])
  assert.equal(item.allDay, false)
})

test('容错：无 DTSTART 但带 RRULE 的事件同样不得抛', () => {
  // 守的洞：`isRecurring()` 为真 + 没有 startDate → iterator() 会抛，必须被兜住。
  const result = parseIcs(
    wrap(event(['UID:no-dtstart-rec@qa', 'RRULE:FREQ=DAILY;COUNT=3', 'SUMMARY:缺开始时间的循环'])),
    { nowIso: NOW },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].startIso, null)
  assert.deepEqual(result.items[0].occurrences, [], '没有基准时刻就无法展开，宁可为空也不要编时间')
})

test('VTODO 带 RRULE：occurrences 必须为空（本阶段不做待办展开）', () => {
  // 守的洞：待办的"循环"语义是"完成后按规则再生成下一次"，直接套 VEVENT 展开会凭空造出一堆待办。
  const result = parseIcs(
    wrap([
      'BEGIN:VTODO',
      'DTSTAMP:20261030T000000Z',
      'UID:todo-rrule@qa',
      'DTSTART;TZID=Asia/Shanghai:20261102T090000',
      'DUE;TZID=Asia/Shanghai:20261102T093000',
      'RRULE:FREQ=WEEKLY;BYDAY=MO',
      'SUMMARY:每周一复盘',
      'END:VTODO',
    ]),
    { nowIso: NOW },
  )
  const todo = result.items[0]
  assert.equal(todo.kind, 'todo')
  assert.equal(todo.isRecurring, true, '规则本身要读出来（后续阶段要用）')
  assert.equal(todo.rrule, 'FREQ=WEEKLY;BYDAY=MO')
  assert.deepEqual(todo.occurrences, [], '本阶段待办不展开实例')
})

test('容错：同 UID 两条主事件（都无 RECURRENCE-ID）只保留第一条并提示', () => {
  // 守的洞：脏数据。静默保留/静默合并都比"保留 + 提示"差；这里锁定后者。
  const result = parseIcs(
    wrap([
      ...event(['UID:dup-master@qa', 'DTSTART:20261101T090000Z', 'SUMMARY:第一条']),
      ...event(['UID:dup-master@qa', 'DTSTART:20261102T090000Z', 'SUMMARY:第二条']),
    ]),
    { nowIso: NOW },
  )
  assert.equal(result.items.length, 1)
  assert.equal(result.items[0].summary, '第一条')
  assert.ok(
    result.warnings.some((warning) => warning.includes('多个主事件')),
    `必须提示数据异常（实际 ${JSON.stringify(result.warnings)}）`,
  )
})

test('容错：一批畸形输入全都不抛（不炸整个导入流程是硬要求）', () => {
  const nasty = [
    '',
    '   ',
    '\r\n\r\n',
    'BEGIN:VCALENDAR',
    'BEGIN:VCALENDAR\r\nEND:VCALENDAR',
    'BEGIN:VEVENT\r\nUID:x@qa\r\nEND:VEVENT',
    '这不是日历',
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nDTSTART:不是时间\r\nEND:VEVENT\r\nEND:VCALENDAR',
    'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nRRULE:这不是规则\r\nDTSTART:20261101T090000Z\r\nEND:VEVENT\r\nEND:VCALENDAR',
  ]
  for (const text of nasty) {
    const result = parseIcs(text, { nowIso: NOW })
    assert.ok(Array.isArray(result.items), `items 必须是数组（输入 ${JSON.stringify(text.slice(0, 30))}）`)
    assert.ok(Array.isArray(result.warnings))
  }
})

/* ==========================================================================
 * 4. 纯函数性 / 不读机器时钟
 * ========================================================================== */

test('纯函数：含循环 + 覆盖 + 全天 + 待办的富文件，两次解析结果 deepEqual', () => {
  // 守的洞：模块级缓存（formatter / 时区校验）若把"上一次解析的状态"带出来，第二次就会变。
  const fixtureText = load('google-weekly-count-exdate.ics')
  const richText = wrap([
    ...event([
      'UID:rich-1@qa',
      'DTSTART;TZID=Asia/Shanghai:20261125T140000',
      'DTEND;TZID=Asia/Shanghai:20261125T150000',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'EXDATE;TZID=Asia/Shanghai:20261209T140000',
      'SUMMARY:周会',
    ]),
    ...event([
      'UID:rich-1@qa',
      'RECURRENCE-ID;TZID=Asia/Shanghai:20261202T140000',
      'DTSTART;TZID=Asia/Shanghai:20261202T160000',
      'DTEND;TZID=Asia/Shanghai:20261202T170000',
      'SUMMARY:改时间',
    ]),
    ...event(['UID:rich-2@qa', 'DTSTART;VALUE=DATE:20261120', 'SUMMARY:全天']),
    'BEGIN:VTODO',
    'DTSTAMP:20261030T000000Z',
    'UID:rich-3@qa',
    'SUMMARY:待办',
    'DUE;TZID=Asia/Shanghai:20261105T180000',
    'END:VTODO',
  ])

  for (const text of [fixtureText, richText]) {
    const first = parseIcs(text, { nowIso: NOW })
    const second = parseIcs(text, { nowIso: NOW })
    assert.deepEqual(second, first)
  }
})

test('纯函数：传入 Object.freeze 的 opts 不抛、不被改写', () => {
  // 守的洞：实现若给 opts 补默认值（`opts.maxOccurrences ??= 200`），冻结对象会抛 TypeError，
  // 而"补默认值"这件事本身会让调用方的配置对象被污染。
  const text = load('google-weekly-count-exdate.ics')
  const opts = Object.freeze({ nowIso: NOW, maxOccurrences: 5, horizonDays: 30 })

  const result = parseIcs(text, opts)
  assert.ok(result.items.length > 0)
  assert.deepEqual(Object.keys(opts).sort(), ['horizonDays', 'maxOccurrences', 'nowIso'], 'opts 键集合不得改变')
  assert.deepEqual({ ...opts }, { nowIso: NOW, maxOccurrences: 5, horizonDays: 30 }, 'opts 值不得改变')
})

test('纯函数：nowIso / horizonDays 只影响"截断"，不得改变已有实例的字段值', () => {
  // 守的洞：实现若在展开里读真实时钟（如用 `Date.now()` 补 DTSTAMP），非循环条目的时间也会漂。
  const infinite = wrap(
    event([
      'UID:clock-gate@qa',
      'DTSTART:20261101T090000Z',
      'DTEND:20261101T100000Z',
      'RRULE:FREQ=DAILY',
      'SUMMARY:无限',
    ]),
  )
  const nonRecurring = wrap(
    event(['UID:clock-gate-single@qa', 'DTSTART;TZID=Asia/Shanghai:20261122T140000', 'SUMMARY:单次']),
  )

  const early = parseIcs(infinite, { nowIso: '2026-10-30T12:00:00.000Z', maxOccurrences: 3 })
  const late = parseIcs(infinite, { nowIso: '2030-01-01T00:00:00.000Z', maxOccurrences: 3 })
  assert.deepEqual(
    late.items[0].occurrences,
    early.items[0].occurrences,
    'nowIso 变了但截断到前 3 条时，这 3 条的字段必须逐字相同',
  )

  const singleA = parseIcs(nonRecurring, { nowIso: '2020-01-01T00:00:00.000Z' })
  const singleB = parseIcs(nonRecurring, { nowIso: '2035-12-31T23:59:59.000Z' })
  assert.equal(singleB.items[0].startIso, singleA.items[0].startIso, '非循环条目的时间与 nowIso 无关')
  assert.equal(singleB.items[0].occurrences[0].startIso, singleA.items[0].occurrences[0].startIso)

  // 时间窗确实只改变"条数"，不改变已有实例
  const narrow = parseIcs(infinite, { nowIso: NOW, maxOccurrences: 2000, horizonDays: 3 })
  const broad = parseIcs(infinite, { nowIso: NOW, maxOccurrences: 2000, horizonDays: 30 })
  assert.ok(narrow.items[0].occurrences.length < broad.items[0].occurrences.length)
  assert.deepEqual(broad.items[0].occurrences.slice(0, 2), narrow.items[0].occurrences)
})

test('纯函数：horizonDays=0 与负数被夹取，不得越界产出，也不得死循环', () => {
  const infinite = wrap(
    event(['UID:zero-horizon@qa', 'DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', 'RRULE:FREQ=DAILY']),
  )
  const zero = parseIcs(infinite, { nowIso: NOW, horizonDays: 0 })
  assert.deepEqual(firstEvent(zero.items).occurrences, [], '窗口右界 = now，11-01 的实例全在窗外')
  assert.ok(
    zero.warnings.some((warning) => warning.includes('时间窗')),
    `必须提示被时间窗截断（实际 ${JSON.stringify(zero.warnings)}）`,
  )
  const negative = parseIcs(infinite, { nowIso: NOW, horizonDays: -30 })
  assert.deepEqual(firstEvent(negative.items).occurrences, [], '负值夹取到 0，不得变成"无限窗口"')
})

/* ==========================================================================
 * 5. 性能烟测
 * ========================================================================== */

test('性能：COUNT=1000 + maxOccurrences=1000 + horizonDays=2000 在 1500ms 内出 1000 条', () => {
  // 守的洞：O(n²)（每条都从头重算 iterator）或隐式死循环。阈值放得很宽，只抓量级问题。
  const text = wrap(
    event([
      'UID:perf-1000@qa',
      'DTSTART:20261101T090000Z',
      'DTEND:20261101T100000Z',
      'RRULE:FREQ=DAILY;COUNT=1000',
      'SUMMARY:千条压测',
    ]),
  )
  const startedAt = Date.now()
  const result = parseIcs(text, { nowIso: NOW, maxOccurrences: 1000, horizonDays: 2000 })
  const elapsed = Date.now() - startedAt

  const occurrences = firstEvent(result.items).occurrences
  assert.equal(occurrences.length, 1000)
  assert.deepEqual(result.warnings, [], '恰好等于上限时不算截断')
  assert.equal(new Set(occurrences.map((occurrence) => occurrence.startIso)).size, 1000, '不得重复产出')
  assert.ok(elapsed < 1500, `展开 1000 条耗时 ${elapsed}ms，超过 1500ms 阈值（疑似 O(n²)）`)
})

/* ==========================================================================
 * 6. normalizeTzid 对抗补充（工程用例已覆盖主流名字，这里只补边界）
 * ========================================================================== */

test('normalizeTzid：首尾空白 / 大小写 / 伪 IANA / 裸缩写 的判定顺序', () => {
  assert.equal(normalizeTzid('  china standard time  '), 'Asia/Shanghai', '大小写 + 空白都要容错')
  assert.equal(normalizeTzid('\tAsia/Shanghai\n'), 'Asia/Shanghai')
  assert.equal(normalizeTzid('ASIA/SHANGHAI'), 'ASIA/SHANGHAI', '含 / 视为 IANA 原样返回（保留调用方大小写）')
  assert.equal(normalizeTzid('Mars/Olympus_Mons'), 'Mars/Olympus_Mons', '伪 IANA 由 Intl 校验兜底，不由本函数判')
  assert.equal(normalizeTzid('CST'), null, '裸缩写在 IANA 里不唯一，只能丢弃')
  assert.equal(normalizeTzid('GMT+8'), null)
})

/* ==========================================================================
 * 7. 缺陷回归门 —— 2026-11-02 Round 1 报出、当日修复的 4 个缺陷
 *
 * 这 4 条在 Round 1 是红灯（当时是"待修缺陷"），现已全部转绿，转为**回归门**。
 * 用例名与注释都按"期望行为"描述（历史原因不再写成"当前不满足"）。
 * **不要在绿灯时放宽这里的断言**：它们各自对应一个真实踩过的坑，
 * 修法细节见 QA Round 1 报告（EXDATE/RECURRENCE-ID 的 Z 形式、DTEND 混用时区、UTF-8 BOM）。
 * ========================================================================== */

test('[缺陷回归] EXDATE 用 Z 形式（UTC）时必须剔除该实例，且 exdates 与 occurrences 不得自相矛盾', () => {
  // 坑（已修）：DTSTART 用 TZID、EXDATE 用等价的 `...Z` 写法（RFC 5545 §3.8.5.1 允许按 UTC 表达）。
  // 文件内没有 VTIMEZONE 时，ical.js 把 DTSTART 当浮动时间（14:00），EXDATE 却是 06:00Z，
  // 两边键对不上 → 用户显式删掉的那次会议照样被导入；而 item.exdates 里已经有 06:00Z，
  // occurrences 里又有这条 → 输出自相矛盾。修复方式是展开后按绝对时刻兜底剔除。
  const result = parseIcs(
    wrap(
      event([
        'UID:exdate-z@qa',
        'DTSTART;TZID=Asia/Shanghai:20261104T140000',
        'DTEND;TZID=Asia/Shanghai:20261104T150000',
        'RRULE:FREQ=WEEKLY;COUNT=4',
        'EXDATE:20261111T060000Z',
        'SUMMARY:Z 形式例外',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.deepEqual(item.exdates, ['2026-11-11T06:00:00.000Z'], 'exdates 已正确归一')
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.localDate),
    ['2026-11-04', '2026-11-18', '2026-11-25'],
    'exdates 里列出的时刻不得同时出现在 occurrences 里',
  )
})

test('[缺陷回归] RECURRENCE-ID 用 Z 形式（UTC）时覆盖必须生效：isOverride / 新时间 / 指回原时段', () => {
  // 坑（已修）：主事件 DTSTART 用 TZID、覆盖实例的 RECURRENCE-ID 用等价的 `...Z`。
  // ical.js 的 exceptions 键是 '2026-12-02T06:00:00Z'，而迭代出来的实例是浮动 '2026-12-02T14:00:00'，
  // 键对不上 → 覆盖曾被**静默**忽略：用户改过的那次会议退回原时间，且没有任何 warning。
  // 修复方式：用 RECURRENCE-ID 自己属性的 TZID 归一成绝对时刻做键，未生效则原地替换该条实例。
  const result = parseIcs(
    wrap([
      ...event([
        'UID:rid-utc@qa',
        'DTSTART;TZID=Asia/Shanghai:20261125T140000',
        'DTEND;TZID=Asia/Shanghai:20261125T150000',
        'RRULE:FREQ=WEEKLY;COUNT=3',
        'SUMMARY:原定时段',
      ]),
      ...event([
        'UID:rid-utc@qa',
        'RECURRENCE-ID:20261202T060000Z',
        'DTSTART;TZID=Asia/Shanghai:20261202T160000',
        'DTEND;TZID=Asia/Shanghai:20261202T170000',
        'SUMMARY:改到 16:00',
      ]),
    ]),
    { nowIso: NOW },
  )
  assert.equal(result.items.length, 1)
  const item = firstEvent(result.items)
  assert.equal(item.occurrences.length, 3, '覆盖是替换，不是新增')
  const overridden = item.occurrences.find((occurrence) => occurrence.localDate === '2026-12-02')
  assert.ok(overridden, '12-02 那条必须仍在')
  assert.equal(overridden?.isOverride, true, '必须被识别为覆盖实例')
  assert.equal(overridden?.summary, '改到 16:00')
  assert.equal(overridden?.startIso, '2026-12-02T08:00:00.000Z', '16:00 +08 = 08:00Z')
  assert.equal(overridden?.recurrenceIdIso, '2026-12-02T06:00:00.000Z', '指回原定时段 14:00')
})

test('[缺陷回归] DTEND 用 Z 形式而 DTSTART 带 TZID 时，endIso 必须按 UTC 解释且不早于 startIso', () => {
  // 坑（已修）：DTEND 没有 TZID 参数时代码回退用 DTSTART 的 TZID（`?? startTzidRaw`），
  // 于是把一个 **UTC** 值当成"+08 墙钟"再换算一次 → 结束时间比开始时间早 8 小时。
  // 修复方式：`resolveTime` 把"值自带 Z"前置成最高优先级的规则，压过任何 TZID 回退。
  const result = parseIcs(
    wrap(
      event([
        'UID:end-utc@qa',
        'DTSTART;TZID=Asia/Shanghai:20261122T140000',
        'DTEND:20261122T070000Z',
        'SUMMARY:DTEND 用 UTC',
      ]),
    ),
    { nowIso: NOW },
  )
  const item = firstEvent(result.items)
  assert.equal(item.startIso, '2026-11-22T06:00:00.000Z')
  assert.equal(item.endIso, '2026-11-22T07:00:00.000Z', 'DTEND 自带 Z，必须按 UTC 解释，不能再套 DTSTART 的时区')
  assert.ok(
    Date.parse(assertIso(item.endIso, 'endIso')) > Date.parse(assertIso(item.startIso, 'startIso')),
    '结束时刻必须晚于开始时刻（不得出现负时长）',
  )
  assert.equal(item.occurrences[0].endIso, '2026-11-22T07:00:00.000Z', '展开实例同样不得出现负时长')
})

test('[缺陷回归] DTEND 混用 Z 的判定必须与运行机器时区无关：6 组时区（含半时区/南半球/Windows 名）抽查', () => {
  // 守的洞：同一份"DTSTART 带 TZID + DTEND 用 Z"的文件，必须**每台机器**都算出同一个绝对值。
  // 只测 +08 一组会被"本机恰好 +08"掩盖（这正是 README 里那颗只在非 +08 机器上炸的雷）。
  // 期望值都是"墙钟 + 1 小时"换算成 UTC 的确定值（2026-11-22 的偏移稳定：伦敦 +00 / 纽约 -05 / 奥克兰 +13）。
  const cases: Array<{
    label: string
    tzidRaw: string
    zone: string
    dtstart: string
    expectStart: string
    expectEnd: string
  }> = [
    {
      label: 'Asia/Shanghai +08',
      tzidRaw: 'Asia/Shanghai',
      zone: 'Asia/Shanghai',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T06:00:00.000Z',
      expectEnd: '2026-11-22T07:00:00.000Z',
    },
    {
      label: 'Windows 名 China Standard Time',
      tzidRaw: 'China Standard Time',
      zone: 'Asia/Shanghai',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T06:00:00.000Z',
      expectEnd: '2026-11-22T07:00:00.000Z',
    },
    {
      label: 'Europe/London（冬令时 +00）',
      tzidRaw: 'Europe/London',
      zone: 'Europe/London',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T14:00:00.000Z',
      expectEnd: '2026-11-22T15:00:00.000Z',
    },
    {
      label: 'America/New_York（EST -05）',
      tzidRaw: 'America/New_York',
      zone: 'America/New_York',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T19:00:00.000Z',
      expectEnd: '2026-11-22T20:00:00.000Z',
    },
    {
      label: 'Asia/Kolkata（+05:30 半时区）',
      tzidRaw: 'Asia/Kolkata',
      zone: 'Asia/Kolkata',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T08:30:00.000Z',
      expectEnd: '2026-11-22T09:30:00.000Z',
    },
    {
      label: 'Pacific/Auckland（+13 南半球）',
      tzidRaw: 'Pacific/Auckland',
      zone: 'Pacific/Auckland',
      dtstart: '20261122T140000',
      expectStart: '2026-11-22T01:00:00.000Z',
      expectEnd: '2026-11-22T02:00:00.000Z',
    },
  ]

  /** 把"某时区的 15:00 墙钟"换算成 UTC ISO（用 `Intl` 的 longOffset 文本，不与实现共享路径）。 */
  const wallToUtcIso = (zone: string, wallTime: string): string => {
    const offsetLabel =
      new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'longOffset' })
        .formatToParts(new Date(`2026-11-22T${wallTime}:00Z`))
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT'
    const matched = /GMT([+-])(\d{2}):(\d{2})/.exec(offsetLabel)
    const offsetMinutesOfZone = matched
      ? (matched[1] === '-' ? -1 : 1) * (Number(matched[2]) * 60 + Number(matched[3]))
      : 0
    return new Date(Date.parse(`2026-11-22T${wallTime}:00Z`) - offsetMinutesOfZone * 60_000).toISOString()
  }

  for (const testCase of cases) {
    // 期望值先用 Intl 校一遍（防止我表里手抄错）
    assert.equal(wallToUtcIso(testCase.zone, '15:00'), testCase.expectEnd, `${testCase.label}：表里的期望值自洽`)

    const text = wrap(
      event([
        `UID:mixed-end-${testCase.zone.replace(/\W/g, '')}@qa`,
        `DTSTART;TZID=${testCase.tzidRaw}:${testCase.dtstart}`,
        `DTEND:${testCase.expectEnd.replace(/[-:]/g, '').replace('.000', '')}`, // 形如 20261122T070000Z
        'SUMMARY:混用 DTEND',
      ]),
    )
    const item = firstEvent(parseIcs(text, { nowIso: NOW }).items)

    assert.equal(item.startIso, testCase.expectStart, `${testCase.label}：startIso`)
    assert.equal(item.endIso, testCase.expectEnd, `${testCase.label}：endIso（UTC 值不得被 TZID 回退改写）`)
    assert.equal(
      Date.parse(assertIso(item.endIso, 'endIso')) - Date.parse(assertIso(item.startIso, 'startIso')),
      3_600_000,
      `${testCase.label}：时长必须正好 1 小时（出现负值说明 UTC 值被当成墙钟又换算了一次）`,
    )
    assert.equal(wallClock(item.startIso as string, testCase.zone), '2026-11-22T14:00:00', `${testCase.label}：墙钟不得漂移`)
    assert.equal(item.occurrences[0].endIso, testCase.expectEnd, `${testCase.label}：实例级 endIso`)
  }
})

test('缺陷回归：循环事件的实例级 endIso 必须等于 startIso + 时长（DTEND 用 Z 形式时不得出现负时长）', () => {
  // 坑（2026-11-02 Round 2 抽查发现，未修）：item 级 endIso 已正确（07:00Z），但**实例级**全是负时长。
  // 根因：`getOccurrenceDetails().endDate` 的 zone 是 **floating**（不是 UTC），新加的"UTC 前置"规则救不到；
  // 而 `makeOccurrence` 里 `endTzidRaw ?? tzidRaw` 又把它当 +08 墙钟换算了一次。
  // 更糟的是 ical.js 自己算出的 duration 本身就是 -25200s（-7 小时），
  // 所以正确修法是"用 item 级已解析的 start/end 求出时长，再逐实例套到 startIso 上"，而不是复用 details.endDate。
  const text = wrap(
    event([
      'UID:rec-end-z@qa',
      'DTSTART;TZID=China Standard Time:20261122T140000',
      'DTEND:20261122T070000Z',
      'RRULE:FREQ=WEEKLY;COUNT=3',
      'SUMMARY:循环 + UTC DTEND',
    ]),
  )
  const item = firstEvent(parseIcs(text, { nowIso: NOW }).items)

  assert.equal(item.startIso, '2026-11-22T06:00:00.000Z')
  assert.equal(item.endIso, '2026-11-22T07:00:00.000Z', 'item 级已经正确，实例级必须与它一致')
  assert.equal(item.occurrences.length, 3)
  assert.deepEqual(
    item.occurrences.map((occurrence) => occurrence.endIso),
    ['2026-11-22T07:00:00.000Z', '2026-11-29T07:00:00.000Z', '2026-12-06T07:00:00.000Z'],
    '每个实例必须是 startIso + 1 小时，不得是负时长',
  )
  for (const occurrence of item.occurrences) {
    assert.ok(
      Date.parse(assertIso(occurrence.endIso, 'endIso')) > Date.parse(assertIso(occurrence.startIso, 'startIso')),
      `实例 ${occurrence.localDate} 的结束时刻必须晚于开始时刻`,
    )
  }
})

test('[缺陷回归] 文本以 UTF-8 BOM 开头时仍必须解析出条目（不得整文件丢弃）', () => {
  // 坑（已修）：Windows 记事本 / 部分导出器会写 UTF-8 BOM。`ICAL.parse` 遇到 BOM 直接抛，
  // 于是整个文件被当成"解析失败"，用户导入一个正常的日历却得到 0 条。
  // 注意 `'\uFEFF'.trim() === ''`，所以空文本守卫拦不住"BOM + 正文"，必须显式剥 BOM。
  const text = `\uFEFF${wrap(
    event(['UID:bom@qa', 'DTSTART:20261101T090000Z', 'DTEND:20261101T100000Z', 'SUMMARY:BOM 文件']),
  )}`
  const result = parseIcs(text, { nowIso: NOW })
  assert.equal(result.items.length, 1, 'BOM 只是元信息，不得导致整文件丢弃')
  assert.equal(result.items[0].summary, 'BOM 文件')
  assert.equal(result.items[0].startIso, '2026-11-01T09:00:00.000Z')
})

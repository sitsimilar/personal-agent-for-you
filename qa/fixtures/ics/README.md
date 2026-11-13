# ICS 夹具（日历互通 P0-1 / P0-2 用）

2026-10-30 建立。**这些文件不是随手写的示例，而是 P0-1 解析层单测的输入基准**：
每个文件对应一组必须通过的预期值，改动夹具等于改动验收线。

## 规格约定

- 行尾 **CRLF**（RFC 5545 §3.1）。
- 内容行按 UTF-8 **75 字节折行**，续行以 1 个空格开头。已实测：还原后与原文逐字一致。
- 文件名即用例名，**不要重命名**，单测按文件名引用。

## 用例矩阵

| 文件 | 覆盖点 | 必须通过的预期 |
|---|---|---|
| `google-weekly-count-exdate.ics` | VTIMEZONE + `TZID` + `RRULE COUNT` + `EXDATE` + `RECURRENCE-ID` 覆盖 + `VALARM` | 展开 **5** 个实例（`COUNT=6` 减 `EXDATE` 1 个）；首例 `2026-11-04T06:00Z`（= 14:00 +08）；**不含** `2026-11-18`；`2026-11-25` 被覆盖实例替换（SUMMARY 变「改到 16:00」、时间变 16:00）；`VALARM TRIGGER = -PT15M` |
| `apple-monthly-byday-until.ics` | `RRULE FREQ=MONTHLY;BYDAY=2TU;UNTIL`（每月的第 N 个星期几） | 展开 **5** 个实例：11-10 / 12-08 / 01-12 / 02-09 / 03-09，全部 09:30 +08；`UNTIL` 之后停止 |
| `outlook-allday-floating.ics` | 全天事件（`VALUE=DATE`）+ 浮动时间（无 TZID 无 Z）+ Windows 时区名 TZID | 三条都能解析；第 1 条 `isDate=true`；第 2 条按**本地**时间解释（不得当 UTC）；第 3 条 TZID 为 `China Standard Time`（非 IANA，文件内无 VTIMEZONE） |
| `radicale-vtodo.ics` | `VTODO` 四态：定时 DUE / 仅日期 DUE / 带 RRULE / 已完成；`PRIORITY` `STATUS` `PERCENT-COMPLETE` `CATEGORIES` `RELATED-TO` | 4 条 VTODO；`PRIORITY` 1/5/9/3 原样读出；`DUE` 能区分 DATE 与 DATETIME；第 3 条读出 `RRULE:FREQ=WEEKLY;BYDAY=MO`；第 2 条 `RELATED-TO` 指回第 1 条 |
| `self-export-roundtrip.ics` | 本产品 `lib/ics.ts` 的导出格式（UTC `Z` + `X-WR-TIMEZONE` + VTODO/VEVENT 成对）+ 转义 + 折行 | SUMMARY 还原为 **80 字**且逐字一致（不得多空格/漏字）；`\,` `\;` `\\` `\n` 四类转义全部还原；已完成 VTODO 的 `STATUS=COMPLETED` 可读 |
| `jtxboard-journal.ics` | jtxBoard 单文件混合格式：1 `VEVENT` + 3 `VTODO` + 1 `VJOURNAL`（正好 **5** 个组件）+ 多值 `CATEGORIES` + `PRIORITY` 1/5/9 + `STATUS:COMPLETED`/`CANCELLED` + `DUE;VALUE=DATE` + `COMPLETED` | 导入后记录数 = **5**（event/todo/journal = 1/3/1，`cancelled` = 1）；`PRIORITY:1` → `priority=high`；已完成那条 `todoStatus=done` 且 `record_meta.completedAt` 非空；`STATUS:CANCELLED` 那条落库 `is_deleted=true`；`VJOURNAL` 落成 `type=idea` 且 `remindAt=null`；`CATEGORIES:工作/会议,会议` → `category=工作/会议` 且 `tags` 两条都在 |

## 实测结论（2026-10-30，ical.js@2.2.1）

用 `ical.js` 跑通全部 5 个夹具，四个必须写进实现里的坑：

1. **`DTSTART` 是否只有日期必须靠 `isDate` 判断，不能靠字符串长度**。
   `20261120`（`VALUE=DATE`）→ `toJSDate()` 得到 `2026-11-19T16:00:00Z`，
   即"+08 的当天 00:00"。只有 `isDate` 为真时才按"本地日期"处理，否则会把全天事件落到前一天。
2. **`toJSDate()` 一定是落库前的最后一步**。`ICAL.Time.toString()` 会丢掉 zone 信息，
   直接存字符串会得到没有时区的裸时间。
3. **Windows 时区名（`China Standard Time`）不会报错，会静默按本地时区解释**。
   本机是 +08，所以"看起来是对的"——**这是一颗只在非 +08 机器上才炸的雷**。
   P0-1 必须内置 Windows → IANA 名称映射表（至少覆盖 `China Standard Time` → `Asia/Shanghai`），
   且单测要断言"解析出的时区标识"，不能只断言时刻。
4. **`CATEGORIES` 是多值属性**，`getFirstPropertyValue('categories')` 只返回第一个
   （实测 `工作,财务` 只读到 `工作`）。要全取必须用 `getValues()`。

另：`EXDATE` 与 `RECURRENCE-ID` 由 `ical.js` 的 `Event.iterator()` 与 master/override 关系处理，
**不要自己手写展开逻辑**；但 iterator 只在 `isRecurring()` 为真时才有意义，非循环事件直接取 `startDate`。

## 校验方式

单测跑通即可，不需要额外脚本。若要人工复核，用临时目录装 `ical.js@2.2.1`：

```bash
mkdir -p /tmp/ical && cd /tmp/ical && npm init -y
npm install ical.js@2.2.1 --registry=https://registry.npmmirror.com
# 然后 require('ical.js') 读本目录的 .ics
```

> 临时目录用完即删，**不要**把 `ical.js` 装到仓库根目录来"验证"——依赖只应加在 `web/`。

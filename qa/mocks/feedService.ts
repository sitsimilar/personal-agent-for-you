/**
 * feedService 的极简 mock（仅供「提醒链路 ↔ 订阅抓取」隔离用例使用）。
 *
 * 只替换 `runFeedTickIfDue`：真实现会读 settings、发网络请求、写记录，
 * 而这条用例要验证的是**提醒调度器有没有被订阅抓取污染**，与抓取本身无关。
 *
 * 通过 `alias` 把 `@/services/feedService` 指到本文件（见 qa/run-tests.mjs），
 * 因此不会影响其它用例使用真实实现。
 */

/** mock 入参形状（只声明用例关心的字段）。 */
export interface FeedTickMockOptions {
  quiet?: boolean
  now?: string
  minIntervalMs?: number
  limit?: number
}

/** mock 实现签名。 */
export type FeedTickMockImpl = (options?: FeedTickMockOptions) => Promise<unknown>

let impl: FeedTickMockImpl = async () => null

/** 每次调用记录入参（断言「quiet 是否被正确传入」）。 */
export const __feedTickCalls: Array<FeedTickMockOptions | undefined> = []

/** 注入实现（例如「直接抛异常」）。 */
export function __setFeedTickMock(fn: FeedTickMockImpl): void {
  impl = fn
}

/** 复位实现与调用记录。 */
export function __resetFeedTickMock(): void {
  impl = async () => null
  __feedTickCalls.length = 0
}

/** 被 reminderService.scheduleFeedTick 调用的入口。 */
export async function runFeedTickIfDue(options?: FeedTickMockOptions): Promise<unknown> {
  __feedTickCalls.push(options)
  return impl(options)
}

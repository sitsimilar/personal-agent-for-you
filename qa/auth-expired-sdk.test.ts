/**
 * web/src/lib/unwrap.ts 的 isAuthExpired() 针对「真实云 SDK CloudError 判别联合形状」的回归测试。
 *
 * 真实形状（web/node_modules/@tencent-ai/workbuddy-cloud-sdk/lib/index.d.ts）：
 *   interface CloudError {
 *     kind: 'unauthenticated' | 'permission-denied' | 'not-found' | 'invalid-request'
 *         | 'unimplemented' | 'credits-exhausted' | 'rate-limited'
 *         | 'backend-unavailable' | 'network' | 'unknown'
 *     message: string
 *     status: number          // 网络层失败为 0
 *     code?: string           // 上游原始错误码，如 'invalid_grant' / '42501'
 *     cause?: unknown         // 上游原始错误体，原样保留
 *   }
 * 契约：kind 是稳定编程契约；kind==='unauthenticated' 或 code==='invalid_grant' 应清凭据。
 * 运行方式：node qa/run-tests.mjs。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isAuthExpired } from '../web/src/lib/unwrap'

test('isAuthExpired：真实 SDK 的 401 失效变体全部识别为 true', () => {
  const expired: unknown[] = [
    // 核心契约：SDK 把 401 / invalid_grant 归一为 kind='unauthenticated'
    {
      kind: 'unauthenticated',
      message: '未登录或 token 已失效',
      status: 401,
      code: 'invalid_grant',
      cause: { error: 'invalid_grant', error_description: 'Token expired' },
    },
    { kind: 'unauthenticated', message: '未登录或 token 已失效', status: 401 },
    { kind: 'unauthenticated', message: '未登录或 token 已失效', status: 401, code: 'invalid_jwt' },
    // 仅有 status=401（防御性结构，SDK 不会单独丢出，但需兼容）
    { message: 'Unauthorized', status: 401 },
    // code 变体：SDK 的 errorKind 对 invalid_grant 即使 HTTP 400 也归一 unauthenticated
    { message: 'invalid grant', status: 400, code: 'invalid_grant' },
    { message: 'jwt invalid', code: 'invalid_jwt' },
    { message: 'session gone', code: 'session_not_found' },
    // 上游 OAuth2 原始错误体经 cause 原样保留的失效信号
    {
      kind: 'unknown',
      message: 'HTTP 400',
      status: 400,
      code: undefined,
      cause: { error: 'invalid_grant', error_description: 'expired' },
    },
    // statusCode / httpStatus 防御性结构（LLM OpenAI 错误体用 statusCode?: string）
    { message: 'Unauthorized', statusCode: 401 },
    { message: 'Unauthorized', statusCode: '401' },
    { message: 'Unauthorized', httpStatus: 401 },
  ]
  for (const v of expired) {
    assert.equal(isAuthExpired(v), true, `应识别为失效：${JSON.stringify(v)}`)
  }
})

test('isAuthExpired：非失效错误不误判为 true', () => {
  const notExpired: unknown[] = [
    { kind: 'network', message: 'fetch failed: ECONNREFUSED', status: 0 },
    { kind: 'permission-denied', message: 'RLS 拒绝', status: 403, code: '42501' },
    { kind: 'not-found', message: 'not found', status: 404 },
    { kind: 'invalid-request', message: 'bad request', status: 400 },
    { kind: 'backend-unavailable', message: '服务不可用', status: 503 },
    { kind: 'rate-limited', message: 'too many', status: 429 },
    { message: 'Internal Server Error', status: 500 },
    { message: 'Forbidden', status: 403, code: '42501' },
    // cause 为非失效错误码时不得误判
    { kind: 'unknown', message: 'HTTP 400', status: 400, cause: { error: 'invalid_request' } },
    null,
    undefined,
    {},
  ]
  for (const v of notExpired) {
    assert.equal(isAuthExpired(v), false, `不应识别为失效：${JSON.stringify(v)}`)
  }
})

test('isAuthExpired：仅凭 message 文本（含 expired/401）不误判登出', () => {
  assert.equal(isAuthExpired({ message: 'JWT expired at 2026-01-01', status: 200 }), false)
  assert.equal(isAuthExpired({ message: 'HTTP 401 Unauthorized（第三方业务文案）' }), false)
})

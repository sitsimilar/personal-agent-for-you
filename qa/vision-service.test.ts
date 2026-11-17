/**
 * 机器视觉 · 服务层重试策略单元测试
 * ============================================================================
 * 只测 isTransient —— 它是"要不要重试"的唯一判据，错了会造成两种事故：
 * - 把 401 判成可重试 → 连着失败两次，用户以为卡死；
 * - 把超时判成不可重试 → 偶发网络抖动直接失败，稳定性倒退。
 *
 * 这里不 mock 网络：isTransient 是纯函数，直接喂错误消息即可。
 */

import { test } from 'node:test'
import assert from 'node:assert/strict'
import { isTransient } from '../web/src/services/visionService'

const err = (msg: string) => new Error(msg)

test('isTransient：网络类错误可重试', () => {
  for (const m of ['fetch failed', 'request timeout', 'ECONNRESET', 'ETIMEDOUT', 'socket hang up', 'EAI_AGAIN']) {
    assert.equal(isTransient(err(m)), true, m)
  }
})

test('isTransient：5xx / 429 可重试', () => {
  for (const m of ['HTTP 500', 'HTTP 502 Bad Gateway', 'server error', '429 Too Many Requests', '服务繁忙']) {
    assert.equal(isTransient(err(m)), true, m)
  }
})

test('isTransient：401/403 不重试（会话问题，重试无意义）', () => {
  for (const m of ['HTTP 401 Unauthorized', '403 Forbidden', '未登录', '无权限']) {
    assert.equal(isTransient(err(m)), false, m)
  }
})

test('isTransient：输入不可用不重试（图有问题，重试还是同一张）', () => {
  for (const m of ['请先选择至少一张图片', '无法识别这张图的格式', '图片尺寸无效（0×0）', '仅支持 JPEG/PNG/WebP 格式']) {
    assert.equal(isTransient(err(m)), false, m)
  }
})

test('isTransient：没有视觉模型不重试（配置问题）', () => {
  assert.equal(isTransient(err('当前没有支持图像识别的模型，请稍后再试')), false)
})

test('isTransient：非 Error 输入也不抛错', () => {
  assert.equal(isTransient(null), false)
  assert.equal(isTransient(undefined), false)
  assert.equal(isTransient({ message: 'timeout' }), false, '非 Error 对象按消息取不到，按不可重试处理')
})

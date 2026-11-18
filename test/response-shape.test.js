/**
 * @file 真实响应结构兼容性测试（node:test，零依赖）。
 *
 * 背景（真实生产事故）：用户已登录、余额充足，但每次取数都失败并**白白扣费**：
 *   任务失败：第 1 页响应无法归一化：接口返回结构无法识别（未找到记录数组）
 * 每次失败扣 294 credits（= 98 条 × 3 credits/条）——数据其实返回了，只是没被解析。
 *
 * 根因：gateway 的真实响应是官方 `InvokeResponse` 形态
 *   { success, command, result:{ comments:[...] }, meta:{ billing:{ deducted } } }
 * 记录数组在 `result` 里，而早期实现只查 `payload.data` / 顶层字段，因此永远找不到。
 *
 * 本文件的夹具直接取自**真实响应**（`comments by_me/other`），不再靠猜测结构。
 *
 * 运行：`node --test test/response-shape.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const harness = await import('../test-support/harness.js');
const weibo = await import('../server/weibo.js');
const fetcher = await import('../server/fetcher.js');

test.after(() => {
  harness.cleanupSandbox();
});

/** 真实响应骨架（字段与实测一致，记录做了裁剪）。 */
function realCommentsPayload(comments) {
  return {
    success: true,
    command: {
      group: 'comments',
      action: 'by_me/other',
      endpoint: 'comments/by_me/other.json',
    },
    result: {
      previous_cursor: 0,
      total_number: 1234,
      next_cursor: 0,
      comments,
      hasvisible: true,
      previous_cursor_str: '0',
      next_cursor_str: '0',
      interval: 0,
    },
    meta: {
      endpoint: 'comments/by_me/other.json',
      method: 'GET',
      auth_type: 'capi',
      response_time_ms: 116,
      record_count: comments.length,
      billing: { deducted: comments.length * 3, truncated: false, returned: comments.length, balance_after: '22409' },
    },
  };
}

const REAL_COMMENT = {
  idstr: '5366242544453885',
  rootid: 5366242544453885,
  created_at: 'Tue Nov 17 14:03:05 +0800 2026',
  mid: '5366242544453885',
  floor_number: 18,
  text: '第一次好像就表达过了 很羡慕看紫银的[并不简单]',
  user: { idstr: '6349473082', screen_name: '吃吃吃田' },
  status: { idstr: '5352271753774116', mid: '5352271753774116', text: '原微博正文' },
  reply_comment: { idstr: '5366000000000001', user: { screen_name: '被回复的人' } },
};

test('归一化：能从官方 result 层取出记录（本次事故的直接回归）', () => {
  const payload = realCommentsPayload([REAL_COMMENT]);
  const list = weibo.normalizeList(payload, 'comments');
  assert.equal(list.length, 1);
  assert.equal(list[0].idstr, '5366242544453885');
});

test('归一化：空结果（result.comments 为空数组）应返回空数组而不是报错', () => {
  const payload = realCommentsPayload([]);
  const list = weibo.normalizeList(payload, 'comments');
  assert.deepEqual(list, []);
});

test('归一化：微博类记录从 result.statuses 取', () => {
  const payload = {
    success: true,
    result: { statuses: [{ idstr: '111', text: '一条微博' }] },
    meta: {},
  };
  const list = weibo.normalizeList(payload, 'statuses');
  assert.equal(list.length, 1);
  assert.equal(list[0].idstr, '111');
});

test('归一化：仍兼容旧形态 payload.data.comments', () => {
  const list = weibo.normalizeList({ data: { comments: [{ idstr: '9' }] } }, 'comments');
  assert.equal(list.length, 1);
});

test('服务端失败必须报真实原因，而不是「未找到记录数组」', () => {
  const payload = {
    success: false,
    error: {
      code: 'INVALID_PARAMS',
      message: 'This command is restricted to the current user. Provided uid 1 does not match 2.',
    },
  };
  assert.throws(
    () => weibo.normalizeList(payload),
    (err) => {
      assert.ok(!/未找到记录数组/.test(err.message), '不应退化成结构错误');
      assert.match(err.message, /只能读取当前登录账号/);
      return true;
    }
  );
});

test('服务端失败（无 error 对象、仅 success=false）也要给出可读原因', () => {
  assert.throws(() => weibo.normalizeList({ success: false }), /服务端返回失败/);
});

test('upstreamError：outcome 为失败态时判为错误', () => {
  const message = weibo.upstreamError({ success: true, result: {}, meta: { outcome: 'denied' } });
  assert.match(message, /outcome=denied/);
});

test('billedCredits：读取服务端真实扣费', () => {
  const payload = realCommentsPayload([REAL_COMMENT]);
  assert.equal(weibo.billedCredits(payload), 3);
  assert.equal(weibo.billedCredits({ result: {} }), null, '无 billing 时返回 null 以便调用方退回估算');
});

test('mapRecord：真实条目字段映射正确（含原微博与回复对象）', () => {
  const record = fetcher.mapRecord('sent', REAL_COMMENT, 'users', '6349473082');
  assert.equal(record.sourceId, '5366242544453885');
  assert.equal(record.author, '吃吃吃田');
  assert.equal(record.authorUid, '6349473082');
  assert.equal(record.postId, '5352271753774116', '应取 item.status 作为原微博');
  assert.match(record.text, /很羡慕看紫银/);
  assert.ok(record.ms > 0, '应解析出时间戳');
  // reply_comment 是对象：必须取到其 id，绝不能是 "[object Object]"
  assert.equal(record.replyId, '5366000000000001');
  assert.equal(record.replyAuthor, '被回复的人');
  assert.ok(!JSON.stringify(record).includes('[object Object]'), '任何字段都不应出现 [object Object]');
});

test('mapRecord：原微博挂在 weibo 字段时也要识别', () => {
  const item = { ...REAL_COMMENT, status: undefined, weibo: { idstr: '5352271753779999', text: 'x' } };
  const record = fetcher.mapRecord('sent', item, 'users', '6349473082');
  assert.equal(record.postId, '5352271753779999');
});

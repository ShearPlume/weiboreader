/**
 * @file 存储层单测（node:test）。
 *
 * 覆盖：recordId 稳定幂等、路径穿越被拒、同批重复入库 added=0、已读覆盖生效、
 *       原子写不留半文件、gap 待补区间计算。
 *
 * 运行：`node --test test/`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// 必须在 import 服务端模块之前设置：把所有数据写到临时目录，绝不污染仓库 data/
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-reader-test-'));
process.env.WEIBO_READER_DATA_DIR = tmpRoot;

const store = await import('../server/store.js');
const util = await import('../server/util.js');

/** 构造一条最小可用记录。 */
function buildRecord(ownerType, ownerId, mode, sourceId, ms, text = '测试正文') {
  const recordId = store.makeRecordId(ownerType, ownerId, mode, sourceId);
  return {
    recordId,
    sourceRef: sourceId,
    sourceId,
    mode,
    type: mode,
    group: mode,
    author: '测试作者',
    authorUid: '1650000000',
    time: util.fmtTime(ms),
    ms,
    text,
    textTruncated: false,
    postId: '',
    postUrl: '',
    source: 'api',
    fetchedAtMs: Date.now(),
  };
}

test('recordId 稳定且幂等（同来源重复生成一致，不同模式/对象互异）', () => {
  const a1 = store.makeRecordId('users', '123', 'sent', '4900000000000001');
  const a2 = store.makeRecordId('users', '123', 'sent', '4900000000000001');
  const b = store.makeRecordId('users', '123', 'received', '4900000000000001');
  const c = store.makeRecordId('users', '456', 'sent', '4900000000000001');
  assert.equal(a1, a2, '同一输入必须得到同一 recordId');
  assert.match(a1, /^[0-9a-f]{16}$/, 'recordId 应为 16 位 hex');
  assert.notEqual(a1, b, '不同模式应有不同 recordId');
  assert.notEqual(a1, c, '不同对象应有不同 recordId');

  // 无来源 ID 时退化为内容哈希，仍稳定
  const h1 = store.makeRecordId('posts', '999', 'post-comments', '', { authorUid: '1', ms: 1700000000000, text: 'abc' });
  const h2 = store.makeRecordId('posts', '999', 'post-comments', '', { authorUid: '1', ms: 1700000000000, text: 'abc' });
  assert.equal(h1, h2);
});

test('路径穿越被拒绝（非法 ID 与越界片段）', () => {
  assert.throws(() => store.recordsDir('users', '../etc'), (err) => err.code === 'INVALID_ID');
  assert.throws(() => store.recordsDir('users', '12/34'), (err) => err.code === 'INVALID_ID');
  assert.throws(() => store.recordsDir('users', 'abc'), (err) => err.code === 'INVALID_ID');
  assert.throws(() => store.recordsDir('others', '123'), (err) => err.code === 'BAD_REQUEST');
  assert.throws(() => store.safeJoin(tmpRoot, '..', 'etc'), (err) => err.code === 'UNSAFE_PATH');
  assert.throws(() => store.safeJoin(tmpRoot, 'sub', '..', '..', 'x'), (err) => err.code === 'UNSAFE_PATH');
  assert.throws(() => store.reportFilePath('../x'), (err) => err.code === 'UNSAFE_PATH');
  // 合法路径应通过
  assert.ok(store.safeJoin(tmpRoot, 'records', 'users', '123').startsWith(path.resolve(tmpRoot)));
});

test('同批与二次入库去重：added 只计真正新增', () => {
  store.addUser({ uid: '1650000001', screenName: '测试用户A' });
  const now = Date.now();
  const r1 = buildRecord('users', '1650000001', 'sent', '4900000000000101', now, '第一条');
  const r2 = buildRecord('users', '1650000000000001', 'sent', 'x', now);
  void r2; // 仅用于确认非法 ID 不会造成副作用（未入库）

  const first = store.appendRecords('users', '1650000001', 'sent', [r1, r1]);
  assert.equal(first.added, 1, '同批重复只入库 1 条');
  assert.equal(first.reused, 1, '同批重复计为复用');

  const second = store.appendRecords('users', '1650000001', 'sent', [r1]);
  assert.equal(second.added, 0, '重复入库 added 必须为 0');
  assert.equal(second.reused, 1);

  const stored = store.readRecords('users', '1650000001', { mode: 'sent' });
  assert.equal(stored.length, 1, '磁盘上只有 1 条记录');

  const user = store.getUser('1650000001');
  assert.equal(user.stats.recordCount, 1);
  assert.equal(user.stats.unreadCount, 1);
  assert.equal(user.stats.byMode.sent, 1);
});

test('已读覆盖层生效：isUnread=false 且未读计数下降（刷新后保持）', () => {
  const records = store.readRecords('users', '1650000001', { mode: 'sent' });
  assert.equal(records[0].isUnread, true);

  const result = store.markRead('users', '1650000001', [records[0].recordId]);
  assert.equal(result.marked, 1);
  assert.equal(result.unreadTotal, 0);

  const after = store.readRecords('users', '1650000001', { mode: 'sent' });
  assert.equal(after[0].isUnread, false, '已读状态应落盘并在读取时生效');

  // 重复标记同一 ID 不重复计数
  const again = store.markRead('users', '1650000001', [records[0].recordId]);
  assert.equal(again.marked, 0);

  // 覆盖层结构：{recordIds:{id:ms}}
  const overlay = store.readOverlay('users', '1650000001');
  assert.ok(Object.prototype.hasOwnProperty.call(overlay.recordIds, records[0].recordId));
  assert.ok(Number.isFinite(overlay.recordIds[records[0].recordId]));
});

test('原子写：写入后无临时文件残留，内容可完整读回', () => {
  const file = path.join(tmpRoot, 'atomic.json');
  const payload = { hello: '世界', n: 42 };
  store.writeJson(file, payload);
  assert.deepEqual(store.readJson(file, null), payload);
  const leftovers = fs.readdirSync(tmpRoot).filter((name) => name.endsWith('.tmp'));
  assert.equal(leftovers.length, 0, '不应残留 .tmp 临时文件');
});

test('gap 待补区间：中间缺失日段被识别并给出建议 limit', () => {
  const ownerId = '1650000002';
  store.addUser({ uid: ownerId, screenName: '测试用户B' });
  const dayStart = util.dayStartMs(Date.now());
  const oldest = dayStart - 5 * 86400000;

  store.appendRecords('users', ownerId, 'received', [
    buildRecord('users', ownerId, 'received', '4900000000000201', oldest, '最早一天'),
  ]);
  store.appendRecords('users', ownerId, 'received', [
    buildRecord('users', ownerId, 'received', '4900000000000202', dayStart, '今天'),
  ]);

  const gaps = store.gaps('users', ownerId, 'received', oldest, dayStart);
  assert.equal(gaps.length, 1, '应识别出 1 段待补区间');
  assert.equal(gaps[0].days, 4, '缺失 4 天');
  assert.equal(gaps[0].startDay, util.dayKey(oldest + 86400000));
  assert.equal(gaps[0].endDay, util.dayKey(dayStart - 86400000));
  assert.ok(gaps[0].limit >= 80, 'gap 应给出建议 limit');
});

test('计数与增量游标：countLocal / maxSourceId 正确', () => {
  const ownerId = '1650000001';
  const now = Date.now();
  store.appendRecords('users', ownerId, 'sent', [
    buildRecord('users', ownerId, 'sent', '4900000000000301', now + 1000, '第二条'),
    buildRecord('users', ownerId, 'sent', '4900000000000302', now + 2000, '第三条'),
  ]);
  assert.equal(store.countLocal('users', ownerId, 'sent', null, null), 3);
  assert.equal(store.maxSourceId('users', ownerId, 'sent'), '4900000000000302');
});

test('未登录/演示模式下网关拒绝真实请求（零付费保护）', async () => {
  const weibo = await import('../server/weibo.js');
  store.writeConfig({ token: null, settings: { demoMode: true } });
  assert.equal(weibo.isDemoMode(), true);
  assert.throws(() => weibo.requireLiveToken(), (err) => err.code === 'DEMO_MODE');
  await assert.rejects(() => weibo.invoke({ group: 'comments', action: 'by_me/other', args: {} }), (err) => err.code === 'DEMO_MODE');
});

test('归一化：多包裹形态兜底与不可识别结构报错', async () => {
  const weibo = await import('../server/weibo.js');
  assert.deepEqual(weibo.normalizeList({ data: [{ id: 1 }] }), [{ id: 1 }]);
  assert.deepEqual(weibo.normalizeList({ statuses: [{ id: 2 }] }), [{ id: 2 }]);
  assert.deepEqual(weibo.normalizeList({ data: { comments: [{ id: 3 }] } }), [{ id: 3 }]);
  assert.deepEqual(weibo.normalizeList({ whatever: [{ id: 4 }] }), [{ id: 4 }]);
  assert.deepEqual(weibo.normalizeList({ id: 5 }), [{ id: 5 }]);
  assert.throws(() => weibo.normalizeList({ foo: 'bar' }), (err) => err.code === 'UPSTREAM_ERROR');
  assert.throws(() => weibo.normalizeList(null), (err) => err.code === 'UPSTREAM_ERROR');
});

test('日期解析：结束日包含当天 23:59:59.999，非法区间报错', () => {
  const start = util.parseDayStart('2026-01-05');
  const end = util.parseDayEnd('2026-01-05');
  assert.equal(new Date(start).getHours(), 0);
  assert.equal(new Date(start).getMinutes(), 0);
  assert.equal(new Date(end).getHours(), 23);
  assert.equal(new Date(end).getSeconds(), 59);
  assert.equal(new Date(end).getMilliseconds(), 999);
  assert.throws(() => util.parseRange({ fromMs: '2026-02-01', toMs: '2026-01-01' }), (err) => err.code === 'INVALID_DATE_RANGE');
  assert.throws(() => util.parseRange({ fromMs: '2026-13-40' }), (err) => err.code === 'INVALID_DATE_RANGE');
});

test('HTML 转义：脚本标签被转义、换行保留为纯文本语义', () => {
  const evil = '<script>alert(1)</script>\n第二行';
  assert.equal(util.esc(evil).includes('<script>'), false);
  assert.ok(util.escText(evil).includes('&lt;script&gt;'));
  assert.ok(util.escText(evil).includes('<br>'));
});

/** 全局清理：删除临时数据目录。 */
test('cleanup', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略清理失败 */
  }
  assert.ok(true);
});

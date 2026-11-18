/**
 * @file 取数引擎单测（node:test，零依赖）：游标推进、翻页终止条件、零付费保护、
 *       并发互斥、停止与落盘、重复入库去重。
 *
 * 手法：不打桩模块，而是打桩 `globalThis.fetch`，这样测到的是**真实代码路径**
 * （fetcher → weibo.httpJson → requireLiveToken → invoke），可以看清到底发出了哪些请求。
 *
 * 隔离：每个用例使用全新的 UID + 全新任务表，避免用例间记录互相污染游标。
 *
 * 运行：`node --test test/fetcher.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const util = await import('../server/util.js');
const fetcher = await import('../server/fetcher.js');

const MODE = 'received';
/** 每个用例独立的 UID 计数器（保证记录、游标互不干扰）。 */
let uidSeq = 1650000000;

/** 新建一个独立用户并返回 UID。 */
function newUser() {
  uidSeq += 1;
  const uid = String(uidSeq);
  store.addUser({ uid, screenName: `QA 用户 ${uid}` });
  return uid;
}

/** 把账户配置切到「已登录真实账号」（不发真实网络，fetch 已被打桩）。 */
function asRealAccount() {
  store.writeConfig({ token: 'qa-fake-token', account: { uid: '1650000001', screenName: 'QA' }, settings: { demoMode: false } });
}

/** 等待任务结束（startTask 是异步 fire-and-forget）。 */
async function waitTask(taskId) {
  return harness.waitFor(() => {
    const task = fetcher.getTask(taskId);
    return task.status !== 'running' ? task : null;
  });
}

/** 让预检/账户接口始终可用，invoke 由传入的 pages 决定。 */
function installPagedFetch(pages, options = {}) {
  let pageIndex = 0;
  return harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload(options.unitPrice) };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(options.balance === undefined ? 100 : options.balance) };
    if (route.path === '/cli/invoke') {
      const page = pages[Math.min(pageIndex, pages.length - 1)];
      pageIndex += 1;
      return { json: { comments: Array.isArray(page) ? page : [] }, delayMs: options.delayMs || 0 };
    }
    return { status: 404, json: { error: 'unexpected path' } };
  });
}

test.beforeEach(async () => {
  fetcher.__clearTasks();
  store.writeConfig({ token: null, account: null, settings: { demoMode: true } });
});

test.after(() => {
  harness.cleanupSandbox();
});

/* ------------------------------------------------------------------ *
 * 1. 零付费保护（P0-05 / P0-17 前置）
 * ------------------------------------------------------------------ */

test('演示模式：startTask 直接拒绝，且一个网络请求都不发', async () => {
  store.setDemoMode(true);
  const uid = newUser();
  const calls = harness.installFetch(() => {
    throw new Error('演示模式下绝不应发起任何请求');
  });
  assert.throws(
    () => fetcher.startTask({ mode: MODE, ownerId: uid, limit: 10 }),
    (err) => {
      assert.equal(err.code, 'DEMO_MODE');
      assert.equal(err.status, 400);
      return true;
    }
  );
  assert.equal(calls.length, 0, `演示模式下不应有任何出站请求，实际 ${calls.length} 次`);
});

test('未登录：startTask 拒绝（401 UNAUTHORIZED），无任何网络请求', async () => {
  store.writeConfig({ token: null, settings: { demoMode: false } });
  const uid = newUser();
  const calls = harness.installFetch(() => {
    throw new Error('未登录不应发起请求');
  });
  assert.throws(
    () => fetcher.startTask({ mode: MODE, ownerId: uid, limit: 10 }),
    (err) => {
      assert.equal(err.code, 'UNAUTHORIZED');
      assert.equal(err.status, 401);
      return true;
    }
  );
  assert.equal(calls.length, 0);
});

test('伪造 token：预检失败即停，绝不发出 /cli/invoke（不产生 credits 消耗）', async () => {
  asRealAccount();
  const uid = newUser();
  const calls = harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { status: 401, json: { error: 'invalid_token' } };
    return { json: {} };
  });

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, limit: 10 });
  const task = await waitTask(taskId);

  assert.equal(task.status, 'failed', '预检 401 应让任务失败');
  assert.match(task.reason, /登录已失效|token/i);
  const invoked = calls.filter((c) => c.path === '/cli/invoke');
  assert.equal(invoked.length, 0, `伪造 token 下必须 0 次 invoke，实际 ${invoked.length} 次`);
  const nonPreflight = calls.map((c) => c.path).filter((p) => !p.startsWith('/cli/commands/'));
  assert.deepEqual(nonPreflight, [], '不应有任何非预检请求（含 whoami/invoke）');
});

test('预检不支持翻页（无 since_id/max_id/page flags）时拒绝执行，不发 invoke', async () => {
  asRealAccount();
  const uid = newUser();
  const calls = harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) {
      return { json: { commands: [{ flags: ['count'], pricing: { unit_price: 0.02, currency: 'credits' } }] } };
    }
    return { json: {} };
  });
  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);
  assert.equal(task.status, 'failed');
  assert.match(task.reason, /无法安全翻页/);
  assert.equal(calls.filter((c) => c.path === '/cli/invoke').length, 0);
});

/* ------------------------------------------------------------------ *
 * 2. 历史分页游标：max_id = min(返回 id) - 1
 * ------------------------------------------------------------------ */

test('历史分页：max_id 严格等于「本页最小来源 ID 减 1」，且逐页递减', async () => {
  asRealAccount();
  const uid = newUser();
  const pages = [
    [harness.rawItem('4900000000000100'), harness.rawItem('4900000000000095'), harness.rawItem('4900000000000090')],
    [harness.rawItem('4900000000000089'), harness.rawItem('4900000000000080')],
    [],
  ];
  const calls = installPagedFetch(pages);

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);

  const invokeArgs = calls.filter((c) => c.path === '/cli/invoke').map((c) => c.body.args);
  assert.equal(invokeArgs.length, 3, '应发出 3 次 invoke（第三页空结果用于确认到底）');

  assert.equal(invokeArgs[0].max_id, undefined, '首页不应带 max_id');
  assert.equal(invokeArgs[1].max_id, '4900000000000089', 'max_id 必须是本页最小 id 减 1');
  assert.equal(invokeArgs[2].max_id, '4900000000000079', 'max_id 必须逐页递减，不能原地踏步');

  assert.equal(task.status, 'success');
  assert.equal(task.progress.returned, 5);
  assert.equal(task.progress.added, 5, '5 条新记录应全部入库');
  assert.equal(store.countLocal('users', uid, MODE, null, null), 5);
});

test('历史分页：max_id 连续不变时立刻停止（防死循环）', async () => {
  asRealAccount();
  const uid = newUser();
  const same = [harness.rawItem('4900000000000200'), harness.rawItem('4900000000000199')];
  const calls = installPagedFetch([same, same, same, same]);

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);

  const invokes = calls.filter((c) => c.path === '/cli/invoke');
  assert.ok(invokes.length <= 3, `接口不推进时必须尽快停止，实际发出 ${invokes.length} 次 invoke`);
  assert.match(task.reason, /max_id 连续未变化|无新增/);
});

test('连续 3 页 added===0 时停止，避免重复计费', async () => {
  asRealAccount();
  const uid = newUser();
  // 预置记录必须与下面 rawItem 的 created_at 落在同一分片（2026-11），否则去重按分片隔离会失效
  const NOV_MS = Date.parse('2026-11-12T10:00:00+08:00');
  const pre = ['4900000000000100', '4900000000000090', '4900000000000085', '4900000000000084'];
  store.appendRecords(
    'users',
    uid,
    MODE,
    pre.map((id) =>
      harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: id, ms: NOV_MS })
    )
  );
  const pages = [
    [harness.rawItem('4900000000000100'), harness.rawItem('4900000000000090')],
    [harness.rawItem('4900000000000085')],
    [harness.rawItem('4900000000000084')],
    [harness.rawItem('4900000000000083')],
  ];
  installPagedFetch(pages);

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);

  assert.equal(task.progress.page, 3, '应在第 3 页停止');
  assert.equal(task.progress.added, 0, '全部命中去重，added 必须为 0');
  assert.match(task.reason, /连续 3 页无新增/);
});

test('单次任务页数上限 200 真实生效', async () => {
  asRealAccount();
  const uid = newUser();
  let cursorId = 4900009000000000;
  const calls = harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload() };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(999) };
    if (route.path === '/cli/invoke') {
      cursorId -= 1;
      return { json: { comments: [harness.rawItem(String(cursorId))] } };
    }
    return { status: 404, json: {} };
  });

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);

  const invokes = calls.filter((c) => c.path === '/cli/invoke').length;
  assert.equal(invokes, 200, `页数上限应为 200，实际 ${invokes}`);
  assert.equal(task.progress.page, 200);
  assert.match(task.reason, /最多 200 页/);
});

/* ------------------------------------------------------------------ *
 * 3. 增量游标：since_id 取本对象本模式「最大 sourceId」
 * ------------------------------------------------------------------ */

test('增量更新：since_id 取本地最大 sourceId（不是 recordId），并按页推进', async () => {
  asRealAccount();
  const uid = newUser();
  store.appendRecords('users', uid, MODE, [
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000000500', ms: 1790000000000 }),
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000000400', ms: 1789900000000 }),
  ]);

  const pages = [[harness.rawItem('4900000000000600'), harness.rawItem('4900000000000550')], []];
  const calls = installPagedFetch(pages);

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'incremental' });
  const task = await waitTask(taskId);

  const invokeArgs = calls.filter((c) => c.path === '/cli/invoke').map((c) => c.body.args);
  assert.equal(invokeArgs[0].since_id, '4900000000000500', 'since_id 必须是本地最大 sourceId');
  assert.equal(invokeArgs[1].since_id, '4900000000000600', '第二页 since_id 应推进到本页最大值');
  assert.equal(task.progress.added, 2);

  const maxId = store.maxSourceId('users', uid, MODE);
  assert.equal(maxId, '4900000000000600');
  assert.match(maxId, /^\d{16}$/, 'since_id 必须是数字来源 ID，不能是 16 位 hex 的 recordId');
});

test('增量更新：本地为空时不带 since_id，从最新一页开始', async () => {
  asRealAccount();
  const uid = newUser();
  const calls = installPagedFetch([[harness.rawItem('4900000000000700')], []]);
  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'incremental' });
  await waitTask(taskId);
  const invokeArgs = calls.filter((c) => c.path === '/cli/invoke').map((c) => c.body.args);
  assert.equal(invokeArgs[0].since_id, undefined);
});

/* ------------------------------------------------------------------ *
 * 4. 并发互斥 / 停止 / 落盘
 * ------------------------------------------------------------------ */

test('并发：第二个取数任务被 409 TASK_BUSY 拒绝；结束后可再次启动', async () => {
  asRealAccount();
  const uid = newUser();
  installPagedFetch([[harness.rawItem('4900000000000800')], []], { delayMs: 25 });

  const first = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  assert.equal(fetcher.isRunning(), true);
  assert.throws(
    () => fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' }),
    (err) => {
      assert.equal(err.code, 'TASK_BUSY');
      assert.equal(err.status, 409);
      return true;
    }
  );
  await waitTask(first.taskId);
  assert.equal(fetcher.isRunning(), false, '任务结束后必须释放互斥锁');
});

test('停止：stopTask 后任务转为 stopped，已落盘数据保留，tasks.jsonl 有记录', async () => {
  asRealAccount();
  const uid = newUser();
  const pages = [
    [harness.rawItem('4900000000000900')],
    [harness.rawItem('4900000000000899')],
    [harness.rawItem('4900000000000898')],
  ];
  installPagedFetch(pages, { delayMs: 20 });

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  await harness.waitFor(() => fetcher.getTask(taskId).progress.page >= 1);
  const stopResult = fetcher.stopTask(taskId);
  assert.deepEqual(stopResult, { stopping: true });

  const task = await waitTask(taskId);
  assert.equal(task.status, 'stopped');
  assert.match(task.reason, /用户手动停止/);

  const persisted = store.countLocal('users', uid, MODE, null, null);
  assert.ok(persisted >= 1, `停止后已取到的 ${persisted} 条必须保留`);

  const rows = store.readTasks(50).filter((row) => row.taskId === taskId);
  assert.equal(rows.length, 1, 'tasks.jsonl 必须落一条任务记录');
  assert.equal(rows[0].status, 'stopped');
  assert.equal(typeof rows[0].finishedAtMs, 'number');
});

test('停止已完成的任务：返回 409 TASK_NOT_RUNNING；不存在的任务返回 404', async () => {
  asRealAccount();
  const uid = newUser();
  installPagedFetch([[harness.rawItem('4900000000000950')], []]);
  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  await waitTask(taskId);

  assert.throws(
    () => fetcher.stopTask(taskId),
    (err) => {
      assert.equal(err.code, 'TASK_NOT_RUNNING');
      assert.equal(err.status, 409);
      return true;
    }
  );
  assert.throws(
    () => fetcher.stopTask('t_not_exist'),
    (err) => {
      assert.equal(err.code, 'TASK_NOT_FOUND');
      assert.equal(err.status, 404);
      return true;
    }
  );
});

test('额度不足保护：预估超出余额时 plan 拦截，运行中余额跌破预估自动停止', async () => {
  asRealAccount();
  const uid = newUser();

  // ① 预估阶段拦截：余额 0.01，限 100 条 × 0.02 = 2.00 > 0.01
  store.writeConfig({ balance: { value: 0.01, atMs: Date.now(), serviceKind: '' } });
  const plan = await fetcher.plan({ mode: MODE, ownerId: uid, limit: 100 });
  assert.equal(plan.blocked.code, 'INSUFFICIENT_CREDITS');
  assert.match(plan.blocked.message, /还差/);

  // ② 运行阶段：余额 0.05，每页 1 条 × 0.02 → 花到 0.06 后必须自动停
  store.writeConfig({ balance: { value: 0.05, atMs: Date.now(), serviceKind: '' } });
  let seq = 4900001000000000;
  installPagedFetch([]); // 占位，下面覆盖
  harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload(0.02) };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(0.05) };
    if (route.path === '/cli/invoke') {
      seq -= 1;
      return { json: { comments: [harness.rawItem(String(seq))] } };
    }
    return { status: 404, json: {} };
  });

  const { taskId } = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const task = await waitTask(taskId);

  assert.equal(task.status, 'success');
  assert.match(task.reason, /余额跌破预估/, `应因余额不足自动停止，实际：${task.reason}`);
  assert.ok(task.progress.credits <= 0.06 + 1e-9, `消耗不得超过可用于判断的页数，实际 ${task.progress.credits}`);
  assert.ok(task.progress.page <= 4, `应在余额耗尽后立刻停止，实际翻页 ${task.progress.page}`);
});

/* ------------------------------------------------------------------ *
 * 5. 去重与本地复用（P0-18）
 * ------------------------------------------------------------------ */

test('同一批数据重复入库：added 为 0，reused 等于条数', () => {
  const uid = newUser();
  const rows = [
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000002001', ms: 1790000000000 }),
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000002002', ms: 1790000100000 }),
  ];
  const first = store.appendRecords('users', uid, MODE, rows);
  assert.deepEqual({ added: first.added, reused: first.reused }, { added: 2, reused: 0 });

  const second = store.appendRecords('users', uid, MODE, rows);
  assert.deepEqual({ added: second.added, reused: second.reused }, { added: 0, reused: 2 }, '重复入库不得新增');
  assert.equal(store.countLocal('users', uid, MODE, null, null), 2);

  const third = store.appendRecords('users', uid, MODE, [rows[0], rows[0]]);
  assert.equal(third.added, 0, '同批内自带重复也要去重');
});

test('plan：本地复用条数与区间命中一致，且 demo 模式标注 blocked', async () => {
  store.setDemoMode(true);
  const uid = newUser();
  store.appendRecords('users', uid, MODE, [
    harness.localRecord(store, util, {
      ownerType: 'users',
      ownerId: uid,
      mode: MODE,
      sourceId: '4900000000003001',
      ms: Date.parse('2026-11-10T10:00:00+08:00'),
    }),
  ]);
  const plan = await fetcher.plan({ mode: MODE, ownerId: uid, fromMs: '2026-11-01', toMs: '2026-11-30', limit: 100 });
  assert.equal(plan.reusedLocal, 1, '区间内应命中 1 条本地记录');
  assert.equal(plan.blocked.code, 'DEMO_MODE');
  assert.equal(plan.willFetch, 100);
  assert.equal(plan.sinceCursor, '4900000000003001');
});

/* ------------------------------------------------------------------ *
 * 6. 归一化容错（mapRecord）
 * ------------------------------------------------------------------ */

test('mapRecord：多形态容错 —— idstr/字符串 id、created_at 解析、postUrl 生成', () => {
  const record = fetcher.mapRecord(MODE, harness.rawItem('4900000000004001'), 'users', '1650000001');
  assert.ok(record);
  assert.equal(record.sourceId, '4900000000004001');
  assert.equal(record.mode, MODE);
  assert.equal(record.author, '作者甲');
  assert.equal(record.postId, '4900000000009999');
  assert.match(record.postUrl, /^https:\/\/m\.weibo\.cn\/detail\/4900000000009999$/);
  assert.match(record.time, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  assert.equal(record.text, '测试正文 4900000000004001');

  const fallback = fetcher.mapRecord(
    MODE,
    { text: '没有 ID 的条目', created_at: 'Wed Nov 12 10:00:00 +0800 2026' },
    'users',
    '1650000001'
  );
  assert.match(fallback.recordId, /^[0-9a-f]{16}$/);

  assert.equal(fetcher.mapRecord('not-a-mode', {}, 'users', '1650000001'), null);
  assert.equal(fetcher.mapRecord(MODE, null, 'users', '1650000001'), null);
});

test('mapRecord：超长正文截断到 2000 字符并标记 textTruncated', () => {
  const long = 'A'.repeat(2500);
  const record = fetcher.mapRecord(MODE, harness.rawItem('4900000000004002', { text: long }), 'users', '1650000001');
  assert.equal(record.text.length, 2000);
  assert.equal(record.textTruncated, true);
});

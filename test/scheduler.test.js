/**
 * @file 订阅调度器单测（node:test，零依赖）：退避阶梯、日预算熔断、跨日恢复、
 *       日志裁剪、演示模式短路、并发互斥。
 *
 * 手法：直接调用 `scheduler.tick()`（真实代码路径），用 `fetch` 打桩替代网关，
 *       用构造的订阅对象驱动各种状态，全部写在临时目录，不污染仓库 data/。
 *
 * 运行：`node --test test/scheduler.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const util = await import('../server/util.js');
const scheduler = await import('../server/scheduler.js');
const fetcher = await import('../server/fetcher.js');
const { BACKOFF_MINUTES } = await import('../server/config.js');

const MODE = 'received';
const NOV_MS = Date.parse('2026-11-12T10:00:00+08:00');
let uidSeq = 1660000000;

/** 建一个用户 + 一条订阅，并让它「现在就该跑」。 */
function makeDueSubscription(overrides = {}) {
  uidSeq += 1;
  const uid = String(uidSeq);
  store.addUser({ uid, screenName: `订阅用户 ${uid}` });
  const sub = store.addSubscription({
    ownerType: 'users',
    ownerId: uid,
    ownerLabel: `订阅用户 ${uid}`,
    mode: MODE,
    perRoundLimit: 10,
    dailyCreditsBudget: 2,
    intervalMode: overrides.intervalMode || 'auto',
    fixedMinutes: overrides.fixedMinutes || 30,
  });
  const patch = { nextRunAtMs: Date.now() - 1000, todayKey: util.todayKey(), ...(overrides.patch || {}) };
  return { uid, sub: store.patchSubscription(sub.id, patch) };
}

/** 让预检/whoami 永远可用；第一页返回 items，之后返回空页（贴合真实接口语义）。 */
function installFetch(items) {
  let used = false;
  return harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload() };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(50) };
    if (route.path === '/cli/invoke') {
      const payload = used ? [] : items;
      used = true;
      return { json: { comments: payload } };
    }
    return { status: 404, json: {} };
  });
}

/** 断言 nextRunAtMs 落在期望分钟数附近（容差 5 秒）。 */
function assertNextRun(sub, minutes) {
  const delta = sub.nextRunAtMs - Date.now();
  const expected = minutes * 60000;
  assert.ok(
    Math.abs(delta - expected) < 5000,
    `下次检查应约为 ${minutes} 分钟后，实际 ${(delta / 60000).toFixed(2)} 分钟`
  );
}

test.beforeEach(() => {
  fetcher.__clearTasks();
  store.writeConfig({ token: 'qa-token', account: { uid: '1', screenName: 'QA' }, settings: { demoMode: false } });
});

test.after(() => {
  harness.cleanupSandbox();
});

test('退避阶梯：added>0 回到第 0 档（1 分钟）', async () => {
  const { sub } = makeDueSubscription({ patch: { step: 4, spentToday: 0 } });
  installFetch([harness.rawItem('4900000000001101')]);

  const result = await scheduler.tick();
  assert.equal(result.ran, 1);

  const after = store.getSubscription(sub.id);
  assert.equal(after.step, 0, '有新增必须回到第 0 档');
  assertNextRun(after, BACKOFF_MINUTES[0]);
  assert.equal(after.lastResult, 'ok');
});

test('退避阶梯：added===0 前进一档（1→3 分钟）', async () => {
  const { uid, sub } = makeDueSubscription({ patch: { step: 0 } });
  // 预置同一条记录，让本轮 added 为 0
  const item = harness.rawItem('4900000000001201');
  store.appendRecords('users', uid, MODE, [
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000001201', ms: NOV_MS }),
  ]);
  installFetch([item]);

  const result = await scheduler.tick();
  assert.equal(result.ran, 1);

  const after = store.getSubscription(sub.id);
  assert.equal(after.step, 1, '无新增应前进一档');
  assertNextRun(after, BACKOFF_MINUTES[1]);
  assert.equal(after.lastResult, 'no-new');
  assert.equal(after.spentToday, 0.02, '无新增也会消耗接口返回条数的 credits');
});

test('退避阶梯：封顶第 5 档（30 分钟），不会越界', async () => {
  const { uid, sub } = makeDueSubscription({ patch: { step: 5 } });
  store.appendRecords('users', uid, MODE, [
    harness.localRecord(store, util, { ownerType: 'users', ownerId: uid, mode: MODE, sourceId: '4900000000001301', ms: NOV_MS }),
  ]);
  installFetch([harness.rawItem('4900000000001301')]);

  await scheduler.tick();
  const after = store.getSubscription(sub.id);
  assert.equal(after.step, BACKOFF_MINUTES.length - 1, '档位必须封顶在最后一档');
  assert.equal(BACKOFF_MINUTES[BACKOFF_MINUTES.length - 1], 30);
  assertNextRun(after, 30);
});

test('退避阶梯：固定间隔模式忽略档位（fixedMinutes=7 → 7 分钟）', async () => {
  const { sub } = makeDueSubscription({ intervalMode: 'fixed', fixedMinutes: 7, patch: { step: 3 } });
  installFetch([harness.rawItem('4900000000001401')]);

  await scheduler.tick();
  const after = store.getSubscription(sub.id);
  assertNextRun(after, 7);
});

test('日预算耗尽：enabled=false、lastResult=budget、写一条日志、并排到 1 小时后', async () => {
  const { sub } = makeDueSubscription({ patch: { spentToday: 1.95 } }); // 1.95 + 10*0.02 > 2
  const calls = installFetch([harness.rawItem('4900000000001501')]);

  const result = await scheduler.tick();
  assert.equal(result.ran, 0, '预算不足时本轮不应真正取数');
  assert.equal(calls.filter((c) => c.path === '/cli/invoke').length, 0, '预算不足绝不应发出付费请求');

  const after = store.getSubscription(sub.id);
  assert.equal(after.enabled, false);
  assert.equal(after.lastResult, 'budget');
  assertNextRun(after, 60);

  const logs = store.readSubLogs(50).filter((row) => row.subId === sub.id);
  assert.equal(logs.length, 1, '预算不足必须记日志');
  assert.equal(logs[0].result, 'budget');
  assert.match(logs[0].message, /预算/);
});

test('跨日：预算耗尽自动暂停的订阅被恢复，且同一个 tick 就真实执行（不再推迟 30s）', async () => {
  // 构造「预算耗尽自动暂停」：enabled=false + pauseReason='budget' + lastResult='budget'
  const { sub } = makeDueSubscription({
    patch: { todayKey: '2000-01-01', spentToday: 1.99, enabled: false, pauseReason: 'budget', lastResult: 'budget', step: 4 },
  });
  installFetch([harness.rawItem('4900000000001601')]);

  // 时序修复后（原 Minor 3）：第一个 tick 就完成「恢复 + 真实取数」，无需等第二轮
  await scheduler.tick();
  const after = store.getSubscription(sub.id);
  assert.equal(after.todayKey, util.todayKey());
  assert.equal(after.enabled, true, '预算耗尽暂停的订阅跨日应恢复启用');
  assert.equal(after.pauseReason, '', '恢复后必须清掉暂停原因');
  assert.equal(after.lastResult, 'ok', '同一个 tick 内应已跑完一轮（result=ok）');
  assert.equal(after.spentToday, 0.02, '同一个 tick 应真实取数（1 条 × 0.02）并计入当日消耗');
  assert.equal(after.step, 0, '有新增 → 回到第 0 档');
});

test('跨日：用户手动暂停的订阅必须保持暂停，绝不自动恢复（M-2 扣费风险）', async () => {
  // 当天手动暂停：不应被 tick 改动
  const { sub } = makeDueSubscription({ patch: { enabled: false } });
  installFetch([]);
  await scheduler.tick();
  let after = store.getSubscription(sub.id);
  assert.equal(after.enabled, false, '当天手动暂停必须保持暂停');
  assert.equal(after.pauseReason, 'user', 'enabled 从 true 翻到 false 应自动推断为用户暂停');

  // 跨日之后：仍然是用户手动暂停 → 必须保持暂停
  store.patchSubscription(sub.id, { todayKey: '2000-01-01' });
  await scheduler.tick();
  after = store.getSubscription(sub.id);
  assert.equal(after.enabled, false, '手动暂停的订阅跨日后必须保持暂停，不得自动恢复并开始扣 credits');
  assert.equal(after.pauseReason, 'user', '跨日不得把用户暂停改写为预算暂停');
  assert.equal(after.todayKey, util.todayKey(), '即使用户手动暂停，todayKey 仍应跨日更新');
  assert.equal(after.spentToday, 0, '保持暂停的订阅不得产生消耗');
});

test('暂停意图：pauseReason 与 enabled 的迁移规则（顺序无关）', () => {
  const { sub } = makeDueSubscription();
  // 预算自动暂停：显式 pauseReason='budget' 必须胜过「翻转为 user」的推断
  let updated = store.patchSubscription(sub.id, { enabled: false, pauseReason: 'budget', lastResult: 'budget' });
  assert.equal(updated.enabled, false);
  assert.equal(updated.pauseReason, 'budget', '显式 pauseReason 必须覆盖 enabled 翻转推断');

  // 用户点「恢复」→ 清原因
  updated = store.patchSubscription(sub.id, { enabled: true });
  assert.equal(updated.enabled, true);
  assert.equal(updated.pauseReason, '', '用户恢复必须清 pauseReason');

  // 用户点「暂停」→ 推断为 user
  updated = store.patchSubscription(sub.id, { enabled: false });
  assert.equal(updated.enabled, false);
  assert.equal(updated.pauseReason, 'user', '手动暂停必须标为 user，日切才不会恢复');

  // 只改其他字段时不得污染 pauseReason（避免把 budget 误判成 user）
  store.patchSubscription(sub.id, { enabled: false, pauseReason: 'budget' });
  updated = store.patchSubscription(sub.id, { perRoundLimit: 20 });
  assert.equal(updated.pauseReason, 'budget', '仅改其他字段不得改写暂停原因');

  assert.equal(updated.autoPaused, undefined, '不应存在旧字段 autoPaused（设计已改用 pauseReason）');
});

test('预算耗尽 → 自动暂停 → 跨日 → 恢复：完整闭环', async () => {
  const { sub } = makeDueSubscription({ patch: { spentToday: 1.95, dailyCreditsBudget: 2 } });
  installFetch([harness.rawItem('4900000000001251')]);

  // 第一轮：预算不足 → 自动暂停
  await scheduler.tick();
  let after = store.getSubscription(sub.id);
  assert.equal(after.enabled, false);
  assert.equal(after.pauseReason, 'budget', '预算暂停必须标记 pauseReason=budget');
  assert.equal(after.lastResult, 'budget');
  assertNextRun(after, 60);

  // 次日：应恢复并真实取数
  store.patchSubscription(sub.id, { todayKey: '2000-01-01' });
  await scheduler.tick();
  after = store.getSubscription(sub.id);
  assert.equal(after.enabled, true, '预算暂停的订阅跨日应自动恢复');
  assert.equal(after.pauseReason, '');
  assert.ok(after.spentToday > 0, '恢复后应真实跑一轮并产生消耗');
});

test('演示模式/未登录：tick 直接短路，不发任何请求，也不消耗预算', async () => {
  const { sub } = makeDueSubscription();
  store.setDemoMode(true);
  const calls = installFetch([harness.rawItem('4900000000001701')]);

  const result = await scheduler.tick();
  assert.equal(result.ran, 0);
  assert.equal(result.reason, 'demo-or-logged-out');
  assert.equal(calls.length, 0, '演示模式不应发起任何出站请求');
  assert.equal(store.listSubscriptions().length, 0, '演示模式读取的是隔离的 demo 目录，看不到真实订阅');

  store.setDemoMode(false);
  assert.equal(store.getSubscription(sub.id).spentToday, 0, '演示模式不得消耗真实预算');
});

test('手动取数运行中：订阅本轮让路（busy），不排队、不并发出请求', async () => {
  const { uid, sub } = makeDueSubscription();
  const calls = installFetch([harness.rawItem('4900000000001801')]);
  // 用一个人为拖慢的手动任务占住互斥锁
  harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload() };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(50) };
    if (route.path === '/cli/invoke') return { json: { comments: [harness.rawItem('4900000000001802')] }, delayMs: 40 };
    return { status: 404, json: {} };
  });
  const task = fetcher.startTask({ mode: MODE, ownerId: uid, cursor: 'history' });
  const result = await scheduler.tick();
  assert.equal(result.reason, 'busy');
  assert.equal(store.getSubscription(sub.id).lastRunAtMs, null, '让路的一轮不应更新 lastRunAtMs');

  await harness.waitFor(() => fetcher.getTask(task.taskId).status !== 'running');
  void calls;
});

test('订阅日志裁剪到最近 200 行', () => {
  for (let i = 0; i < 260; i += 1) {
    store.appendSubLog({
      atMs: Date.now() + i,
      subId: `s_trim_${i}`,
      mode: MODE,
      returned: 1,
      added: 0,
      credits: 0.02,
      result: 'no-new',
      message: `trim ${i}`,
    });
  }
  const all = store.readSubLogs(1000);
  assert.equal(all.length, 200, `订阅日志必须裁到 200 行，实际 ${all.length}`);
  assert.equal(all[0].message, 'trim 259', '保留的应是最新 200 行');
});

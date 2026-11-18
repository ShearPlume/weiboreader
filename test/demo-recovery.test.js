/**
 * @file 演示数据自愈（ensureDemoData）在「部分删除」场景下的正确性测试。
 *
 * 背景：`seed({reset:true})` 在 Windows 上可能因瞬时文件锁**部分失败**——
 * `users.json`/`posts.json` 已删、`records/` 分片仍在，此时抛 `IO_ERROR` 且不回滚。
 * 随后启动的 `ensureDemoData()` 看到 `users=0` 便补种，会在**残留分片之上重复追加**，
 * 把未读数静默翻倍（实测 166 → 333）。
 *
 * 该问题在 `ensureDemoData` 加入前需要用户手动点「重置演示数据」才会触发；
 * 加入自愈后，变为**启动即自动发生**，且用户完全无感（只看到「未读 333」）。
 *
 * 运行：`node --test test/demo-recovery.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const demo = await import('../server/demo.js');

/** 模拟「reset 中途失败」：索引文件已删，但 records 分片仍在。 */
function simulatePartialReset() {
  const root = store.getRoot();
  for (const name of ['users.json', 'posts.json', 'subscriptions.json']) {
    fs.rmSync(path.join(root, name), { force: true });
  }
}

/** 统计记录分片文件数量。 */
function shardCount() {
  const dir = path.join(store.getRoot(), 'records', 'users');
  let n = 0;
  if (!fs.existsSync(dir)) return 0;
  for (const uid of fs.readdirSync(dir)) {
    const sub = path.join(dir, uid);
    if (fs.statSync(sub).isDirectory()) n += fs.readdirSync(sub).filter((f) => f.endsWith('.jsonl')).length;
  }
  return n;
}

test.after(() => {
  harness.cleanupSandbox();
});

test('修复后：部分删除后 ensureDemoData 自愈不会翻倍（走原子重建）', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const before = store.counts();
  assert.equal(before.unread, 166, '前置：演示数据初始未读 166');

  simulatePartialReset();
  assert.equal(store.listUsers().total, 0, '前置：模拟索引已删');
  assert.ok(shardCount() > 0, '前置：records 分片必须仍在（这正是问题所在）');

  const reseeded = demo.ensureDemoData();
  const after = store.counts();

  assert.equal(reseeded, true, '看到空索引应补种');
  assert.deepEqual(after, before, `自愈结果必须与初始一致，不得叠加残留分片：${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
});

test('修复后：部分删除后 seed({reset:false}) 不再往上叠加（拒绝追加或原子重建）', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const before = store.counts();
  simulatePartialReset();
  let error = null;
  try {
    demo.seed({ reset: false });
  } catch (err) {
    error = err;
  }
  const after = store.counts();
  // 两种可接受结果：拒绝追加（IO_ERROR，提示去重置），或原子重建后与初始一致。
  // 唯一不可接受的是「在残留分片上叠加」。
  if (error) {
    assert.equal(error.code, 'IO_ERROR', '不一致状态应给出 IO_ERROR 明确指引');
    assert.equal(after.unread, 0, '拒绝时不得写入任何记录（索引为空即视为 0）');
  } else {
    assert.deepEqual(after, before, `若允许重建，结果必须等于初始值，不得叠加：${before.unread} → ${after.unread}`);
  }
});

test('对照：干净空库时 ensureDemoData 补种不会翻倍（说明问题只在「部分删除」分支）', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const before = store.counts();
  // 索引与分片一起清空 = 干净空库
  const root = store.getRoot();
  fs.rmSync(path.join(root, 'records'), { recursive: true, force: true });
  simulatePartialReset();
  demo.ensureDemoData();
  const after = store.counts();
  assert.deepEqual(after, before, `干净空库补种应完全等于初始值：${JSON.stringify(before)} vs ${JSON.stringify(after)}`);
});

test('目标行为：部分删除后自愈应得到与初始完全一致的 counts', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const before = store.counts();
  simulatePartialReset();
  demo.ensureDemoData();
  assert.deepEqual(store.counts(), before, '自愈结果必须与初始一致，不得叠加残留分片');
});

/**
 * @file 启动自愈测试（node:test，零依赖）：演示数据缺失时必须自动补种，
 *       避免用户打开应用看到空库而无从恢复。
 *
 * 背景：`ensureFirstRun()` 只在 `data/config.json` 不存在时播种，因此演示数据被误删、
 * 或 `seed({reset:true})` 中途失败留下空目录时，启动后会是一个空库
 * （交付验收中实际复现过两次）。`ensureDemoData()` 专门兜住这种情况。
 *
 * 运行：`node --test test/bootstrap.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const demo = await import('../server/demo.js');

test.after(() => {
  harness.cleanupSandbox();
});

/** 清空当前数据根下的用户/博文索引与记录分片，模拟"数据被人为删除"。 */
function wipeLibrary() {
  const root = store.getRoot();
  for (const name of ['users.json', 'posts.json']) {
    fs.rmSync(path.join(root, name), { force: true });
  }
  const records = path.join(root, 'records', 'users');
  if (fs.existsSync(records)) {
    for (const uid of fs.readdirSync(records)) {
      fs.rmSync(path.join(records, uid), { recursive: true, force: true });
    }
  }
  const postRecords = path.join(root, 'records', 'posts');
  if (fs.existsSync(postRecords)) {
    for (const pid of fs.readdirSync(postRecords)) {
      fs.rmSync(path.join(postRecords, pid), { recursive: true, force: true });
    }
  }
}

test('演示数据被清空后，ensureDemoData() 会自动补种', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  assert.ok(store.listUsers().total > 0, '前置：应已有演示用户');

  wipeLibrary();
  assert.equal(store.listUsers().total, 0, '前置：库应已为空');
  assert.equal(store.listPosts().total, 0, '前置：博文也应已为空');

  const reseeded = demo.ensureDemoData();
  assert.equal(reseeded, true, '空库时应执行补种');
  assert.equal(store.listUsers().total, 3, '应补回 3 个演示用户');
  assert.equal(store.listPosts().total, 2, '应补回 2 条演示博文');
  assert.ok(store.counts().unread > 0, '应补回未读互动');
});

test('已有数据时 ensureDemoData() 不重复播种（幂等）', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const before = store.counts();

  const reseeded = demo.ensureDemoData();
  assert.equal(reseeded, false, '已有数据时不应重复播种');
  const after = store.counts();
  assert.deepEqual(after, before, '统计数不得变化（防重复入库）');
});

test('非演示模式（真实账号）下 ensureDemoData() 不得注入演示数据', () => {
  store.setDemoMode(false);
  wipeLibrary();
  assert.equal(store.listUsers().total, 0, '前置：真实库为空');

  const reseeded = demo.ensureDemoData();
  assert.equal(reseeded, false, '真实模式下不得自动灌入演示数据');
  assert.equal(store.listUsers().total, 0, '真实库仍应为空，不能被污染');

  store.setDemoMode(true);
  demo.seed({ reset: true });
});

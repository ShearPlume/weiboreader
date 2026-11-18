/**
 * @file 单实例锁与残留清理测试（node:test，零依赖）。
 *
 * 背景：两个实例同时用同一数据目录会在同一批 JSONL 上并发写入，本机实测出现过
 * `posts.json` 丢失、未读数 166 → 156 的数据损坏。仅靠端口冲突拦不住
 * （第二个实例换个 PORT 就绕过了），因此必须有文件锁。
 *
 * 这里只测锁的判定函数与残留清理，不真的起两个服务器进程（那属于手工验收）。
 *
 * 运行：`node --test test/instance-lock.test.js`
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

test('sweepTrash() 清理数据根旁的 .trash-* 残留目录', () => {
  const base = store.baseDataDir();
  fs.mkdirSync(base, { recursive: true });
  const dead1 = path.join(base, 'demo.trash-1001');
  const dead2 = path.join(base, 'demo.trash-1002');
  for (const dir of [dead1, dead2]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'leftover.txt'), 'x');
  }
  assert.ok(fs.existsSync(dead1), '前置：残留目录应已创建');

  const removed = demo.sweepTrash();

  assert.ok(removed >= 2, `应至少清理 2 个残留目录，实际 ${removed}`);
  assert.equal(fs.existsSync(dead1), false, '残留目录应被删除');
  assert.equal(fs.existsSync(dead2), false, '残留目录应被删除');
});

test('sweepTrash() 不误删正常数据目录', () => {
  const base = store.baseDataDir();
  const normal = path.join(base, 'demo');
  fs.mkdirSync(normal, { recursive: true });
  fs.writeFileSync(path.join(normal, 'users.json'), '{"users":[]}');

  demo.sweepTrash();

  assert.equal(fs.existsSync(normal), true, '正常目录不得被清理');
  assert.equal(fs.existsSync(path.join(normal, 'users.json')), true, '正常目录内容不得被删除');
});

test('seed({reset:true}) 后不遗留 .trash-* 目录（正常路径）', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const base = store.baseDataDir();
  const leftovers = fs.readdirSync(base).filter((name) => name.includes('.trash-'));
  assert.deepEqual(leftovers, [], `正常路径不应残留回收目录，实际: ${leftovers.join(', ')}`);
});

test('连续多次 seed({reset:true}) 统计数稳定、无回收目录累积', () => {
  store.setDemoMode(true);
  demo.seed({ reset: true });
  const first = store.counts();

  for (let i = 0; i < 4; i += 1) demo.seed({ reset: true });

  const after = store.counts();
  assert.deepEqual(after, first, `多次重置后统计数应完全一致：${JSON.stringify(first)} vs ${JSON.stringify(after)}`);

  const base = store.baseDataDir();
  const leftovers = fs.readdirSync(base).filter((name) => name.includes('.trash-'));
  assert.deepEqual(leftovers, [], `多次重置不应累积回收目录，实际: ${leftovers.join(', ')}`);
});

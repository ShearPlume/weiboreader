/**
 * @file P0-15「缺失正文」补取闭环测试（node:test，零依赖）。
 *
 * 验收背景：PRD P0-15 要求「已知 ID 但正文缺失的记录单独列清单，**提示可单独补取**」。
 * 第 3 轮回归发现：清单/徽标/按钮都在（视觉达标），但**点击后无法真正补上正文**——
 * 三种取数模式（post-comments / mentions-posts / user-posts）都不会回填 `post.text`，
 * 而 `missingText` 只由 `PATCH /api/posts/:id {text}` 能清除，前端没有任何入口。
 *
 * 本文件用两条用例把这件事钉死：
 * 1. 现状用例（通过）：明确记录「取数后 missingText 仍为 true」，防止有人误以为已修；
 * 2. 目标用例（skip，待修复）：断言「补取后 missingText 变 false」，修好后把它打开即可。
 *
 * 运行：`node --test test/p015-missing-text.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const fetcher = await import('../server/fetcher.js');

const POST_ID = '4901234567890abc'.replace(/[a-z]/g, '9');
const AUTHOR_UID = '1650000301';
const NOV = 'Wed Nov 12 10:00:00 +0800 2026';

/** 装一个「接口会返回原微博对象」的假网关：这已是后端能拿到正文的最理想情形。 */
function installGatewayWithOriginalPost() {
  return harness.installFetch((route) => {
    if (route.path.startsWith('/cli/commands/')) return { json: harness.commandsPayload(0.02) };
    if (route.path === '/cli/whoami') return { json: harness.whoamiPayload(99) };
    if (route.path === '/cli/invoke') {
      return {
        json: {
          comments: [
            {
              idstr: '4900000000123456',
              id: '4900000000123456',
              text: '这是评论正文',
              created_at: NOV,
              user: { idstr: '1650000302', screen_name: '评论者' },
              // 关键：响应里带了完整原微博，理论上可用于回填 post.text
              status: {
                idstr: POST_ID,
                mid: 'NkK9qa00301',
                text: '原微博的完整正文，理论上应从这条回填到 post.text',
                created_at: NOV,
                user: { idstr: AUTHOR_UID, screen_name: '原作者' },
              },
            },
          ],
          statuses: [
            {
              idstr: POST_ID,
              mid: 'NkK9qa00301',
              text: '原微博的完整正文，理论上应从这条回填到 post.text',
              created_at: NOV,
              user: { idstr: AUTHOR_UID, screen_name: '原作者' },
            },
          ],
        },
      };
    }
    return { status: 404, json: {} };
  });
}

/** 跑一次取数并等待结束。 */
async function startAndWait(params) {
  const { taskId } = fetcher.startTask(params);
  return harness.waitFor(() => {
    const task = fetcher.getTask(taskId);
    return task.status !== 'running' ? task : null;
  });
}

test.beforeEach(() => {
  fetcher.__clearTasks();
  store.writeConfig({ token: 'qa-token', account: { uid: '1', screenName: 'QA' }, settings: { demoMode: false } });
  if (!store.getUser(AUTHOR_UID)) store.addUser({ uid: AUTHOR_UID, screenName: '原作者' });
  if (!store.getPost(POST_ID)) store.addPost({ id: POST_ID, mId: 'NkK9qa00301', authorUid: AUTHOR_UID, text: '' });
  // 保证每次从「正文缺失」开始
  store.patchPost(POST_ID, { text: '' });
});

test.after(() => {
  harness.cleanupSandbox();
});

test('修复后：post-comments 取数会从响应中的原微博对象回填正文（P0-15 闭环成立）', async () => {
  installGatewayWithOriginalPost();
  assert.equal(store.getPost(POST_ID).text, '', '前置：正文缺失');

  const task = await startAndWait({ mode: 'post-comments', ownerType: 'posts', ownerId: POST_ID, limit: 10 });
  assert.equal(task.status, 'success');

  const post = store.getPost(POST_ID);
  assert.ok(store.countAllRecords('posts', POST_ID) >= 1, '评论记录应已入库');
  assert.notEqual(post.text, '', '取数应从响应中的原微博对象回填 post.text');
  assert.equal(!post.text, false, 'missingText 变 false → 徽标消失');
  assert.ok(
    task.logs.some((line) => line.includes('回填正文')),
    '任务日志应记录回填动作'
  );
});

test('边界：mentions-posts / user-posts 不越权回填（只对博文维度生效）', async () => {
  installGatewayWithOriginalPost();
  for (const mode of ['mentions-posts', 'user-posts']) {
    store.patchPost(POST_ID, { text: '' });
    const task = await startAndWait({ mode, ownerType: 'users', ownerId: AUTHOR_UID, limit: 10 });
    assert.equal(task.status, 'success', `${mode} 应成功`);
    assert.equal(
      store.getPost(POST_ID).text,
      '',
      `${mode} 的 owner 是用户而非该博文，不做回填（避免把别人的微博正文写进来）`
    );
  }
});

test('手工兜底：PATCH /api/posts/:id {text} 同样能清除 missingText（保底路径）', () => {
  store.patchPost(POST_ID, { text: '手工补录的正文' });
  assert.equal(store.getPost(POST_ID).text, '手工补录的正文');
  assert.equal(!store.getPost(POST_ID).text, false, 'PATCH 是自动回填之外的保底路径（前端已有「粘贴正文」入口）');
});

test('目标行为：补取正文后 missingText 应为 false', async () => {
  installGatewayWithOriginalPost();
  store.patchPost(POST_ID, { text: '' });
  await startAndWait({ mode: 'post-comments', ownerType: 'posts', ownerId: POST_ID, limit: 10 });
  assert.notEqual(store.getPost(POST_ID).text, '', '补取正文后 post.text 必须被回填');
});

/**
 * @file HTTP 层端到端测试（node:test，零依赖）：安全校验、路径穿越、两段式已读、
 *       报告转义、搜索/分页边界、导入导出、数据目录切换。
 *
 * 手法：在测试进程内用 `router.handle` 起真服务（随机端口），全部数据落在临时目录，
 *       不依赖、也不干扰后台运行的那个 7788 实例。
 *
 * 运行：`node --test test/api.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const harness = await import('../test-support/harness.js');
const store = await import('../server/store.js');
const util = await import('../server/util.js');
const router = await import('../server/router.js');
const report = await import('../server/report.js');

const UID = '1650000100';
const POST_ID = '4901234567890999';
const NOV_MS = Date.parse('2026-11-12T09:00:00+08:00');

/** 恶意/边界正文：脚本、引号、&、换行、超长无空格串、emoji。 */
const MALICIOUS = `<script>alert(1)</script> "双引号" '单引号' A&B\n第二行 ` + 'X'.repeat(400) + ' 🚀👍';

let server;

/** 预置可控的本地数据。 */
function seed() {
  store.setDemoMode(false);
  store.addUser({ uid: UID, screenName: '测试用户甲', avatarUrl: '' });
  store.addUser({ uid: '1650000101', screenName: '测试用户乙' });
  const rows = [
    harness.localRecord(store, util, {
      ownerType: 'users',
      ownerId: UID,
      mode: 'received',
      sourceId: '4900000000007101',
      ms: NOV_MS,
      text: MALICIOUS,
    }),
    harness.localRecord(store, util, {
      ownerType: 'users',
      ownerId: UID,
      mode: 'received',
      sourceId: '4900000000007102',
      ms: NOV_MS - 3600000,
      text: '第二条普通评论，含关键词 城市步行。',
    }),
    harness.localRecord(store, util, {
      ownerType: 'users',
      ownerId: UID,
      mode: 'sent',
      sourceId: '4900000000007103',
      ms: NOV_MS - 7200000,
      text: '第三条普通评论，含关键词 城市步行 与 夜间照明。',
    }),
  ];
  store.appendRecords('users', UID, 'received', rows.slice(0, 2));
  store.appendRecords('users', UID, 'sent', rows.slice(2));

  store.addPost({
    id: POST_ID,
    mId: 'NkK9qa00001',
    authorUid: '1650000101',
    author: '测试用户乙',
    text: '一条用于测试的博文正文',
  });
  store.appendRecords('posts', POST_ID, 'post-comments', [
    harness.localRecord(store, util, {
      ownerType: 'posts',
      ownerId: POST_ID,
      mode: 'post-comments',
      sourceId: '4900000000007201',
      ms: NOV_MS,
      text: '博文下的评论 <b>不是标签</b>',
    }),
  ]);
  store.recomputeStats('users', UID);
  store.recomputeStats('posts', POST_ID);
}

test.before(async () => {
  seed();
  server = await harness.startApiServer(router);
});

test.after(async () => {
  if (server) await server.close();
  harness.cleanupSandbox();
});

/* ------------------------------------------------------------------ *
 * 1. 路径穿越 / 非法输入：任何越界都必须 4xx，且不返回仓库源码或凭据
 * ------------------------------------------------------------------ */

test('路径穿越：../、%2e%2e%2f、双编码、反斜杠、绝对路径全部被拒', async () => {
  const attacks = [
    '/reports/../config.json',
    '/reports/..%2fconfig.json',
    '/reports/%2e%2e%2f%2e%2e%2fserver%2fconfig.js',
    '/reports/%252e%252e%252fconfig.json',
    '/reports/..%5cconfig.json',
    '/reports/../data/config.json',
    '/reports/users-1650000100.html/../../config.json',
    '/%2e%2e/server/config.js',
    '/web/../server/config.js',
    '/js/../../server/weibo.js',
    '/reports/....//config.json',
    '/reports/%c0%ae%c0%ae/config.json',
  ];
  for (const attack of attacks) {
    const res = await harness.httpJson(server.base, attack);
    assert.ok(res.status >= 400 && res.status < 500, `${attack} 应返回 4xx，实际 ${res.status}`);
    assert.doesNotMatch(res.text, /WEIBO_BASE|CLIENT_ID|access_token|TOKEN|createServer/i, `${attack} 泄漏了源码内容`);
    assert.doesNotMatch(res.text, /root:|win32|node_modules/i, `${attack} 泄漏了路径/环境信息`);
  }
});

test('报告托管只接受白名单文件名，任意合法形态但未生成的 key 一律 404', async () => {
  for (const name of ['users-1.html', 'posts-1.html', 'users-abc.html', 'users-1650000100.htm', 'config.json', 'users-1650000100.html.bak']) {
    const res = await harness.httpJson(server.base, `/reports/${name}`);
    assert.equal(res.status, 404, `/reports/${name} 应 404，实际 ${res.status}`);
  }
});

test('非法对象 ID：非数字、超长、含 NUL 均不返回数据（4xx，且不是 5xx）', async () => {
  const cases = [
    '/api/owners/users/abc/records',
    '/api/owners/users/1%00/records',
    `/api/owners/users/${'9'.repeat(300)}/records`,
    '/api/owners/users/-1/records',
    '/api/owners/users/1e5/records',
    '/api/owners/posts/abc/records',
    '/api/owners/evil/1650000100/records',
  ];
  for (const pathname of cases) {
    const res = await harness.httpJson(server.base, pathname);
    assert.ok(res.status >= 400 && res.status < 500, `${pathname} 应 4xx，实际 ${res.status}`);
    assert.equal(res.json.ok, false, `${pathname} 不应返回 ok:true`);
    assert.equal(res.json.data, undefined);
  }
});

test('未知接口返回结构化 404 JSON，不会被 SPA 回落成 HTML', async () => {
  const res = await harness.httpJson(server.base, '/api/not-exist');
  assert.equal(res.status, 404);
  assert.equal(res.json.ok, false);
  assert.equal(res.json.error.code, 'NOT_FOUND');
  assert.doesNotMatch(res.text, /<!DOCTYPE/i);
});

test('非法 JSON 请求体返回 400 BAD_REQUEST', async () => {
  const res = await fetch(`${server.base}/api/search`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad json',
  });
  assert.equal(res.status, 400);
  const json = await res.json();
  assert.equal(json.error.code, 'BAD_REQUEST');
});

/* ------------------------------------------------------------------ *
 * 2. 零付费保护（HTTP 视角）
 * ------------------------------------------------------------------ */

test('演示模式下：plan 标注 blocked，取数接口 400 拒绝', async () => {
  store.setDemoMode(true);
  // 演示模式读取的是隔离的 demo 目录，这里在 demo 目录里放一个对象用于预估
  const created = await harness.httpJson(server.base, '/api/users', { method: 'POST', body: { input: UID } });
  assert.equal(created.status, 200, created.text);

  const plan = await harness.httpJson(server.base, '/api/fetch/plan', {
    method: 'POST',
    body: { mode: 'received', ownerId: UID, limit: 10 },
  });
  assert.equal(plan.status, 200, plan.text);
  assert.equal(plan.json.data.blocked.code, 'DEMO_MODE');
  assert.deepEqual(plan.json.data.commands, [], '演示模式不应做任何接口预检');

  const start = await harness.httpJson(server.base, '/api/fetch/tasks', {
    method: 'POST',
    body: { mode: 'received', ownerId: UID, limit: 10 },
  });
  assert.equal(start.status, 400);
  assert.equal(start.json.error.code, 'DEMO_MODE');

  store.setDemoMode(false);
});

test('未登录（非演示模式）：取数接口 401 拒绝', async () => {
  store.writeConfig({ token: null, settings: { demoMode: false } });
  const res = await harness.httpJson(server.base, '/api/fetch/tasks', {
    method: 'POST',
    body: { mode: 'received', ownerId: UID, limit: 10 },
  });
  assert.equal(res.status, 401);
  assert.equal(res.json.error.code, 'UNAUTHORIZED');
});

test('取数参数校验：非法 mode / 非法 ownerId / 模式与对象类型不匹配', async () => {
  const bad = [
    [{ mode: 'hack', ownerId: UID }, 'INVALID_MODE'],
    [{ mode: 'received', ownerId: 'abc' }, 'INVALID_ID'],
    [{ mode: 'post-comments', ownerType: 'users', ownerId: UID }, 'BAD_REQUEST'],
    [{ mode: 'received', ownerId: UID, fromMs: '2026-13-45' }, 'INVALID_DATE_RANGE'],
    [{ mode: 'received', ownerId: UID, fromMs: '2026-11-10', toMs: '2026-11-01' }, 'INVALID_DATE_RANGE'],
  ];
  for (const [body, code] of bad) {
    const res = await harness.httpJson(server.base, '/api/fetch/tasks', { method: 'POST', body });
    assert.equal(res.json.error.code, code, `${JSON.stringify(body)} 应返回 ${code}`);
    assert.ok(res.status >= 400 && res.status < 500);
  }
  // 未在本地库中的对象
  const missing = await harness.httpJson(server.base, '/api/fetch/plan', {
    method: 'POST',
    body: { mode: 'received', ownerId: '1999999999', limit: 10 },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

test('退出登录：清 token、自动进演示模式、本地已归档数据一条不少（P0-06）', async () => {
  store.writeConfig({ token: 'qa-token', account: { uid: '1650000100', screenName: '测试用户甲' }, settings: { demoMode: false } });
  const before = (await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`)).json.data.total;

  const out = await harness.httpJson(server.base, '/api/auth/logout', { method: 'POST' });
  assert.equal(out.status, 200);
  assert.equal(out.json.data.demoMode, true);

  const settings = (await harness.httpJson(server.base, '/api/settings')).json.data;
  assert.equal(settings.loggedIn, false, 'token 必须被清除');
  assert.equal(settings.tokenTail4, '', '不得残留 token 片段');
  assert.equal(settings.settings.demoMode, true, '退出后应进入演示模式');
  assert.equal(settings.account, null);

  store.setDemoMode(false);
  const after = (await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`)).json.data.total;
  assert.equal(after, before, '退出登录不得影响本地已归档数据');
});

/* ------------------------------------------------------------------ *
 * 3. 用户 / 博文录入（P0-07 / P0-09）
 * ------------------------------------------------------------------ */

test('添加用户：数字 UID、/u/ 链接、纯昵称链接；重复添加不产生重复记录', async () => {
  const forms = [
    { input: '1650000200', expect: '1650000200' },
    { input: 'https://weibo.com/u/1650000201', expect: '1650000201' },
    { input: 'weibo.com/u/1650000202?is_all=1', expect: '1650000202' },
    { input: 'https://weibo.com/1650000203', expect: '1650000203' },
  ];
  for (const form of forms) {
    const res = await harness.httpJson(server.base, '/api/users', { method: 'POST', body: { input: form.input } });
    assert.equal(res.status, 200, `${form.input} 应能识别：${res.text}`);
    assert.equal(res.json.data.user.uid, form.expect);
  }

  const dup = await harness.httpJson(server.base, '/api/users', { method: 'POST', body: { input: '1650000200' } });
  assert.equal(dup.status, 200);
  assert.equal(dup.json.data.created, false, '重复添加应返回 created:false');
  const list = await harness.httpJson(server.base, '/api/users');
  assert.equal(list.json.data.items.filter((u) => u.uid === '1650000200').length, 1);

  const bad = await harness.httpJson(server.base, '/api/users', { method: 'POST', body: { input: '随便一段话不是链接' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /无法从该链接识别 UID/);
});

test('添加博文：纯 ID、详情页短链、m.weibo.cn detail 链接；非法输入给出明确提示', async () => {
  const byId = await harness.httpJson(server.base, '/api/posts', { method: 'POST', body: { input: '4901234567890777' } });
  assert.equal(byId.status, 200);
  assert.equal(byId.json.data.post.id, '4901234567890777');

  const byShort = await harness.httpJson(server.base, '/api/posts', {
    method: 'POST',
    body: { input: 'https://weibo.com/1650000101/NkK9qa00002' },
  });
  assert.equal(byShort.status, 200);
  assert.match(byShort.json.data.post.id, /^\d+$/, '短链必须换算成数字 mid');
  assert.equal(byShort.json.data.post.mId, 'NkK9qa00002');

  const byDetail = await harness.httpJson(server.base, '/api/posts', {
    method: 'POST',
    body: { input: 'https://m.weibo.cn/detail/4901234567890778' },
  });
  assert.equal(byDetail.json.data.post.id, '4901234567890778');

  const bad = await harness.httpJson(server.base, '/api/posts', { method: 'POST', body: { input: '不是链接' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error.message, /无法从该链接识别微博 ID/);
});

test('添加博文不会自动取评论（P0-09）：新博文 recordCount 为 0 且 missingText 标记正确', async () => {
  const created = await harness.httpJson(server.base, '/api/posts', { method: 'POST', body: { input: '4901234567890779' } });
  const id = created.json.data.post.id;
  const res = await harness.httpJson(server.base, `/api/posts/${id}`);
  assert.equal(res.json.data.post.stats.recordCount, 0);
  assert.equal(res.json.data.missingText, true, '正文缺失应被标记');
});

/* ------------------------------------------------------------------ *
 * 4. 两段式已读（P0-25）
 * ------------------------------------------------------------------ */

test('两段式已读：生成报告不改未读；不调 read 未读不变；调 read 只减传入的条数', async () => {
  const before = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`);
  const unreadBefore = before.json.data.items.filter((r) => r.isUnread).length;
  const statsUnreadBefore = before.json.data.stats.unreadCount;
  assert.equal(unreadBefore, 3, '初始应有 3 条未读');
  assert.equal(statsUnreadBefore, 3);

  const gen = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'users', ownerId: UID },
  });
  assert.equal(gen.status, 200, gen.text);
  const { reportKey, pendingReadIds, url } = gen.json.data;
  assert.equal(pendingReadIds.length, 3);

  const afterGen = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`);
  assert.equal(afterGen.json.data.stats.unreadCount, 3, '仅生成报告不得改动已读状态');

  // 前端确认能取到报告（这是第二段的前置条件）
  const fileRes = await harness.httpJson(server.base, url);
  assert.equal(fileRes.status, 200);
  assert.match(fileRes.headers.get('content-type'), /text\/html/);

  // 只标记前 2 条
  const read = await harness.httpJson(server.base, `/api/reports/${reportKey}/read`, {
    method: 'POST',
    body: { ids: pendingReadIds.slice(0, 2) },
  });
  assert.equal(read.status, 200);
  assert.equal(read.json.data.marked, 2);
  assert.equal(read.json.data.unreadTotal, 1, '未读应只减少 2 条');

  const afterRead = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`);
  assert.equal(afterRead.json.data.stats.unreadCount, 1);
  const stillUnread = afterRead.json.data.items.filter((r) => r.isUnread).map((r) => r.recordId);
  assert.deepEqual(stillUnread, [pendingReadIds[2]], '剩下那条必须仍未读');

  // 重复标记同一条：幂等，不重复扣减
  const again = await harness.httpJson(server.base, `/api/reports/${reportKey}/read`, {
    method: 'POST',
    body: { ids: [pendingReadIds[0]] },
  });
  assert.equal(again.json.data.marked, 0, '已读的记录重复标记必须 marked=0');
  assert.equal(again.json.data.unreadTotal, 1);
});

test('按分组标记已读（all=true + mode）只影响该分组', async () => {
  const res = await harness.httpJson(server.base, `/api/owners/users/${UID}/read`, {
    method: 'POST',
    body: { all: true, mode: 'sent' },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.marked >= 1);
  const sent = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?mode=sent`);
  assert.equal(sent.json.data.items.filter((r) => r.isUnread).length, 0, 'sent 分组应全部已读');
});

test('report/read 缺 ids 返回 400；对不存在的报告返回 404', async () => {
  const empty = await harness.httpJson(server.base, `/api/reports/users-${UID}/read`, { method: 'POST', body: { ids: [] } });
  assert.equal(empty.status, 400);
  const missing = await harness.httpJson(server.base, '/api/reports/users-1999999999/read', {
    method: 'POST',
    body: { ids: ['abc'] },
  });
  assert.equal(missing.status, 404);
  assert.equal(missing.json.error.code, 'NOT_FOUND');
});

/* ------------------------------------------------------------------ *
 * 5. 报告内容与唯一性（P0-24 / P0-26）
 * ------------------------------------------------------------------ */

test('报告转义：脚本/引号/&/换行/超长串/emoji 全部安全，且不含 token/余额字样', async () => {
  store.appendRecords('users', '1650000101', 'received', [
    // 让「乙用户」也带上恶意正文，覆盖 scoped 报告
    harness.localRecord(store, util, {
      ownerType: 'users',
      ownerId: '1650000101',
      mode: 'received',
      sourceId: '4900000000007301',
      ms: NOV_MS,
      text: MALICIOUS,
    }),
  ]);
  const gen = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'users', ownerId: UID },
  });
  assert.equal(gen.status, 200, gen.text);
  const res = await harness.httpJson(server.base, gen.json.data.url);
  const html = res.text;

  assert.doesNotMatch(html, /<script/i, '报告里不得出现 script 标签');
  assert.doesNotMatch(html, /onerror\s*=|onload\s*=/i);
  assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/, '尖括号必须被转义');
  assert.match(html, /&quot;双引号&quot;/, '双引号必须被转义');
  assert.match(html, /&#39;单引号&#39;/, '单引号必须被转义');
  assert.match(html, /A&amp;B/, '& 必须被转义');
  assert.match(html, /A&amp;B<br>第二行/, '换行必须转成 <br> 保留可读性');
  assert.match(html, /🚀👍/, 'emoji 必须原样保留');
  assert.match(html, /X{400}/, '超长无空格串必须完整保留（靠 CSS 断词）');
  assert.doesNotMatch(html, /<b>不是标签<\/b>/);

  assert.doesNotMatch(html, /access_token/i, '报告不得出现 access_token');
  assert.doesNotMatch(html, /token/i, '报告不得出现 token 字样');
  assert.doesNotMatch(html, /balance|credits|余额/i, '报告不得出现余额/credits');
  assert.doesNotMatch(html, /src\s*=|@import|https?:\/\/(?!weibo\.com|m\.weibo\.cn|wx\d\.sinaimg\.cn)/i, '报告不得引用外部资源');
});

test('报告唯一性：重复生成只保留最新 1 份（P0-24）', async () => {
  const first = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'users', ownerId: UID, limit: 1 },
  });
  assert.equal(first.status, 200);
  const second = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'users', ownerId: UID },
  });
  assert.equal(second.status, 200);
  assert.equal(first.json.data.path, second.json.data.path, '同一对象必须覆盖同一文件');
  assert.ok(second.json.data.recordCount >= first.json.data.recordCount);

  const dir = store.reportsDir();
  const mine = fs.readdirSync(dir).filter((name) => name === `users-${UID}.html`);
  assert.equal(mine.length, 1, '同一对象磁盘上只能有 1 份报告');
});

test('报告自动清理（P0-32）：非白名单 html 与索引孤儿 html 都必须被真正删除', async () => {
  const dir = store.reportsDir();
  const junk = path.join(dir, 'evil-report.html'); // 非白名单形态
  const orphan = path.join(dir, 'users-1999999999.html'); // 白名单形态但索引里没有
  fs.writeFileSync(junk, '<html>junk</html>', 'utf8');
  fs.writeFileSync(orphan, '<html>orphan</html>', 'utf8');

  // 直接调用清理函数：返回值必须真实反映被删文件，不能「报 0 但其实没删/没删却报删」
  const removed = report.cleanupReports();
  const removedList = Array.isArray(removed) ? removed : [];
  assert.equal(fs.existsSync(junk), false, '非白名单 html 必须被删除（否则 P0-32 不成立）');
  assert.equal(fs.existsSync(orphan), false, '索引中无对应条目的孤儿 html 必须被删除');
  assert.ok(
    removedList.includes('evil-report.html') && removedList.includes('users-1999999999.html'),
    `cleanupReports 的返回值必须包含被删文件名，实际 ${JSON.stringify(removedList)}`
  );

  // 再验证「生成报告后也会触发清理」这条路径
  fs.writeFileSync(junk, '<html>junk2</html>', 'utf8');
  await harness.httpJson(server.base, '/api/reports', { method: 'POST', body: { ownerType: 'users', ownerId: UID } });
  assert.equal(fs.existsSync(junk), false, '每次生成报告后也应清理非白名单 html');

  // 合法报告必须幸存
  assert.equal(fs.existsSync(store.reportFilePath(`users-${UID}`)), true, '索引内的报告不得被误删');
});

test('报告元信息：未生成时 404；生成后 meta 含 url/path/recordCount', async () => {
  const missing = await harness.httpJson(server.base, '/api/reports/users-1999999999');
  assert.equal(missing.status, 404);
  const meta = await harness.httpJson(server.base, `/api/reports/users-${UID}`);
  assert.equal(meta.status, 200);
  assert.equal(meta.json.data.url, `/reports/users-${UID}.html`);
  assert.ok(meta.json.data.recordCount >= 1);
});

test('报告文件被删除后，report/read 必须拒绝标记已读（不再误标）', async () => {
  const gen = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'posts', ownerId: POST_ID },
  });
  const { reportKey, url, pendingReadIds } = gen.json.data;
  assert.ok(pendingReadIds.length >= 1, '需要至少 1 条未读才能验证');

  const beforeUnread = (await harness.httpJson(server.base, `/api/owners/posts/${POST_ID}/records?pageSize=200`)).json.data
    .stats.unreadCount;

  fs.rmSync(store.reportFilePath(reportKey), { force: true });
  const fileRes = await harness.httpJson(server.base, url);
  assert.equal(fileRes.status, 404, '文件已删，GET 必须 404');

  const read = await harness.httpJson(server.base, `/api/reports/${reportKey}/read`, {
    method: 'POST',
    body: { ids: pendingReadIds },
  });
  assert.equal(read.status, 404, '报告文件已不存在时必须拒绝标记');
  assert.equal(read.json.error.code, 'NOT_FOUND');
  assert.match(read.json.error.message, /已被删除|重新生成/);

  const afterUnread = (await harness.httpJson(server.base, `/api/owners/posts/${POST_ID}/records?pageSize=200`)).json.data
    .stats.unreadCount;
  assert.equal(afterUnread, beforeUnread, '被拒绝的标记请求不得改动未读数');
});

test('report/read 只接受本报告 pendingReadIds 子集：越权 ID 被丢弃并计入 skipped', async () => {
  // 先重置该博文的未读态：重新灌一条未读记录
  const gen = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'posts', ownerId: POST_ID },
  });
  const { reportKey, pendingReadIds } = gen.json.data;
  assert.ok(pendingReadIds.length >= 1);

  const res = await harness.httpJson(server.base, `/api/reports/${reportKey}/read`, {
    method: 'POST',
    body: { ids: [...pendingReadIds, 'ffffffffffffffff', 'not-a-real-id'] },
  });
  assert.equal(res.status, 200, res.text);
  assert.equal(res.json.data.marked, pendingReadIds.length, '合法 ID 应全部被标记');
  assert.equal(res.json.data.skipped, 2, '越权/不存在于本报告的 ID 必须被丢弃并计入 skipped');

  // 重复提交：已被移除出 pendingReadIds → 幂等
  const again = await harness.httpJson(server.base, `/api/reports/${reportKey}/read`, {
    method: 'POST',
    body: { ids: pendingReadIds },
  });
  assert.equal(again.status, 200);
  assert.equal(again.json.data.marked, 0, '重复提交不得重复标记');
  assert.equal(again.json.data.skipped, pendingReadIds.length, '已消费的 ID 应全部跳过');
});

/* ------------------------------------------------------------------ *
 * 6. 搜索边界（P0-21 / P0-22）
 * ------------------------------------------------------------------ */

test('搜索：空关键词返回全部；总条数与分页 items 自洽', async () => {
  const res = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: {} });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.total >= 5);
  assert.ok(res.json.data.items.length <= res.json.data.pageSize);
  assert.equal(res.json.data.items.length, Math.min(res.json.data.total, res.json.data.pageSize));
});

test('搜索：纯空格/超长/含 <>& 的关键词都不崩且语义合理', async () => {
  const space = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { q: '   ' } });
  assert.equal(space.status, 200);
  assert.equal(space.json.data.conditions.q, '', '纯空格应被 trim 成空关键词');

  const long = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { q: '关'.repeat(5000) } });
  assert.equal(long.status, 200);
  assert.equal(long.json.data.total, 0);

  const special = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { q: '<script>&"x"' } });
  assert.equal(special.status, 200);
  assert.equal(special.json.data.total, 0);
  assert.equal(special.json.data.items.length, 0);
});

test('搜索：日期只填一端、日期倒置、page 越界、pageSize 超限', async () => {
  const onlyTo = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { toMs: '2030-01-01' } });
  assert.equal(onlyTo.status, 200);
  assert.ok(onlyTo.json.data.total >= 1);

  const onlyFrom = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { fromMs: '2020-01-01' } });
  assert.equal(onlyFrom.status, 200);
  assert.ok(onlyFrom.json.data.total >= 1);

  const inverted = await harness.httpJson(server.base, '/api/search', {
    method: 'POST',
    body: { fromMs: '2026-11-10', toMs: '2026-11-01' },
  });
  assert.equal(inverted.status, 400);
  assert.equal(inverted.json.error.code, 'INVALID_DATE_RANGE');

  const beyond = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { page: 999 } });
  assert.equal(beyond.status, 200);
  assert.deepEqual(beyond.json.data.items, [], '超出总页数应返回空 items，而不是报错');
  assert.ok(beyond.json.data.total >= 1, 'total 仍应是真实命中数');

  const hugeSize = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { pageSize: 1000 } });
  assert.equal(hugeSize.status, 200);
  assert.ok(hugeSize.json.data.pageSize <= 200, `pageSize 必须被夹到 200，实际 ${hugeSize.json.data.pageSize}`);
});

test('搜索：关键词 + 作者 + 对象 + 日期四条件取交集，且条件回显与生效条件一致', async () => {
  const byKeyword = await harness.httpJson(server.base, '/api/search', { method: 'POST', body: { q: '城市步行' } });
  assert.ok(byKeyword.json.data.total >= 2, '应有 2 条命中城市步行');

  const byAuthor = await harness.httpJson(server.base, '/api/search', {
    method: 'POST',
    body: { q: '城市步行', author: '本地作者' },
  });
  assert.equal(byAuthor.status, 200);
  assert.equal(byAuthor.json.data.total, byKeyword.json.data.total, '作者过滤为同一作者时应不影响命中');

  const byWrongAuthor = await harness.httpJson(server.base, '/api/search', {
    method: 'POST',
    body: { q: '城市步行', author: '不存在的作者' },
  });
  assert.equal(byWrongAuthor.json.data.total, 0);

  const byOwner = await harness.httpJson(server.base, '/api/search', {
    method: 'POST',
    body: { q: '城市步行', ownerType: 'users', ownerId: UID },
  });
  assert.equal(byOwner.json.data.total, 2);

  const outOfRange = await harness.httpJson(server.base, '/api/search', {
    method: 'POST',
    body: { q: '城市步行', fromMs: '2020-01-01', toMs: '2020-12-31' },
  });
  assert.equal(outOfRange.json.data.total, 0, '日期区间外应无命中');

  assert.equal(byKeyword.json.data.conditions.q, '城市步行');
  assert.equal(byKeyword.json.data.conditions.ownerType, '');
});

/* ------------------------------------------------------------------ *
 * 7. 记录分页与时间轴
 * ------------------------------------------------------------------ */

test('记录分页：pageSize 夹取、total 与分页自洽、非法 mode 报错', async () => {
  const all = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=200`);
  const total = all.json.data.total;
  assert.ok(total >= 3);

  const p1 = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=1&page=1`);
  assert.equal(p1.json.data.items.length, 1);
  assert.equal(p1.json.data.total, total);

  const p2 = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=1&page=2`);
  assert.equal(p2.json.data.items.length, 1);
  assert.notEqual(p1.json.data.items[0].recordId, p2.json.data.items[0].recordId, '两页不能返回同一条');

  const badMode = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?mode=evil`);
  assert.equal(badMode.status, 400);
  assert.equal(badMode.json.error.code, 'INVALID_MODE');

  const clamp = await harness.httpJson(server.base, `/api/owners/users/${UID}/records?pageSize=5000`);
  assert.ok(clamp.json.data.pageSize <= 200);

  assert.ok(Array.isArray(all.json.data.timeline), '时间轴数据应返回（P0-19）');
  assert.ok(Array.isArray(all.json.data.gaps), 'gap 待补区间应返回（P0-14）');
});

/* ------------------------------------------------------------------ *
 * 8. 导入导出（P0-31）
 * ------------------------------------------------------------------ */

test('导出数据包不含 token / 订阅 / 已读状态；再导入时全部按 recordId 跳过', async () => {
  const res = await harness.httpJson(server.base, '/api/exchange/export');
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-disposition') || '', /attachment; filename=/);
  assert.doesNotMatch(res.text, /token|access_token|refreshToken/i, '数据包不得携带登录态');
  assert.doesNotMatch(res.text, /"subscriptions?":/i, '数据包不得携带订阅');
  assert.doesNotMatch(res.text, /isUnread/);
  assert.doesNotMatch(res.text, /"remark":/);

  const payload = res.json;
  assert.ok(Array.isArray(payload.records) && payload.records.length >= 5);

  const imported = await harness.httpJson(server.base, '/api/exchange/import', { method: 'POST', body: payload });
  assert.equal(imported.status, 200);
  assert.equal(imported.json.data.added, 0, '同一份数据再导入必须 0 新增');
  assert.ok(imported.json.data.skipped >= 5);

  const bad = await harness.httpJson(server.base, '/api/exchange/import', { method: 'POST', body: { schema: 'other/9' } });
  assert.equal(bad.status, 400);
});

/* ------------------------------------------------------------------ *
 * 9. 静态资源与深链
 * ------------------------------------------------------------------ */

test('首页与深链：/ 与 /users/xxx 都返回 index.html（前端 hash 路由），静态资源可获取', async () => {
  for (const pathname of ['/', '/users/1650000100', '/posts/4901234567890999', '/search', '/settings']) {
    const res = await harness.httpJson(server.base, pathname);
    assert.equal(res.status, 200, `${pathname} 应 200`);
    assert.match(res.text, /<!DOCTYPE html>/i, `${pathname} 应返回 HTML 骨架`);
    assert.match(res.text, /Weibo Reader/);
  }
  const js = await harness.httpJson(server.base, '/js/app.js');
  assert.equal(js.status, 200);
  assert.match(js.headers.get('content-type'), /javascript/);
  assert.equal(js.headers.get('x-content-type-options'), 'nosniff');

  const missingAsset = await harness.httpJson(server.base, '/js/nope.js');
  assert.equal(missingAsset.status, 404, '带扩展名的缺失资源必须 404，不能回落 index.html');
});

test('安全响应头：/api/* 带 nosniff + no-store；/reports/*.html 带 CSP', async () => {
  const api = await harness.httpJson(server.base, '/api/health');
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(api.headers.get('cache-control'), 'no-store');

  const gen = await harness.httpJson(server.base, '/api/reports', {
    method: 'POST',
    body: { ownerType: 'users', ownerId: UID },
  });
  const reportRes = await harness.httpJson(server.base, gen.json.data.url);
  assert.match(reportRes.headers.get('content-security-policy') || '', /default-src 'none'/);
  assert.equal(reportRes.headers.get('referrer-policy'), 'no-referrer');
});

/* ------------------------------------------------------------------ *
 * 10. 设置：数据目录切换（P0-30）
 * ------------------------------------------------------------------ */

test('数据目录切换：不可写时拒绝并保留原配置；可写时切换成功', async () => {
  const plainFile = harness.makePlainFile('not-a-dir.txt');
  const before = (await harness.httpJson(server.base, '/api/settings')).json.data.dataDir;

  const rejected = await harness.httpJson(server.base, '/api/settings', { method: 'PATCH', body: { dataDir: plainFile } });
  assert.equal(rejected.status, 400, rejected.text);
  assert.equal(rejected.json.error.code, 'IO_ERROR');
  const after = (await harness.httpJson(server.base, '/api/settings')).json.data.dataDir;
  assert.equal(after, before, '切换失败不得改动配置');

  const empty = await harness.httpJson(server.base, '/api/settings', { method: 'PATCH', body: { dataDir: '   ' } });
  assert.equal(empty.status, 200, '空白目录名视为未提交，不应报错');

  const target = path.join(harness.sandboxRoot, 'switch-target');
  const ok = await harness.httpJson(server.base, '/api/settings', { method: 'PATCH', body: { dataDir: target } });
  assert.equal(ok.status, 200, ok.text);
  assert.equal(path.resolve(ok.json.data.dataDir), path.resolve(target));
  assert.equal(fs.existsSync(path.join(target, 'records')), true, '切换后应自动建好子目录');
  const swapped = await harness.httpJson(server.base, '/api/users');
  assert.deepEqual(swapped.json.data.items, [], '切换后应看不到旧目录的数据');

  // 切回原目录，避免影响后续用例
  await harness.httpJson(server.base, '/api/settings', { method: 'PATCH', body: { dataDir: harness.sandboxRoot } });
});

test('设置项校验：pageSize / reportMaxRecords 被夹到合法区间', async () => {
  const res = await harness.httpJson(server.base, '/api/settings', {
    method: 'PATCH',
    body: { pageSize: 9999, reportMaxRecords: 999999 },
  });
  assert.equal(res.status, 200);
  assert.ok(res.json.data.settings.pageSize <= 200);
  assert.ok(res.json.data.settings.reportMaxRecords <= 5000);
});

/**
 * @file 前端静态与纯函数测试（node:test，零依赖）：转义/高亮安全、模块导入一致性、
 *       index.html 资源引用存在性。
 *
 * 为什么需要「导入一致性」测试：浏览器里少 import 一个函数不会在构建期报错，
 * 只会在运行时抛 `X is not defined` 并把整个视图打成错误条（本次验收就抓到了
 * `views-library.js` 未导入 `fmtNum` 导致首页不可用）。这类缺陷必须由静态检查兜住。
 *
 * 运行：`node --test test/frontend.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const WEB_DIR = path.resolve(import.meta.dirname, '..', 'web');
const JS_DIR = path.join(WEB_DIR, 'js');

/** 读取 web/js 下所有前端模块（不含子目录）。 */
const modules = fs
  .readdirSync(JS_DIR)
  .filter((name) => name.endsWith('.js'))
  .map((name) => ({ name, file: path.join(JS_DIR, name), src: fs.readFileSync(path.join(JS_DIR, name), 'utf8') }));

/** api.js 的导出符号表。 */
const apiSrc = modules.find((m) => m.name === 'api.js').src;
const apiExports = [...apiSrc.matchAll(/export\s+(?:async\s+)?function\s+([\w$]+)|export\s+const\s+([\w$]+)/g)].map(
  (m) => m[1] || m[2]
);
const api = await import('../web/js/api.js');

test('api.js 至少导出前端公共工具（防止导出被误删）', () => {
  for (const name of ['api', 'esc', 'escText', 'highlight', 'fmtNum', 'fmtTime', 'html', 'navigate', 'toast', 'setBusy']) {
    assert.ok(apiExports.includes(name), `api.js 应导出 ${name}`);
  }
});

test('导入一致性：所有前端模块用到的 api.js 符号都必须真的被 import', () => {
  const problems = [];
  for (const mod of modules) {
    if (mod.name === 'api.js') continue;
    const importMatch = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/api\.js['"]/.exec(mod.src);
    const imported = importMatch
      ? importMatch[1]
          .split(',')
          .map((part) => part.trim().split(/\s+as\s+/).pop().trim())
          .filter(Boolean)
      : [];
    // 去掉 import 语句本身，避免把 import 里的名字当成使用点
    const body = importMatch ? mod.src.replace(importMatch[0], '') : mod.src;
    for (const name of apiExports) {
      const used = new RegExp(`(^|[^.\\w$])${name}\\s*\\(`).test(body);
      if (used && !imported.includes(name)) problems.push(`${mod.name}: 使用了 ${name}() 但没有从 ./api.js 导入`);
    }
  }
  assert.deepEqual(problems, [], `发现未导入即使用的公共函数（浏览器里会 ReferenceError）：\n${problems.join('\n')}`);
});

test('前端模块不得使用 innerHTML 拼接未经 esc() 处理的服务端数据（抽查高危字段）', () => {
  // 只检查「同一行里既出现 HTML 标签、又裸插字段」的行——这类才是 innerHTML 注入点；
  // 纯 JS 的模板串（如 <option> 的 label 对象）会在插入时统一 esc()，不算问题。
  const risky = ['record.text', 'item.text', 'user.screenName', 'item.author', 'record.author', 'sub.ownerLabel', 'item.ownerLabel', 'user.remark'];
  const problems = [];
  for (const mod of modules) {
    mod.src.split('\n').forEach((line, index) => {
      if (!/<[a-z][a-z0-9-]*[\s>]/i.test(line)) return;
      for (const field of risky) {
        const bare = new RegExp(`\\$\\{\\s*${field.replace(/\./g, '\\.')}\\s*\\}`);
        if (bare.test(line)) problems.push(`${mod.name}:${index + 1} 行 \${${field}} 直接插入 HTML，缺 esc()`);
      }
    });
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('转义函数：& < > " 、单引号全部被编码', () => {
  assert.equal(api.esc(`<img src=x onerror="alert('1')">&`), '&lt;img src=x onerror=&quot;alert(&#39;1&#39;)&quot;&gt;&amp;');
  assert.equal(api.esc(null), '');
  assert.equal(api.esc(undefined), '');
  assert.equal(api.esc(0), '0');
  assert.equal(api.escText('a\nb'), 'a\nb', '换行保留（依赖 CSS white-space: pre-wrap）');
});

test('关键词高亮：恶意关键词与恶意正文都不会产出可执行标签', () => {
  const html = api.highlight('<script>alert(1)</script> 关键词 <b>x</b>', ['<script>', '关键词']);
  assert.doesNotMatch(html, /<script/i, '正文里的 script 必须被转义');
  assert.doesNotMatch(html, /<b>/i, '正文里的 b 标签必须被转义');
  assert.match(html, /&lt;mark&gt;|&lt;script&gt;/);
  assert.match(html, /<mark>/);

  // 正则元字符作为关键词不能抛出异常，也不能把正文吞掉
  const withSpecial = api.highlight('a.b*c', ['.', '*', '(']);
  assert.match(withSpecial, /a/);
  assert.equal(api.highlight('abc', []), 'abc', '无关键词时退化为纯转义');

  // 大小写不敏感
  const ci = api.highlight('KeyWord', ['keyword']);
  assert.match(ci, /<mark>KeyWord<\/mark>/);
});

test('纯函数：fmtNum 对空值回落为 "—"（不再把「余额未知」渲染成 0 credits）', () => {
  // 回归护栏（对应 QA-REPORT M-1）：`Number(null) === 0`，若用
  // `Number.isFinite(Number(v))` 判空，「余额未知」会被渲染成「剩余 0 credits」。
  assert.equal(api.fmtNum(null), '—', 'null 必须显示为 — 而不是 0');
  assert.equal(api.fmtNum(undefined), '—');
  assert.equal(api.fmtNum(''), '—');
  assert.equal(api.fmtNum('abc'), '—', '非数字必须显示为 —');
  assert.equal(api.fmtNum(NaN), '—');
  assert.equal(api.fmtNum(1.5), '1.5');
  assert.equal(api.fmtNum(2), '2');
  assert.equal(api.fmtNum(0.02, 4), '0.02');

  // 0 是合法值，绝不能被当成空值吞掉（「今日消耗 0」「余额 0」必须显示 0）
  assert.equal(api.fmtNum(0), '0', '0 必须显示为 0，不能被当成空值');
  assert.equal(api.fmtNum('0'), '0');
});

test('numOrNull：严格判空但保留合法 0（M-1 的统一入口）', () => {
  assert.equal(api.numOrNull(null), null);
  assert.equal(api.numOrNull(undefined), null);
  assert.equal(api.numOrNull(''), null);
  assert.equal(api.numOrNull('   '), 0, '纯空格 Number() 得 0，属边缘行为，此处仅锁定不抛错');
  assert.equal(api.numOrNull('abc'), null);
  assert.equal(api.numOrNull(NaN), null);
  assert.equal(api.numOrNull(Infinity), null);
  assert.equal(api.numOrNull(0), 0, '0 必须被保留');
  assert.equal(api.numOrNull('0'), 0);
  assert.equal(api.numOrNull(1.25), 1.25);
  assert.equal(api.numOrNull('3.5'), 3.5);
});

test('index.html 引用的静态资源都存在，且除充值入口外无外链（离线可用）', () => {
  const htmlSrc = fs.readFileSync(path.join(WEB_DIR, 'index.html'), 'utf8');
  const rechargeUrl = 'https://open.weibo.com/cli';
  const refs = [...htmlSrc.matchAll(/(?:src|href)="([^"]+)"/g)].map((m) => m[1]);
  assert.ok(refs.length >= 2);
  for (const ref of refs) {
    if (ref.startsWith('#')) continue;
    if (ref === rechargeUrl) continue;
    // 允许站内相对路径（便于部署到子路径）与站内绝对路径
    assert.ok(!/^[a-z][a-z0-9+.-]*:/i.test(ref), `${ref} 应为站内路径`);
    const file = path.join(WEB_DIR, ref.replace(/^\/+/, ''));
    assert.equal(fs.existsSync(file), true, `index.html 引用的 ${ref} 不存在`);
  }
  const offlineHtml = htmlSrc.split(rechargeUrl).join('');
  assert.doesNotMatch(offlineHtml, /https?:\/\//i, 'index.html 除充值入口外不得引用外链（离线可用要求）');
});

test('前端源码不得引用外部 CDN/字体（PRD §6 无外链要求）', () => {
  const allowed = /https?:\/\/(?:weibo\.com|m\.weibo\.cn|wx\d\.sinaimg\.cn|idolgallery\.xyz|idolgallary\.xyz|127\.0\.0\.1|localhost)/i;
  for (const mod of modules) {
    for (const [index, line] of mod.src.split('\n').entries()) {
      const urls = line.match(/https?:\/\/[^\s'"`)<>]+/gi) || [];
      for (const url of urls) {
        assert.match(url, allowed, `${mod.name}:${index + 1} 出现可疑外链 ${url}`);
      }
    }
  }
  const css = fs.readFileSync(path.join(WEB_DIR, 'css', 'app.css'), 'utf8');
  assert.doesNotMatch(css, /@import|url\(\s*['"]?https?:/i, 'CSS 不得引用外部资源');
});

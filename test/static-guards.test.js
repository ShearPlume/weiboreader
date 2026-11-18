/**
 * @file 跨层静态护栏（node:test，零依赖）：抓「未导入即使用」这类只在运行时爆炸的缺陷。
 *
 * 为什么需要：本轮验收出现过两次同类事故——前端 `views-library.js` 用了 `fmtNum` 却
 * 没 import（首页整页 ReferenceError），服务端 `report.js` 用了 `path.join` 却没
 * import `node:path`（清理函数被 try/catch 静默吞掉，报告清理彻底失效且无任何报错）。
 * 这类缺陷语法检查过、构建也过，只有真的跑到那行才会炸；而后者甚至炸了也不报错。
 *
 * 运行：`node --test test/static-guards.test.js`
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const PROJECT_ROOT = path.resolve(import.meta.dirname, '..');

/** 需要检查的目录（源码，不含测试）。 */
const SOURCE_DIRS = ['server', 'web/js'];

/** Node 内置模块名 → 允许的本地别名（模块名本身也可能是命名空间导入）。 */
const NODE_BUILTINS = [
  'fs',
  'path',
  'os',
  'http',
  'https',
  'url',
  'crypto',
  'util',
  'stream',
  'zlib',
  'events',
  'child_process',
  'readline',
  'querystring',
];

/** 真正的全局对象，不要求 import。 */
const REAL_GLOBALS = new Set(['process', 'Buffer', 'console', 'globalThis', 'fetch', 'URL', 'URLSearchParams', 'Response', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'structuredClone']);

/** 收集某文件的全部源码文本。 */
function listSources() {
  const out = [];
  for (const dir of SOURCE_DIRS) {
    const abs = path.join(PROJECT_ROOT, dir);
    for (const name of fs.readdirSync(abs).filter((n) => n.endsWith('.js'))) {
      out.push({ label: `${dir}/${name}`, src: fs.readFileSync(path.join(abs, name), 'utf8') });
    }
  }
  return out;
}

/** 从源码中提取「已导入的本地名」与「已声明的本地名」。 */
function collectDeclaredNames(src) {
  const names = new Set();

  // import fs from 'node:fs' / import * as store from ... / import { a, b as c } from ...
  for (const m of src.matchAll(/^\s*import\s+([\s\S]*?)\s+from\s+['"][^'"]+['"];?/gm)) {
    const clause = m[1];
    const def = /^([\w$]+)\s*(?:,|$)/.exec(clause);
    if (def && !clause.trim().startsWith('{')) names.add(def[1]);
    const ns = /\*\s*as\s+([\w$]+)/.exec(clause);
    if (ns) names.add(ns[1]);
    const braces = /\{([\s\S]*?)\}/.exec(clause);
    if (braces) {
      for (const part of braces[1].split(',')) {
        const piece = part.trim();
        if (!piece) continue;
        const alias = /\s+as\s+([\w$]+)$/.exec(piece);
        names.add(alias ? alias[1] : piece);
      }
    }
  }

  // const/let/var/function/class 声明
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([\w$]+)/g)) names.add(m[1]);
  for (const m of src.matchAll(/\b(?:function|class)\s+([\w$]+)/g)) names.add(m[1]);
  // 解构声明：const { a, b } = ... / const [a, b] = ...
  for (const m of src.matchAll(/\b(?:const|let|var)\s*\{([^}]*)\}/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().split(':').pop().trim().split('=')[0].trim();
      if (/^[\w$]+$/.test(piece)) names.add(piece);
    }
  }
  // 函数参数（简化：括号内的标识符）
  for (const m of src.matchAll(/(?:function\s*[\w$]*\s*|\)\s*=>\s*|\b[\w$]+\s*=>\s*)\(([^)]*)\)/g)) {
    for (const part of m[1].split(',')) {
      const piece = part.trim().split('=')[0].trim();
      if (/^[\w$]+$/.test(piece)) names.add(piece);
    }
  }
  return names;
}

/** 去掉注释与字符串字面量，避免把注释/文档里的词当成使用点。 */
function stripCommentsAndStrings(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/[^\n]*/g, '$1 ')
    .replace(/'(?:[^'\\]|\\.)*'/g, "''")
    .replace(/"(?:[^"\\]|\\.)*"/g, '""')
    .replace(/`(?:[^`\\]|\\.)*`/g, '``');
}

test('服务端与前端都不得「使用 Node 内置模块前缀却未导入」（本轮 report.js 的 path 事故）', () => {
  const problems = [];
  for (const { label, src } of listSources()) {
    const declared = collectDeclaredNames(src);
    const code = stripCommentsAndStrings(src);
    for (const mod of NODE_BUILTINS) {
      // 只看「标识符后紧跟点」的使用形态，避免把 .path / 'path' 之类误判
      const used = new RegExp(`(^|[^.\\w$'"\`])${mod}\\s*\\.`, 'm').test(code);
      if (!used) continue;
      if (declared.has(mod)) continue;
      problems.push(`${label}: 使用了 \`${mod}.\` 但既未 import 也未声明（运行时会 ReferenceError）`);
    }
  }
  assert.deepEqual(problems, [], `发现「未导入即使用」的模块前缀：\n${problems.join('\n')}`);
});

test('不得使用真正的全局对象以外的裸标识符（抽查常见笔误）', () => {
  const mistyped = ['requre', 'imoprt', 'exportt', 'functoin', 'awiat', 'Docuemnt', 'JSONx'];
  const problems = [];
  for (const { label, src } of listSources()) {
    const code = stripCommentsAndStrings(src);
    for (const bad of mistyped) {
      if (new RegExp(`(^|[^.\\w$])${bad}\\b`).test(code)) problems.push(`${label}: 出现疑似拼写错误的标识符 ${bad}`);
    }
  }
  assert.deepEqual(problems, [], problems.join('\n'));
});

test('catch 块不得静默吞掉可能的编程错误：{} 或只写注释的 catch 必须限定在「可预期失败」处', () => {
  // 不是禁止空 catch（I/O 容错需要它），而是把「空 catch + 危险操作」这种组合点名出来，
  // 要求作者显式确认。历史上 report.js 的 path 未导入正是被空 catch 吞掉的。
  const risky = [/fs\.rmSync/, /fs\.unlinkSync/, /fs\.writeFileSync/, /JSON\.parse/];
  const problems = [];
  for (const { label, src } of listSources()) {
    // 找到每个 catch 块及其内部内容
    for (const m of src.matchAll(/catch\s*(?:\([^)]*\))?\s*\{([\s\S]*?)\n\s*\}/g)) {
      const body = m[1];
      const isEmpty = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '').trim() === '';
      if (!isEmpty) continue;
      // 取 catch 之前 400 字符，看这段是否含危险操作
      const before = src.slice(Math.max(0, m.index - 400), m.index);
      for (const re of risky) {
        if (re.test(before)) {
          const line = src.slice(0, m.index).split('\n').length;
          problems.push(`${label}:${line} 空 catch 包裹了 ${re.source}，异常会被完全吞掉（须写日志或校验收敛原因）`);
          break;
        }
      }
    }
  }
  // 允许存在，但必须在报告里被知晓：这里只断言「不超过既有基线」，防止继续恶化
  assert.ok(
    problems.length <= 12,
    `空 catch 包裹危险操作的位置过多（${problems.length} 处），新增点请显式记录日志：\n${problems.join('\n')}`
  );
});

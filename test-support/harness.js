/**
 * @file QA 测试沙箱：把数据根目录指向系统临时目录（绝不污染仓库 data/），
 *       并提供 fetch 打桩、HTTP 客户端、记录工厂等测试工具。
 *
 * 重要：必须在导入任何 `server/*` 模块之前导入本模块——环境变量在模块顶层设置，
 * 而 `server/config.js` 在导入时就固化 `DEFAULT_DATA_DIR`。
 * 因此测试文件请统一使用动态导入：
 *
 *   const harness = await import('../test-support/harness.js');
 *   const store = await import('../server/store.js');
 *
 * 注意：本文件刻意放在 `test-support/` 而不是 `test/`——`node --test` 会把 `test/` 下
 * 所有 .js 都当成测试文件执行，放在里面会被重复执行并泄漏临时目录。
 *
 * @module test-support/harness
 */

import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'weibo-qa-'));
process.env.WEIBO_READER_DATA_DIR = tmpRoot;

// 兜底清理：即使用例没走到 after 钩子（异常/超时），也不留临时目录
process.on('exit', () => {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 忽略 */
  }
});

/** 本次测试使用的临时数据根目录。 */
export const sandboxRoot = tmpRoot;

/** 删除临时目录（测试收尾）。 */
export function cleanupSandbox() {
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响测试结论 */
  }
}

/** 一个不会产生网络的假 Base URL 之外，所有请求都走 fetch 打桩。 */
const API_PREFIX = 'https://open.weibo.com/cli/api';

/**
 * 安装 fetch 打桩。
 * @param {(route:{path:string,method:string,body:object|null}, index:number)=>({status?:number,json?:unknown,delayMs?:number})} handler
 * @returns {Array<{path:string,method:string,body:object|null}>} 调用流水（引用，随时可读）
 */
export function installFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init = {}) => {
    const full = String(url);
    const pathname = full.startsWith(API_PREFIX) ? full.slice(API_PREFIX.length) : full;
    let body = null;
    if (init && init.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = null;
      }
    }
    const route = { path: pathname, method: String(init.method || 'GET').toUpperCase(), body };
    calls.push(route);
    const out = (await handler(route, calls.length - 1)) || {};
    if (out.delayMs) await new Promise((resolve) => setTimeout(resolve, out.delayMs));
    const payload = out.json === undefined ? '' : JSON.stringify(out.json);
    return new Response(payload, {
      status: out.status || 200,
      headers: { 'Content-Type': 'application/json' },
    });
  };
  return calls;
}

/** 还原真实 fetch（若有）。 */
export function restoreFetch(original) {
  globalThis.fetch = original;
}

/** 标准「命令预检」响应体：支持 since_id / max_id / page / count / uid。 */
export function commandsPayload(unitPrice = 0.02) {
  return {
    commands: [
      {
        flags: ['count', 'uid', 'max_id', 'since_id', 'page', 'id', 'mid'],
        pricing: { unit_price: unitPrice, currency: 'credits', configured: true },
      },
    ],
  };
}

/** 微博 whoami 响应。 */
export function whoamiPayload(balance = 100) {
  return { user: { balance }, service_status: { kind: 'personal', title: '个人版' } };
}

/**
 * 构造一条接口原始评论/微博条目。
 * @param {string} id 微博侧数字 ID（字符串）
 * @param {object} [extra]
 */
export function rawItem(id, extra = {}) {
  return {
    idstr: String(id),
    id: String(id),
    text: `测试正文 ${id}`,
    created_at: extra.created_at || 'Wed Nov 12 10:00:00 +0800 2026',
    user: { idstr: '1650000777', screen_name: '作者甲' },
    status: { idstr: '4900000000009999' },
    ...extra,
  };
}

/**
 * 构造一条本地归档记录（供 store.appendRecords 直接入库）。
 * @param {object} store server/store.js
 * @param {object} util server/util.js
 * @param {{ownerType:string,ownerId:string,mode:string,sourceId:string,ms:number,text?:string}} p
 */
export function localRecord(store, util, p) {
  const recordId = store.makeRecordId(p.ownerType, p.ownerId, p.mode, p.sourceId);
  return {
    recordId,
    sourceRef: p.sourceId,
    sourceId: p.sourceId,
    mode: p.mode,
    type: p.mode,
    group: p.mode,
    author: p.author || '本地作者',
    authorUid: p.authorUid || '1650000777',
    time: util.fmtTime(p.ms),
    ms: p.ms,
    text: p.text === undefined ? `本地记录 ${p.sourceId}` : p.text,
    textTruncated: false,
    postId: '',
    postUrl: '',
    source: 'api',
    fetchedAtMs: Date.now(),
  };
}

/**
 * 在当前进程内启动一个基于 router.handle 的 HTTP 服务（随机端口，不写仓库 data/）。
 * @param {object} router server/router.js
 * @returns {Promise<{base:string,close:()=>Promise<void>}>}
 */
export async function startApiServer(router) {
  const server = http.createServer((req, res) => {
    router.handle(req, res).catch(() => {
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: 'test harness' } }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

/**
 * JSON HTTP 请求（使用真实 fetch，指向本地测试服务）。
 * @param {string} base
 * @param {string} pathname
 * @param {{method?:string,body?:unknown,raw?:boolean}} [options]
 * @returns {Promise<{status:number,json:any,text:string,headers:Headers}>}
 */
export async function httpJson(base, pathname, options = {}) {
  const method = options.method || 'GET';
  const init = { method, headers: {} };
  if (options.body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(options.body);
  }
  const res = await fetch(`${base}${pathname}`, init);
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = null;
  }
  return { status: res.status, json, text, headers: res.headers };
}

/** 轮询等待条件成立。 */
export async function waitFor(predicate, timeoutMs = 4000, stepMs = 5) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await predicate();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error('waitFor 超时：条件始终未成立');
}

/** 写一个只用于占位的普通文件（测试「目录不可写」用）。 */
export function makePlainFile(name = 'not-a-dir.txt') {
  const file = path.join(tmpRoot, name);
  fs.writeFileSync(file, 'x', 'utf8');
  return file;
}

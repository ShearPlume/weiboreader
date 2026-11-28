/**
 * @file 启动入口：初始化数据目录 → 首次运行 seed 演示数据 → 清理冗余报告 →
 *       创建 HTTP 服务（127.0.0.1）→ 启动订阅调度器（30s）→ 打印访问地址。
 *
 * 进程退出即停：订阅与任务均不跨进程存活（PRD Q1）。
 * @module server/server
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

import { APP_NAME, HOST, PORT, VERSION } from './config.js';
import { log } from './util.js';
import * as store from './store.js';
import * as router from './router.js';
import * as demo from './demo.js';
import * as report from './report.js';
import * as fetcher from './fetcher.js';
import * as scheduler from './scheduler.js';

/** 单个实例最长多久不刷新锁即视为已死（秒），用于兜住 pid 复用的误判。 */
const LOCK_STALE_MS = 3 * 60 * 1000;

/**
 * 判断锁持有者是否真的还活着。
 *
 * 只 `kill(pid, 0)` 是不够的：Windows 上 pid 会被快速复用，一个已退出的实例
 * 的 pid 可能被系统分配给任意无关程序，于是「进程存在」被误判成「本应用在跑」，
 * 用户就会永久打不开且报错指向一个不相干进程 —— 这是最糟的故障形态。
 *
 * 因此用两个信号相互印证：
 * 1. 锁文件 mtime 心跳：运行中的实例每 30 秒刷新一次 mtime，超过 `LOCK_STALE_MS` 未刷新即视为陈旧；
 * 2. pid 存活性（作为快速通道，配合心跳窗口判断）。
 *
 * @param {string} lockFile 锁文件路径
 * @param {number|null} pid 锁中记录的 pid
 * @returns {boolean} 是否真的有实例在运行
 */
function lockHolderAlive(lockFile, pid) {
  let ageMs = Infinity;
  try {
    ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
  } catch {
    return false;
  }
  const heartbeating = ageMs < LOCK_STALE_MS;
  if (!heartbeating) return false; // 心跳停了，无论 pid 在不在都算陈旧
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM = 进程存在但无权限；ESRCH = 已退出
    return err && err.code === 'EPERM';
  }
}

/**
 * 单实例锁：同一个数据目录只允许一个进程写入。
 *
 * 为什么必须有：两个实例同时跑会在同一批 JSONL 上并发追加/覆盖，
 * 本机实测出现过 `posts.json` 丢失、未读数从 166 变成 156 的数据损坏。
 * 若端口不同（例如 PORT=7789 的第二个实例），仅靠端口冲突拦不住，必须用文件锁。
 *
 * 锁内容带一个随机 token，释放时校验 token 而不只是 pid：
 * pid 会被系统复用，只按 pid 判断可能误删「别人刚建的锁」。
 * 陈旧锁自动回收：心跳超时或持有进程已退出则直接接管，避免崩溃后永久锁死。
 *
 * 注意：本函数**不打印任何面向用户的错误**，只返回失败原因。因为「锁被占用」
 * 最常见的原因其实是「本应用已经在运行」，那种情况应当友好地打开浏览器而不是报错。
 * @returns {{ok:true, release:Function}|{ok:false, reason:'busy'|'unwritable', holderPid:number|null, lockFile:string}}
 */
function acquireInstanceLock() {
  const lockFile = path.join(store.baseDataDir(), '.instance.lock');
  const token = randomUUID();
  const stamp = () => `pid=${process.pid} token=${token} at=${new Date().toISOString()} dir=${store.baseDataDir()}`;
  try {
    fs.mkdirSync(store.baseDataDir(), { recursive: true });
    fs.writeFileSync(lockFile, stamp(), { flag: 'wx' });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') throw err;
    let holder = null;
    try {
      const content = fs.readFileSync(lockFile, 'utf8');
      const matched = /pid=(\d+)/.exec(content);
      holder = matched ? Number(matched[1]) : null;
    } catch {
      holder = null;
    }
    if (lockHolderAlive(lockFile, holder)) {
      return { ok: false, reason: 'busy', holderPid: holder, lockFile };
    }
    // 陈旧锁：持有进程已不存在 / 心跳已停，直接接管
    if (Number.isInteger(holder) && holder > 0) {
      let pidStillThere = false;
      try {
        process.kill(holder, 0);
        pidStillThere = true;
      } catch (err) {
        pidStillThere = Boolean(err && err.code === 'EPERM');
      }
      if (pidStillThere) {
        // 心跳已停但 pid 仍在：可能是本应用被挂起（如笔记本休眠）后恢复，
        // 也可能该 pid 已被系统分配给无关程序。两种情况都接管，但留下告警便于排查。
        log('warn', 'server', 'lock-takeover', {
          holderPid: holder,
          note: '锁心跳已超时，按陈旧锁接管；若确有另一实例在运行请立即关闭',
        });
      }
    }
    fs.writeFileSync(lockFile, stamp());
  }
  // 回读自检：确认磁盘上的锁确实是本进程，避免在异常的 pid 映射下"以为拿到实则没拿到"
  try {
    const written = fs.readFileSync(lockFile, 'utf8');
    if (!written.includes(`token=${token}`)) {
      return { ok: false, reason: 'unwritable', holderPid: null, lockFile };
    }
  } catch {
    return { ok: false, reason: 'unwritable', holderPid: null, lockFile };
  }

  /** 刷新锁 mtime 作为心跳，让后来的实例能区分「真活着」与「pid 被复用」。 */
  /**
   * 刷新锁 mtime 作为心跳，让后来的实例能区分「真活着」与「pid 被复用」。
   * 若锁文件被外部删掉，则重建立即补回——否则本实例会在无保护状态下继续写，
   * 此时新启动的实例会误以为空闲并同时写入，正是要避免的数据损坏场景。
   */
  const heartbeat = () => {
    try {
      const content = fs.readFileSync(lockFile, 'utf8');
      if (content.includes(`token=${token}`)) {
        fs.utimesSync(lockFile, new Date(), new Date());
        return;
      }
      // 文件存在但内容不是自己的（被别的实例接管）：说明本进程已失去独占，告警
      log('warn', 'server', 'lock-lost', {
        lockFile,
        note: '锁已被其他实例接管，本实例不应继续写入；请关闭此窗口',
      });
    } catch {
      // 文件不存在：重建，继续持有
      try {
        fs.writeFileSync(lockFile, stamp(), { flag: 'wx' });
        log('warn', 'server', 'lock-recreated', { lockFile, note: '锁文件曾被外部删除，已重建' });
      } catch (err) {
        if (err && err.code === 'EEXIST') {
          log('warn', 'server', 'lock-lost', { lockFile, note: '锁已被其他实例占用，本实例不应继续写入' });
        }
      }
    }
  };
  heartbeat();
  const beat = setInterval(heartbeat, 30 * 1000);
  if (typeof beat.unref === 'function') beat.unref();

  const release = () => {
    clearInterval(beat);
    try {
      const content = fs.readFileSync(lockFile, 'utf8');
      // 只删属于自己的锁：pid 会被复用，仅凭 pid 可能误删他人刚建的锁
      if (content.includes(`token=${token}`)) fs.rmSync(lockFile, { force: true });
    } catch {
      /* 已删除则忽略 */
    }
  };
  process.on('exit', release);
  return { ok: true, release };
}

/** 启动前的一次性初始化。 */
function bootstrap() {
  store.ensureDirs();
  // 清理上次因文件占用未删掉的原子重置旧目录，避免磁盘随重置次数增长
  const swept = demo.sweepTrash();
  const firstRun = demo.ensureFirstRun();
  store.ensureDirs();
  // 演示数据自愈：避免数据被误删/上次 reset 中途失败时，用户启动即见到空库。
  const reseeded = demo.ensureDemoData();
  const interrupted = fetcher.markInterruptedTasks();
  const removed = report.cleanupReports();
  log('info', 'server', 'bootstrap', {
    dataDir: store.getRoot(),
    demoMode: store.readConfig().settings.demoMode,
    firstRunSeeded: firstRun,
    demoReseeded: reseeded,
    sweptTrash: swept,
    interruptedTasks: interrupted,
    removedReports: removed.length,
    removedFiles: removed,
  });
}

/** 创建并监听 HTTP 服务。 */
function createServer() {
  const server = http.createServer((req, res) => {
    router.handle(req, res).catch((err) => {
      log('error', 'server', 'handle-failed', { error: err instanceof Error ? err.message : String(err) });
      if (!res.headersSent) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: false, error: { code: 'IO_ERROR', message: '服务端内部错误' } }));
      } else {
        res.end();
      }
    });
  });
  server.keepAliveTimeout = 5000;
  server.on('error', (err) => {
    if (err && err.code === 'EADDRINUSE') {
      console.error(`\n[错误] 端口 ${PORT} 已被占用。可换个端口启动：`);
      console.error(`  Windows:  set PORT=7788 && node server/server.js`);
      console.error(`  PowerShell: $env:PORT=7788; node server/server.js\n`);
      process.exit(1);
    }
    console.error('[错误] HTTP 服务启动失败：', err);
    process.exit(1);
  });
  return server;
}

/**
 * 打开系统默认浏览器。
 *
 * 放在 Node 里而不是藏在 .bat 的延迟命令里：.bat 里用 `start`/`explorer` 拼超时容易
 * 因行尾或引号问题静默失败，而这里能拿到真实结果、失败也只是提示，不影响服务。
 */
function openAppPages(url) {
  openBrowser(url);
  openBrowser(`${url}/showcase.html`);
}

function openBrowser(url) {
  if (process.env.NO_OPEN === '1') return;
  try {
    let cmd;
    let args;
    if (process.platform === 'win32') {
      cmd = 'cmd';
      args = ['/c', 'start', '', url];
    } else if (process.platform === 'darwin') {
      cmd = 'open';
      args = [url];
    } else {
      cmd = 'xdg-open';
      args = [url];
    }
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    /* 打不开浏览器不算启动失败，用户可手动访问 */
  }
}

/** 探测目标端口上是否已有本应用在运行。 */
async function probeRunning(url) {
  try {
    const res = await fetch(`${url}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (!res.ok) return false;
    const payload = await res.json();
    return Boolean(payload && payload.ok && payload.data && payload.data.app === APP_NAME);
  } catch {
    return false;
  }
}

/** 主流程。 */
async function main() {
  const url = `http://${HOST}:${PORT}`;
  // 抢锁必须在任何写入之前：避免第二个实例把同一批归档写坏
  const lock = acquireInstanceLock();
  if (!lock.ok) {
    if (lock.reason === 'busy') {
      // 最常见的情形其实是「已经启动过、又双击了一次」——此时友好接管而不是报错
      if (await probeRunning(url)) {
        console.log(`\n  ${APP_NAME} 已经在运行：${url}`);
        console.log('  已为你打开后台和展示页，无需重复启动。\n');
        openAppPages(url);
        process.exit(0);
      }
      console.error(`\n[提示] 另一个 ${APP_NAME} 实例正在使用同一数据目录（pid ${lock.holderPid}）。`);
      console.error(`  数据目录：${store.baseDataDir()}`);
      console.error('  同一数据目录只允许一个实例写入，否则会损坏归档数据。');
      console.error('  请先关闭已打开的那个窗口，或到「设置」里换一个数据目录。');
      console.error(`  若确认没有其他窗口在运行，可删除该文件后重试：${lock.lockFile}\n`);
      process.exit(1);
    }
    console.error(`\n[错误] 无法在数据目录建立实例锁：${lock.lockFile}`);
    console.error('  请确认该目录可写，且没有其他程序拦截文件操作。\n');
    process.exit(1);
  }
  bootstrap();
  const server = createServer();
  server.listen(PORT, HOST, () => {
    console.log('');
    console.log(`  ${APP_NAME} v${VERSION} 已启动`);
    console.log(`  ➜  访问地址: ${url}`);
    console.log(`  ➜  数据目录: ${store.getRoot()}`);
    console.log(
      `  ➜  当前模式: ${store.readConfig().settings.demoMode ? '演示数据（不含真实账号）' : '真实账号'}${
        store.readConfig().token ? '' : ' · 未登录'
      }`
    );
    console.log('  ➜  按 Ctrl+C 停止（退出后订阅巡检与任务都会停止）');
    console.log('');
    scheduler.start();
    openAppPages(url);
  });

  const shutdown = (signal) => {
    console.log(`\n收到 ${signal}，正在退出…`);
    scheduler.stop();
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('unhandledRejection', (reason) => {
    log('error', 'server', 'unhandledRejection', {
      error: reason instanceof Error ? reason.message : String(reason),
    });
  });
}

main();

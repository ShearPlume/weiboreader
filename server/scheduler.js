/**
 * @file 订阅调度器：30s tick、串行执行到期订阅、auto 退避阶梯、日预算裁剪、
 *       日切恢复、日志裁剪至最近 200 行。
 *
 * 并发模型（ARCH §7.8）：全局同时只允许 1 个取数作业；订阅与手动取数共享 `fetcher` 的互斥锁，
 * 遇到手动任务运行中则本轮跳过（不排队，避免把用户等待时间拉长）。
 * @module server/scheduler
 */

import { BACKOFF_MINUTES, LIMITS } from './config.js';
import { log, todayKey } from './util.js';
import * as store from './store.js';
import * as fetcher from './fetcher.js';

/** @type {NodeJS.Timeout|null} */
let timer = null;
let ticking = false;

/** 启动 30s 心跳（进程内定时器，关进程即停）。 */
export function start() {
  if (timer) return;
  timer = setInterval(() => {
    void tick();
  }, LIMITS.schedulerIntervalMs);
  if (typeof timer.unref === 'function') timer.unref();
  log('info', 'scheduler', 'start', { intervalMs: LIMITS.schedulerIntervalMs });
}

/** 停止心跳。 */
export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  log('info', 'scheduler', 'stop', {});
}

/** 是否已启动。 */
export function isStarted() {
  return timer !== null;
}

/**
 * 一次 tick：找出到期订阅并串行执行。
 * @returns {Promise<{ran:number,reason?:string}>}
 */
export async function tick() {
  if (ticking) return { ran: 0, reason: 'tick-in-progress' };
  ticking = true;
  try {
    return await runTick();
  } catch (err) {
    log('error', 'scheduler', 'tick-failed', { error: err instanceof Error ? err.message : 'unknown' });
    return { ran: 0, reason: 'error' };
  } finally {
    ticking = false;
  }
}

/**
 * 日切：todayKey 变化 → spentToday 归零并重新排期。
 *
 * **只恢复 `pauseReason === 'budget'` 的订阅**。`pauseReason === 'user'` 是用户显式
 * 暂停，跨日必须保持暂停 —— 否则次日首个 tick 会自动恢复并按 1 分钟间隔开始巡检，
 * 已登录真实账号时会意外消耗 credits。
 * @param {object} sub 当前订阅快照（会被就地更新）
 * @param {number} now 本轮 tick 的时间基准。用同一个 `now` 作 `nextRunAtMs`，
 *   保证「跨日恢复」的当轮就能执行，不会因为写入时间晚于比较基准而空转 30s。
 */
function rollDay(sub, now) {
  const key = todayKey();
  if (sub.todayKey === key) return false;
  const shouldResume = sub.pauseReason === 'budget';
  /** @type {Record<string, unknown>} */
  const patch = {
    todayKey: key,
    spentToday: 0,
    step: 0,
    nextRunAtMs: now,
  };
  if (shouldResume) {
    patch.enabled = true;
    patch.pauseReason = '';
    patch.lastResult = '';
  }
  store.patchSubscription(sub.id, patch);
  sub.todayKey = key;
  sub.spentToday = 0;
  sub.step = 0;
  sub.nextRunAtMs = now;
  if (shouldResume) {
    sub.enabled = true;
    sub.pauseReason = '';
    sub.lastResult = '';
  }
  return true;
}

/** 计算下一次检查时间。 */
function nextRunFor(sub, addedCount) {
  const step = addedCount > 0 ? 0 : Math.min((sub.step || 0) + 1, BACKOFF_MINUTES.length - 1);
  const minutes = sub.intervalMode === 'fixed' ? sub.fixedMinutes : BACKOFF_MINUTES[step];
  return { step, minutes, nextRunAtMs: Date.now() + Math.max(1, minutes) * 60000 };
}

async function runTick() {
  const cfg = store.readConfig();
  if (cfg.settings.demoMode || !cfg.token) {
    return { ran: 0, reason: 'demo-or-logged-out' };
  }
  const now = Date.now();
  const subs = store.listSubscriptions();
  let ran = 0;

  for (const snapshot of subs) {
    const sub = store.getSubscription(snapshot.id);
    if (!sub) continue;
    rollDay(sub, now);
    if (!sub.enabled) continue;
    if (sub.nextRunAtMs > now) continue;
    if (fetcher.isRunning()) return { ran, reason: 'busy' };

    const unitPrice = fetcher.unitPriceFor(sub.mode);
    const estimate = Math.round(sub.perRoundLimit * unitPrice * 10000) / 10000;
    if (sub.spentToday + estimate > sub.dailyCreditsBudget + 1e-9) {
      // budget 是「预算耗尽自动暂停」：置 pauseReason='budget'，日切时会被恢复；
      // 用户手动暂停（pauseReason='user'）则永远不会被日切恢复。
      store.patchSubscription(sub.id, {
        enabled: false,
        pauseReason: 'budget',
        lastResult: 'budget',
        nextRunAtMs: now + 3600000,
      });
      store.appendSubLog({
        atMs: now,
        subId: sub.id,
        mode: sub.mode,
        returned: 0,
        added: 0,
        credits: 0,
        result: 'budget',
        message: `今日预算不足：已花 ${sub.spentToday.toFixed(
          2
        )}，本轮预估 ${estimate.toFixed(2)}，每日预算 ${sub.dailyCreditsBudget}`,
      });
      log('warn', 'scheduler', 'budget-exhausted', { subId: sub.id, spentToday: sub.spentToday, estimate });
      continue;
    }

    const summary = await fetcher.runSubscription(sub);
    if (!summary) return { ran, reason: 'busy' };
    ran += 1;

    const credits = Math.round((Number(summary.credits) || 0) * 100) / 100;
    const addedCount = Number(summary.added) || 0;
    const returned = Number(summary.returned) || 0;
    const result = summary.status === 'failed' ? 'error' : addedCount > 0 ? 'ok' : 'no-new';
    const { step, nextRunAtMs } = nextRunFor(sub, addedCount);

    store.patchSubscription(sub.id, {
      spentToday: Math.round((sub.spentToday + credits) * 100) / 100,
      step,
      nextRunAtMs,
      lastRunAtMs: Date.now(),
      lastResult: result,
    });
    store.appendSubLog({
      atMs: Date.now(),
      subId: sub.id,
      mode: sub.mode,
      returned,
      added: addedCount,
      credits,
      result,
      message: String(summary.reason || ''),
    });
    log('info', 'scheduler', 'round-done', { subId: sub.id, result, returned, added: addedCount, credits });

    if (summary.status === 'failed' && /TOKEN|登录|授权/.test(String(summary.reason || ''))) {
      return { ran, reason: 'token-invalid' };
    }
  }

  return { ran };
}

/** 诊断信息（/api/status 可选透出）。 */
export function diagnostics() {
  return {
    started: isStarted(),
    ticking,
    intervalMs: LIMITS.schedulerIntervalMs,
    backoffMinutes: [...BACKOFF_MINUTES],
  };
}

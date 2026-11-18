/**
 * @file 报告生成：选记录 → 全量转义 HTML（未读高亮、无脚本无外链）→ 固定文件名覆盖写 →
 *       返回待标记已读 ID 列表（两段式已读的前半段）。
 *
 * 安全约束（ARCH §7.5 / PRD §6）：所有文本 esc() 后按纯文本渲染（`\n` → `<br>`）；
 * 报告内不含 token / 余额；不引用任何外部资源、不含脚本。
 * @module server/report
 */

import fs from 'node:fs';
import path from 'node:path';

import { LIMITS, MODES } from './config.js';
import { AppError, esc, escText, fmtTime, fmtTimeSec, parseRange, clamp, toInt } from './util.js';
import * as store from './store.js';

/** 报告 CSS（内联，单文件可直接邮件发送）。 */
const REPORT_CSS = `
:root { color-scheme: light; }
* { box-sizing: border-box; }
body { margin: 0; padding: 32px 20px 64px; background: #f5f6f8; color: #1f2328;
  font-family: -apple-system, "Segoe UI", "Microsoft YaHei", "PingFang SC", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-size: 14px; line-height: 1.65; }
.wrap { max-width: 860px; margin: 0 auto; }
h1 { font-size: 20px; margin: 0 0 6px; letter-spacing: .2px; }
.meta { color: #6a737d; font-size: 12px; margin-bottom: 18px; }
.stats { display: flex; gap: 10px; flex-wrap: wrap; margin: 0 0 22px; }
.stat { background: #fff; border: 1px solid #e2e5e9; border-radius: 8px; padding: 8px 14px; font-size: 12px; color: #57606a; }
.stat b { display: block; font-size: 18px; color: #1f2328; font-weight: 600; }
.rec { background: #fff; border: 1px solid #e2e5e9; border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; position: relative; }
.rec.unread { border-left: 3px solid #1f6feb; }
.rec-head { display: flex; align-items: baseline; gap: 8px; flex-wrap: wrap; margin-bottom: 6px; }
.author { font-weight: 600; color: #1f2328; }
.time { color: #8b949e; font-size: 12px; }
.badge { font-size: 11px; color: #57606a; background: #f0f2f5; border-radius: 4px; padding: 1px 6px; }
.unread-dot { font-size: 11px; color: #1f6feb; font-weight: 600; }
.text { white-space: normal; word-break: break-word; color: #24292f; }
.pics { margin-top: 8px; font-size: 12px; color: #57606a; }
.pics a { color: #1f6feb; text-decoration: none; }
.foot { margin-top: 6px; font-size: 12px; }
.foot a { color: #1f6feb; text-decoration: none; }
.empty { background: #fff; border: 1px dashed #d0d7de; border-radius: 10px; padding: 32px; text-align: center; color: #8b949e; }
footer { margin-top: 26px; color: #8b949e; font-size: 11px; text-align: center; }
`.trim();

/** 只允许 http(s) 链接进入 href。 */
function safeUrl(value) {
  const url = String(value || '').trim();
  return /^https?:\/\//i.test(url) ? url : '';
}

/** 对象标题。 */
function reportTitle(ownerType, owner) {
  if (ownerType === 'users') {
    return owner.screenName ? `${owner.screenName}（UID ${owner.uid}）` : `UID ${owner.uid}`;
  }
  const text = String(owner.text || '').replace(/\s+/g, ' ').trim();
  return text ? `博文 ${owner.id} · ${text.slice(0, 30)}` : `博文 ${owner.id}`;
}

/**
 * 生成（覆盖）某对象的 HTML 报告。
 * @param {{ownerType:string,ownerId:string,limit?:number,fromMs?:unknown,toMs?:unknown}} input
 * @returns {{reportKey:string,url:string,path:string,recordCount:number,unreadCount:number,pendingReadIds:string[]}}
 */
export function generate(input = {}) {
  const ownerType = store.assertOwnerType(input.ownerType);
  const ownerId = String(input.ownerId || '');
  if (!/^\d{1,20}$/.test(ownerId)) throw new AppError('INVALID_ID', '对象 ID 必须是 1~20 位数字', 400);
  const owner = ownerType === 'users' ? store.getUser(ownerId) : store.getPost(ownerId);
  if (!owner) {
    throw new AppError('NOT_FOUND', ownerType === 'users' ? '该用户不在本地库中' : '该博文不在本地库中', 404);
  }
  const { fromMs, toMs } = parseRange(input);
  const settings = store.getSettings();
  const limit = clamp(
    toInt(input.limit, settings.reportMaxRecords || LIMITS.defaultReportMax),
    1,
    LIMITS.maxReportRecords
  );

  let records = store.readRecords(ownerType, ownerId, { fromMs, toMs });
  const matched = records.length;
  if (records.length > limit) records = records.slice(0, limit);

  const pendingReadIds = records.filter((r) => r.isUnread).map((r) => String(r.recordId));
  const reportKey = `${ownerType}-${ownerId}`;
  const filePath = store.reportFilePath(reportKey);
  const nowMs = Date.now();

  const rangeText =
    fromMs === null && toMs === null
      ? '全部时间'
      : `${fromMs === null ? '不限' : fmtTime(fromMs)} ~ ${toMs === null ? '不限' : fmtTime(toMs)}`;

  const rows = records.map((record) => {
    const cls = record.isUnread ? 'rec unread' : 'rec';
    const pics = record.pictures && Array.isArray(record.pictures.items) && record.pictures.items.length > 0;
    const picHtml = pics
      ? `<div class="pics">配图 ${esc(record.pictures.total || record.pictures.items.length)} 张：${record.pictures.items
          .map((pic, index) => {
            const url = safeUrl(pic && pic.url);
            return url ? `<a href="${esc(url)}" rel="noreferrer noopener">图${index + 1}</a>` : '';
          })
          .filter(Boolean)
          .join(' · ')}</div>`
      : '';
    const postUrl = safeUrl(record.postUrl);
    const linkHtml = postUrl
      ? `<div class="foot"><a href="${esc(postUrl)}" rel="noreferrer noopener">查看原微博</a>${
          record.postId ? ` · ID ${esc(record.postId)}` : ''
        }</div>`
      : record.postId
        ? `<div class="foot">原微博 ID ${esc(record.postId)}</div>`
        : '';
    return `<article class="${cls}">
  <div class="rec-head">
    <span class="author">${esc(record.author || '未知作者')}</span>
    ${record.authorUid ? `<span class="badge">UID ${esc(record.authorUid)}</span>` : ''}
    <span class="time">${esc(record.time || fmtTime(record.ms))}</span>
    <span class="badge">${esc(record.type || record.mode || '')}</span>
    ${record.isUnread ? '<span class="unread-dot">未读</span>' : ''}
    ${record.textTruncated ? '<span class="badge">已截断</span>' : ''}
  </div>
  <div class="text">${escText(record.text || '（无正文）')}</div>
  ${picHtml}
  ${linkHtml}
</article>`;
  });

  const modeSummary = Object.entries(
    records.reduce((acc, record) => {
      const key = String(record.mode || '');
      acc[key] = (acc[key] || 0) + 1;
      return acc;
    }, {})
  )
    .map(([mode, count]) => `${(MODES[mode] && MODES[mode].label) || mode} ${count}`)
    .join(' · ');

  const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(reportTitle(ownerType, owner))} · Weibo Reader 报告</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<div class="wrap">
  <h1>${esc(reportTitle(ownerType, owner))}</h1>
  <div class="meta">时间范围：${esc(rangeText)} · 生成时间：${esc(fmtTimeSec(nowMs))} · 本报告为本地离线文件，无需联网</div>
  <div class="stats">
    <div class="stat"><b>${records.length}</b>收录记录</div>
    <div class="stat"><b>${pendingReadIds.length}</b>未读高亮</div>
    <div class="stat"><b>${matched}</b>区间命中</div>
  </div>
  ${modeSummary ? `<div class="meta">构成：${esc(modeSummary)}</div>` : ''}
  ${rows.length > 0 ? rows.join('\n') : '<div class="empty">该时间范围内没有本地记录。可先在「获取数据」页取数后再生成报告。</div>'}
  <footer>由 Weibo Reader 本地生成 · 数据仅存于本机 · 报告不含任何账户凭据</footer>
</div>
</body>
</html>
`;

  store.writeText(filePath, html);
  store.updateReportIndex(reportKey, {
    ownerType,
    ownerId,
    title: reportTitle(ownerType, owner),
    path: filePath,
    createdAtMs: nowMs,
    recordCount: records.length,
    unreadCount: pendingReadIds.length,
    // 落盘待标记 ID：第二段式已读时用于校验「只允许标记本报告展示过的记录」，
    // 防止前端/脚本传入任意 ID 批量刷已读。
    pendingReadIds,
  });

  return {
    reportKey,
    url: `/reports/${reportKey}.html`,
    path: filePath,
    recordCount: records.length,
    unreadCount: pendingReadIds.length,
    pendingReadIds,
  };
}

/** 取报告元信息（不存在抛 NOT_FOUND）。 */
export function meta(reportKey) {
  const key = String(reportKey || '').replace(/\.html$/i, '');
  const index = store.readReportIndex();
  const entry = index.reports[key];
  const filePath = store.reportFilePath(key);
  if (!entry || !fs.existsSync(filePath)) {
    throw new AppError('NOT_FOUND', '报告不存在，请先生成', 404);
  }
  // pendingReadIds 只服务于第二段式已读校验，不下发到元信息接口（避免无谓的响应膨胀）
  const { pendingReadIds, ...rest } = entry;
  return { ...rest, pendingCount: Array.isArray(pendingReadIds) ? pendingReadIds.length : 0, url: `/reports/${key}.html`, exists: true };
}

/**
 * 第二段式已读：仅在前端确认已取到报告后调用。
 *
 * 两道防线：
 * 1. 报告文件必须仍存在（否则用户其实没看到内容，不该被标记已读）；
 * 2. `ids` 必须是该报告生成时返回的 `pendingReadIds` 的子集，避免调用方传入
 *    任意 ID 把「用户没看过的记录」批量标成已读。
 * @param {string} reportKey
 * @param {string[]} ids
 * @returns {{marked:number,unreadTotal:number,skipped:number}}
 */
export function markReportRead(reportKey, ids) {
  const key = String(reportKey || '').replace(/\.html$/i, '');
  const index = store.readReportIndex();
  const entry = index.reports[key];
  if (!entry) throw new AppError('NOT_FOUND', '报告不存在，请先生成', 404);

  const filePath = store.reportFilePath(key);
  if (!fs.existsSync(filePath)) {
    throw new AppError('NOT_FOUND', '报告文件已被删除，请重新生成', 404);
  }

  const wanted = Array.isArray(ids) ? ids.map((id) => String(id || '')).filter(Boolean) : [];
  const allowed = Array.isArray(entry.pendingReadIds) ? new Set(entry.pendingReadIds.map(String)) : null;
  const effective = allowed ? wanted.filter((id) => allowed.has(id)) : wanted;
  const skipped = wanted.length - effective.length;

  const result = store.markRead(entry.ownerType, entry.ownerId, effective);

  // 已标记的 ID 从待标记列表里移除，避免重复提交时口径漂移
  if (allowed && result.marked > 0) {
    const remaining = [...allowed].filter((id) => !effective.includes(id));
    store.updateReportIndex(key, { ...entry, pendingReadIds: remaining, unreadCount: remaining.length });
  }
  return { ...result, skipped };
}

/**
 * 报告唯一化：每个对象只保留最新 1 份（固定文件名覆盖写已天然满足）。
 *
 * 额外做两件清理，满足 P0-32「启动与每次生成后清理」：
 * 1. 删除不符合白名单 `^[a-z]+-\d+\.html$` 的 html（异常残留，且不会被只读托管命中）；
 * 2. 删除「索引里已无对应条目」的孤儿报告文件（导入/切换数据目录后可能遗留）。
 * @returns {string[]} 被删除的文件名列表（便于调用方打印数量与排查）
 */
export function cleanupReports() {
  const dir = store.reportsDir();
  /** @type {string[]} */
  const removed = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return removed;
  }
  const keep = new Set(Object.keys(store.readReportIndex().reports).map((key) => `${key}.html`));
  for (const name of names) {
    if (!name.toLowerCase().endsWith('.html')) continue;
    const whitelisted = /^[a-z]+-\d+\.html$/.test(name);
    // 白名单形态且索引里有它 → 保留；其余（非法形态 / 孤儿）一律删除
    if (whitelisted && keep.has(name)) continue;
    try {
      fs.rmSync(path.join(dir, name), { force: true });
      removed.push(name);
    } catch {
      /* 忽略单个文件清理失败，不阻断启动/生成 */
    }
  }
  return removed;
}

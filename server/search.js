/**
 * @file 本地搜索：条件交集 + 逐条扫描 + 分页 + 耗时统计（0 credits）。
 *
 * 为什么不用倒排索引（ARCH 6.5）：单用户本地 1e4~1e5 条、单条 ≤2000 字符，
 * 全量 includes 扫描 50~200ms 即可满足「即时搜索」；倒排需中文分词且需维护增量一致性，
 * 复杂度与故障面都大于收益。这里用「按对象目录懒加载 + LRU(8) + mtime 失效」控制重复扫描成本。
 * @module server/search
 */

import fs from 'node:fs';
import path from 'node:path';

import { LIMITS } from './config.js';
import { assertOwnerType, getPost, getUser, listPosts, listUsers, readRecords, recordsDir } from './store.js';
import { clamp, parseRange, toInt } from './util.js';

/** @type {Map<string,{signature:string,records:object[],ownerLabel:string}>} */
const cache = new Map();

/** 目录签名（文件名 + mtime + size），用于缓存失效。 */
function dirSignature(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir).sort();
  } catch {
    return 'missing';
  }
  const parts = [];
  for (const name of names) {
    try {
      const stat = fs.statSync(path.join(dir, name));
      parts.push(`${name}:${stat.mtimeMs}:${stat.size}`);
    } catch {
      parts.push(`${name}:?`);
    }
  }
  return parts.join('|');
}

/** 取对象标签（用户昵称 / 博文摘要）。 */
function ownerLabel(ownerType, ownerId) {
  if (ownerType === 'users') {
    const user = getUser(ownerId);
    return user ? user.screenName : ownerId;
  }
  const post = getPost(ownerId);
  if (!post) return ownerId;
  const text = String(post.text || '').replace(/\s+/g, ' ').trim();
  return text ? text.slice(0, 40) : `博文 ${ownerId}`;
}

/** LRU 写入并淘汰（上限 8 个对象）。 */
function cacheSet(key, value) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, value);
  while (cache.size > LIMITS.searchLruOwners) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    cache.delete(oldest.value);
  }
}

/** 懒加载某对象的全部记录（带 mtime 失效缓存）。 */
function loadOwnerRecords(ownerType, ownerId) {
  const key = `${ownerType}/${ownerId}`;
  const signature = dirSignature(recordsDir(ownerType, ownerId));
  const cached = cache.get(key);
  if (cached && cached.signature === signature) {
    cache.delete(key);
    cache.set(key, cached);
    return cached.records;
  }
  const records = readRecords(ownerType, ownerId, {});
  const entry = { signature, records, ownerLabel: ownerLabel(ownerType, ownerId) };
  cacheSet(key, entry);
  return records;
}

/**
 * 执行搜索。
 * @param {{q?:string,author?:string,ownerType?:string,ownerId?:string,fromMs?:unknown,toMs?:unknown,page?:number,pageSize?:number}} input
 * @returns {{total:number,tookMs:number,page:number,pageSize:number,items:object[],conditions:object}}
 */
export function search(input = {}) {
  const startedAt = process.hrtime.bigint();
  const q = String(input.q === undefined || input.q === null ? '' : input.q).trim();
  const terms = q ? q.toLowerCase().split(/\s+/).filter(Boolean) : [];
  const author = String(input.author === undefined || input.author === null ? '' : input.author)
    .trim()
    .toLowerCase();
  const ownerType = input.ownerType ? assertOwnerType(input.ownerType) : null;
  const ownerId = input.ownerId ? String(input.ownerId) : null;
  const { fromMs, toMs } = parseRange(input);
  const page = Math.max(1, toInt(input.page, 1));
  const pageSize = clamp(toInt(input.pageSize, LIMITS.defaultPageSize), 1, 200);

  const types = ownerType ? [ownerType] : ['users', 'posts'];
  const hits = [];

  for (const type of types) {
    const owners = ownerId ? [{ id: ownerId }] : type === 'users'
      ? listUsers().items.map((u) => ({ id: u.uid }))
      : listPosts().items.map((p) => ({ id: p.id }));
    for (const owner of owners) {
      if (!/^\d{1,20}$/.test(owner.id)) continue;
      const records = loadOwnerRecords(type, owner.id);
      const label = ownerLabel(type, owner.id);
      for (const record of records) {
        if (terms.length > 0) {
          const text = String(record.text || '').toLowerCase();
          let ok = true;
          for (const term of terms) {
            if (!text.includes(term)) {
              ok = false;
              break;
            }
          }
          if (!ok) continue;
        }
        if (author) {
          const name = String(record.author || '').toLowerCase();
          const uid = String(record.authorUid || '');
          if (!name.includes(author) && !uid.includes(author)) continue;
        }
        if (fromMs !== null && Number(record.ms) < fromMs) continue;
        if (toMs !== null && Number(record.ms) > toMs) continue;
        hits.push({
          ownerType: type,
          ownerId: owner.id,
          ownerLabel: label,
          recordId: String(record.recordId || ''),
          mode: String(record.mode || ''),
          type: String(record.type || ''),
          author: String(record.author || ''),
          authorUid: String(record.authorUid || ''),
          time: String(record.time || ''),
          ms: Number(record.ms) || 0,
          text: String(record.text || ''),
          textTruncated: Boolean(record.textTruncated),
          postId: record.postId ? String(record.postId) : '',
          postUrl: record.postUrl ? String(record.postUrl) : '',
          isUnread: Boolean(record.isUnread),
        });
      }
    }
  }

  hits.sort((a, b) => b.ms - a.ms);
  const total = hits.length;
  const start = (page - 1) * pageSize;
  const items = hits.slice(start, start + pageSize);
  const tookMs = Number(process.hrtime.bigint() - startedAt) / 1e6;

  return {
    total,
    tookMs: Math.round(tookMs * 100) / 100,
    page,
    pageSize,
    items,
    conditions: {
      q,
      author: author ? String(input.author).trim() : '',
      ownerType: ownerType || '',
      ownerId: ownerId || '',
      fromMs: fromMs !== null ? fromMs : null,
      toMs: toMs !== null ? toMs : null,
    },
  };
}

/** 清空搜索缓存（导入/切换目录后调用）。 */
export function clearCache() {
  cache.clear();
}

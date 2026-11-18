/**
 * @file 数据包导入 / 导出。
 *
 * 边界（PRD §6 / P0-31）：导出内容数据用于合并迁移，**不含**登录态（token）、订阅、备注、已读状态；
 * 导入按「记录唯一键（ownerType:ownerId#recordId）」去重合并，返回新增/跳过条数。
 * @module server/exchange
 */

import { AppError, ID_RE } from './util.js';
import * as store from './store.js';

/** 数据包结构标识。 */
export const SCHEMA = 'weibo-reader-web/1';

/** 从记录里挑出可迁移字段（剔除已读状态与内部缓存字段）。 */
function cleanRecord(record) {
  const out = {
    recordId: String(record.recordId || ''),
    sourceRef: String(record.sourceRef || ''),
    sourceId: String(record.sourceId || ''),
    mode: String(record.mode || ''),
    type: String(record.type || ''),
    group: String(record.group || ''),
    author: String(record.author || ''),
    authorUid: String(record.authorUid || ''),
    time: String(record.time || ''),
    ms: Number(record.ms) || 0,
    text: String(record.text || ''),
    textTruncated: Boolean(record.textTruncated),
    postId: String(record.postId || ''),
    postUrl: String(record.postUrl || ''),
    source: record.source === 'demo' ? 'demo' : 'api',
    fetchedAtMs: Number(record.fetchedAtMs) || Date.now(),
  };
  if (record.pictures && Array.isArray(record.pictures.items)) {
    out.pictures = {
      total: Number(record.pictures.total) || record.pictures.items.length,
      items: record.pictures.items.map((pic) => ({ url: String((pic && pic.url) || '') })),
    };
  }
  return out;
}

/**
 * 构造导出数据包。
 * @returns {{schema:string,exportedAtMs:number,users:object[],posts:object[],records:object[]}}
 */
export function buildExport() {
  const users = store.listUsers().items.map((user) => ({
    uid: user.uid,
    screenName: user.screenName,
    avatarUrl: user.avatarUrl,
    addedAtMs: user.addedAtMs,
  }));
  const posts = store.listPosts().items.map((post) => ({
    id: post.id,
    mId: post.mId,
    authorUid: post.authorUid,
    author: post.author,
    text: post.text,
    textTruncated: post.textTruncated,
    createdAtMs: post.createdAtMs,
    sourceUrl: post.sourceUrl,
    addedAtMs: post.addedAtMs,
  }));

  const records = [];
  for (const type of ['users', 'posts']) {
    const ownerIds = store.listRecordOwnerIds(type);
    for (const ownerId of ownerIds) {
      for (const record of store.readRecords(type, ownerId, {})) {
        records.push({ ownerType: type, ownerId, ...cleanRecord(record) });
      }
    }
  }

  return { schema: SCHEMA, exportedAtMs: Date.now(), users, posts, records };
}

/**
 * 导入数据包（去重合并）。
 * @param {any} payload
 * @returns {{added:number,skipped:number,usersAdded:number,postsAdded:number}}
 */
export function importPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new AppError('BAD_REQUEST', '数据包格式不正确（应为 JSON 对象）', 400);
  }
  if (payload.schema && String(payload.schema) !== SCHEMA) {
    throw new AppError('BAD_REQUEST', `数据包结构版本不受支持：${String(payload.schema)}`, 400);
  }
  const users = Array.isArray(payload.users) ? payload.users : [];
  const posts = Array.isArray(payload.posts) ? payload.posts : [];
  const records = Array.isArray(payload.records) ? payload.records : [];
  if (users.length === 0 && posts.length === 0 && records.length === 0) {
    throw new AppError('BAD_REQUEST', '数据包里没有可导入的内容', 400);
  }

  let usersAdded = 0;
  let postsAdded = 0;
  let added = 0;
  let skipped = 0;

  for (const user of users) {
    const uid = String((user && user.uid) || '');
    if (!ID_RE.test(uid)) continue;
    try {
      const result = store.addUser({
        uid,
        screenName: user.screenName ? String(user.screenName) : '',
        avatarUrl: user.avatarUrl ? String(user.avatarUrl) : '',
      });
      if (result.created) usersAdded += 1;
    } catch {
      /* 单条失败不阻断整体导入 */
    }
  }

  for (const post of posts) {
    const id = String((post && post.id) || '');
    if (!ID_RE.test(id)) continue;
    try {
      const result = store.addPost({
        id,
        mId: post.mId ? String(post.mId) : '',
        authorUid: post.authorUid ? String(post.authorUid) : '',
        author: post.author ? String(post.author) : '',
        text: post.text ? String(post.text) : '',
        createdAtMs: Number.isFinite(Number(post.createdAtMs)) ? Number(post.createdAtMs) : null,
        sourceUrl: post.sourceUrl ? String(post.sourceUrl) : '',
      });
      if (result.created) postsAdded += 1;
    } catch {
      /* 忽略非法条目 */
    }
  }

  /** @type {Map<string,{ownerType:string,ownerId:string,mode:string,rows:object[]}>} */
  const buckets = new Map();
  for (const record of records) {
    if (!record || typeof record !== 'object') continue;
    const ownerType = record.ownerType === 'posts' ? 'posts' : 'users';
    const ownerId = String(record.ownerId || '');
    const mode = String(record.mode || '');
    if (!ID_RE.test(ownerId) || !mode) {
      skipped += 1;
      continue;
    }
    const ms = Number(record.ms);
    if (!Number.isFinite(ms)) {
      skipped += 1;
      continue;
    }
    const key = `${ownerType}/${ownerId}/${mode}`;
    if (!buckets.has(key)) buckets.set(key, { ownerType, ownerId, mode, rows: [] });
    const cleaned = cleanRecord({ ...record, ms });
    if (!/^[0-9a-f]{16}$/.test(cleaned.recordId)) {
      cleaned.recordId = store.makeRecordId(ownerType, ownerId, mode, cleaned.sourceRef || cleaned.sourceId, {
        authorUid: cleaned.authorUid,
        ms,
        text: cleaned.text,
      });
    }
    buckets.get(key).rows.push(cleaned);
  }

  for (const bucket of buckets.values()) {
    // 确保宿主对象存在（导入的数据包可能只带记录）
    if (bucket.ownerType === 'users' && !store.getUser(bucket.ownerId)) {
      try {
        store.addUser({ uid: bucket.ownerId, screenName: `用户${bucket.ownerId}` });
        usersAdded += 1;
      } catch {
        skipped += bucket.rows.length;
        continue;
      }
    }
    if (bucket.ownerType === 'posts' && !store.getPost(bucket.ownerId)) {
      try {
        store.addPost({ id: bucket.ownerId });
        postsAdded += 1;
      } catch {
        skipped += bucket.rows.length;
        continue;
      }
    }
    try {
      const result = store.appendRecords(bucket.ownerType, bucket.ownerId, bucket.mode, bucket.rows);
      added += result.added;
      skipped += result.reused;
    } catch {
      skipped += bucket.rows.length;
    }
  }

  for (const ownerId of store.listRecordOwnerIds('users')) store.recomputeStats('users', ownerId);
  for (const ownerId of store.listRecordOwnerIds('posts')) store.recomputeStats('posts', ownerId);

  return { added, skipped, usersAdded, postsAdded };
}

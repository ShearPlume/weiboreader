/**
 * @file 展示页邀请码：存储、生成、停用与校验。
 *
 * 数据保存在 `data/invites.json`（不进 Git、不进 COS）；展示页只调用验证接口，
 * 不接触完整列表。邀请码用于给展示页加一层轻量访问校验（软门槛）。
 * @module server/invites
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_DATA_DIR } from './config.js';

const FILE = path.join(DEFAULT_DATA_DIR, 'invites.json');
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function read() {
  try {
    const doc = JSON.parse(fs.readFileSync(FILE, 'utf8'));
    if (doc && doc.codes && typeof doc.codes === 'object') return doc;
  } catch {
    /* 文件不存在或损坏时从空表开始 */
  }
  return { version: 1, codes: {} };
}

function write(doc) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

function normalize(code) {
  return String(code || '')
    .replace(/[\s-]/g, '')
    .toUpperCase();
}

function display(raw) {
  return `${raw.slice(0, 2)}-${raw.slice(2, 6)}-${raw.slice(6, 10)}`;
}

function newRaw() {
  let raw = 'WX';
  for (let i = 0; i < 8; i += 1) raw += ALPHABET[crypto.randomInt(ALPHABET.length)];
  return raw;
}

/** 默认邀请码只开放测试账号（恐龙毛衫）。 */
export const DEFAULT_SCOPE_ACCOUNTS = Object.freeze(['7984139147']);

function normalizeAccounts(accounts) {
  if (!Array.isArray(accounts)) return [];
  const out = [];
  for (const raw of accounts) {
    const uid = String(raw || '').trim();
    if (/^\d{1,20}$/.test(uid) && !out.includes(uid)) out.push(uid);
    if (out.length >= 100) break;
  }
  return out;
}

function scopeOf(entry) {
  if (entry.scope === 'all') return { scope: 'all', accounts: [] };
  if (entry.scope === 'selected') return { scope: 'selected', accounts: normalizeAccounts(entry.accounts) };
  if (entry.scope === 'default') return { scope: 'default', accounts: [...DEFAULT_SCOPE_ACCOUNTS] };
  // 旧邀请码没有 scope：保持“全部账号”的行为
  return { scope: 'all', accounts: [] };
}

function statusOf(entry) {
  if (!entry.enabled) return 'disabled';
  if (entry.expiresAtMs && Date.now() > entry.expiresAtMs) return 'expired';
  return 'active';
}

function dto(entry) {
  return {
    code: entry.code,
    note: entry.note,
    uses: Number(entry.uses) || 0,
    createdAtMs: entry.createdAtMs,
    expiresAtMs: entry.expiresAtMs,
    enabled: Boolean(entry.enabled),
    status: statusOf(entry),
    ...scopeOf(entry),
  };
}

/** 列出全部邀请码（仅后台使用）。 */
export function list() {
  const doc = read();
  return Object.values(doc.codes).map(dto).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** 生成邀请码；expiresInDays=0 表示永不过期。 */
export function create({ note = '', expiresInDays = 0, scope = 'default', accounts = [] } = {}) {
  const doc = read();
  let raw = newRaw();
  while (doc.codes[raw]) raw = newRaw();
  const days = Math.max(0, Math.min(3650, Number(expiresInDays) || 0));
  const normalized = scope === 'selected' ? normalizeAccounts(accounts) : scope === 'all' ? [] : [...DEFAULT_SCOPE_ACCOUNTS];
  const entry = {
    code: display(raw),
    note: String(note || '').trim().slice(0, 80),
    scope: scope === 'all' ? 'all' : scope === 'selected' ? 'selected' : 'default',
    accounts: normalized,
    createdAtMs: Date.now(),
    expiresAtMs: days ? Date.now() + days * 86400000 : null,
    uses: 0,
    enabled: true,
  };
  doc.codes[raw] = entry;
  write(doc);
  return dto(entry);
}

/** 启用/停用。 */
export function setEnabled(code, enabled) {
  const doc = read();
  const entry = doc.codes[normalize(code)];
  if (!entry) return null;
  entry.enabled = Boolean(enabled);
  write(doc);
  return dto(entry);
}

/** 修改可见范围（复用新建邀请码的范围字段）。 */
export function updateScope(code, scope, accounts) {
  const doc = read();
  const entry = doc.codes[normalize(code)];
  if (!entry) return null;
  const normalizedScope = scope === 'all' ? 'all' : scope === 'selected' ? 'selected' : 'default';
  entry.scope = normalizedScope;
  entry.accounts =
    normalizedScope === 'selected'
      ? normalizeAccounts(accounts)
      : normalizedScope === 'default'
        ? [...DEFAULT_SCOPE_ACCOUNTS]
        : [];
  write(doc);
  return dto(entry);
}

/** 删除。 */
export function remove(code) {
  const doc = read();
  const key = normalize(code);
  if (!doc.codes[key]) return false;
  delete doc.codes[key];
  write(doc);
  return true;
}

/** 校验并累计使用次数。 */
export function verify(code) {
  const key = normalize(code);
  if (!key) return { valid: false, reason: '请输入邀请码' };
  const doc = read();
  const entry = doc.codes[key];
  if (!entry) return { valid: false, reason: '邀请码无效' };
  if (!entry.enabled) return { valid: false, reason: '邀请码已停用' };
  if (entry.expiresAtMs && Date.now() > entry.expiresAtMs) return { valid: false, reason: '邀请码已过期' };
  entry.uses = (Number(entry.uses) || 0) + 1;
  write(doc);
  return { valid: true, uses: entry.uses, ...scopeOf(entry) };
}

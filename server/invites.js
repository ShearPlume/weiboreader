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
  };
}

/** 列出全部邀请码（仅后台使用）。 */
export function list() {
  const doc = read();
  return Object.values(doc.codes).map(dto).sort((a, b) => b.createdAtMs - a.createdAtMs);
}

/** 生成邀请码；expiresInDays=0 表示永不过期。 */
export function create({ note = '', expiresInDays = 0 } = {}) {
  const doc = read();
  let raw = newRaw();
  while (doc.codes[raw]) raw = newRaw();
  const days = Math.max(0, Math.min(3650, Number(expiresInDays) || 0));
  const entry = {
    code: display(raw),
    note: String(note || '').trim().slice(0, 80),
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
  return { valid: true, uses: entry.uses };
}

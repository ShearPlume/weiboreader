/**
 * @file 用户资料缓存（昵称 / 头像 / 简介 / 粉丝数）。
 *
 * 数据由 `tools/fetch-profiles.mjs` 离线拉取后写入 `data/profiles.json`；
 * 展示页只读该缓存，不触发任何微博请求。缓存缺失时返回空对象，展示页回退首字头像。
 * @module server/profiles
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from './config.js';

/** 缓存文件位置（始终位于数据根目录，不随 settings.dataDir 迁移）。 */
export const PROFILES_FILE = path.join(DEFAULT_DATA_DIR, 'profiles.json');
/** 头像图片目录（由 tools/fetch-profiles.mjs 预取，本地托管）。 */
export const AVATAR_DIR = path.join(DEFAULT_DATA_DIR, 'avatars');

const AVATAR_EXTS = ['.jpg', '.webp', '.png', '.gif'];
const AVATAR_MIME = {
  '.jpg': 'image/jpeg',
  '.webp': 'image/webp',
  '.png': 'image/png',
  '.gif': 'image/gif',
};

let cachedMtime = -1;
/** @type {Record<string, object>} */
let cachedProfiles = {};

/**
 * 读取用户资料表（按 mtime 缓存，文件更新后自动失效）。
 * @returns {Record<string, {uid:string,screenName:string,avatarUrl:string,description:string,followers:number,friends:number,statuses:number,verified:boolean,verifiedReason:string,fetchedAtMs:number}>}
 */
export function loadProfiles() {
  let stat;
  try {
    stat = fs.statSync(PROFILES_FILE);
  } catch {
    return {};
  }
  if (stat.mtimeMs === cachedMtime) return cachedProfiles;
  try {
    const doc = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
    const profiles = doc && doc.profiles && typeof doc.profiles === 'object' ? doc.profiles : {};
    cachedProfiles = profiles;
    cachedMtime = stat.mtimeMs;
    return cachedProfiles;
  } catch {
    return cachedProfiles;
  }
}

/**
 * 只读托管 `/avatar/<uid>`：本地缓存的头像图片。
 * 微博图片 CDN 要求 Referer 为 weibo.com，浏览器直连会 403，因此统一由本机转发。
 * @param {import('node:http').IncomingMessage} req
 * @param {import('node:http').ServerResponse} res
 * @param {string} pathname
 */
export function serveAvatar(req, res, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const uid = pathname.slice('/avatar/'.length).replace(/\.(jpg|webp|png|gif)$/i, '');
  if (!/^\d{1,20}$/.test(uid)) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  let file = '';
  for (const ext of AVATAR_EXTS) {
    const candidate = path.join(AVATAR_DIR, `${uid}${ext}`);
    if (fs.existsSync(candidate)) {
      file = candidate;
      break;
    }
  }
  if (!file) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Not Found');
    return;
  }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'Content-Type': AVATAR_MIME[path.extname(file).toLowerCase()] || 'application/octet-stream',
    'Content-Length': stat.size,
    'Cache-Control': 'public, max-age=86400',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  fs.createReadStream(file).pipe(res);
}

/**
 * @file 拉取微博用户资料（昵称 / 头像 / 简介 / 粉丝数）并缓存到 data/profiles.json。
 *
 * 展示页（showcase.html）通过 `/api/profiles` 读取该缓存来显示真实头像与个人主页信息；
 * 缓存缺失时展示页自动回退为首字头像，不影响离线使用。
 *
 * 用法：
 *   node tools/fetch-profiles.mjs --cookie-file <weibo_cookies.json>
 *                                [--authors] [--limit N] [--delay 900] [--force]
 *
 * cookie 文件支持 {"cookie_str","xsrf_token"} 或 {"cookie","xsrfToken"} 两种写法。
 * 仅在本机执行，不随展示页运行时请求微博。
 */

import fs from 'node:fs';
import path from 'node:path';
import { DEFAULT_DATA_DIR } from '../server/config.js';

const MOBILE_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';
const PROFILE_FILE = path.join(DEFAULT_DATA_DIR, 'profiles.json');
const AVATAR_DIR = path.join(DEFAULT_DATA_DIR, 'avatars');
const AVATAR_EXTS = ['.jpg', '.webp', '.png', '.gif'];
const TTL_MS = 30 * 24 * 60 * 60 * 1000;

function parseArgs(argv) {
  const opts = { authors: false, limit: 0, delay: 900, force: false, cookieFile: '', avatarsOnly: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--authors') opts.authors = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--avatars-only') opts.avatarsOnly = true;
    else if (arg === '--cookie-file') opts.cookieFile = path.resolve(String(argv[(i += 1)] || ''));
    else if (arg === '--limit') opts.limit = Math.max(0, Number(argv[(i += 1)]) || 0);
    else if (arg === '--delay') opts.delay = Math.max(100, Number(argv[(i += 1)]) || 900);
  }
  return opts;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 读取 cookie（兼容两种字段命名）。 */
function loadCookie(file) {
  const doc = readJson(file, null);
  if (!doc) throw new Error(`无法读取 cookie 文件：${file}`);
  const cookie = doc.cookie_str || doc.cookie || '';
  const xsrf = doc.xsrf_token || doc.xsrfToken || '';
  if (!cookie) throw new Error('cookie 文件中没有 cookie_str / cookie 字段');
  return { cookie, xsrf };
}

/** 账号 UID + 记录作者 UID（按出现频次排序）。 */
function collectUids(withAuthors) {
  const usersDoc = readJson(path.join(DEFAULT_DATA_DIR, 'users.json'), { users: [] });
  const accountUids = (Array.isArray(usersDoc.users) ? usersDoc.users : []).map((user) => String(user.uid));
  if (!withAuthors) return accountUids;

  const counts = new Map();
  const walk = (dir) => {
    let names = [];
    try {
      names = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of names) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl')) continue;
      for (const line of fs.readFileSync(full, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try {
          const rec = JSON.parse(line);
          const uid = rec && rec.authorUid ? String(rec.authorUid) : '';
          if (uid) counts.set(uid, (counts.get(uid) || 0) + 1);
        } catch {
          /* 单行损坏不影响其余记录 */
        }
      }
    }
  };
  walk(path.join(DEFAULT_DATA_DIR, 'records'));

  const authors = [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([uid]) => uid);
  return [...new Set([...accountUids, ...authors])];
}

/** 拉取单个用户资料；418/432 等风控返回自动退避重试。 */
async function fetchProfile(uid, auth, referer) {
  const url = `https://m.weibo.cn/api/container/getIndex?type=uid&value=${encodeURIComponent(uid)}`;
  let lastError = '';
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          'User-Agent': MOBILE_UA,
          Referer: referer,
          Cookie: auth.cookie,
          'X-XSRF-TOKEN': auth.xsrf,
          Accept: 'application/json, text/plain, */*',
        },
      });
      if ([403, 414, 418, 432].includes(response.status)) {
        lastError = `HTTP ${response.status}`;
        await sleep(1500 + attempt * 2000);
        continue;
      }
      if (!response.ok) return { ok: false, error: `HTTP ${response.status}` };
      const doc = await response.json();
      if (doc.ok !== 1) {
        lastError = `ok=${doc.ok} errno=${doc.errno || ''}`;
        if ([403, 414, 418, 432, 100005].includes(Number(doc.errno))) {
          await sleep(1500 + attempt * 2000);
          continue;
        }
        return { ok: false, error: lastError };
      }
      const info = (doc.data && doc.data.userInfo) || null;
      if (!info) return { ok: false, error: '响应中没有 userInfo' };
      return {
        ok: true,
        profile: {
          uid,
          screenName: String(info.screen_name || ''),
          avatarUrl: String(info.avatar_hd || info.profile_image_url || ''),
          description: String(info.description || ''),
          followers: Number(info.followers_count) || 0,
          friends: Number(info.follow_count) || 0,
          statuses: Number(info.statuses_count) || 0,
          verified: Boolean(info.verified),
          verifiedReason: String(info.verified_reason || ''),
          fetchedAtMs: Date.now(),
        },
      };
    } catch (err) {
      lastError = err instanceof Error ? err.message : '网络异常';
      await sleep(1000 + attempt * 1500);
    }
  }
  return { ok: false, error: lastError || '重试后仍失败' };
}

function saveDoc(doc) {
  doc.updatedAtMs = Date.now();
  fs.mkdirSync(path.dirname(PROFILE_FILE), { recursive: true });
  fs.writeFileSync(PROFILE_FILE, `${JSON.stringify(doc, null, 2)}\n`);
}

/** 把最新昵称同步回 users.json，避免后台/展示页仍显示“用户<uid>”。 */
function syncUserNames(profiles) {
  const file = path.join(DEFAULT_DATA_DIR, 'users.json');
  const usersDoc = readJson(file, null);
  if (!usersDoc || !Array.isArray(usersDoc.users)) return;
  let changed = false;
  for (const user of usersDoc.users) {
    const profile = profiles[String(user.uid)];
    if (profile && profile.screenName && user.screenName !== profile.screenName) {
      user.screenName = profile.screenName;
      changed = true;
    }
  }
  if (changed) fs.writeFileSync(file, `${JSON.stringify(usersDoc, null, 2)}\n`);
}

/** 本地已缓存头像文件（按扩展名探测）。 */
function existingAvatar(uid) {
  for (const ext of AVATAR_EXTS) {
    const file = path.join(AVATAR_DIR, `${uid}${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return '';
}

/**
 * 下载头像到 data/avatars/<uid>.<ext>。
 * 微博图片 CDN 要求 Referer 为 weibo.com，浏览器直连会 403，因此必须由本机预取。
 */
async function downloadAvatar(uid, url, force = false) {
  if (!url) return '';
  const cached = existingAvatar(uid);
  if (cached && !force) return cached;
  const response = await fetch(url, {
    headers: { 'User-Agent': DESKTOP_UA, Referer: 'https://weibo.com/' },
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const type = String(response.headers.get('content-type') || '');
  const ext = type.includes('webp') ? '.webp' : type.includes('png') ? '.png' : type.includes('gif') ? '.gif' : '.jpg';
  const buffer = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(AVATAR_DIR, { recursive: true });
  const file = path.join(AVATAR_DIR, `${uid}${ext}`);
  fs.writeFileSync(file, buffer);
  if (force) {
    // 换过头像时扩展名可能变化，清掉旧文件避免同名多份
    for (const other of AVATAR_EXTS) {
      const candidate = path.join(AVATAR_DIR, `${uid}${other}`);
      if (candidate !== file && fs.existsSync(candidate)) fs.unlinkSync(candidate);
    }
  }
  return file;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const doc = readJson(PROFILE_FILE, { version: 1, profiles: {} });
  if (!doc.profiles || typeof doc.profiles !== 'object') doc.profiles = {};

  if (opts.avatarsOnly) {
    const entries = Object.values(doc.profiles);
    console.log(`待补齐头像 ${entries.length} 个（目录：${AVATAR_DIR}）`);
    let done = 0;
    let failed = 0;
    for (const [index, profile] of entries.entries()) {
      if (existingAvatar(profile.uid)) {
        done += 1;
        continue;
      }
      try {
        await downloadAvatar(profile.uid, profile.avatarUrl, opts.force);
        done += 1;
        console.log(`[${index + 1}/${entries.length}] ${profile.uid} 头像 ✓`);
      } catch (err) {
        failed += 1;
        console.warn(`[${index + 1}/${entries.length}] ${profile.uid} 头像失败：${err instanceof Error ? err.message : err}`);
      }
      await sleep(250 + Math.round(Math.random() * 250));
    }
    console.log(`头像完成：成功 ${done}，失败 ${failed}`);
    return;
  }

  if (!opts.cookieFile) {
    console.error(
      '用法：node tools/fetch-profiles.mjs --cookie-file <weibo_cookies.json> [--authors] [--limit N] [--delay 900] [--force]\n' +
        '      node tools/fetch-profiles.mjs --avatars-only   # 仅按已有 profiles.json 补齐本地头像'
    );
    process.exit(2);
  }
  const auth = loadCookie(opts.cookieFile);

  let uids = collectUids(opts.authors);
  const now = Date.now();
  uids = uids.filter((uid) => {
    const cached = doc.profiles[uid];
    if (opts.force || !cached) return true;
    return !cached.fetchedAtMs || now - cached.fetchedAtMs > TTL_MS;
  });
  if (opts.limit > 0) uids = uids.slice(0, opts.limit);
  console.log(`待拉取 ${uids.length} 个用户资料（缓存文件：${PROFILE_FILE}）`);

  let done = 0;
  let failed = 0;
  for (const [index, uid] of uids.entries()) {
    const result = await fetchProfile(uid, auth, `https://m.weibo.cn/u/${uid}`);
    if (result.ok) {
      doc.profiles[uid] = result.profile;
      saveDoc(doc);
      done += 1;
      try {
        await downloadAvatar(uid, result.profile.avatarUrl, opts.force);
      } catch (err) {
        console.warn(`[${index + 1}/${uids.length}] ${uid} 头像下载失败：${err instanceof Error ? err.message : err}`);
      }
      console.log(`[${index + 1}/${uids.length}] ${uid} ${result.profile.screenName} ✓`);
    } else {
      failed += 1;
      console.warn(`[${index + 1}/${uids.length}] ${uid} 失败：${result.error}`);
    }
    await sleep(opts.delay + Math.round(Math.random() * opts.delay * 0.5));
  }
  saveDoc(doc);
  syncUserNames(doc.profiles);
  console.log(`完成：成功 ${done}，失败 ${failed}，累计缓存 ${Object.keys(doc.profiles).length} 个用户。`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

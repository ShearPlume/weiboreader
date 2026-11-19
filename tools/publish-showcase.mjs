/**
 * @file 发布展示页到腾讯云 COS（静态直连），并导出展示页所需的静态数据快照。
 *
 * 为什么需要：展示页部署在新加坡服务器，国内用户访问时 HTML/CSS/JS/头像/数据 JSON
 * 若都经过服务器反代会绕一圈（国内→新加坡→广州 COS→新加坡→国内）。本脚本把
 * 静态资源与数据快照直接发布到广州 COS，浏览器从国内直连广州节点，只有很小的
 * API 请求走新加坡（作为兜底）。
 *
 * 用法（在服务器或有 COS 凭据的机器上执行）：
 *   node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf
 *   node tools/publish-showcase.mjs --cos-conf ~/.cos.conf --mode data
 *   node tools/publish-showcase.mjs --cos-conf ~/.cos.conf --uid 6372442231
 *
 * 增量策略：每个对象先 HEAD 取 ETag（单次 PUT 的 ETag 即内容 MD5），与本地内容
 * MD5 相同则跳过上传；数据是 append-only 的 JSONL，重新导出即包含新增记录。
 *
 * @module tools/publish-showcase
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DEFAULT_DATA_DIR, MODE_KEYS, PROJECT_ROOT } from '../server/config.js';

const DEFAULT_BUCKET = 'mirugumi-space-1382800327';
const DEFAULT_REGION = 'ap-guangzhou';
const DEFAULT_PREFIX = 'fakeaccount/';
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

function parseArgs(argv) {
  const opts = {
    cosConf: process.env.COS_CONF || '',
    bucket: process.env.COS_BUCKET || DEFAULT_BUCKET,
    region: process.env.COS_REGION || DEFAULT_REGION,
    prefix: DEFAULT_PREFIX,
    cdnBase: process.env.SHOWCASE_CDN_BASE || '',
    siteBase: process.env.SHOWCASE_SITE_BASE || 'https://idolgallery.xyz/fakeaccount/',
    mode: 'all',
    uid: '',
    force: false,
    skipAvatars: false,
    dryRun: false,
    dataDir: DEFAULT_DATA_DIR,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--cos-conf') opts.cosConf = path.resolve(String(argv[(i += 1)] || ''));
    else if (arg === '--bucket') opts.bucket = String(argv[(i += 1)] || '');
    else if (arg === '--region') opts.region = String(argv[(i += 1)] || '');
    else if (arg === '--prefix') opts.prefix = String(argv[(i += 1)] || '');
    else if (arg === '--cdn-base') opts.cdnBase = String(argv[(i += 1)] || '');
    else if (arg === '--site-base') opts.siteBase = String(argv[(i += 1)] || '');
    else if (arg === '--mode') opts.mode = String(argv[(i += 1)] || 'all');
    else if (arg === '--uid') opts.uid = String(argv[(i += 1)] || '').trim();
    else if (arg === '--data-dir') opts.dataDir = path.resolve(String(argv[(i += 1)] || ''));
    else if (arg === '--force') opts.force = true;
    else if (arg === '--skip-avatars') opts.skipAvatars = true;
    else if (arg === '--dry-run') opts.dryRun = true;
  }
  if (opts.prefix && !opts.prefix.endsWith('/')) opts.prefix += '/';
  if (!opts.cdnBase) opts.cdnBase = `https://${opts.bucket}.cos.${opts.region}.myqcloud.com/`;
  if (!opts.cdnBase.endsWith('/')) opts.cdnBase += '/';
  if (!opts.siteBase.endsWith('/')) opts.siteBase += '/';
  opts.staticRoot = opts.cdnBase + opts.prefix;
  return opts;
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

/** 解析 coscmd 使用的 INI 配置。 */
function loadCosConf(file) {
  if (!file) throw new Error('缺少 --cos-conf（coscmd 配置文件）');
  const text = fs.readFileSync(file, 'utf8');
  const conf = {};
  for (const line of text.split(/\r?\n/)) {
    const matched = /^\s*([\w_]+)\s*=\s*(.+?)\s*$/.exec(line);
    if (matched) conf[matched[1].toLowerCase()] = matched[2];
  }
  if (!conf.secret_id || !conf.secret_key) throw new Error(`COS 配置缺少 secret_id/secret_key：${file}`);
  return conf;
}

function sha1(value) {
  return crypto.createHash('sha1').update(value).digest('hex');
}

function hmacSha1(key, value) {
  return crypto.createHmac('sha1', key).update(value).digest('hex');
}

function md5(buffer) {
  return crypto.createHash('md5').update(buffer).digest('hex');
}

function objectUrl(opts, key) {
  const encoded = key.split('/').map(encodeURIComponent).join('/');
  return `https://${opts.bucket}.cos.${opts.region}.myqcloud.com/${encoded}`;
}

function authorization(opts, key, extraHeaders, secretId, secretKey) {
  const now = Math.floor(Date.now() / 1000);
  const keyTime = `${now};${now + 3600}`;
  const signKey = hmacSha1(secretKey, keyTime);
  const headers = { host: `${opts.bucket}.cos.${opts.region}.myqcloud.com`, ...extraHeaders };
  const entries = Object.entries(headers)
    .map(([k, v]) => [k.toLowerCase(), encodeURIComponent(String(v))])
    .sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const headerString = entries.map(([k, v]) => `${k}=${v}`).join('&');
  const httpString = `put\n/${key}\n\n${headerString}\n`;
  const stringToSign = `sha1\n${keyTime}\n${sha1(httpString)}\n`;
  const signature = hmacSha1(signKey, stringToSign);
  const headerList = entries.map(([k]) => k).join(';');
  return `q-sign-algorithm=sha1&q-ak=${secretId}&q-sign-time=${keyTime}&q-key-time=${keyTime}&q-header-list=${headerList}&q-url-param-list=&q-signature=${signature}`;
}

/** HEAD 取远端 ETag（单次 PUT 即内容 MD5），不存在返回空串。 */
async function remoteMd5(opts, key) {
  try {
    const res = await fetch(objectUrl(opts, key), { method: 'HEAD' });
    if (!res.ok) return '';
    return String(res.headers.get('etag') || '').replace(/"/g, '').toLowerCase();
  } catch {
    return '';
  }
}

/** 简单并发池：控制 HEAD/PUT 并发，避免几百个对象串行等待。 */
async function pool(items, concurrency, worker) {
  const queue = items.slice();
  const runners = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    while (queue.length) {
      const item = queue.shift();
      await worker(item);
    }
  });
  await Promise.all(runners);
}

/**
 * 上传一个对象；内容未变化则跳过。
 * @returns {Promise<'uploaded'|'skipped'|'would-upload'>}
 */
async function putAsset(opts, key, buffer, contentType, cacheControl, secrets) {
  const localMd5 = md5(buffer);
  if (!opts.force) {
    const etag = await remoteMd5(opts, key);
    if (etag && etag === localMd5) return 'skipped';
  }
  if (opts.dryRun) return 'would-upload';
  const extra = { 'x-cos-acl': 'public-read' };
  if (cacheControl) extra['cache-control'] = cacheControl;
  const auth = authorization(opts, key, extra, secrets.id, secrets.key);
  const headers = {
    Authorization: auth,
    'Content-Type': contentType,
    'Content-Length': String(buffer.length),
    'x-cos-acl': 'public-read',
  };
  if (cacheControl) headers['Cache-Control'] = cacheControl;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await fetch(objectUrl(opts, key), { method: 'PUT', headers, body: buffer });
    if (res.ok) return 'uploaded';
    const text = await res.text();
    if (attempt === 2 || res.status < 500) throw new Error(`PUT ${key} -> ${res.status} ${text.slice(0, 160)}`);
    await new Promise((resolve) => setTimeout(resolve, 600 * (attempt + 1)));
  }
  return 'uploaded';
}

/** 读取一个账号的全部记录，按模式聚合（与 server/store.readRecords 行为一致）。 */
function readOwnerRecords(dataDir, uid) {
  const dir = path.join(dataDir, 'records', 'users', uid);
  const overlay = readJson(path.join(dir, '_read.json'), null);
  const readIds = overlay && overlay.recordIds && typeof overlay.recordIds === 'object' ? overlay.recordIds : overlay || {};
  const modes = new Map();
  let files = [];
  try {
    files = fs.readdirSync(dir).filter((name) => name.endsWith('.jsonl'));
  } catch {
    return modes;
  }
  for (const file of files) {
    const mode = MODE_KEYS.find((key) => file.startsWith(`${key}_`));
    if (!mode) continue;
    const list = modes.get(mode) || [];
    for (const line of fs.readFileSync(path.join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      record.ms = Number(record.ms) || 0;
      record.isUnread = !Object.prototype.hasOwnProperty.call(readIds, String(record.recordId || ''));
      list.push(record);
    }
    modes.set(mode, list);
  }
  for (const list of modes.values()) {
    list.sort((a, b) => b.ms - a.ms || String(b.recordId).localeCompare(String(a.recordId)));
  }
  return modes;
}

/** 本地头像文件（uid.ext）。 */
function avatarFiles(dataDir) {
  const dir = path.join(dataDir, 'avatars');
  const out = [];
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of names) {
    const ext = path.extname(name).toLowerCase();
    if (!MIME[ext] || !ext.startsWith('.')) continue;
    if (['.jpg', '.jpeg', '.png', '.webp', '.gif'].includes(ext)) {
      out.push({ uid: path.basename(name, ext), file: name, ext });
    }
  }
  return out;
}

/** 生成线上 index.html：注入 <base> 指向 COS，并给 CSS/JS 加版本号。 */
function buildIndexHtml(opts, stamp) {
  const source = fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'showcase.html'), 'utf8');
  let html = source
    .replace('href="css/showcase.css"', `href="css/showcase.css?v=${stamp}"`)
    .replace('src="js/showcase.js"', `src="js/showcase.js?v=${stamp}"`);
  html = html.replace('<head>', `<head>\n<base href="${opts.staticRoot}">`);
  // manifest / 主屏图标必须用站点绝对地址，不能落到 COS 域名（否则 API 会跨域/404）
  html = html
    .replace('href="manifest.webmanifest"', `href="${opts.siteBase}manifest.webmanifest"`)
    .replace('href="icons/fake-weibo-180.png"', `href="${opts.siteBase}icons/fake-weibo-180.png"`);
  return html;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!['all', 'data', 'static'].includes(opts.mode)) throw new Error('--mode 只能是 all|data|static');
  const conf = loadCosConf(opts.cosConf);
  const secrets = { id: conf.secret_id, key: conf.secret_key };
  const dataDir = opts.dataDir;
  const usersDoc = readJson(path.join(dataDir, 'users.json'), { users: [] });
  const users = Array.isArray(usersDoc.users) ? usersDoc.users : [];
  const profilesDoc = readJson(path.join(dataDir, 'profiles.json'), { profiles: {} });
  const profiles = profilesDoc.profiles && typeof profilesDoc.profiles === 'object' ? profilesDoc.profiles : {};
  const avatars = avatarFiles(dataDir);
  const avatarByUid = new Map(avatars.map((item) => [item.uid, item]));
  const stamp = Date.now().toString(36);

  const targets = opts.uid ? users.filter((user) => String(user.uid) === opts.uid) : users;
  if (opts.uid && targets.length === 0) throw new Error(`本地没有账号 ${opts.uid}`);

  const stats = { uploaded: 0, skipped: 0, wouldUpload: 0, bytes: 0 };
  const upload = async (key, buffer, type, cacheControl = 'public, max-age=300') => {
    const result = await putAsset(opts, key, buffer, type, cacheControl, secrets);
    if (result === 'uploaded') {
      stats.uploaded += 1;
      stats.bytes += buffer.length;
    } else if (result === 'skipped') stats.skipped += 1;
    else stats.wouldUpload += 1;
    return result;
  };

  console.log(`发布目标：${opts.staticRoot}`);
  console.log(`模式：${opts.mode}${opts.uid ? `（仅 ${opts.uid}）` : ''}${opts.force ? ' · 强制' : ''}${opts.dryRun ? ' · 预演' : ''}`);

  if (opts.mode !== 'data') {
    const assets = [
      ['index.html', buildIndexHtml(opts, stamp), 'text/html; charset=utf-8', 'no-cache'],
      ['css/showcase.css', fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'css', 'showcase.css')), 'text/css; charset=utf-8', 'public, max-age=31536000, immutable'],
      ['js/showcase.js', fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'js', 'showcase.js')), 'application/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
      ['js/api.js', fs.readFileSync(path.join(PROJECT_ROOT, 'web', 'js', 'api.js')), 'application/javascript; charset=utf-8', 'public, max-age=31536000, immutable'],
    ];

    // PWA：manifest 与页面同源提供，start_url 指向 /<prefix>/（nginx → COS index）
    const manifest = {
      name: '微博通知 · 本地归档展示',
      short_name: '微博展示',
      description: '用本地归档数据还原的微博通知界面',
      lang: 'zh-CN',
      start_url: './',
      scope: './',
      display: 'standalone',
      display_override: ['fullscreen', 'standalone'],
      background_color: '#ffffff',
      theme_color: '#ffffff',
      icons: [
        { src: 'icons/fake-weibo-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icons/fake-weibo-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
      ],
    };
    assets.push([
      'manifest.webmanifest',
      Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8'),
      'application/manifest+json',
      'no-cache',
    ]);
    for (const icon of ['fake-weibo-180.png', 'fake-weibo-192.png', 'fake-weibo-512.png']) {
      const iconFile = path.join(PROJECT_ROOT, 'web', 'icons', icon);
      if (fs.existsSync(iconFile)) {
        assets.push([`icons/${icon}`, fs.readFileSync(iconFile), 'image/png', 'public, max-age=31536000, immutable']);
      }
    }

    for (const [key, body, type, cache] of assets) {
      await upload(`${opts.prefix}${key}`, Buffer.isBuffer(body) ? body : Buffer.from(body, 'utf8'), type, cache);
    }
    console.log(`静态资源：上传 ${stats.uploaded} / 跳过 ${stats.skipped}`);
  }

  if (opts.mode !== 'static' && !opts.skipAvatars) {
    let uploaded = 0;
    let skipped = 0;
    await pool(avatars, 8, async (avatar) => {
      const key = `${opts.prefix}avatar/${avatar.file}`;
      const body = fs.readFileSync(path.join(dataDir, 'avatars', avatar.file));
      const result = await upload(key, body, MIME[avatar.ext] || 'application/octet-stream', 'public, max-age=604800');
      if (result === 'uploaded') uploaded += 1;
      else if (result === 'skipped') skipped += 1;
    });
    console.log(`头像：上传 ${uploaded} / 跳过 ${skipped}`);
  }

  if (opts.mode !== 'static') {
    const exportedUsers = users.map((user) => {
      const avatar = avatarByUid.get(String(user.uid));
      return { ...user, avatarFile: avatar ? avatar.file : '' };
    });
    const exportedProfiles = {};
    for (const [uid, profile] of Object.entries(profiles)) {
      const avatar = avatarByUid.get(String(uid));
      exportedProfiles[uid] = { ...profile, avatarFile: avatar ? avatar.file : '' };
    }
    const dataJobs = [
      {
        key: `${opts.prefix}users.json`,
        body: Buffer.from(JSON.stringify({ items: exportedUsers }), 'utf8'),
      },
      {
        key: `${opts.prefix}profiles.json`,
        body: Buffer.from(JSON.stringify({ items: exportedProfiles }), 'utf8'),
      },
    ];

    let recordFiles = 0;
    for (const user of targets) {
      const uid = String(user.uid);
      const modes = readOwnerRecords(dataDir, uid);
      // 全部 6 种模式都导出（没有数据的写空快照），避免页面回落 API 时遇到 404
      for (const mode of MODE_KEYS) {
        const list = modes.get(mode) || [];
        const payload = {
          uid,
          mode,
          total: list.length,
          unread: list.filter((item) => item.isUnread).length,
          items: list,
        };
        dataJobs.push({
          key: `${opts.prefix}records/${uid}/${mode}.json`,
          body: Buffer.from(JSON.stringify(payload), 'utf8'),
        });
        recordFiles += 1;
      }
    }

    await pool(dataJobs, 6, async (job) => {
      await upload(job.key, job.body, MIME['.json'], 'no-cache');
    });
    console.log(`数据快照：${recordFiles} 个记录文件；上传 ${stats.uploaded} / 跳过 ${stats.skipped}`);
  }

  console.log(
    `完成：上传 ${stats.uploaded} 个（${(stats.bytes / 1024).toFixed(1)} KB），跳过未变化 ${stats.skipped} 个${
      opts.dryRun ? `，预演待传 ${stats.wouldUpload} 个` : ''
    }。`
  );
  console.log(`页面地址：${opts.cdnBase.replace(/\/$/, '')}/${opts.prefix}index.html`);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});

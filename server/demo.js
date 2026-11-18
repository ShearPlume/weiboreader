/**
 * @file 演示数据 seed：写入 `data/demo/`（结构与真实根完全一致），
 *       让无 token / 无网络时也能完整体验「浏览 → 搜索 → 生成报告 → 配置订阅」。
 *
 * 说明：`data/demo/` 与真实数据物理隔离（store 在 demoMode 下 root 指向该目录），
 * 因此演示数据的增删改绝不会污染真实归档。
 * @module server/demo
 */

import fs from 'node:fs';
import path from 'node:path';

import { CONFIG_FILE } from './config.js';
import { AppError, dayStartMs, fmtTime } from './util.js';
import * as store from './store.js';

/** 演示用户。 */
const DEMO_USERS = [
  { uid: '1650000001', screenName: '林间有风', starred: true },
  { uid: '1650000002', screenName: '夜航船笔记', starred: false },
  { uid: '1650000003', screenName: '数读城市', starred: false },
];

/** 演示博文。 */
const DEMO_POSTS = [
  {
    id: '4901234567890123',
    mId: 'NkK9abcdefg',
    authorUid: '1650000002',
    author: '夜航船笔记',
    text: '把一年的通勤路线画成线稿，才发现自己每天其实只走了三条街。\n明天换一条试试。',
  },
  {
    id: '4901234567890456',
    mId: 'NkK9hijklmn',
    authorUid: '1650000003',
    author: '数读城市',
    text: '统计了本季度公开数据里的 1200 条诉求，高频问题前三名是：路灯、井盖、噪音。',
  },
];

/** 评论/微博文案池（含换行与需要转义的 HTML 片段，用于验证报告安全性）。 */
const TEXTS = {
  sent: [
    '这段关于城市步行系统的分析很有启发，尤其是「连续界面」那一段。',
    '请问这份数据的时间口径是自然季度还是滚动季度？',
    '同意。补充一点：夜间照明对步行意愿的影响也很明显。\n我整理过一份小样本，回头贴出来。',
    '收藏了，周末细读。',
    '表格里第三列的单位似乎不一致，方便核对一下吗？',
    '刚好在做同类题目，这条线索很有用，谢谢。',
  ],
  received: [
    '谢谢补充，我把你这句加到正文里。',
    '口径是自然季度，已在图注里补充说明。',
    '这条线稿太漂亮了，请问用什么工具画的？',
    '<script>alert(1)</script> 这段是刻意放进去的转义测试文本。',
    '同感，夜间照明确实是个被低估的变量。',
    '期待你的小样本，正好可以交叉验证。',
  ],
  'mentions-comments': [
    '@林间有风 提到的「连续界面」概念，出处可以看这一篇。',
    '@夜航船笔记 你的通勤线稿被同事设成群头像了。',
    '@数读城市 这组数据能不能按区县再拆一层？',
    '@林间有风 周末的线下分享还有名额吗？',
  ],
  'user-posts': [
    '本周阅读记录：三篇关于城市形态的论文，两篇是重复的，结论方向一致。',
    '写了一个小脚本，把通勤轨迹导出成 SVG，意外地好看。',
    '年末整理：今年一共记了 4 万多字的随手笔记，删掉了三分之二。',
  ],
  'mentions-posts': [
    '被 @ 的一次讨论：城市里的「可停留空间」到底该怎么度量。',
    '被 @ 的一组旧图，重新整理了一下标注。',
  ],
  'post-comments': [
    '三条街的观察很有意思，其实这就是最小尺度的城市体验。',
    '请问线稿里不同颜色代表不同交通方式吗？',
    '同意二楼的看法，尺度再放大一点会更有说服力。',
    '这个统计口径下，噪音问题被低估了。',
    '已转发给做社区营造的朋友。',
  ],
};

/** 记录生成的时间偏移（天），刻意跳过部分日期以形成 gap 待补区间。 */
const DAY_OFFSETS = [0, 1, 2, 4, 5, 6, 9, 13, 18, 26, 33, 45];

let sequence = 4901000000000000;

/** 生成下一个数字来源 ID（保证 recordId 稳定且唯一）。 */
function nextSourceId() {
  sequence += 1;
  return String(sequence);
}

/** 构造一条演示记录。 */
function buildRecord(ownerType, ownerId, mode, text, ms, author, authorUid, extra = {}) {
  const sourceId = nextSourceId();
  const recordId = store.makeRecordId(ownerType, ownerId, mode, sourceId);
  const record = {
    recordId,
    sourceRef: sourceId,
    sourceId,
    mode,
    type: extra.type || mode,
    group: mode,
    author,
    authorUid,
    time: fmtTime(ms),
    ms,
    text,
    textTruncated: false,
    postId: extra.postId || '',
    postUrl: extra.postUrl || '',
    source: 'demo',
    fetchedAtMs: Date.now(),
  };
  if (extra.likes !== undefined) record.likes = extra.likes;
  if (extra.pictures) record.pictures = extra.pictures;
  return record;
}

/** 把 mode key 转成中文标签。 */
const MODE_LABEL = {
  sent: '发出的评论',
  received: '收到的评论',
  'mentions-comments': '被 @ 的评论',
  'user-posts': '用户微博',
  'mentions-posts': '被 @ 的微博',
  'post-comments': '某条微博下的评论',
  both: '发出和收到的评论',
};

/**
 * 原子清空数据根：把整个目录 `rename` 成 `.trash-<ts>`（同卷 rename 是原子操作，
 * 不会出现「删了一半」的中间态），随后重建空目录。旧目录交给调用方在播种成功后清理。
 *
 * 为什么不用逐个删除：Windows 上 Defender/索引器会瞬时锁文件，逐文件删除可能中途失败，
 * 留下「索引已删、分片还在」的半残状态；此时任何后续 seed 都会在残留分片上重复追加
 * （实测未读数 166 → 333）。rename 要么整体成功、要么整体失败，不存在中间态。
 *
 * @returns {string|null} 待清理的旧目录路径（无旧目录时为 null）
 */
function atomicClearRoot(root) {
  if (!fs.existsSync(root)) return null;
  const trash = `${root}.trash-${Date.now()}`;
  try {
    fs.renameSync(root, trash);
  } catch (err) {
    // rename 失败说明目录被占用：此刻**什么都没动**，旧数据完好，用户重试是安全的。
    throw new AppError(
      'IO_ERROR',
      '重置演示数据失败：数据目录正被其他程序占用。请关闭占用该目录的程序后重试（旧数据未受影响）。',
      500,
      { root, lastError: String(err.code || err.message) }
    );
  }
  return trash;
}

/**
 * 尽力删除原子重置留下的旧目录；失败不影响正确性，但会占磁盘。
 *
 * Windows 上刚 rename 过去的目录常被 Defender/索引器短暂占用，首次 `rmSync` 可能失败。
 * 因此这里做多轮短退避重试；仍失败则保留，交由 `sweepTrash()` 在下次启动时清理。
 */
function removeTrash(trashPath) {
  if (!trashPath) return;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.rmSync(trashPath, { recursive: true, force: true, maxRetries: 5 });
    } catch {
      /* 落到下面的存在性检查 */
    }
    if (!fs.existsSync(trashPath)) return;
    // 同步短退避：Windows 文件锁通常几十毫秒即释放
    const until = Date.now() + 60 * (attempt + 1);
    while (Date.now() < until) {
      /* 忙等极短时间，避免引入异步复杂度 */
    }
  }
}

/**
 * 清理历史遗留的 `<root>.trash-*` 目录（例如上次删除时被占用而残留）。
 * 启动时调用一次，避免磁盘占用随重置次数线性增长。
 * @returns {number} 清理掉的目录数量
 */
export function sweepTrash() {
  const base = store.baseDataDir();
  let removed = 0;
  let entries = [];
  try {
    entries = fs.readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of entries) {
    if (!name.includes('.trash-')) continue;
    const target = path.join(base, name);
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 5 });
      removed += 1;
    } catch {
      /* 仍被占用则下次启动再试 */
    }
  }
  return removed;
}

/** 判断是否存在残留记录分片（索引为空但分片还在 = 部分删除的中间态）。 */
function hasResidualRecords(root) {
  const recordsDir = path.join(root, 'records');
  if (!fs.existsSync(recordsDir)) return false;
  let kinds = [];
  try {
    kinds = fs.readdirSync(recordsDir);
  } catch {
    return false;
  }
  for (const kind of kinds) {
    let owners = [];
    try {
      owners = fs.readdirSync(path.join(recordsDir, kind));
    } catch {
      continue;
    }
    for (const ownerId of owners) {
      try {
        const files = fs.readdirSync(path.join(recordsDir, kind, ownerId));
        if (files.some((name) => name.endsWith('.jsonl'))) return true;
      } catch {
        /* 目录不可读，跳过 */
      }
    }
  }
  return false;
}

/**
 * 写入演示数据。
 * @param {{reset?:boolean}} [options] reset=true 时先清空演示目录再写入
 * @returns {{seeded:boolean,skipped?:boolean,counts:object}}
 */
export function seed(options = {}) {
  store.setDemoMode(true);
  const root = store.getRoot();
  /** @type {string|null} */
  let trashPath = null;
  if (options.reset) {
    trashPath = atomicClearRoot(root);
  }
  store.ensureDirs();

  const existing = store.listUsers().total + store.listPosts().total;
  if (existing === 0 && !options.reset && hasResidualRecords(root)) {
    // 不一致状态：索引没了但分片还在。此时追加会在残留之上重复写入（未读翻倍），
    // 因此拒绝继续，并指向能真正自愈的「重置演示数据」（走原子替换）。
    throw new AppError(
      'IO_ERROR',
      '检测到数据不一致（索引为空但仍有残留记录）。请点击「重置演示数据」修复后再试。',
      500,
      { root }
    );
  }
  if (existing > 0 && !options.reset) {
    removeTrash(trashPath);
    return { seeded: true, skipped: true, counts: store.counts() };
  }

  const todayStart = dayStartMs(Date.now());

  // 1) 用户
  for (const user of DEMO_USERS) {
    store.addUser({ uid: user.uid, screenName: user.screenName, starred: user.starred });
  }

  // 2) 博文
  for (const post of DEMO_POSTS) {
    store.addPost({
      id: post.id,
      mId: post.mId,
      authorUid: post.authorUid,
      author: post.author,
      text: post.text,
      createdAtMs: todayStart - 3 * 86400000,
      sourceUrl: `https://weibo.com/${post.authorUid}/${post.mId}`,
    });
  }

  // 3) 用户维度的互动记录
  for (const user of DEMO_USERS) {
    const modes = ['sent', 'received', 'mentions-comments'];
    modes.forEach((mode, modeIndex) => {
      const pool = TEXTS[mode];
      DAY_OFFSETS.forEach((offset, dayIndex) => {
        const count = (dayIndex + modeIndex) % 3 === 0 ? 2 : 1;
        for (let i = 0; i < count; i += 1) {
          const ms = todayStart - offset * 86400000 + (9 + i * 3) * 3600000 + modeIndex * 600000;
          const text = pool[(dayIndex + modeIndex + i) % pool.length];
          const record = buildRecord('users', user.uid, mode, text, ms, user.screenName, user.uid, {
            type: MODE_LABEL[mode],
            likes: (dayIndex * 2 + i) % 17,
            postId: DEMO_POSTS[(dayIndex + i) % DEMO_POSTS.length].id,
            postUrl: `https://m.weibo.cn/detail/${DEMO_POSTS[(dayIndex + i) % DEMO_POSTS.length].id}`,
          });
          store.appendRecords('users', user.uid, mode, [record]);
        }
      });
    });

    // 用户微博（正文类，含超长与配图示例）
    TEXTS['user-posts'].forEach((text, index) => {
      const ms = todayStart - (index * 11 + 3) * 86400000 + 20 * 3600000;
      const record = buildRecord('users', user.uid, 'user-posts', text, ms, user.screenName, user.uid, {
        type: MODE_LABEL['user-posts'],
        likes: 12 + index,
        pictures: { total: 2, items: [{ url: 'https://wx1.sinaimg.cn/demo/1.jpg' }, { url: 'https://wx1.sinaimg.cn/demo/2.jpg' }] },
      });
      store.appendRecords('users', user.uid, 'user-posts', [record]);
    });

    // 被 @ 的微博
    TEXTS['mentions-posts'].forEach((text, index) => {
      const ms = todayStart - (index * 15 + 6) * 86400000 + 14 * 3600000;
      const record = buildRecord('users', user.uid, 'mentions-posts', text, ms, '其他用户', '1650000099', {
        type: MODE_LABEL['mentions-posts'],
        likes: 3 + index,
      });
      store.appendRecords('users', user.uid, 'mentions-posts', [record]);
    });

    store.recomputeStats('users', user.uid);
  }

  // 4) 博文维度的评论记录
  for (const post of DEMO_POSTS) {
    TEXTS['post-comments'].forEach((text, index) => {
      const ms = todayStart - (index * 4 + 1) * 86400000 + 11 * 3600000;
      const record = buildRecord('posts', post.id, 'post-comments', text, ms, '评论者' + (index + 1), String(1650000100 + index), {
        type: MODE_LABEL['post-comments'],
        likes: index,
        postId: post.id,
        postUrl: `https://weibo.com/${post.authorUid}/${post.mId}`,
      });
      store.appendRecords('posts', post.id, 'post-comments', [record]);
    });
    store.recomputeStats('posts', post.id);
  }

  // 5) 部分已读样例（验证「未读高亮 + 已读落盘」）
  const firstUserRecords = store.readRecords('users', DEMO_USERS[0].uid, { mode: 'sent' }).slice(0, 3);
  if (firstUserRecords.length > 0) {
    store.markRead('users', DEMO_USERS[0].uid, firstUserRecords.map((r) => String(r.recordId)));
  }

  // 6) 订阅（演示模式下调度器不会真正执行，仅用于展示与配置）
  const existingSubs = store.listSubscriptions();
  if (existingSubs.length === 0) {
    store.addSubscription({
      ownerType: 'users',
      ownerId: DEMO_USERS[0].uid,
      ownerLabel: DEMO_USERS[0].screenName,
      mode: 'received',
      perRoundLimit: 50,
      dailyCreditsBudget: 2,
      intervalMode: 'auto',
      enabled: false,
    });
    store.addSubscription({
      ownerType: 'posts',
      ownerId: DEMO_POSTS[0].id,
      ownerLabel: `博文 ${DEMO_POSTS[0].id}`,
      mode: 'post-comments',
      perRoundLimit: 100,
      dailyCreditsBudget: 3,
      intervalMode: 'fixed',
      fixedMinutes: 60,
      enabled: false,
    });
  }

  // 7) 订阅日志样例
  if (store.readSubLogs(1).length === 0) {
    const now = Date.now();
    const rows = [
      { result: 'ok', returned: 12, added: 5, credits: 0.1, message: '演示数据：本轮新增 5 条' },
      { result: 'no-new', returned: 20, added: 0, credits: 0.4, message: '演示数据：无新增记录' },
      { result: 'budget', returned: 0, added: 0, credits: 0, message: '演示数据：今日额度用尽，明日自动恢复' },
      { result: 'error', returned: 0, added: 0, credits: 0, message: '演示数据：接口暂时不可用（示例）' },
    ];
    const subs = store.listSubscriptions();
    rows.forEach((row, index) => {
      store.appendSubLog({
        atMs: now - (index + 1) * 3600000,
        subId: subs.length > 0 ? subs[index % subs.length].id : 'demo',
        mode: subs.length > 0 ? subs[index % subs.length].mode : 'received',
        returned: row.returned,
        added: row.added,
        credits: row.credits,
        result: row.result,
        message: row.message,
      });
    });
  }

  removeTrash(trashPath);
  return { seeded: true, counts: store.counts() };
}

/**
 * 首次启动兜底：没有 `data/config.json` 时自动写入演示模式配置并 seed。
 * @returns {boolean} 是否执行了初始化
 */
export function ensureFirstRun() {
  if (fs.existsSync(CONFIG_FILE)) return false;
  store.writeConfig({ settings: { demoMode: true } });
  seed({ reset: false });
  return true;
}

/**
 * 演示数据自愈：`ensureFirstRun()` 只看 `config.json` 是否存在，所以演示数据被误删、
 * 或 `seed({reset:true})` 中途失败留下空目录时，用户启动后会看到一个空库。
 *
 * 索引为空时该库对用户而言就是空的，没有任何可保留的内容，因此这里走**原子重建**
 * 而不是追加补种：若磁盘上还有残留的记录分片（部分删除的中间态），追加会在残留之上
 * 重复写入，把未读数翻倍（实测 166 → 333）。原子重建则保证结果恒等于初始状态。
 *
 * 注意：仅在演示模式生效，真实账号库绝不被自动灌入演示数据。
 * @returns {boolean} 是否执行了补种
 */
export function ensureDemoData() {
  if (!store.readConfig().settings.demoMode) return false;
  if (store.listUsers().total > 0 || store.listPosts().total > 0) return false;
  seed({ reset: true });
  return true;
}

/** 演示数据的固定 ID（供测试引用）。 */
export const DEMO_IDS = {
  users: DEMO_USERS.map((u) => u.uid),
  posts: DEMO_POSTS.map((p) => p.id),
};

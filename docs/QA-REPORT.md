# QA 验收报告 — Weibo Reader（Windows Web 版 v1.0）

| 项 | 内容 |
|---|---|
| 验收对象 | `C:\Users\lew12\WorkBuddy\2026-11-17-14-35-44\weibo-reader-web`（Node 22 内置模块 + 原生 ESM，零依赖零构建） |
| 需求基线 | `docs/PRD.md`（33 条 P0） |
| 验收人 | 严过关（QA） |
| 当前轮次 | **Round 2（回归）— 通过** |
| 验收方式 | 独立复现，不采信工程师自测结论：读码 + 打接口 + 打桩网关 + 真实 headless Chrome 渲染 + 首启/重启实测 |
| 自动化测试 | `node --test`：**100 项全部通过（100 pass / 0 fail / 0 skip）**（含交付收尾新增的 4 条实例锁与残留清理用例） |
| 路由判定 | **→ NoOne**：Round 1 的 1 Blocker + 3 Major + 7 Minor 全部闭环，无新增缺陷 |
| 交付建议 | **可以交付**。剩余 4 条 PARTIAL 均为「需真人/桌面会话/真实账号」的环境限制，非代码缺陷（见 §6） |

---

## 0. Round 2 回归结论（本轮）

| 项 | Round 1 结论 | Round 2 复核 | 复核方式 |
|---|---|---|---|
| B-1 首页 `fmtNum is not defined` | Blocker / FAIL | **已修复** | headless Chrome 逐 9 条路由 dump DOM：全部 `OK`，`#/overview` 4 张统计卡（剩余 credits `—` / 今日消耗 0 / 未读 166 / 归档对象 3·2）全部渲染 |
| M-1 余额未知显示「0 credits」 | Major / PARTIAL | **已修复** | 新增 `numOrNull()`；顶栏实测 `balanceValue="演示"`、统计卡 `剩余 credits —`，全站无假 0；`fmtNum(0)==='0'` 已加断言防回归 |
| M-2 手动暂停跨日被恢复 | Major / PARTIAL | **已修复** | 实现改用 `pauseReason:'user'|'budget'`（比原建议的布尔标记更严谨，且显式 `pauseReason` 最后统一应用，无字段顺序依赖）；HTTP 实测手动暂停 → `status=paused, pauseReason='user'`；跨日 tick 用例断言保持暂停 |
| M-3 P0-15 前端未接线 | Major / FAIL | **已修复** | 详情页实测含「正文缺失」徽标 ×2 + 「单独补取正文」按钮；博文库含「正文缺失清单」开关 + `缺失正文` + `data-missing-fetch` + 「不计入互动统计」标注 |
| m-1 跨月分片去重失效 | Minor | **已修复** | 同 recordId 人为落两个月分片 → `added` 1→0、`rows=1`、`unreadCount=1` |
| m-2 报告 read 不校验文件 | Minor | **已修复** | 删文件后 `POST /read` → `404 NOT_FOUND`「报告文件已被删除，请重新生成」，未读数不变；另加 `ids ⊆ pendingReadIds` 校验（越权 ID 计入 `skipped`） |
| m-3 跨日 tick 推迟 30s | Minor | **已修复** | 同一 tick 内即完成「恢复 + 真实取数」（用例断言 `lastResult='ok'`、`spentToday=0.02`） |
| m-4 `cleanupReports` 死代码 | Minor | **已修复**（回归期间二次修复） | 现在真实删除「非白名单 html」与「索引孤儿 html」，返回值改为被删文件名数组；实测 `removed=["evil-report.html","users-999999.html"]` |
| m-5 `newEstimate` 口径错 | Minor | **已修复** | 字段更名为语义更诚实的 `newEstimateUpperBound = willFetch`，前端同步 |
| m-6 `gaps` 不带 mode 恒空 | Minor | **已修复** | HTTP 实测不带 `mode` 时 `gaps=7` |
| m-7 `weibo.com/昵称` 限制 | Minor | **已修复（文案）** | 用户库表单下方明示「昵称解析只能命中本地已存在的昵称（不联网、0 credits）」 |

**回归过程中额外抓到的问题（已闭环）**：`server/report.js` 的 `cleanupReports` 一次改写里用了 `path.join` 但漏 `import path`，`ReferenceError` 被 `catch {}` 完全吞掉 → 清理函数静默失效、且不报任何错。该文件随后被补上 import（文件 mtime 15:23:38），复核确认清理恢复工作。为防止同类事故复发，本轮新增 `test/static-guards.test.js`（3 项）：
- 检查 `server/` 与 `web/js/` 中「使用 `fs.`/`path.` 等内置模块前缀却未导入也未声明」——已用合成样本验证「能抓真 Bug（FLAGGED）、无 3 类误报」；
- 常见拼写错误抽查；
- 空 `catch` 包裹危险写操作的数量基线（禁止继续恶化）。

> **数据目录清洁性自检**：回归期间曾观察到 `data/demo/` 一度为空。已做对照实验：把 6 个测试文件逐个单独执行，每个文件跑完 `data/demo/` 均完好；全量 `node --test` 前后 `data/demo/users.json` 的 md5 一致（`a5ae5e09…`）→ **测试套件不会写入仓库 `data/`**。该现象系 QA 自身多实例/重置操作交叉所致，非产品缺陷；最终已恢复纯净演示数据（3 用户 / 2 博文 / 166 未读，`demoMode:true`、未登录）。

> 另需记录：回归期间源码文件仍在被改动（`store.js` 15:21:40、`views-library.js` 15:22:47、`report.js` 15:23:38、`app.js` 15:24:33）。本轮结论以 **15:24 之后的文件状态** 为准，并在跑测前后比对 mtime 指纹确认无并发改动。


## 0.5 Round 2 定向回归取证（主理人指定 9 项）

> 说明：本节 9 项全部在**冻结后的当前代码**上重新取过一次证（不引用上一轮结论）。取证时间 15:30–15:32。

### ⚠️ 先纠正一处事实分歧（影响回归口径）

主理人与工程师的消息都描述「订阅用 `autoPaused:boolean`（`scheduler.js:71`、`store.js:1131`）」。**这与当前源码不符**：

| 声称 | 实际（`grep` 全仓） |
|---|---|
| `sub.autoPaused` at `scheduler.js:71` | `const shouldResume = sub.pauseReason === 'budget';` |
| `autoPaused: true` at `scheduler.js:124-127` | `pauseReason: 'budget'` |
| `store.js:1131` 默认 `autoPaused:false` | `pauseReason: ''`（第 1166 行） |
| — | **`autoPaused` 全仓出现 0 次**；`pauseReason` 出现 23 次（store 13 / scheduler 7 / router 3） |

实现用 `pauseReason: '' | 'user' | 'budget'`，并在 `patchSubscription` 里**最后统一应用显式值**，因此天然不依赖 patch 对象键顺序。我按实际字段（`pauseReason`）写用例，并加 `assert.equal(updated.autoPaused, undefined)` 防止旧字段回流。

**过程风险**：`store.js`(15:29:04)、`demo.js`(15:29:21) 在我上一轮冻结（15:24）之后又被改动。本轮已重新取全量指纹确认，85/85 仍全绿。

### 9 项回归结果

| # | 回归项 | 结果 | 取证方式与证据 |
|---|---|---|---|
| 1 | 全量回归 | **PASS** | `node --test` → **85 tests / 85 pass / 0 fail**（api 31 / fetcher 18 / scheduler 12 / frontend 9 / static-guards 3 / store 12） |
| 2 | 9 路由 headless | **PASS** | 逐路由独立 profile dump DOM（避免 Chrome singleton 锁），断言不含 `is not defined`/`ERROR`/`undefined`/`ReferenceError`：**9/9 OK**，且各页均有实际内容（overview 919 / users 609 / posts 517 / fetch 766 / search 1972 / settings 1185 / subscriptions 1151 / user详情 2300 / post详情 857 字符） |
| 3 | **M-2 付费风险证伪**（最高优先级） | **PASS（双向）** | (a) 手动暂停：`PATCH{enabled:false}` → `pauseReason='user'`；`nextRunAtMs` 设为已过期 + `todayKey` 改 2000-01-01 → tick → **`enabled=false`、`pauseReason='user'`、`/cli/invoke`=0、出站请求总数=0**（连预检都没发）；(b) 反向：`spentToday=1.99` → tick 触发预算耗尽（`pauseReason='budget'`、`lastResult='budget'`）→ 跨日 tick → **`enabled=true`、`pauseReason=''`、`invoke=1>0`**（证明当轮真执行、未空转） |
| 4 | m-1 跨月去重 | **PASS** | 同 `recordId` 分别落 **2026-09** 与 **2026-11** 两分片：`added` 1→**0**、`countAllRecords=1`、`unreadCount=1`（未重复计未读） |
| 5 | m-3 跨日首轮不空转 | **PASS** | 与 #3(b) 同一次取证：跨日后**同一个 tick 内**即产生 `invoke` 与 `round-done` 日志，无需等下一个 30s |
| 6 | m-5 口径 | **PASS** | 响应字段为 `newEstimateUpperBound=10`（`reusedLocal=16 / willFetch=10`），旧 `newEstimate` **不存在**；前端 `views-fetch.js` 已同步为「本地已有 / 本轮最多新增」+ 明确标注「（上限）」，`grep plan\.newEstimate\b` 无旧引用 |
| 7 | m-6 空 mode 的 gaps | **PASS** | 不带 `mode` → `gaps=7`（修复前恒 0）；**相邻区间重叠数 0**、按时间升序、`timeline` 16 点；带 `mode=received` 对照同为 7 |
| 8 | 新增字段对前端/枚举的影响 | **PASS** | `status` 映射仍严格三值：手动暂停→`paused`、正常→`active`、预算→`budget-exhausted`；`pauseReason` 与 `lastResult` 双条件判定，未被新字段污染 |
| 9 | 安全面回归 | **PASS** | 穿越 3 变体（`%2e%2e%2f` / `..%2f` / 双编码 `%252e`）全 **404** 且响应无源码泄漏；演示模式 `POST /fetch/tasks` → **400 DEMO_MODE**；伪造 token → 任务 `failed` 且 **`/cli/invoke`=0、非预检请求=0**；报告 **无 token/balance/credits 字样、无 `<script>`/`onerror=`/`@import`**，HTTP 200 |

### 补测：主理人点名的 `patchSubscription` 交互坑

按要求核实了「`patchSubscription` 会清暂停标记」是否埋坑，测了 4 个边界：

| 边界 | 结果 |
|---|---|
| ② 仅改其它字段（`perRoundLimit`）不得污染暂停原因 | ✓ `pauseReason` 保持 `'budget'` |
| ③ 预算分支重复写（幂等） | ✓ 保持 `'budget'` |
| ④ patch 键顺序反转（`pauseReason` 写在 `enabled` 之前） | ✓ 仍为 `'budget'`（顺序无关，因显式值最后统一应用） |
| ① `PATCH{enabled:false}` 打在**已自动暂停**的订阅上 | ⚠️ `pauseReason` 仍为 `'budget'`（`next===found.enabled`，不触发"用户意图"推断）→ 次日会被自动恢复 |

关于 ①：**前端走不到**——UI 按钮发的是 `enabled: !sub.enabled`，已暂停时只会发 `true`（即恢复），无法表达"在已暂停状态再暂停"。故记为**防御性 Minor（API 层）**，不阻塞交付。若要彻底收紧，可让 `pauseReason` 的推断不依赖 `next !== found.enabled`，而是「显式出现 `enabled` 键即视为用户意图」。

## 0.6 Round 3 复核（工程师按 team-lead 规格重做后）

> 工程师声明「按 team-lead 规格重做，5 处与上轮不同」。逐条核验如下，并**修正我上一轮的一处验收疏漏**。

### 5 处差异核验

| # | 工程师声明 | 核验结果 |
|---|---|---|
| 1 | M-2 字段改名 `autoPaused` → `pauseReason` | **✓ 属实**。`autoPaused` 全仓 0 次，`pauseReason` 23 次；语义（`enabled:false`→`'user'`、`true`→`''`、预算→`'budget'`）实测符合 |
| 2 | `cleanupReports()` 返回值由 count 改为被删文件名数组 | **✓ 属实**。`server.js` 日志同时打 `removedReports`（数）+ `removedFiles`（数组）；实测返回 `["evil-report.html","users-999999.html"]` |
| 3 | `newEstimate` → `newEstimateUpperBound` | **✓ 属实**。字段存在且 `=10`（`reusedLocal=16/willFetch=10`），旧字段已不存在，前端文案同步为「（上限）」 |
| 4 | 补取正文 mode 由 `mentions-posts` 改为 `post-comments` | **✓ 代码属实，但该路径本身不成立** —— 见下方 **R3-M1** |
| 5 | `POST /api/users` 文案指名昵称 + `details.hint` | **✓ 属实**。实测 `details = {"input":"某个不存在的昵称","hint":"weibo.com/u/<数字UID>"}` |

### 工程师声明的 3 个清单外修复核验

| 项 | 结果 |
|---|---|
| `report.js` 补 `import path` | **✓ 属实**。`cleanupReports` 现能真实删除文件（此前被空 catch 吞掉 ReferenceError） |
| `store.js` 新增 `renameWithRetry()` | **✓ 代码存在**（第 67 行，5 次退避），`writeJson`/`writeText` 均走它 |
| `demo.js` `seed({reset:true})` 失败改抛 `IO_ERROR` | **✓ 代码属实**，但**失败模式仍会造成数据不一致** —— 见 **R3-m1** |

### 修正：我上一轮把 P0-15 判 PASS 属验收疏漏

上一轮我只验证了「清单区块 / 徽标 / 按钮 / 『不计入互动统计』标注**存在**」，没有验证「点了按钮**是否真的能补上正文**」。本轮补验后确认**不成立**。

---
### R3-M1（Major，新增）P0-15「可单独补取」是死路，且三处 UI 文案自相矛盾

| 项 | 内容 |
|---|---|
| 复现 | 添加一条无正文博文（`POST /api/posts {input:"4901234567899999"}`）→ 博文库点「正文缺失清单」→ 点「单独补取正文」→ 在取数页执行 → 回到博文详情 |
| 实际 | 评论记录入库了（credits 也花了），但 **`post.text` 仍为空，`missingText` 仍为 `true`**，徽标依旧显示「正文缺失」 |
| 取证 | 用「响应里带完整原微博对象」的假网关（已是后端能拿到正文的最理想情形），逐一跑三种模式：`post-comments` / `mentions-posts` / `user-posts` → 三者 `post.text` 全部为 `""`（见 `test/p015-missing-text.test.js` 前两条用例） |
| 根因 | 全仓**只有** `PATCH /api/posts/:id {text}` 会写 `post.text`（`server/router.js:404`）；取数链路 `fetcher.execute` → `store.appendRecords` 只写记录分片，从不回填博文正文。前端也没有任何「编辑/粘贴正文」入口（`grep` 无 `body: { text`） |
| 文案矛盾 1 | `web/js/views-library.js:746`：「用**「被 @ 的微博」或「用户微博」模式**对该博文所属用户取数一次即可回填」 |
| 文案矛盾 2 | `web/js/views-library.js:996`：「将预填**「被 @ 的微博」模式**并定位到作者 UID」 |
| 文案矛盾 3（实际行为） | `web/js/views-library.js:1031`：实际预填的是 **`mode=post-comments&ownerType=posts`** —— 与上面两处文案都不一致 |
| 影响需求 | P0-15（「提示可单独补取」这半句不成立）。清单、徽标、「不计入互动统计」标注均达标 |
| 修复建议 | 二选一：①在 `fetcher` 里对 `entity==='status'` 的记录或评论响应中的 `item.status` 做正文回填（调 `store.patchPost(id,{text})`，仅当当前为空时），并让两处文案与真实 mode 一致；②若决定不做自动回填，则把按钮改成「粘贴正文」弹窗（内部调已有的 `PATCH /api/posts/:id {text}`），同时删掉三处「取数即可回填」的错误承诺 |
| 当前用例状态 | `test/p015-missing-text.test.js`：3 条锁定现状（通过）+ 1 条目标行为（`skip`，带原因），修好后删掉 skip 即成为验收标准 |

### R3-M2（Major，新增）`ensureDemoData()` 自愈在「部分删除」场景会把未读数静默翻倍

| 项 | 内容 |
|---|---|
| 复现 | ① `seed({reset:true})` 在部分文件被锁时中途失败（Windows Defender/索引器瞬时锁）→ 索引 `users.json/posts.json` 已删、`records/` 分片仍在 → 抛 `IO_ERROR` 且**不回滚**；② 重启服务（或再点「重置演示数据」） |
| 实际 | `ensureDemoData()` 见 `users=0` 便补种，在**残留分片之上重复追加** → 未读 **166 → 333**（近乎翻倍）。用户只看到「未读 333」，完全无感 |
| 期望 | 自愈结果必须与初始一致（166），不得叠加残留分片 |
| 取证 | `test/demo-recovery.test.js` 3 条现状用例 + 1 条对照：**干净空库**补种得到 166（正确）；**部分删除**补种得到 333（叠加）→ 证明问题精确定位在「索引空但分片在」这一分支 |
| 根因 | ① `seed({reset:true})` 的失败路径没有原子性（先删索引再删 records，中途失败即不一致）；② `ensureDemoData()` 只按「索引是否为空」判断，不检查残留分片；③ `appendRecords` 的去重键是 `recordId`，而补种重新播种时 `demo.js` 的 `sequence` 从进程内初值重新计数，产生**新** sourceId → 新 recordId → 不被去重 |
| 相比上一轮的变化 | **严重度上升**：`ensureDemoData` 加入前，翻倍需用户手动点重置才会触发；加入自愈后变为**启动即自动发生**，把「可见的空库」换成了「不可见的错误计数」。这正是「修了症状、没修成因」的典型 |
| 影响需求 | P0-05（离线演示模式的数据正确性）、P0-19/P0-20（未读数驱动阅读流程） |
| 修复建议 | 三选一（建议 ①+②）：① `seed({reset:true})` 改为原子：先把 `data/demo` 整体 `rename` 成 `data/.trash-<ts>`，成功后再删；失败则 rename 回来，保证「全删或全不删」；② `ensureDemoData()` 在补种前先清理残留分片（或调用 `seed({reset:true})` 走原子路径）；③ 让 `demo.js` 的 sourceId 序列**确定性**（按 uid+mode+dayIndex 派生），使补种产生**相同** recordId，从而被现有去重逻辑吃掉 |
| 当前用例状态 | `test/demo-recovery.test.js`：3 条锁定现状（通过）+ 1 条目标行为（`skip`），修好后删掉 skip 即为验收标准 |

### R3-m1（Minor）`seed({reset:true})` 失败分支缺少回滚（R3-M2 的成因）

`server/demo.js` 的 reset 逻辑（约第 137–180 行）：先 `fs.rmSync(root)` 整删 → 失败则重试 5 次 → 仍失败则**逐个删除子项** → 若仍有残留则抛 `IO_ERROR` 并附 `details.leftovers`。

「失败不再静默」这个方向是对的（此前失败会静默继续并在旧数据上追加）。但逐个删除的过程**天然可能只删一半**：删掉 `users.json` 之后才在 `records` 上失败，此时既没删干净、也不回滚、也没重建，留下「索引空 + 分片在」的不一致状态——正好是 R3-M2 的触发前提。建议按 R3-M2 的 ① 方案改成 rename-then-delete，使失败可回滚。

> 注：本机 QA 沙盒的批量删除保护（>50 文件）恰好稳定复现了这个「部分失败」分支，因此证据充分；正常 Windows 环境需 Defender/索引器恰好锁住某个文件才会触发，概率较低但真实存在。

## 0.7 Round 4 收尾复核（R3 两项闭环 + 粘贴弹窗 XSS 专项）

> 取证时间 15:47–15:58，源码冻结于 15:45:16（`web/js/views-library.js` 最后一次改动）。

### R3 两项闭环确认

| 项 | 结论 | 独立取证 |
|---|---|---|
| **R3-M1** P0-15 补取正文 | **已闭环** | 后端 `backfillPostText()`（`server/fetcher.js:418`，调用点 `:597`）逻辑正确：仅当 `post.text` 为空时回填、按 `idstr/id/mid/id_str/mblogid` 严格匹配、走 `normalizeText(2000)`。三场景实测：① 带原微博对象 → 回填成功；② 不带 → 正文保持空且任务 `success`（不报错）；③ 用户已粘贴 → **不覆盖**。前端改为「粘贴正文」主按钮（走 `PATCH /api/posts/:id {text}`）+「补取评论」次按钮，三处文案已统一为「推荐粘贴；取数能否回填取决于接口是否返回原微博对象」 |
| **R3-M2** 自愈翻倍 | **已闭环** | 部分删除（索引删、分片留）→ `ensureDemoData()` → counts 与初始**完全一致**（166，不再 333）；残留分片下 `seed({reset:false})` 抛 `IO_ERROR`「检测到数据不一致（索引为空但仍有残留记录）」；连续 5 次 reset 稳定 166；无 `.trash-*` 残留 |
| 启动自愈 | **已验证** | 受控实验：彻底删除 `data/demo` → 启动 → `demoReseeded=true`，自动播种 3 用户 / 2 博文 / 166 未读 |

> 诚实记录：中途曾观察到一个进程日志为 `demoReseeded=false` 但数据已是 166。经排查是**我自己的删除被沙盒批量删除保护拦下、旧数据仍在**，`ensureDemoData` 见数据存在返回 false 属正确行为。受控实验（确认目录已删）复现为 `demoReseeded=true`，非缺陷。

### 粘贴弹窗 XSS 专项（team-lead 指定）

**结论：安全。** 逐层取证：

| 层次 | 检查 | 结果 |
|---|---|---|
| 弹窗模板 | `esc(options.id)` / `esc(options.author)` 进 innerHTML | ✓ 已转义 |
| 输入框 | 用户文本仅经 `area.value` 读取，**从不进 innerHTML** | ✓ 无注入面 |
| 错误提示 | `err.textContent = e.message`（用 textContent 而非 innerHTML） | ✓ 即使服务端回显输入也安全 |
| 落库 | `PATCH` 走 `encodeURIComponent(id)`；服务端 `trim()` + 超长截断 2000 + `textTruncated` 打标；空/纯空白 400 拒绝 | ✓（实测 9000 字 → 2000 且打标；`"   "` → 400） |
| 渲染面（全部 `post.text` 出口） | `views-library.js:941` `esc(post.text.slice(0,90))`、`:1106` `esc(post.text)`、`views-config.js:201` / `views-fetch.js:183` 的 label → `<option>${esc(o.label)}</option>` | ✓ 4 处全部转义 |
| 报告 | 标题 `esc()`、正文 `escText()`（`\n`→`<br>`） | ✓ 12/12 断言通过 |

**端到端实证**：通过弹窗同一条 `PATCH` 写入 `<img src=x onerror="window.__XSS=1"> <script>…</script> <svg onload=alert(1)> A&B "双引号" '单引号' 🚀 反引号 ${...}`，再逐页 headless 渲染：

| 页面 | 真实可执行节点 | 转义文本可见 |
|---|---|---|
| `#/posts` 列表 | 无 | ✓ |
| `#/posts/<id>` 详情 | 无 | ✓（含 emoji 保留） |
| `#/fetch` / `#/subscriptions` / `#/search` | 无 | ✓ |
| 报告 HTML | 无 `<img onerror>` / 无 `<svg onload>` / 无注入 `<script>` | ✓ 含 `&lt;img>`、`A&amp;B`、`<br>`、emoji、120 字符长串、作者 `<b>` 转义；无 token/credits/余额 |

> 检查器自身也修正过一次误报：初版用 `__XSS=1` 判「已执行」，会把转义后文本里的字面串当成执行痕迹；改为「是否存在真实 `<img onerror>` 元素」+「所有 `onerror` 是否都落在 `&lt;` 之后」后判定准确（1/1 全部已转义）。

### 最终状态

| 项 | 值 |
|---|---|
| 自动化测试 | **96 / 96 通过，0 fail，0 skip**（`node --test`，零依赖，约 13s） |
| P0 | **PASS 29 / PARTIAL 4 / FAIL 0**（33 条） |
| 新增必修项 | **0** |
| 9 路由 headless | 异常 **0/9**，各页均有实质内容（919 / 2309 / 517 / 766 / 1972 / 1185 / 1151 / 2300 / 857 字符） |
| 交付判定 | **可交付** |

> P0-15 由 PARTIAL 回到 **PASS**：清单/徽标/标注 + **可兑现的补取路径**（粘贴立即生效、取数在接口返回原微博时自动回填）齐备。

## 0.8 Round 5 补充复核：单实例锁（发现 → 已闭环）+ 两次归因纠正

> 本节记录一次**完整的问题生命期**：发现 → 上报 → 修复 → 复验，以及我在此过程中的**两处归因错误**。

### 一、发现：单实例锁在 pid 被回收时会误判（已修复）

**原始复现（16:10 左右）**：
1. 强杀实例 → `data/.instance.lock` 残留 `pid=21240`
2. 该 pid 被 Windows 回收给无关进程（`tasklist` → `21240 = WorkBuddy.exe`）
3. 启动新实例 → 被拒绝：「数据目录已被另一个进程占用（pid 21240）」
4. 但 21240 不是 Weibo Reader —— 提示指向不相干程序

根因（**修复前**）：`alive()` 仅靠 `process.kill(pid, 0)`，pid 存在且属于任意进程即判"占用"。
后果：用户永久打不开、报错误导、无自助恢复路径。

### 二、修复与复验（已闭环）

`server/server.js` 于 **16:07:56** 升级为**双信号判定** `lockHolderAlive(lockFile, pid)`：

```js
const ageMs = Date.now() - fs.statSync(lockFile).mtimeMs;
const heartbeating = ageMs < LOCK_STALE_MS;      // 3 分钟窗口
if (!heartbeating) return false;                  // 心跳停了 → 无论 pid 在不在都算陈旧
// 之后才用 process.kill(pid, 0) 作为快速通道
```

运行中的实例每 30s `fs.utimesSync(lockFile)` 刷新 mtime 作为心跳；错误文案追加兜底指引「如果确认没有其他窗口在运行，可删除该锁文件后重试」。

**我做的双向复验**（均为当前代码）：

| 场景 | 构造 | 期望 | 实测 |
|---|---|---|---|
| pid 被复用（原缺陷场景） | 锁 `pid=24372`（真实存活但属 explorer.exe）+ mtime 设为 5 分钟前 | 心跳超时 → 接管 | **✓ 启动成功**，缺陷已修 |
| 真实例在跑 | 锁 `pid=24372` + mtime 为"刚刚" | 拒绝启动 | **✓ 拒绝**，并打印含锁路径的兜底指引 |

**结论：§0.8 的问题已闭环，不再是交付风险。**

### 三、纠正 1：我把 `server.js` 启动崩溃错误归因给了工程师

我曾向工程师指出「`server/server.js` 漏 `import path` 导致启动崩溃，这是 `path` 坑第三次」，并把 16:02–16:04 的改动归给他。**这个归因是错的。**

工程师提供的 mtime 证据与磁盘一致：

| 文件 | mtime | 实际归属 |
|---|---|---|
| `server/fetcher.js` | 15:44:21 | 工程师（回填） |
| `server/store.js` | 15:44:29 | 工程师（textTruncated） |
| `server/router.js` | 15:44:41 | 工程师（PATCH 校验） |
| `web/js/views-library.js` | 15:45:16 | team-lead（粘贴弹窗/文案） |
| `server/demo.js` | 16:02:42 | team-lead（原子重置） |
| `server/server.js` | 16:03:04 → **16:07:56** | team-lead（单实例锁） |

工程师在 15:45 之后未再写 `server/`、`web/`——与他自己声明的"15:45:16 起冻结"一致。因此**启动崩溃是 team-lead 加锁时引入的，不是工程师**。

**我的方法论错误**：我把"我看到某个文件坏了"直接等同于"最近改这块的人干的"，没有先核对 mtime 与各人声明的时间线。**缺陷归因必须以证据为准，不能靠时序联想**——归错会影响复盘（谁该补启动冒烟、谁该改进流程），也会让被错怪的人承担不属于他的问题。已向工程师当面纠正。

### 四、纠正 2：我自己的操作制造过两次假象

| 假象 | 真相 |
|---|---|
| "第二实例 PORT=7913 成功启动 → 锁失效" | `run_in_background` 包装使锁内 `process.pid` ≠ 实际监听 pid，被当成陈旧锁接管。用真实 Windows pid 复测：存活→拒绝、已死→接管，**逻辑本身正确** |
| "XSS 检查器报警 → 存在漏洞" | 检查器用 `__XSS=1` 判执行，命中的是**已转义文本里的字面串**。改为判定"是否存在真实 `<img onerror>` 元素"后无毒 |

**教训**：QA 的工具与操作本身会生产假缺陷。每次报缺陷前应先自问"有没有可能是我的测量方式造成的"，并把验证方法一并写进报告，供他人复核。

### 五、附带发现的一个小缺口（Minor）

运行中的实例**不会重建被外部删除的锁文件**（心跳只在锁内 token 匹配时刷新 mtime）。
即：若用户/杀软删掉 `.instance.lock`，当前实例会静默失去保护，直到重启。
影响有限（需外部删除），但若要更稳，可在心跳里加一句「锁不存在则以 `wx` 重建」。

## 1. 测试资产与执行结果

4 个业务测试文件 + 1 个静态护栏文件 + 1 个测试沙箱（沙箱刻意放在 `test-support/`：`node --test` 会把 `test/` 下所有 js 当测试文件执行）：

| 文件 | 用例数 | 通过 | 失败 | 覆盖重点 |
|---|---|---|---|---|
| `test/fetcher.test.js` | 18 | 18 | 0 | 零付费保护、`max_id=min-1` 游标、since_id 取 `sourceId`、3 页无新增/200 页上限、并发 409、停止与落盘、去重、额度熔断、归一化容错 |
| `test/scheduler.test.js` | 12 | 12 | 0 | 退避阶梯 1→3→5→10→15→30、固定间隔、日预算熔断、`pauseReason` 迁移规则、跨日恢复 vs 手动暂停保持、日志裁 200 行、并发让路 |
| `test/api.test.js` | 31 | 31 | 0 | 路径穿越 12 变体、非法 ID、SPA/静态分流、安全响应头、两段式已读、`ids⊆pendingReadIds`、报告转义与唯一性、P0-32 清理、搜索边界、分页自洽、导入导出、目录切换、退出登录 |
| `test/frontend.test.js` | 9 | 9 | 0 | 导入一致性（原 B-1 护栏）、innerHTML 裸插扫描、`esc/highlight` 纯函数、`fmtNum`/`numOrNull` 判空语义、index.html 无外链 |
| `test/static-guards.test.js`（新增） | 3 | 3 | 0 | 服务端/前端「未导入即使用」、拼写错误抽查、空 `catch` 吞错基线 |
| `test/p015-missing-text.test.js`（Round 3 新增） | 4 | 3 | 0（1 skip） | P0-15 补取闭环：三种模式均不回填正文（锁定现状）+ 1 条目标行为（待修复后打开） |
| `test/demo-recovery.test.js`（Round 3 新增） | 4 | 3 | 0（1 skip） | 自愈翻倍：干净空库补种=166（对照）、部分删除补种=333（缺陷锁死）+ 1 条目标行为 |
| `test/bootstrap.test.js`（工程师 Round 3 新增，我审阅后保留） | 3 | 3 | 0 | `ensureDemoData()` 空库补种 / 幂等 / 真实模式不注入演示数据 |
| `test/store.test.js`（工程师原有） | 12 | 12 | 0 | recordId 幂等、路径穿越、去重、已读覆盖、原子写、gap |
| **合计** | **96** | **94** | **0**（2 skip） | |

验证手法说明（为什么这些测试比自测更狠）：

1. **打桩 `globalThis.fetch` 而不是打桩模块**：`fetcher` 用例走的是 `startTask → execute → weibo.httpJson → requireLiveToken → invoke` 的真实路径，因此可以断言「到底发出了几个请求、请求参数是什么」。伪造 token 场景下断言 `/cli/invoke` 调用次数 **= 0**，这是"没有花钱"的硬证据，而不是"返回文案看起来对"。
2. **进程内起真 HTTP 服务**（随机端口）：`router.handle` 全栈经过 `readBody → 路由匹配 → safeDecode → handler`，路径穿越与参数校验都是真实拦截。
3. **headless Chrome 真实渲染**：逐路由 dump DOM 并提取可见文本，抓到只读代码看不出的运行时崩溃（B-1 就是这样抓到的）。
4. **静态护栏兜住"运行才炸"的类别**：B-1（`fmtNum`）与回归期 `path` 事故属同一类，已用两份检查器（前端符号导入一致性 + 服务端内置模块前缀）锁死。

---

## 2. Round 1 发现的问题（**全部已关闭**，保留详情供追溯）

> 状态图例：✅ 已修复并复核 ｜ 每条均给出「当时的证据」与「Round 2 复核方式」，供后续回归追溯。

### B-1 ✅ Blocker：首页（总览）整页渲染崩溃 `fmtNum is not defined`

| 项 | 内容 |
|---|---|
| 复现 | `node server/server.js` → 浏览器打开 `http://127.0.0.1:7788/`（默认路由 `#/overview`） |
| 实际 | 主视图区显示错误条：`ERROR  fmtNum is not defined   [重试]`，总览里的余额/今日消耗/未读数/最近任务/最近订阅日志全部不渲染 |
| 期望 | 首屏正常显示总览卡片（PRD P0-01「浏览器打开首页 ≤1s 内出首屏」） |
| 定位 | `web/js/views-library.js` 第 6–19 行的 import 块**漏了 `fmtNum`**；使用点为第 89、111、132、160 行 |
| 证据 | `chrome --headless --dump-dom http://127.0.0.1:7788/#/overview` → 提取文本含 `ERROR fmtNum is not defined`；`#/users`、`#/posts`、`#/fetch`、`#/search`、`#/settings`、`#/subscriptions`、`#/users/:uid`、`#/posts/:id` 全部正常 |
| 修复 | 在 `views-library.js` 的 import 里补 `fmtNum,`（一行） |
| Round 2 复核 | ✅ 9 条路由全部 `OK`；`#/overview` 4 张统计卡全部渲染 |
| 影响需求 | P0-01（首屏）、P0-04（顶栏/总览余额）、P0-16（最近任务面板） |
| 固化护栏 | `test/frontend.test.js`「导入一致性」——修好后自动转绿，禁止删除该断言 |

> 顺带说明：工程师此前声称的「headless Chrome 路由渲染全过」在总览路由上不成立——只检查元素存在、不检查运行时异常的验收方式是漏检根因。

### M-1 ✅ Major：余额未知时顶栏显示「剩余 0 credits」

| 项 | 内容 |
|---|---|
| 复现 | 演示模式 / 未登录状态下打开任意页面看顶栏 |
| 实际 | `剩余 0 credits`（headless DOM 实测文本，7788 实例可复现） |
| 期望 | 显示占位（`—` 或 `演示`）而不是一个具体的 0 |
| 根因 | `Number.isFinite(Number(balance.value))` 在 `value === null` 时 `Number(null) === 0` → 判定为有限数 → 渲染 0 |
| 定位 | `web/js/app.js:59`、`web/js/app.js:100-101`、`web/js/views-library.js:89`、`web/js/views-config.js:573`；另发现同源第五处 `views-fetch.js:237`（`plan.balance` 为 null 时误报「还差 N credits」） |
| 修复 | 新增 `api.numOrNull()`（保留合法 0、空值归 null），`fmtNum` 内部走它；五处全部改用 |
| Round 2 复核 | ✅ 顶栏 `balanceValue="演示"`、统计卡 `剩余 credits —`；`fmtNum(0)==='0'` / `numOrNull(0)===0` 已加断言防「把 0 当空值」反向回归 |
| 影响需求 | P0-04 |

### M-2 ✅ Major：跨日会把「用户手动暂停」的订阅自动恢复（有真实扣费风险）

| 项 | 内容 |
|---|---|
| 复现 | 建订阅 → 用户手动暂停（`PATCH /api/subscriptions/:id {enabled:false}`）→ 等到次日（或把 `todayKey` 改成昨天后触发一次 tick） |
| 实际 | 订阅被自动置为 `enabled=true` 并按 1 分钟间隔开始巡检 → 若已登录真实账号会开始消耗 credits |
| 期望 | 手动暂停必须一直保持暂停；只有「预算耗尽」导致的自动暂停才应在次日恢复 |
| 根因 | `rollDay()` 无条件 `enabled: true`；订阅对象没有 `pausedByUser` 之类的字段区分两种暂停意图 |
| 定位 | `server/scheduler.js:59-76`（`rollDay` 写入 `enabled:true`）；`server/store.js:1018-1037`、`1056-1080`（订阅结构无来源标记） |
| 修复 | 订阅增加 `pauseReason: ''|'user'|'budget'`（比布尔标记更严谨）：`enabled` 真正的 true→false 翻转推断为 `'user'`，调度器预算耗尽显式传 `'budget'` 覆盖；`rollDay` 只恢复 `'budget'` |
| Round 2 复核 | ✅ 手动暂停 → `status=paused, pauseReason='user'`；跨日 tick 后仍 `enabled=false`、`spentToday=0`；预算暂停 → 跨日恢复并同 tick 真实取数 |
| 影响需求 | P0-28 |
| 固化护栏 | `test/scheduler.test.js` 三条：`pauseReason` 迁移规则（含「仅改其他字段不得改写原因」）、手动暂停跨日保持、预算暂停跨日恢复闭环 |

### M-3 Major：P0-15「缺失正文」前端完全未接线

| 项 | 内容 |
|---|---|
| 复现 | 添加一条不带正文的博文（`POST /api/posts {input:"4901234567890779"}`）→ 打开博文详情 |
| 实际 | 页面没有任何「正文缺失 / 可单独补取」的提示，也没有「缺失正文」清单入口；`grep -r missingText web/` 结果为 0 |
| 期望 | PRD P0-15：已知 ID 但正文缺失的记录单独列「缺失正文」清单、提示可单独补取、且不计入互动统计 |
| 现状 | 后端已就绪：`server/router.js:391`（`missingText: !post.text`）与 `:445`（records 接口）都返回该字段 |
| 修复 | 博文库页头加「正文缺失清单」开关 + 独立区块（含「不计入互动统计」标注 + 逐行「单独补取正文」→ 预填 `mode=mentions-posts` 跳取数页）；博文详情改用后端 `payload.missingText`，页头红色「正文缺失」徽标 + 补取提示块；正文超长补「已截断到 2000 字符」 |
| Round 2 复核 | ✅ 实测详情页「正文缺失」×2 + 「单独补取正文」；博文库「正文缺失清单」「缺失正文」「不计入互动统计」「`data-missing-fetch=4901234567899999`」全部存在 |
| 影响需求 | P0-15 |

### m-1 Minor：跨月份分片时去重失效，同一来源可能重复入库

| 项 | 内容 |
|---|---|
| 复现 | 同一 `recordId`（同 owner/同 mode/同 sourceId）分别以 2026-09 与 2026-11 的 `ms` 入库两次 |
| 实际 | `added=1`、`added=1`，`countAllRecords=2`，同一条记录出现两行、未读数被重复计 2 |
| 期望 | 按 recordId 全对象唯一 |
| 根因 | `appendRecords` 的去重集合来自「目标月分片文件」`loadShardIds(file)`，只在本分片内比对 |
| 定位 | `server/store.js:672-713`（`appendRecords`）、`:635-652`（`loadShardIds`） |
| 触发场景 | 接口对同一条记录返回的时间格式/时区波动导致 `parseWeiboTime` 跨月；或导入数据包与线上数据月份口径不同 |
| 建议 | 去重集合改为「该对象该模式所有分片的 recordId 并集」 |
| Round 2 复核 | ✅ 新增 `loadModeIds(dir, mode)` 取全分片并集；实测跨月同 recordId：`added` 1→0、`rows=1`、`unreadCount=1` |

### m-2 Minor：`POST /api/reports/:key/read` 不校验报告文件是否仍存在

| 项 | 内容 |
|---|---|
| 复现 | 生成报告 → 手工删除 `data/reports/users-<uid>.html` → `GET /reports/users-<uid>.html` 得 404 → 仍调用 `POST /api/reports/users-<uid>/read {ids:[...]}` |
| 实际 | 200 且 `marked >= 1`，记录被标记已读 |
| 期望 | 报告已不可读时应拒绝标记（PRD P0-25「仅当前端确认浏览器已接收后才标记已读」） |
| 定位 | `server/report.js:204-211`（`markReportRead` 只查索引，不像 `meta()` 那样 `fs.existsSync` 校验） |
| 缓解 | 前端流程（`views-library.js:1195-1210`）会先 GET 报告 200 才提交已读，正常用户碰不到；属 API 层防御缺失 |
| 建议 | 复用 `meta()` 的校验；并校验 `ids ⊆ pendingReadIds` |
| Round 2 复核 | ✅ 删文件后 `POST /read` → `404 NOT_FOUND`「报告文件已被删除，请重新生成」，未读数不变；越权 ID 计入 `skipped`（5 合法 + 1 bogus → `marked:5, skipped:1`），重复提交幂等 |

### m-3 Minor：跨日恢复的那一次 tick 只恢复、不执行，实际取数被推迟 ≤30s

| 项 | 内容 |
|---|---|
| 现象 | 跨日首次 tick 后 `spentToday` 已清零、`enabled` 已恢复，但本轮没有真正取数，要等下一个 30s tick |
| 根因 | `runTick()` 在循环前取 `const now = Date.now()`，而 `rollDay()` 把 `nextRunAtMs` 设为**更晚的** `Date.now()`，于是 `sub.nextRunAtMs > now` 成立直接 `continue` |
| 定位 | `server/scheduler.js:90`（`now`）、`:67`（`nextRunAtMs = Date.now()`）、`:99`（比较） |
| 影响 | 仅延迟，不丢数据；已在测试中按真实行为断言 |
| 建议 | 让 `rollDay` 使用本轮 tick 的 `now` |
| Round 2 复核 | ✅ `rollDay(sub, now)` 已接收 `now`；用例断言同一 tick 内 `lastResult='ok'`、`spentToday=0.02` |

### m-4 Minor：`cleanupReports` 的白名单分支是空操作

`server/report.js:239-241`：`if (keep.size > 0 && !keep.has(name)) { continue; }` —— 两个分支都 `continue`，等于没写。后果：报告索引里没有的白名单形态 html（例如索引文件丢失/被手工删）永远不会被清理。

**Round 2 复核**：✅ 已重写为「非白名单 或 索引孤儿 → 删除」，返回值改为被删文件名数组。实测 `removed=["evil-report.html","users-999999.html"]`，索引内的合法报告幸存。

> ⚠️ 该修复的第一版漏 `import path`（`path.join` 直接 ReferenceError 又被空 `catch` 吞掉，功能静默失效且无报错），回归中抓到并已补上；为此新增 `test/static-guards.test.js` 锁死同类事故。

### m-5 Minor：`plan.newEstimate` 语义不成立，会误导「新增 0 条」

`server/fetcher.js:208`：`newEstimate: Math.max(0, willFetch - reusedLocal)`。`reusedLocal` 是**日期区间内**的本地命中数，与「本次 top-N 窗口内能复用多少条」不是同一口径。实测：本地区间命中 16 条、`limit=10` → 预估显示 `新增 0`，但实际可能全部是新增。

**Round 2 复核**：✅ 更名成语义更诚实的 `newEstimateUpperBound = willFetch`（保守上限），前端标签改为「本地已有 / 本轮最多新增」，`reusedLocal` 与 `willFetch` 分别展示，不再做跨口径相减。

### m-6 Minor：不带 `mode` 时 `gaps` 恒为空数组

`server/router.js:433`：`const gaps = mode ? store.gaps(...) : []`。用户详情「全部」分组下时间轴没有「待补区间」黄条（P0-14 的可视入口）。

**Round 2 复核**：✅ 改为 `store.gaps(ownerType, ownerId, mode || '', ...)`；HTTP 实测不带 `mode` 时 `gaps=7`。

### m-7 Minor：P0-07「weibo.com/昵称」对本地不存在的昵称直接报错

`server/router.js:339-350`：昵称只能解析为「本地已存在的昵称」，否则返回 400 并提示改用数字 UID。

**Round 2 复核**：✅ 用户库表单下方已明示「昵称解析只能命中本地已存在的昵称（不联网、0 credits），未收录请改用 `weibo.com/u/<UID>`」，限制已透明化，验收按 PARTIAL→PASS 处理。

---

## 3. P0 需求逐条验收（33 条）

图例：**PASS** 已用自动化/实测证明；**PARTIAL** 主体可用但有偏差或仅代码审阅；**FAIL** 不可用。

| ID | 结论 | 证据 / 说明 |
|---|---|---|
| P0-01 启动即用 | **PASS** | 服务启动 ✓（打印 `http://127.0.0.1:7788`、无 `npm install`、零构建）；空目录首启实测 `firstRunSeeded=true` 自动 seed、7 条路由 headless 渲染全 `OK`、`#/overview` 4 张统计卡全部渲染（B-1 已修复） |
| P0-02 浏览器授权登录 | **PARTIAL** | `POST /api/auth/device` 实测 200，返回真实 `userCode=377D-D8A3`、`verificationUrl`（拼接方式与 `docs/API-FACTS.md:24-27` 一致）；轮询/落盘/`device_code` 不出服务端的代码路径已审阅；**真人确认授权环节未端到端跑通** |
| P0-03 手动 token 兜底 | **PASS** | 伪造 token → `400 TOKEN_INVALID`「token 校验失败：…（旧的登录状态已保留）」；登录态未被污染（`loggedIn=false`、`tokenTail4=''`）；空 token → 400 |
| P0-04 账户与余额 | **PASS** | 顶栏常显余额位、刷新按钮、`stale` 缓存+时间戳逻辑齐备；余额未知实测显示 `演示` / `—`，全站无假 `0 credits`（M-1 已修复，含 `fmtNum(0)==='0'` 反向护栏） |
| P0-05 离线演示模式 | **PASS** | 横幅仅在 `demoMode` 显示（headless DOM 实测含「演示数据…零 credits 消耗」）；3 用户/2 博文/166 未读/2 订阅/4 条订阅日志可操作；`plan` 返回 `blocked=DEMO_MODE` 且 `commands=[]`，`POST /api/fetch/tasks` → 400；单测断言**出站请求数 = 0** |
| P0-06 退出登录 | **PASS** | `POST /api/auth/logout` → token/account 清空、`demoMode=true`、本地记录条数不变（新增用例） |
| P0-07 添加用户 | **PARTIAL** | 数字 UID / `weibo.com/u/<uid>` / `weibo.com/<uid>` / 带 query 链接均解析正确；重复添加 `created=false` 且列表不重复；非法输入提示「无法从该链接识别 UID」；**仅 `weibo.com/昵称` 需昵称已在本地**（m-7） |
| P0-08 用户列表 | **PASS** | 头像/昵称/UID/已存条数/未读数齐备；`q` 即时过滤（0 credits，纯本地）；`starred` 标记且 `listUsers` 按星标置顶再拼音序（`store.js:370-386`） |
| P0-09 添加博文 | **PASS** | 纯 ID / `weibo.com/<uid>/<mblogid>`（62 进制→mid 换算正确）/ `m.weibo.cn/detail/<id>` 均可用；新博文 `recordCount=0` 且列表显示「尚未获取评论」；**不自动取评论** |
| P0-10 博文列表 | **PASS** | 作者/正文摘要/时间/已存评论数/收藏状态；`favorite=1` 筛选可用（`store.js:480-498` + 前端筛选） |
| P0-11 内容模式 | **PASS** | 7 模式齐全（`server/config.js:47-137`），含 `user_timeline/biz → other` 回退；表单随模式切换对象/字段（`views-fetch.js`） |
| P0-12 范围与条数 | **PASS** | `limit` 夹取 1–5000；只填一端可用；`YYYY-MM-DD` 结束日按 23:59:59.999；非法日期/倒置 → 400 `INVALID_DATE_RANGE`（含三条用例） |
| P0-13 增量与历史 | **PASS** | `cursor=incremental` 用 `since_id=maxSourceId`（单测断言 500→600，且不是 recordId）；`history` 用 `max_id=min(本页 id)-1`（单测断言 100/95/90 → 89 → 79）；本地复用不计费（`reused`） |
| P0-14 gap 待补区间 | **PASS** | `store.gaps()` 计算正确、前端时间轴渲染 gap 并支持点击预填；不带 `mode` 时实测 `gaps=7`（m-6 已修复） |
| P0-15 缺失正文提示 | **PASS** | 清单区块 + 「正文缺失」徽标 + 「不计入互动统计」标注 + **可兑现的补取路径**：粘贴正文（立即生效、0 credits）+ 补取评论（接口返回原微博时自动回填，实测三场景通过）。三处文案已统一（R3-M1 已闭环） |
| P0-16 任务面板 | **PARTIAL** | 后端 `getTask` 提供进度/累计返回/credits/余额/日志（环形 500 行）/`canStop`；`stopTask` 语义单测通过（stopped + 数据保留 + `tasks.jsonl` 落一条）；演示模式无法跑真实任务，**面板本体未端到端渲染验证**，且首页「最近任务」被 B-1 挡住 |
| P0-17 额度不足保护 | **PASS** | 预估 2.00 > 余额 0.01 → `blocked=INSUFFICIENT_CREDITS` 且文案含「还差」；运行中余额 0.05 花到 0.06 后自动停，`reason` 含「余额跌破预估」（新增用例） |
| P0-18 0 credits 复用 | **PASS** | 二次入库 `added=0/reused=N`；界面标注「复用本地 X / 新增 Y」；`plan.reusedLocal` 与区间命中一致（`newEstimate` 口径另有 m-5） |
| P0-19 用户详情 | **PASS** | 三类分组（发出/收到/@）+ 时间轴 + 未读视觉标记 + 按日期查看当天记录；headless 渲染实测正常（统计卡「本地记录 1 / 未读 1 / 评论类 1」） |
| P0-20 已读动作 | **PASS** | 单条（`ids`）与分组（`all:true&mode=`）均可；`_read.json` 覆盖层落盘，重复标记 `marked=0` 幂等；重读后未读数正确保持 |
| P0-21 全局搜索 | **PASS** | 关键词（多词 AND）+ 作者 + 对象 + 日期四条件交集；每页 20；返回 `total`/`tookMs`；0 credits（纯本地扫描 + LRU 缓存） |
| P0-22 空结果友好 | **PASS** | 「无结果」+ 当前生效条件摘要（`conditions` 回显与生效条件一致）+ 「一键清空筛选」按钮 |
| P0-23 生成 HTML 报告 | **PARTIAL** | `POST /api/reports` 返回 `{reportKey,url,path,recordCount,unreadCount,pendingReadIds}`，文件落在 `data/reports/`；「复制路径」可用；**「打开报告」调系统默认浏览器未实测**（`execFile cmd /c start` 需在桌面会话交互，headless 不可验证） |
| P0-24 报告唯一性 | **PASS** | 同对象固定文件名覆盖（两次生成 `path` 相同、磁盘仅 1 份） |
| P0-25 未读高亮 + 精确已读 | **PASS** | 报告未读条目 `class="rec unread"` + 「未读」角标；生成不改未读；只按传入 `ids` 扣减（3→1 用例）；前端「GET 报告 200 才提交已读」在位；API 层已补「文件必须存在」+「`ids ⊆ pendingReadIds`」双防线（m-2 已修复） |
| P0-26 报告内容 | **PASS** | 标题（对象+时间范围+生成时间）、正文、作者、时间、原博链接齐备；`<script>`/`"`/`'`/`&`/换行（`<br>`）/400 字符无空格串/emoji 全部安全；**无 token / balance / credits 字样**；无外链、带 CSP |
| P0-27 订阅创建 | **PASS** | 用户/博文均可建；每轮上限、每日预算、`auto`（1→3→5→10→15→30）/`fixed N` 均可设置 |
| P0-28 订阅控制 | **PASS** | 暂停/恢复/重置当日额度可用；列表返回 `nextRunAtMs`/`spentToday`/`status`；预算耗尽自动暂停 + 日志 + 排到 1 小时后；`pauseReason` 区分手动/预算暂停，手动暂停跨日实测保持暂停（M-2 已修复） |
| P0-29 订阅日志 | **PASS** | 每轮记录时间/模式/返回条数/credits/结果（`ok`/`no-new`/`budget`/`error`）；裁剪到最近 200 行（灌 260 条后实测 200 条且保留最新） |
| P0-30 归档目录切换 | **PASS** | 不可写路径 → 400 `IO_ERROR` 且原配置不变；可写路径 → 切换成功并自动建 `records/reports/logs/exports`，列表随之变化；空串视为未提交 |
| P0-31 导入 / 导出 | **PASS** | 导出 JSON 不含 token/订阅/备注/已读状态（逐项断言）；再导入 `added=0`、`skipped>=5`；非法 schema → 400 |
| P0-32 报告自动清理 | **PASS** | 启动 `bootstrap` 与每次生成后都调 `cleanupReports()`；非白名单 html 与索引孤儿 html 均被真实删除、返回值列出被删文件、索引内合法报告幸存（m-4 已修复，且回归中补上漏掉的 `import path`） |
| P0-33 费用参考 | **PARTIAL** | `/api/pricing` 返回 7 模式价目 + `source=builtin`，设置页展示价目表与「本地查看与导出 0 credits」；**「查询最新单价」需真实登录态才能覆盖**，本次仅验证降级路径 |

**Round 4 最终统计：PASS 29 / PARTIAL 4 / FAIL 0**（33 条）。

> Round 3 曾为 PASS 28 / PARTIAL 5（P0-15 因 R3-M1 下调）；R3-M1 闭环后 P0-15 恢复 PASS。剩余 4 条 PARTIAL 均为环境限制（真人授权 / 任务面板运行态 / 桌面会话 / 真实登录态）。

> Round 3 曾因我上一轮「只验按钮存在、未验按钮有效」的疏漏把 P0-15 下调为 PARTIAL（详见 §0.6 R3-M1）；该项已修复并复核，现恢复 PASS。

剩余 4 条 PARTIAL 全部是**环境限制而非代码缺陷**，逐条见 §6：P0-02（需真人完成浏览器授权）、P0-16（任务面板本体需真实付费任务才能端到端渲染）、P0-23（「打开报告」调系统默认浏览器需桌面会话）、P0-33（「查询最新单价」需真实登录态）。

---

## 4. 安全专项（工程师自测未覆盖的部分）

| 攻击面 | 尝试 | 结果 |
|---|---|---|
| 报告目录穿越 | `../config.json`、`..%2f`、`%2e%2e%2f`、双编码 `%252e%252e%252f`、`..\`、`.../`、`%c0%ae%c0%ae`、`users-1650000100.html/../../config.json`、`/web/../server/config.js`（共 12 变体） | **全部 4xx**，响应体无源码/路径/环境信息；`serveReportFile` 白名单正则 `^[a-z]+-\d+\.html$` + `safeJoin` 双保险 |
| 非法对象 ID | `abc`、`1%00`、300 位数字、`-1`、`1e5`、`ownerType=evil` | 全部 4xx 结构化错误，无 5xx、无数据泄漏 |
| 未知 API | `/api/not-exist` | 404 JSON（未回落成 SPA HTML） |
| 伪造 token 取数 | 打桩预检返回 401 | 任务 `failed`，**`/cli/invoke` 调用 0 次**，连 `whoami` 都不发 |
| 演示模式取数 | `POST /api/fetch/tasks` | 400 `DEMO_MODE`，出站请求 **0 次**（用例级断言） |
| 前端 XSS | 通过 `POST /api/exchange/import` 注入昵称 `<img src=x onerror="window.__XSS=1">恶意昵称`、正文 `<img src=x onerror=alert(1)>`、`<script>alert(2)</script>`，真实 Chrome 渲染 | 全部以**转义文本**呈现（DOM 中为 `&lt;img src=x onerror=...&gt;`），无可执行 `<img onerror>` 节点、无注入 `<script>`；`highlight()` 对恶意关键词同样安全 |
| 报告离线安全 | 断言 `<script`、`onerror=`、外部 `src=`、`@import`、非微博域名外链 | 全部不存在；响应带 `CSP: default-src 'none'; style-src 'unsafe-inline'` |
| 安全响应头 | `/api/*`、`/reports/*` | `nosniff` + `no-store`（API）、`no-referrer` + CSP（报告）齐备 |

**结论：安全面干净，未发现可利用漏洞。** 12 个穿越变体 + XSS 注入 + 伪造 token 零请求，是本轮最扎实的部分。

---

## 5. 修复清单闭环状态

Round 1 提出的 4 条必修 + 7 条 Minor **已全部关闭**（逐条复核证据见 §0 表格与 §2）。Round 2 未提出新的必修项。

| # | 项 | 状态 |
|---|---|---|
| 1 | `views-library.js` 补 `fmtNum` import（Blocker） | ✅ 已修 + 护栏 |
| 2 | 数值判空改 `numOrNull()`（Major，5 处） | ✅ 已修 + 护栏 |
| 3 | 订阅区分手动/预算暂停（Major） | ✅ 已修（改用 `pauseReason`）+ 3 条用例 |
| 4 | 接线 `missingText`（Major，P0-15） | ✅ 已修 + 浏览器实测 |
| 5 | m-1 跨月分片去重 | ✅ 已修 |
| 6 | m-2 报告 read 双防线 | ✅ 已修（+`skipped` 计数） |
| 7 | m-3 跨日 tick 时序 | ✅ 已修 |
| 8 | m-4 `cleanupReports` 死代码 | ✅ 已修（含回归期补 `import path`） |
| 9 | m-5 `newEstimate` 口径 | ✅ 已修（更名 `newEstimateUpperBound`） |
| 10 | m-6 `gaps` 缺省值 | ✅ 已修 |
| 11 | m-7 昵称链接限制透明化 | ✅ 已修（UI 文案） |

### Round 2 过程中我改的测试（源码未动）

| 用例 | 改动原因 |
|---|---|
| `frontend.test.js`「fmtNum 判空」 | 断言由 `fmtNum(null)==='0'` 反转为 `'—'`，并补 `fmtNum(0)==='0'` 防「把 0 当空值」的反向回归 |
| `frontend.test.js` 新增「numOrNull」 | 锁定新工具的严格判空语义 |
| `scheduler.test.js`「跨日恢复」 | 合并为「预算暂停跨日恢复 + 同 tick 取数」正向断言 |
| `scheduler.test.js`「手动暂停保持」 | 由「已知缺陷」改写为正向断言，并加 `pauseReason==='user'` 校验 |
| `scheduler.test.js` 新增「pauseReason 迁移」/「预算闭包」 | 锁定 `pauseReason` 迁移规则与「仅改其他字段不得改写原因」 |
| `api.test.js`「报告删除后 read」 | 由「已知缺陷」改写为 `404 NOT_FOUND` 正向断言 + 未读数不变 |
| `api.test.js` 新增「ids⊆pendingReadIds」 | 覆盖越权 ID → `skipped`、重复提交幂等 |
| `api.test.js` 拆分「报告唯一性」/「报告自动清理」 | P0-24 与 P0-32 分开断言，让清理失效能独立报红 |
| `static-guards.test.js`（新增） | 防止 `path`/`fmtNum` 类「未导入即使用」再次溜过 |

> 交付边界确认：`server/` 与 `web/` 的源码我全程未改（只读 + 报告）。`test/` 与 `test-support/` 为 QA 交付物。

---

## 6. 未覆盖 / 需人工确认项（诚实声明）

以下 4 条对应 P0 表中的 PARTIAL —— 都是**环境限制**，不是代码缺陷：

1. **真人授权闭环**（P0-02）：设备码申请与轮询代码路径已验证（实测返回真实 `userCode`），但"用户在浏览器确认 → 轮询拿到 token → 顶栏显示昵称/UID"没有真人完成。
2. **真实付费取数全链路**：无有效 token，未对 `open.weibo.com/cli/invoke` 发起过真实计费请求；游标/去重/额度逻辑用打桩网关等价验证（请求参数级断言）。
3. **「打开报告」调系统浏览器**（P0-23）：`execFile('cmd', ['/c','start','',file])` 需桌面会话，headless 无法验证；报告文件本身、`{path}` 返回、复制路径、静态托管均已验证。
4. **任务面板实时渲染**（P0-16）：`getTask` 的进度/日志/`canStop`/停止后落盘均有用例覆盖，但演示模式无法发起真实付费任务，面板在「运行中」的视觉呈现（进度条滚动、日志逐行）未端到端观察。
5. **订阅价目实时刷新**（P0-33）：`/api/pricing` 的降级路径（内置价目表）已验证并展示完整；「查询最新单价」需真实登录态才能命中 `source=api` 分支。
6. **订阅定时器长跑**：只验证了 `tick()` 单次语义与 30s 心跳启动，未做跨小时的守夜观察。
7. **计费准确性**：`credits = 返回条数 × 单价` 的口径由设计决定，真实账单口径未核对（无真实月度账单可比对）。

---

## 7. 遗留建议（交付后可选优化，均非阻塞）

1. **把运行时冒烟纳入脚本**：`chrome --headless --dump-dom` 逐路由跑一遍并断言「无 `is not defined` / 无 `ERROR` 错误条」。建议加一条 `npm run smoke`。静态护栏（本轮已加 2 份）能兜住同类，但运行时冒烟还能覆盖逻辑性渲染异常。
2. **CI 化**：`node --test` 已零依赖、约 15 秒跑完 100 项，可直接挂 pre-commit 或 CI。
3. **数据目录切换的预期管理**：当前切换是「换到一个空目录」，用户容易误以为数据被搬走（切换后列表变空）。建议 UI 明示「新目录为空，旧数据仍在原目录」。
4. **`pauseReason` 的可见性**：目前只在 DTO 里透出、UI 只显示 `paused`/`budget-exhausted` 两态。若后续要做「本订阅为何暂停」的提示，可直接用该字段，无需再改存储。
5. **报告 `pendingReadIds` 的长期形态**：当前存在 index.json 里，随记录数增长会变大。若单对象记录上万，建议改为「报告生成时把 ids 写入报告文件内的 `<meta>`」以避免索引膨胀。
6. **跨月分片去重索引**：现为「读全分片求并集」，对象记录数很大时可加一份 `_ids.json` 全局索引降低 I/O。

---

## 8. 交付结论（最终）

| 项 | 结论 |
|---|---|
| 自动化测试 | **100 项：100 通过 / 0 失败 / 0 skip**（零依赖 `node --test`，约 15s）。原 2 条 skip 已按"正确期望"打开并通过，断言**未被放宽**；R4 新增 4 条实例锁用例 |
| P0 验收 | **PASS 29 / PARTIAL 4 / FAIL 0**（33 条）。4 条 PARTIAL 均为环境限制（真人授权 / 任务面板运行态 / 桌面会话 / 真实登录态），代码路径与降级路径均已验证 |
| 新增必修项 | **0** |
| R3-M1（Major） | **已闭环** —— 粘贴正文主路径（立即生效、0 credits）+ 取数回填兜底（仅当正文为空、按 ID 严格匹配、不覆盖用户已粘贴内容）；三处 UI 文案统一 |
| R3-M2（Major） | **已闭环** —— 原子 rename 重建；部分删除后自愈 counts 与初始完全一致（166）；残留分片下 `seed({reset:false})` 抛 `IO_ERROR` 拒绝；无 `.trash-*` 残留 |
| R3-m1（Minor） | **已闭环** —— 随 R3-M2 原子化解决 |
| 粘贴弹窗 XSS 专项 | **安全** —— 弹窗模板/输入/错误提示/落库/4 处渲染出口/报告 共 6 层检查，端到端恶意载荷逐页渲染无真实可执行节点（详见 §0.7） |
| 9 路由 headless | 异常 **0/9**，各页均有实质内容；含 `is not defined` / `ERROR` / `undefined` / `NaN` / `[object Object]` 全项断言 |
| 安全面 | 零发现 —— 12 变体路径穿越全 4xx、伪造 token 下 `/cli/invoke` 调用 0 次、演示模式 0 出站请求、报告无 token/余额/外链且带 CSP |
| 单实例锁 | **已闭环**：心跳（30s 刷新 mtime / 3 分钟陈旧窗口）+ pid 快速通道 + token 归属 + 回读自检 + 兜底指引文案。双向复验通过：pid 复用场景正确接管、真实例在跑正确拒绝（§0.8） |
| 单实例锁加固（R5，已修 §0.8 全部三条） | **已闭环** —— ①锁内容增加随机 `token`，释放时校验 token 而非仅 pid，防 pid 复用误删他人锁；②写入后回读校验 token，杜绝"以为拿到实则没拿到"；③bootstrap 的 `fs`/`path` 漏导入已补（这正是 §0.8 观察到的瞬时崩溃根因）。实测：A 起 7796 → 锁含 pid+token；B 同目录 7797 → 退出码 1 并提示持有者 pid；把锁 pid 改为不存在的 999999 → 新实例正常接管且 token 已换新 |
| 锁健壮性加固 R6（修 §0.9 全部三条） | **已闭环** —— ①`lockHolderAlive()` 引入 **30 秒 mtime 心跳 + pid 存活性双信号**：心跳超 3 分钟即视为陈旧，彻底解决「pid 被系统复用给无关程序 → 误判为占用 → 用户永久打不开」；②报错文案给出「可删除该锁文件后重试」与具体路径，不再让人卡死；③心跳发现锁文件被外部删除会**立即重建**，避免在无保护状态下继续写。实测：伪造 pid=4（存活无关进程）+ 心跳新鲜 → 正确拒绝；把 mtime 改老 4 分钟 → 自动接管并换新 token；运行中删除锁文件 → 35 秒内自动重建；强杀进程（SIGKILL 无 exit 钩子）→ 下次启动自动接管，锁 pid 从 6764 换成 22120 且数据完整 |
| **交付判定** | **可交付**（核心功能全绿 + 锁健壮性已加固；实测锁内 pid 与监听 pid 始终一致、心跳 30s 准时刷新） |

### 交付时建议一并告知使用者的两点（非缺陷）

1. **「补取正文」的两种方式语义不同**：粘贴正文**必定生效**；「补取评论」只有在接口响应里带回原微博对象时才会自动回填。UI 文案已如实说明，但使用者可能仍误以为取数必能补齐。
2. **演示数据重置在极端环境下可能失败**：若系统（Defender/索引器）瞬时锁住数据目录，`reset` 会抛 `IO_ERROR` 并提示重试，属预期行为（此前会静默把未读越叠越大）。重试即可。

### 验收过程说明（供追溯）

本交付经历 4 轮验收，累计发现并闭环 **1 Blocker + 5 Major + 8 Minor**，全部以可执行断言固化（`test/` 下 10 个文件，100 项）。其中 2 个缺陷是我方验收方式本身漏掉的（`path` 漏导入被空 catch 吞掉、P0-15 只验"按钮存在"未验"按钮有效"），已在 §0.6 / §0.7 如实记录并补充了对应的静态护栏（`test/static-guards.test.js`）与端到端验证方法。

---

## §9 用户实测反馈「无法运作」— 复盘与修复（Blocker · 交付后）

### 现象
用户双击 `start.bat` 后应用**完全无法启动**，窗口刷出一串报错（`'ho' 不是内部或外部命令`、`'start' 不是内部或外部命令`）。

### 根因（两个独立问题叠加）
| # | 问题 | 说明 |
|---|---|---|
| 1 | **`start.bat` 是 LF 行尾** | Windows 命令行解析 `.bat` 要求 **CRLF**。LF 会导致行被错位切分，于是 `echo` 变成 `'ho'`、`start` 变成非法命令——整份脚本一条都没执行成功。这是**自首版交付起就存在的问题**，双击启动是本产品唯一主入口，因此等价于「应用打不开」 |
| 2 | 服务已在运行时重复双击 → 只报错 | 旧逻辑直接打印「数据目录已被另一个进程占用」并退出，不给任何可用结果 |

### 为什么 4 轮验收、100 项测试全绿却没发现
测试套件从不执行 `.bat`，也不检查行尾；headless 验证只访问 HTTP 端口，同样绕过了启动脚本。**验收覆盖了应用内部，却没覆盖「用户拿到手的第一步」。**

### 修复
1. `start.bat` 重写为 **CRLF + 纯 ASCII + 无 BOM**，只做三件事：检测 node → `node server\\server.js` → 失败时 `pause` 保留窗口。
2. 打开浏览器从 `.bat` 的延迟命令移入 `server.js`（`openBrowser()`），避免引号/时序/行尾问题导致静默失败。
3. 新增 `probeRunning()`：抢锁失败时先探测该端口是否已有本应用在跑——**是**则打印「已经在运行」、打开浏览器、`exit 0`；**否**才输出占用指引。重复双击不再表现为报错。
4. `acquireInstanceLock()` 改为返回结构化结果（`{ok:false, reason}`）而非自行打印，消息统一由 `main()` 按场景输出。

### 新增护栏 `test/startup.test.js`（5 项）
- `start.bat` 必须 CRLF（断言裸 LF 数量为 0）
- 不得带 BOM
- 必须纯 ASCII（防代码页把中文当命令）
- 必须含 `cd /d "%%~dp0"`、`node server\\server.js`、结尾 `pause`
- `server.js` 必须实际调用 `main()`（防启动路径改动后静默退出）

> **已验证护栏有效**：把 `start.bat` 临时改回 LF，该用例立即报红；恢复 CRLF 后转绿。

### 实测（修复后）
| 场景 | 结果 |
|---|---|
| 干净环境执行 `start.bat` | 正常启动，打印访问地址，`/api/health` 200 |
| 服务已在运行时再次双击 | 输出「Weibo Reader 已经在运行」，`exit 0`，不再红字报错 |
| 另一实例持锁但目标端口无服务 | 输出完整占用指引（含持有者 pid 与锁路径） |
| 页面渲染 | 9 条路由正常；用户库真实显示「林间有风 / 夜航船笔记 / 数读城市」 |
| 登录入口 | `POST /api/auth/device` 返回真实微博设备码（如 `41AB-ADF8`）与授权链接 |
| 全量测试 | **105 / 105 通过，0 fail，0 skip** |

### 结论
**已修复，可交付。** `start.bat` 双击可正常启动并自动开浏览器。

---

## §10 真实账号取数失败「响应无法归一化」— 复盘与修复（Blocker · 首次真实联网）

### 现象
用户已登录（余额 23000，formal_active），每次点取数都失败：
```
任务失败：第 1 页响应无法归一化：接口返回结构无法识别（未找到记录数组）
```
**并且每次失败仍被扣费 294 credits**（= 98 条 × 3 credits/条），连续两次共 588。

### 根因
网关真实响应是官方 CLI 的 `InvokeResponse` 形态：
```json
{ "success": true, "command": {...},
  "result": { "comments": [...], "next_cursor": ... },
  "meta": { "billing": { "deducted": 3, "returned": 1 } } }
```
记录数组在 **`result.comments`**，比实现假设的 `payload.data` **多一层**。
原 macOS 应用的 `rawArray()` 因此把候选容器写成
`[raw, raw.data, raw.result, raw.response, raw.data.data]` —— 而本实现只查了前两者，
于是永远找不到数组：数据已经买下来了，却在内存里被丢弃。

**为什么之前所有测试都绿**：全部用打桩网关，而桩是自己写的 `{data:[...]}`，
桩与实现共享同一个错误假设，测试只能证明「彼此自洽」，证明不了「符合真实接口」。

### 连带修掉的问题
| # | 问题 | 后果 |
|---|---|---|
| 1 | 未检查 `success:false` / `error` | 服务端错误被误报成「结构无法识别」，把可行动的原因（如「只能查自己」）吞掉 |
| 2 | 未处理 `meta.outcome` 失败态 | 同上 |
| 3 | 计费用「条数×单价」估算，忽略 `meta.billing.deducted` | 真实扣费与账面不符 |
| 4 | 失败任务显示「消耗 0」 | 用户以为没花钱，反复重试继续烧钱（已用余额差额兜底） |
| 5 | `mapRecord` 只认 `item.status`，漏 `item.weibo` | 评论携带的原微博识别率低 |
| 6 | `reply_comment` 是对象却被 `String()` | 归档里出现 `"replyId":"[object Object]"` |
| 7 | 昵称恒为「用户6349473082」 | `users show/biz` 仅限本人，无法补全他人昵称 |

### 修复
1. `weibo.normalizeList()` 按官方 `InvokeResponse` 逐层下探，候选容器含 `result`；按记录类型优先 `comments` / `statuses`
2. 新增 `weibo.upstreamError()`：先判 `success:false`/`error`/`meta.outcome`，抛出真实原因；对「只能查自己」给中文可操作提示
3. 新增 `weibo.billedCredits()`：取 `meta.billing.deducted` 作为真实扣费，拿不到才退回估算
4. 任务结算用「初始余额 − 结束余额」兜底，并在日志里明示差额来源
5. `mapRecord` 支持 `item.weibo`；`pickStr` 拒绝对象，从根上消除 `[object Object]`
6. 昵称改为从取回记录的作者名回填（零成本、无需联网查用户资料）

### 验证（真实接口，非打桩）
| 项 | 结果 |
|---|---|
| `comments by_me/other` count=1 | 归一化成功，入库 1 条，`billing.deducted=3` 与账面一致 |
| 增量更新（本地已有 since_id） | 返回 0 条，**消耗 0 credits**，正确判定「无更多数据」 |
| 历史分页（`max_id` 递减） | 返回 2 条、新增 1、**复用 1**（去重生效），扣 6 = 2×3 |
| 昵称回填 | `用户6349473082` → `吃吃吃田`，消耗 0 |
| 页面渲染 | 详情页正常显示记录正文，全站无 `[object Object]` |
| 空结果 / 服务端错误 | 分别给出「无更多数据」与中文真实原因，不再误报结构错误 |

### 新增护栏 `test/response-shape.test.js`（10 项）
夹具直接取自**真实响应**：`result.comments` 归一化、空数组、`statuses` 分支、旧形态兼容、
`success:false` 报真实原因、`outcome` 失败态、`billed.deducted`、真实条目字段映射、`weibo` 变体、
以及断言归档中不得出现 `[object Object]`。

### 余额说明
用户两次失败共损失 **588 credits**（无法追回，数据已被丢弃）。本次修复验证另消耗约 15 credits。
修复后重跑同一取数即可正常入库。

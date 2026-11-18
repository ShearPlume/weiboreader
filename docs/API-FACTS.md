# 微博开放平台 CLI 网关 · 接口事实（已实测）

> 本文由主理人在实现前实测确认，作为架构与实现的唯一事实来源，不要凭猜测改接口。

## 1. 基址

```
BASE = https://open.weibo.com/cli/api
```

所有请求 `Accept: application/json`；需要鉴权时带 `Authorization: Bearer <access_token>`。

## 2. 登录（OAuth Device Authorization Grant）

| 用途 | 方法与路径 | 请求体 |
| --- | --- | --- |
| 申请设备码 | `POST /oauth/device/code` | `{"client_id":"weibo-cli","device_name":"weibo-reader-web"}` |
| 轮询令牌 | `POST /oauth/token` | `{"grant_type":"urn:ietf:params:oauth:grant-type:device_code","device_code":"<device_code>","client_id":"weibo-cli"}` |
| 账户信息 | `GET /oauth/userinfo` | — |

实测申请设备码返回（HTTP 200）：

```json
{"device_code":"...","user_code":"469D-20C2","verification_uri":"https://open.weibo.com/cli/api/oauth/device","expires_in":600,"interval":5}
```

授权地址 = `verification_uri + "?user_code=" + user_code`（须用户在浏览器打开并确认）。

轮询语义：
- 200 → 返回 `{access_token, refresh_token, expires_in, refresh_expires_in, token_type}`，登录成功。
- 未确认 → 错误码 `authorization_pending`；过快 → `slow_down`（下次轮询间隔 +5s）。
- 其他错误 → 失败，展示 `error_description`。
- 总超时 600s。

## 3. 账户与余额

```
GET /cli/whoami
→ {"user":{"username":"...","balance":123.45,...},"service_status":{"kind":"trial_active|formal_active|...","title":"...","subtitle":"..."},"usage":{...}}
```

- 余额字段：`user.balance`（数字，单位 credits）。该查询**不产生费用**。
- `service_status.kind` 用于提示「体验/正式/未开通」。

## 4. 调用业务接口

```
POST /cli/invoke
Authorization: Bearer <token>
{"group":"comments","action":"by_me/other","args":{"uid":"123","count":50,"page":1}}
```

- `args` 是 CLI 旗标的对象形式（`--count 50` → `count:50`）。
- 响应为接口原始 JSON，命令行工具会按 `data`/`statuses`/`comments` 等字段输出；本项目**自行兼容**多种包裹：优先读 `payload.data`，否则读首个数组字段。
- **计费**：按接口实际返回条数/请求计费（credits）；本地复用已存数据不计费。

命令元数据（用于确认参数与单价，不产生费用）：

```
GET /cli/commands?group=comments      → {"commands":[{"group","action","description","flags":[...],"pricing":{"unit_price":...},"price_type":"..."}]}
GET /cli/commands/comments/by_me%2Fother
```

## 5. 本项目使用的接口映射（来自原应用 config.js，已核对）

| 业务模式 | group | action |
| --- | --- | --- |
| 发出的评论 | comments | `by_me/other` |
| 收到的评论 | comments | `to_me/other` |
| 发出和收到的评论 | comments | `timeline/other` |
| 被 @ 的评论 | comments | `mentions/other` |
| 被 @ 的微博 | statuses | `mentions/other` |
| 某条微博下的评论 | comments | `show/all` |
| 用户微博 | statuses | `user_timeline/biz`（若 404 则回退 `statuses/user_timeline/other`，并在 UI 提示） |
| 用户信息（昵称/头像） | users | `show/biz`（批量：`show_batch/other`，参数 `uids` 或 `screen_name`） |

**分页参数约定**（先 `commands show` 校验再请求，缺参即停止，避免白花 credits）：
- 增量：`since_id`（只有最新一段新增）
- 历史：`max_id` / `page`（向更早翻页）
- 条数：`count`（单页上限，微博侧通常 ≤ 100）
- 用户维度：`uid`

## 6. 错误格式

```json
{"error":"Unauthorized: Missing token"}   // HTTP 401
```

- 401 → 视为未登录/令牌失效，提示重新授权，不重试。
- 402/429 或含 `insufficient`/`budget`/`quota` → 额度不足或限流，停止任务并提示。
- 其他 4xx/5xx → 记录 `message` 到任务日志，可重试一次。

## 7. 硬性约束

1. 任何联网取数前，必须先确认接口存在且参数受支持（用 `/cli/commands/...`），不支持就停止，不允许盲请求。
2. 同一记录重复返回仍可能计费 → 本地按 `recordId` 去重，入库时统计「新增条数」而非「返回条数」。
3. 离线模式（无 token / 无网络）必须可用：浏览、搜索、报告、订阅配置均走本地数据。

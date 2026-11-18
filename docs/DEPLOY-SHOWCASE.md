# 展示页部署与数据加速（/fakeaccount）

对外地址：<https://idolgallery.xyz/fakeaccount/>

## 1. 线上结构

```
国内浏览器
├─ HTML（2KB）           → idolgallery.xyz（新加坡 nginx → COS 广州，仅一次）
├─ CSS / JS / 头像 / JSON → COS 广州（直连，命中 <base>）
└─ /fakeaccount/api/*     → 新加坡 nginx → 本机 Node 7788（仅兜底，正常 0 次）
```

关键点：部署出来的 `index.html` 会在 `<head>` 注入

```html
<base href="https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/">
```

因此页面里的 `css/showcase.css`、`js/showcase.js`、`avatar/<uid>.jpg`、`users.json`、
`records/<uid>/<mode>.json` 全部由浏览器**直连广州 COS**，不再绕道新加坡。
展示页会优先读这些静态快照，只有快照不存在时才回落到 `/fakeaccount/api/*`。

> 不要手工改线上 `index.html` 的 `<base>`，它由发布脚本生成。

## 2. 目录与配置

| 项 | 值 |
|---|---|
| 服务器代码 | `/home/admin/weibo-reader-web`（git clone） |
| 数据目录 | `/home/admin/weibo-reader-web/data`（`config.json` 不含 token） |
| Node 进程 | pm2 `weibo-showcase`，`HOST=172.17.0.1 PORT=7788 NO_OPEN=1` |
| nginx 配置 | 宿主机 `/home/admin/IdolGallary/frontend/app.conf`（挂载进 `vue_frontend`） |
| nginx 备份 | `app.conf.bak.showcase` |
| COS 桶 | `mirugumi-space-1382800327`（`ap-guangzhou`，公有读私有写） |
| COS 前缀 | `fakeaccount/` |
| COS 凭据 | `/home/admin/.cos.conf`（coscmd 格式，**不要提交到仓库**） |

### nginx 关键片段

```nginx
location = /fakeaccount { return 301 /fakeaccount/; }

location = /fakeaccount/ {
    proxy_pass https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/index.html;
    proxy_ssl_server_name on;
    proxy_http_version 1.1;
    proxy_set_header Host mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com;
    add_header Cache-Control "no-cache" always;
}

location ^~ /fakeaccount/avatar/ {
    proxy_pass https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/avatar/;
    proxy_ssl_server_name on;
    add_header Cache-Control "public, max-age=604800" always;
}

location ^~ /fakeaccount/api/ {
    limit_except GET { deny all; }          # 展示页只读，屏蔽 POST/PATCH/DELETE
    proxy_pass http://172.17.0.1:7788/api/; # 新加坡本机 Node，仅兜底
    proxy_set_header Host $host;
    add_header Cache-Control "no-store" always;
}

location ^~ /fakeaccount/ {
    proxy_pass https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/;
    proxy_ssl_server_name on;
    add_header Cache-Control "public, max-age=3600" always;
}
```

改完执行：

```bash
docker exec vue_frontend nginx -t && docker exec vue_frontend nginx -s reload
```

## 3. 日常更新（同一账号新增数据）

数据是 append-only 的 JSONL，**重新发布即可增量生效**：
发布脚本对每个对象先 `HEAD` 取 ETag（= 内容 MD5），内容没变就跳过，只上传变化的文件。

```bash
# 在“有最新 data/ 的机器”上执行（本地或服务器均可，需要 COS 凭据）
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf

# 只刷新某一个账号（推荐，最快）
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf --uid 6372442231

# 只刷新数据快照（不动 HTML/CSS/JS/头像）
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf --mode data

# 预演：只对比、不上传
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf --dry-run
```

会发生什么：

1. `users.json` / `profiles.json` 重新导出；
2. `records/<uid>/<mode>.json` 重新生成（含 `total`、`unread`）；
   **每个账号固定导出全部 6 种模式**，没有数据的模式也会写空快照（`{items:[],total:0,unread:0}`），
   这样页面永远不会因为静态文件缺失回落到 API 再遇到 404；
3. 按 MD5 对比 COS 上的 ETag，只上传变化的文件；
4. 页面刷新后直接读到新数据，**不需要重启 Node**。

> 注意：`--uid` 只影响 `records/`；`users.json` 与 `profiles.json` 始终全量对比。

### 如果新数据是在本地取的

服务器上的 `/api/*` 只是兜底。推荐流程：

```bash
# 1) 本地发布静态数据到 COS（需要本地有 cos.conf）
node tools/publish-showcase.mjs --cos-conf ~/.cos.conf --uid <uid>

# 2) 可选：把 data/ 同步到服务器，保证 API 兜底也是新的
rsync -avz --exclude config.json data/ admin@43.153.223.229:/home/admin/weibo-reader-web/data/
```

若服务器没有 rsync/密钥，可打包后经 COS 中转：

```bash
tar -czf data.tar.gz data/users.json data/profiles.json data/records
# 上传 data.tar.gz 到 COS 的 fakeaccount/_deploy/data.tar.gz（可用发布脚本所在机器的 COS 工具）
ssh admin@43.153.223.229 'cd /home/admin/weibo-reader-web && curl -fsSL <COS 上的 data.tar.gz 地址> -o /tmp/data.tar.gz && tar -xzf /tmp/data.tar.gz'
```

## 4. 新增账号

1. 在后台管理（本地）添加账号并取数；
2. 补齐资料与头像：

```bash
node tools/fetch-profiles.mjs --cookie-file <weibo_cookies.json> --authors
# 已有头像下载失败时：
node tools/fetch-profiles.mjs --avatars-only
```

3. 发布（只发新账号即可）：

```bash
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf --uid <新uid>
```

4. 打开页面，右上「我」→ 底部切换账号即可看到新账号（默认展示最近添加的账号）。

## 5. 代码更新后

```bash
# 本地
git add -A && git commit -m "..." && git push

# 服务器
cd /home/admin/weibo-reader-web && git pull
export PATH=/root/.nvm/versions/node/v22.23.1/bin:$PATH
export PM2_HOME=/home/admin/.pm2
pm2 restart weibo-showcase
```

前端静态文件（`web/`）改动后，必须重新执行一次发布脚本，否则线上仍是旧文件：

```bash
node tools/publish-showcase.mjs --cos-conf /home/admin/.cos.conf --mode static
```

## 6. 验证清单

```bash
# 1) 页面与静态资源
curl -sS -o /dev/null -w '%{http_code}\n' https://idolgallery.xyz/fakeaccount/
curl -sS -o /dev/null -w '%{http_code}\n' https://idolgallery.xyz/fakeaccount/api/users

# 2) 静态数据
curl -sS https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/users.json | head -c 200

# 3) 浏览器 Network 检查（关键）
#    打开 /fakeaccount/，F12 → Network：
#    - CSS/JS/头像/JSON 的域名应为 mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com
#    - /fakeaccount/api/ 请求应为 0 次（除非静态快照缺失）
```

### 页面报「请求失败（HTTP 404）」

1. 先强制刷新：`Ctrl+F5`，或直接打开
   `https://idolgallery.xyz/fakeaccount/?v=<任意时间戳>`（绕过微信/浏览器缓存）；
2. 页面错误框现在会显示**具体失败的 URL**，把它和浏览器 Network 里的 404 一起发出来；
3. 确认静态快照是否存在：
   `curl -I https://mirugumi-space-1382800327.cos.ap-guangzhou.myqcloud.com/fakeaccount/records/<uid>/<mode>.json`
   若 404，重新执行 `node tools/publish-showcase.mjs --uid <uid>`；
4. 微信内置浏览器缓存很顽固，必要时在「设置 → 通用 → 存储空间」清理，或换系统浏览器验证。

## 7. 回滚

- 代码：`git reset --hard <上一个提交> && pm2 restart weibo-showcase`
- 静态：重新执行发布脚本（会按当前代码覆盖 COS 对象）
- nginx：`cp /home/admin/IdolGallary/frontend/app.conf.bak.showcase /home/admin/IdolGallary/frontend/app.conf`
  然后 `docker exec vue_frontend nginx -t && docker exec vue_frontend nginx -s reload`

## 8. 安全与注意事项

- COS 桶是**公有读**：`fakeaccount/records/**.json` 与头像可被直接访问；这与展示页本身暴露的数据一致。
  不要把 `data/config.json`（含微博 token）上传到 COS 或仓库。
- 展示页只读：nginx 对 `/fakeaccount/api/` 只放行 GET；页面本身不提供任何写操作。
- 头像来自微博 CDN，需带 `Referer: https://weibo.com/` 才能下载，所以由 `tools/fetch-profiles.mjs`
  在本机预取到 `data/avatars/`，再随静态发布上传。
- 静态 JSON 变化时使用 `Cache-Control: no-cache`，页面用 `cache: 'no-store'` 读取，避免看到旧数据；
  CSS/JS 通过 `?v=<发布版本>` 刷新缓存。

## 9. 服务器后台（/fakeadmin）

为了不必每次本地操作，服务器上同时暴露了只给管理员使用的后台（原有后台 + 新增「展示页」页）。

- 地址：<https://idolgallery.xyz/fakeadmin/>
- 认证：nginx Basic Auth，凭据文件 `/etc/letsencrypt/fakeadmin.htpasswd`（用户 `admin`，密码请自行修改）
- 反向代理：`/fakeadmin/` → `http://172.17.0.1:7788/`，因此 `/fakeadmin/api/*`、`/fakeadmin/reports/*` 都走后端；
  前端 `api.js` 会自动按当前路径加前缀，支持子路径部署。
- 环境变量（pm2 `weibo-showcase`）：
  - `SHOWCASE_COS_CONF=/home/admin/.cos.conf`
  - `SHOWCASE_COOKIE_FILE=/home/admin/IdolGallary/backend/weibo_cookies.json`
- 新增「展示页」页做的事：
  1. 可选先跑 `tools/fetch-profiles.mjs --authors`（补新账号/新作者的资料与头像）；
  2. 跑 `tools/publish-showcase.mjs`（导出静态快照 + 增量上传 COS）；
  3. 页面直接显示执行日志。
- 支持「只发布数据」「预演（不上传）」「指定账号（只重建该 uid 的记录快照）」。
- 典型使用顺序：**取数页同步互动数据 → 展示页 → 勾选「先刷新资料与头像」→ 发布**。

> 后台具备取数等写操作，必须保持 Basic Auth 与 HTTPS；不要把 `/fakeadmin` 的凭据写进仓库或展示页。

# 装修新媒体协同工作台 - 后端服务

## 本地启动（开发）

```bash
# 1. 安装依赖
cd server
npm install

# 2. 准备 MySQL 数据库
#    推荐方式 A: 本机 MySQL
#       CREATE DATABASE media_workbench DEFAULT CHARACTER SET utf8mb4;
#
#    推荐方式 B: 用 Docker 一键启动
#       docker run -d --name mysql-dev -p 3306:3306 \
#         -e MYSQL_ROOT_PASSWORD=root123 \
#         -e MYSQL_DATABASE=media_workbench \
#         mysql:8.0

# 3. 复制环境变量并修改
cp .env.example .env
#    修改 DB_HOST/DB_PASSWORD 等

# 4. 启动
npm start
```

启动后访问：http://localhost:3000

默认管理员账号：`admin` / `admin123`（首次启动自动创建，修改请编辑 `.env`）

---

## 部署到 Railway（推荐，零运维）

### 1. 准备工作
- 注册 [Railway](https://railway.app) 账号（GitHub 一键登录）
- 项目代码推到 GitHub 仓库

### 2. 在 Railway 创建项目
1. 点 `New Project` → `Deploy from GitHub repo`
2. 选择刚推的代码仓库，Root Directory 设为 `server`
3. Railway 自动识别 Node.js 项目，开始构建

### 3. 添加 MySQL 数据库
1. 在同一个 Railway 项目里点 `+ New` → `Database` → `MySQL`
2. MySQL 服务创建后，点击它 → `Variables` 标签
3. 把里面的 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DATABASE` 复制出来

### 4. 配置环境变量
回到你的 web 服务 → `Variables` 标签，添加：

| 变量 | 值 |
|---|---|
| `DB_HOST` | （从 MySQL 服务复制） |
| `DB_PORT` | （同上） |
| `DB_USER` | （同上） |
| `DB_PASSWORD` | （同上） |
| `DB_NAME` | （同上） |
| `JWT_SECRET` | （填一个长随机字符串，如 `openssl rand -hex 32`） |
| `ADMIN_USERNAME` | `admin` |
| `ADMIN_PASSWORD` | （你的管理员密码） |
| `STATIC_DIR` | `/app` |
| `PORT` | Railway 会自动注入，不需要设 |

### 5. 修改启动脚本
Railway 默认只跑 `server` 子目录，但前端文件 `index.html` 在上级目录。最简方式：把 `index.html` 和 `lib/` 也放到 `server/` 里，或修改 Railway 配置：

**推荐方式**：在项目根目录建 `railway.toml`：

```toml
[build]
builder = "NIXPACKS"

[deploy]
startCommand = "node server/server.js"
```

然后给 `server/server.js` 加一个兜底，让 `STATIC_DIR` 指向父目录：

```js
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '..');
```

### 6. 获取公网地址
Railway 部署成功后，会给你一个 `xxx.up.railway.app` 的地址（如 `https://media-workbench-server.up.railway.app`）

### 7. 绑定自有域名
1. Railway 服务页 → `Settings` → `Domains` → `Custom Domain`
2. 添加 `zimaptoop.asia`（或子域名如 `app.zimaptoop.asia`）
3. Railway 会给一个 CNAME 记录值（如 `xxx.up.railway.app`）
4. 去 DNSPod → 你的域名 → 域名解析 → 添加 CNAME 记录：
   - 主机记录：`app`（或 `@`）
   - 记录类型：`CNAME`
   - 记录值：`xxx.up.railway.app`
   - TTL：5 分钟
5. 等待 5-10 分钟，Railway 自动签 SSL 证书，https 即可访问

### 8. 配置钉钉 H5 微应用
1. 登录 [钉钉开放平台](https://open.dingtalk.com) → 应用开发 → 企业内部应用 → 创建应用
2. 应用类型选 **H5 微应用**
3. 填写：
   - 应用首页地址：`https://app.zimaptoop.asia`
   - 可信域名：`app.zimaptoop.asia`
4. 发布应用，等待管理员审核通过
5. 团队成员在钉钉工作台即可看到应用入口

---

## API 接口速览

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/login` | 登录（返回 token） |
| GET | `/api/auth/me` | 当前用户信息 |
| GET | `/api/staff` | 员工列表 |
| POST | `/api/staff` | 新增员工（admin/supervisor） |
| GET/POST/PUT/DELETE | `/api/short_video` | 短视频 CRUD |
| GET/POST/PUT/DELETE | `/api/live` | 直播 CRUD |
| GET/POST/PUT/DELETE | `/api/ad_spend` | 投流消耗 CRUD |
| GET/POST/PUT/DELETE | `/api/leads` | 客资 CRUD |
| POST | `/api/leads/:id/follow` | 添加跟进记录 |
| GET | `/api/dashboard` | 看板汇总数据 |

所有接口（除登录和静态文件）都需要 Header：`Authorization: Bearer <token>`

---

## 角色权限矩阵

| 角色 | 短视频 | 直播 | 投流消耗 | 客资录入 | 客资查看 | 客资分配 | 看板 |
|---|---|---|---|---|---|---|---|
| admin | 全部 | 全部 | 全部 | ✅ | 全部 | ✅ | ✅ |
| supervisor | 全部 | 全部 | 全部 | ✅ | 全部 | ✅ | ✅ |
| operator | 自己 | 自己 | 自己 | ✅ | 全部 | ❌ | ✅（仅自己） |
| salesman | ❌ | ❌ | ❌ | ❌ | 仅被分配 | ❌ | ✅（仅自己） |
| viewer | ❌ | ❌ | ❌ | ❌ | 全部 | ❌ | ✅ |

- **自己** = `created_by = 当前用户ID`
- **被分配** = `assigned_to = 当前用户姓名`

---

## 故障排查

| 现象 | 原因 |
|---|---|
| 启动报 `ECONNREFUSED 3306` | MySQL 没启动，或 DB_HOST/DB_PORT 配错 |
| 启动报 `Access denied` | DB_USER/DB_PASSWORD 错 |
| 接口报 `未登录` | 没传 token，或 token 过期 |
| 接口报 `当前角色无权限` | 当前登录用户角色不允许该操作 |
| 前端打开白屏 | 检查浏览器控制台，常见原因：CORS、API地址错 |

---

## 数据迁移

如果需要把现在 localStorage 里的数据迁到 MySQL，写个导入脚本即可。联系开发者协助。
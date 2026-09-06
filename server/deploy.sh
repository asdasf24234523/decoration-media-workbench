#!/bin/bash
# ==============================================
# 装修新媒体协同工作台 — 云服务器一键部署脚本
# 运行方式：curl -fsSL ... | bash
# 或下载后 chmod +x deploy.sh && ./deploy.sh
# ==============================================
set -e

echo "=========================================="
echo "装修新媒体协同工作台 — 服务器部署"
echo "=========================================="

# ---- 颜色提示 ----
GREEN='\033[0;32m'; YELLOW='\033[1;33m'; RED='\033[0;31m'; NC='\033[0m'

# ---- 1. 检查 Node.js ----
echo -e "\n${YELLOW}[1/7] 检查 Node.js ...${NC}"
if command -v node &> /dev/null; then
  echo "Node.js: $(node -v)"
else
  echo "安装 Node.js 18 LTS ..."
  curl -fsSL https://deb.nodesource.com/setup_18.x | bash -
  apt-get install -y nodejs
fi

# ---- 2. 安装 MySQL ----
echo -e "\n${YELLOW}[2/7] 安装 MySQL 8.0 ...${NC}"
if command -v mysql &> /dev/null; then
  echo "MySQL 已安装: $(mysql --version)"
else
  apt-get update
  apt-get install -y mysql-server
  systemctl enable mysql
  systemctl start mysql
fi

# ---- 3. 创建数据库和用户 ----
echo -e "\n${YELLOW}[3/7] 初始化数据库 ...${NC}"
# 创建数据库
mysql -e "CREATE DATABASE IF NOT EXISTS media_workbench CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# 创建用户（后续 .env 里用这个用户）
# 注意：生产环境请改强密码！
mysql -e "CREATE USER IF NOT EXISTS 'workbench'@'localhost' IDENTIFIED BY 'WbPass2026!';"
mysql -e "GRANT ALL PRIVILEGES ON media_workbench.* TO 'workbench'@'localhost';"
mysql -e "FLUSH PRIVILEGES;"
echo -e "${GREEN}✓ 数据库 media_workbench 已创建，用户 workbench/WbPass2026!${NC}"

# ---- 4. 上传代码（手动或 git clone）----
echo -e "\n${YELLOW}[4/7] 部署代码 ...${NC}"
echo "请在 /home/ubuntu/media-workbench 目录放置代码"
echo "方式一（推荐，从 GitHub 拉）："
echo "  cd /home/ubuntu"
echo "  git clone <你的仓库> media-workbench"
echo "  cd media-workbench/server"
echo ""
echo "方式二（直接上传）："
echo "  把 workbench/server 目录上传到服务器 /home/ubuntu/media-workbench/server/"
echo ""

read -p "代码已放到 /home/ubuntu/media-workbench/server 目录了吗？(y/n): " confirm
if [ "$confirm" != "y" ]; then
  echo "请先放好代码再重新运行本脚本"
  exit 1
fi

# ---- 5. 安装依赖 ----
echo -e "\n${YELLOW}[5/7] 安装 Node 依赖 ...${NC}"
cd /home/ubuntu/media-workbench/server
npm install

# ---- 6. 配置 .env ----
echo -e "\n${YELLOW}[6/7] 配置环境变量 ...${NC}"
ENV_FILE="/home/ubuntu/media-workbench/server/.env"
cat > "$ENV_FILE" << 'ENVEOF'
PORT=3000
DB_HOST=localhost
DB_PORT=3306
DB_USER=workbench
DB_PASSWORD=WbPass2026!
DB_NAME=media_workbench
JWT_SECRET=CHANGE_THIS_TO_A_LONG_RANDOM_STRING_AT_LEAST_32_CHARS
STATIC_DIR=/home/ubuntu/media-workbench
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ENVEOF
echo -e "${GREEN}✓ .env 已创建（请记住 admin/admin123 登录密码）${NC}"
echo -e "${RED}⚠  建议立即把 JWT_SECRET 改成随机长字符串！${NC}"

# ---- 7. 启动服务 ----
echo -e "\n${YELLOW}[7/7] 启动服务 ...${NC}"

# 用 systemd 管理服务（可选，临时启动用 npm start 也行）
# 临时启动测试：
nohup npm start > /var/log/media-workbench.log 2>&1 &
sleep 3
if curl -sf http://localhost:3000/health > /dev/null; then
  echo -e "${GREEN}=========================================="
  echo -e "${GREEN}✓ 服务启动成功！"
  echo -e "${GREEN}=========================================="
  echo ""
  echo "访问地址：http://<服务器IP>:3000"
  echo "登录账号：admin"
  echo "登录密码：admin123"
  echo ""
  echo "日志：tail -f /var/log/media-workbench.log"
else
  echo -e "${RED}✗ 服务启动失败，请检查日志："
  tail -30 /var/log/media-workbench.log
fi

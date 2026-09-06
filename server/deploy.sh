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
  curl -fsSL https://deb.nodesource.com/setup_18.x | sudo bash -
  sudo apt-get install -y nodejs
fi

# ---- 2. 安装 MySQL ----
echo -e "\n${YELLOW}[2/7] 安装 MySQL 8.0 ...${NC}"
if command -v mysql &> /dev/null; then
  echo "MySQL 已安装: $(mysql --version)"
else
  sudo apt-get update
  sudo apt-get install -y mysql-server
  sudo systemctl enable mysql
  sudo systemctl start mysql
fi

# ---- 3. 创建数据库和用户 ----
echo -e "\n${YELLOW}[3/7] 初始化数据库 ...${NC}"
# 创建数据库
sudo mysql -e "CREATE DATABASE IF NOT EXISTS media_workbench CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;"
# 创建用户（后续 .env 里用这个用户）
# 注意：生产环境请改强密码！
sudo mysql -e "CREATE USER IF NOT EXISTS 'workbench'@'localhost' IDENTIFIED BY 'WbPass2026!';"
sudo mysql -e "GRANT ALL PRIVILEGES ON media_workbench.* TO 'workbench'@'localhost';"
sudo mysql -e "FLUSH PRIVILEGES;"
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

read -p "代码已放到 /home/ubuntu/media-workbench/server 目录了吗？(y/n/yes): " confirm
confirm=$(echo "$confirm" | tr '[:upper:]' '[:lower:]')
if [ "$confirm" != "y" ] && [ "$confirm" != "yes" ]; then
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
PORT=80
DB_HOST=localhost
DB_PORT=3306
DB_USER=workbench
DB_PASSWORD=WbPass2026!
DB_NAME=media_workbench
JWT_SECRET=$(openssl rand -base64 48 | tr -dc 'A-Za-z0-9' | head -c 48)
STATIC_DIR=/home/ubuntu/media-workbench
ADMIN_USERNAME=admin
ADMIN_PASSWORD=admin123
ENVEOF
echo -e "${GREEN}✓ .env 已创建（请记住 admin/admin123 登录密码）${NC}"
echo -e "${RED}⚠  建议立即把 JWT_SECRET 改成随机长字符串！${NC}"

# ---- 7. 启动服务（systemd 托管 + 开机自启）----
echo -e "\n${YELLOW}[7/7] 配置并启动服务 ...${NC}"

# 允许 node 绑定 80 端口（特权端口，无需 root 运行）
sudo setcap cap_net_bind_service=+ep $(readlink -f $(which node))

# 停掉旧的 nohup 进程，避免端口冲突
pkill -f "node server.js" 2>/dev/null || true
sleep 1

# 写入 systemd 服务文件
SERVICE_FILE="/etc/systemd/system/media-workbench.service"
sudo tee "$SERVICE_FILE" > /dev/null << 'EOF'
[Unit]
Description=装修新媒体协同工作台
After=network.target mysql.service

[Service]
Type=simple
User=ubuntu
WorkingDirectory=/home/ubuntu/media-workbench/server
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable media-workbench
sudo systemctl restart media-workbench
sleep 3

LOG_FILE="/home/ubuntu/media-workbench/server/server.log"
if curl -sf http://localhost/health > /dev/null; then
  echo -e "${GREEN}=========================================="
  echo -e "${GREEN}✓ 服务启动成功（systemd 托管，开机自启）！"
  echo -e "${GREEN}=========================================="
  echo ""
  echo "访问地址：http://<服务器IP>（端口 80，已自动放行）"
  echo "登录账号：admin"
  echo "登录密码：admin123"
  echo ""
  echo "查看状态：sudo systemctl status media-workbench"
  echo "查看日志：sudo journalctl -u media-workbench -f"
else
  echo -e "${RED}✗ 服务启动失败，请检查："
  sudo journalctl -u media-workbench -n 30 --no-pager
fi

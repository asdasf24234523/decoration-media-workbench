/**
 * 装修新媒体协同工作台 - 后端服务
 *
 * 启动: npm install && npm start
 * 默认端口: 3000 (可通过 PORT 环境变量修改)
 *
 * 数据隔离逻辑:
 *  - operator: 只能看/改自己的数据
 *  - admin/supervisor: 看所有数据，可分配客资
 *  - salesman: 只能看被分配给自己的客资
 *  - viewer: 全部只读
 */
require('dotenv').config();
const express = require('express');
const mysql = require('mysql2/promise');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const STATIC_DIR = process.env.STATIC_DIR || path.resolve(__dirname, '..');

const pool = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT) || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'media_workbench',
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  multipleStatements: true
});

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// ============ 数据库初始化 ============
async function initDB() {
  const conn = await pool.getConnection();
  try {
    // 表结构
    await conn.query(`
      CREATE TABLE IF NOT EXISTS sys_user (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(64) UNIQUE NOT NULL,
        password_hash VARCHAR(255) NOT NULL,
        display_name VARCHAR(64) NOT NULL,
        role VARCHAR(32) NOT NULL DEFAULT 'operator',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS short_video (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_date DATE NOT NULL,
        platforms JSON NOT NULL,
        video_category VARCHAR(32),
        operator VARCHAR(64),
        account VARCHAR(128),
        video_count INT DEFAULT 0,
        ad_spend DECIMAL(10,2) DEFAULT 0,
        leads_count INT DEFAULT 0,
        remark TEXT,
        created_by INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_date (record_date),
        INDEX idx_creator (created_by)
      );
      CREATE TABLE IF NOT EXISTS live_stream (
        id INT AUTO_INCREMENT PRIMARY KEY,
        live_date DATE NOT NULL,
        session_number INT,
        host VARCHAR(64),
        ad_spend DECIMAL(10,2) DEFAULT 0,
        leads_count INT DEFAULT 0,
        duration_minutes INT,
        remark TEXT,
        created_by INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_date (live_date),
        INDEX idx_creator (created_by)
      );
      CREATE TABLE IF NOT EXISTS ad_spend (
        id INT AUTO_INCREMENT PRIMARY KEY,
        spend_date DATE NOT NULL,
        sv_spend DECIMAL(10,2) DEFAULT 0,
        live_spend DECIMAL(10,2) DEFAULT 0,
        omni_spend DECIMAL(10,2) DEFAULT 0,
        mobile_live_spend DECIMAL(10,2) DEFAULT 0,
        omni_deal_amount DECIMAL(10,2) DEFAULT 0,
        omni_deal_count INT DEFAULT 0,
        live_leads INT DEFAULT 0,
        sv_leads INT DEFAULT 0,
        remark TEXT,
        created_by INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_date (spend_date),
        INDEX idx_creator (created_by)
      );
      CREATE TABLE IF NOT EXISTS customer_lead (
        id INT AUTO_INCREMENT PRIMARY KEY,
        get_date DATE NOT NULL,
        lead_source VARCHAR(32) NOT NULL,
        customer_name VARCHAR(64) NOT NULL,
        customer_phone VARCHAR(32),
        intent_demand TEXT,
        assigned_to VARCHAR(64),
        follow_status VARCHAR(32) DEFAULT 'pending_contact',
        follow_records JSON,
        created_by INT NOT NULL,
        assigned_by INT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_date (get_date),
        INDEX idx_assigned (assigned_to),
        INDEX idx_creator (created_by)
      );
      CREATE TABLE IF NOT EXISTS staff (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(64) UNIQUE NOT NULL,
        role VARCHAR(32),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // 创建初始管理员
    const [rows] = await conn.query('SELECT COUNT(*) AS n FROM sys_user');
    if (rows[0].n === 0) {
      const adminUser = process.env.ADMIN_USERNAME || 'admin';
      const adminPass = process.env.ADMIN_PASSWORD || 'admin123';
      const hash = await bcrypt.hash(adminPass, 10);
      await conn.query(
        'INSERT INTO sys_user (username, password_hash, display_name, role) VALUES (?,?,?,?)',
        [adminUser, hash, '系统管理员', 'admin']
      );
      console.log(`✓ 初始管理员已创建: ${adminUser} / ${adminPass}`);
    }

    // 创建示例员工
    const [staffRows] = await conn.query('SELECT COUNT(*) AS n FROM staff');
    if (staffRows[0].n === 0) {
      for (const name of ['李明','赵丽','王强','陈静']) {
        await conn.query('INSERT INTO staff (name) VALUES (?)', [name]);
      }
    }
  } finally {
    conn.release();
  }
}

// ============ 鉴权中间件 ============
function auth(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : null;
  if (!token) return res.status(401).json({ error: '未登录' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch (e) {
    return res.status(401).json({ error: '登录已过期，请重新登录' });
  }
}

// 根据角色生成数据范围SQL
function scopeWhere(user, alias) {
  const a = alias ? alias + '.`created_by`' : '`created_by`';
  const aa = alias ? alias + '.`assigned_to`' : '`assigned_to`';
  switch (user.role) {
    case 'admin':
    case 'supervisor':
      return { sql: '1=1', params: [] };
    case 'salesman':
      return { sql: `${aa} = ?`, params: [user.display_name] };
    case 'operator':
    default:
      return { sql: `${a} = ?`, params: [user.id] };
  }
}

function canEdit(user) {
  return ['admin','supervisor','operator'].includes(user.role);
}

function canDelete(user) {
  return user.role === 'admin';
}

function canAssign(user) {
  return ['admin','supervisor'].includes(user.role);
}

// ============ 路由：登录 ============
app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: '用户名和密码必填' });
  try {
    const [rows] = await pool.query('SELECT * FROM sys_user WHERE username = ?', [username]);
    if (!rows.length) return res.status(401).json({ error: '用户名或密码错误' });
    const u = rows[0];
    const ok = await bcrypt.compare(password, u.password_hash);
    if (!ok) return res.status(401).json({ error: '用户名或密码错误' });
    const token = jwt.sign(
      { id: u.id, username: u.username, display_name: u.display_name, role: u.role },
      JWT_SECRET, { expiresIn: '7d' }
    );
    res.json({
      token,
      user: { id: u.id, username: u.username, display_name: u.display_name, role: u.role }
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/auth/me', auth, (req, res) => {
  res.json({ user: req.user });
});

// ============ 路由：员工列表 ============
app.get('/api/staff', auth, async (req, res) => {
  try {
    const [rows] = await pool.query('SELECT name FROM staff ORDER BY id');
    res.json(rows.map(r => r.name));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/staff', auth, async (req, res) => {
  if (!['admin','supervisor'].includes(req.user.role)) return res.status(403).json({ error: '无权限' });
  const { name } = req.body || {};
  if (!name) return res.status(400).json({ error: '姓名必填' });
  try {
    await pool.query('INSERT INTO staff (name) VALUES (?)', [name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/staff/:name', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '无权限' });
  try {
    await pool.query('DELETE FROM staff WHERE name = ?', [req.params.name]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 通用 CRUD 工具 ============
function crudRoutes(config) {
  const router = express.Router();
  router.use(auth);

  // 列表
  router.get('/', async (req, res) => {
    const { start, end, mine } = req.query;
    const scope = scopeWhere(req.user, 't');
    const dateCol = config.dateCol;
    let sql = `SELECT t.*, u.display_name AS creator_name FROM ${config.table} t LEFT JOIN sys_user u ON t.created_by = u.id WHERE ${scope.sql}`;
    const params = [...scope.params];
    if (start) { sql += ` AND t.\`${dateCol}\` >= ?`; params.push(start); }
    if (end)   { sql += ` AND t.\`${dateCol}\` <= ?`; params.push(end); }
    if (mine === '1') { sql += ` AND t.\`created_by\` = ?`; params.push(req.user.id); }
    sql += ` ORDER BY t.\`${dateCol}\` DESC, t.id DESC`;
    try {
      const [rows] = await pool.query(sql, params);
      // JSON字段解析
      rows.forEach(r => {
        if (config.jsonCols) config.jsonCols.forEach(jc => {
          if (r[jc] && typeof r[jc] === 'string') {
            try { r[jc] = JSON.parse(r[jc]); } catch(e) { r[jc] = []; }
          }
        });
      });
      res.json(rows);
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 新增
  router.post('/', async (req, res) => {
    if (!canEdit(req.user)) return res.status(403).json({ error: '当前角色无录入权限' });
    const body = req.body || {};
    if (!body[dateCol]) return res.status(400).json({ error: `${config.dateLabel}必填` });
    try {
      const data = config.fromBody(body, req.user);
      const cols = Object.keys(data);
      const placeholders = cols.map(() => '?').join(',');
      const vals = cols.map(c => data[c]);
      const [r] = await pool.query(
        `INSERT INTO ${config.table} (${cols.map(c=>'`'+c+'`').join(',')}) VALUES (${placeholders})`,
        vals
      );
      res.json({ id: r.insertId, ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 更新
  router.put('/:id', async (req, res) => {
    if (!canEdit(req.user)) return res.status(403).json({ error: '当前角色无修改权限' });
    try {
      // 权限校验：operator只能改自己的
      const scope = scopeWhere(req.user, '');
      const [own] = await pool.query(
        `SELECT created_by FROM ${config.table} WHERE id = ?`,
        [req.params.id]
      );
      if (!own.length) return res.status(404).json({ error: '记录不存在' });
      if (req.user.role === 'operator' && own[0].created_by !== req.user.id) {
        return res.status(403).json({ error: '只能修改自己录入的记录' });
      }
      const data = config.fromBody(req.body || {}, req.user);
      const cols = Object.keys(data);
      if (!cols.length) return res.json({ ok: true });
      const set = cols.map(c => `\`${c}\` = ?`).join(',');
      const vals = cols.map(c => data[c]);
      vals.push(req.params.id);
      await pool.query(`UPDATE ${config.table} SET ${set} WHERE id = ?`, vals);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 删除
  router.delete('/:id', async (req, res) => {
    if (!canDelete(req.user)) return res.status(403).json({ error: '仅管理员可删除' });
    try {
      await pool.query(`DELETE FROM ${config.table} WHERE id = ?`, [req.params.id]);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

// 短视频
const shortVideoRouter = crudRoutes({
  table: 'short_video',
  dateCol: 'record_date',
  dateLabel: '日期',
  jsonCols: ['platforms'],
  fromBody: (body, user) => ({
    record_date: body.record_date,
    platforms: JSON.stringify(body.platforms || []),
    video_category: body.video_category || '',
    operator: body.operator || '',
    account: body.account || '',
    video_count: Number(body.video_count) || 0,
    ad_spend: Number(body.ad_spend) || 0,
    leads_count: Number(body.leads_count) || 0,
    remark: body.remark || '',
    created_by: user.id
  })
});
app.use('/api/short_video', shortVideoRouter);

// 直播
const liveRouter = crudRoutes({
  table: 'live_stream',
  dateCol: 'live_date',
  dateLabel: '直播日期',
  fromBody: (body, user) => ({
    live_date: body.live_date,
    session_number: Number(body.session_number) || 0,
    host: body.host || '',
    ad_spend: Number(body.ad_spend) || 0,
    leads_count: Number(body.leads_count) || 0,
    duration_minutes: Number(body.duration_minutes) || 0,
    remark: body.remark || '',
    created_by: user.id
  })
});
app.use('/api/live', liveRouter);

// 投流消耗
const adSpendRouter = crudRoutes({
  table: 'ad_spend',
  dateCol: 'spend_date',
  dateLabel: '日期',
  fromBody: (body, user) => ({
    spend_date: body.spend_date,
    sv_spend: Number(body.sv_spend) || 0,
    live_spend: Number(body.live_spend) || 0,
    omni_spend: Number(body.omni_spend) || 0,
    mobile_live_spend: Number(body.mobile_live_spend) || 0,
    omni_deal_amount: Number(body.omni_deal_amount) || 0,
    omni_deal_count: Number(body.omni_deal_count) || 0,
    live_leads: Number(body.live_leads) || 0,
    sv_leads: Number(body.sv_leads) || 0,
    remark: body.remark || '',
    created_by: user.id
  })
});
app.use('/api/ad_spend', adSpendRouter);

// 客资线索（特殊：可分配，含follow_records）
app.use('/api/leads', auth, async (req, res, next) => {
  if (req.method === 'GET') {
    const { start, end, mine, unassigned } = req.query;
    const scope = scopeWhere(req.user, 't');
    let sql = `SELECT t.*, u.display_name AS creator_name FROM customer_lead t LEFT JOIN sys_user u ON t.created_by = u.id WHERE ${scope.sql}`;
    const params = [...scope.params];
    if (start) { sql += ` AND t.\`get_date\` >= ?`; params.push(start); }
    if (end)   { sql += ` AND t.\`get_date\` <= ?`; params.push(end); }
    if (mine === '1') { sql += ` AND t.\`created_by\` = ?`; params.push(req.user.id); }
    if (unassigned === '1') { sql += ` AND (t.\`assigned_to\` IS NULL OR t.\`assigned_to\` = '')`; }
    sql += ` ORDER BY t.\`get_date\` DESC, t.id DESC`;
    try {
      const [rows] = await pool.query(sql, params);
      rows.forEach(r => {
        if (r.follow_records && typeof r.follow_records === 'string') {
          try { r.follow_records = JSON.parse(r.follow_records); } catch(e) { r.follow_records = []; }
        }
      });
      return res.json(rows);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }
  next();
});

// 客资新增
app.post('/api/leads', auth, async (req, res) => {
  if (!canEdit(req.user)) return res.status(403).json({ error: '当前角色无录入权限' });
  const body = req.body || {};
  if (!body.get_date) return res.status(400).json({ error: '获取日期必填' });
  if (!body.customer_name) return res.status(400).json({ error: '客户姓名必填' });
  try {
    const [r] = await pool.query(
      `INSERT INTO customer_lead (get_date, lead_source, customer_name, customer_phone, intent_demand, assigned_to, follow_status, follow_records, created_by) VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        body.get_date,
        body.lead_source || 'short_video',
        body.customer_name,
        body.customer_phone || '',
        body.intent_demand || '',
        body.assigned_to || '',
        body.follow_status || 'pending_contact',
        JSON.stringify(body.follow_records || []),
        req.user.id
      ]
    );
    res.json({ id: r.insertId, ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客资更新
app.put('/api/leads/:id', auth, async (req, res) => {
  const body = req.body || {};
  try {
    const [own] = await pool.query('SELECT created_by FROM customer_lead WHERE id = ?', [req.params.id]);
    if (!own.length) return res.status(404).json({ error: '记录不存在' });
    // operator只能编辑自己录入的；分配操作只允许admin/supervisor
    if (req.user.role === 'operator' && own[0].created_by !== req.user.id) {
      return res.status(403).json({ error: '只能修改自己录入的客资' });
    }
    if ('assigned_to' in body && !canAssign(req.user)) {
      return res.status(403).json({ error: '仅管理员/主管可分配客资' });
    }
    const sets = [];
    const vals = [];
    ['get_date','lead_source','customer_name','customer_phone','intent_demand','assigned_to','follow_status'].forEach(k => {
      if (k in body) { sets.push(`\`${k}\` = ?`); vals.push(body[k]); }
    });
    if ('follow_records' in body) { sets.push('`follow_records` = ?'); vals.push(JSON.stringify(body.follow_records)); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE customer_lead SET ${sets.join(',')} WHERE id = ?`, vals);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客资删除
app.delete('/api/leads/:id', auth, async (req, res) => {
  if (!canDelete(req.user)) return res.status(403).json({ error: '仅管理员可删除' });
  try {
    await pool.query('DELETE FROM customer_lead WHERE id = ?', [req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 添加跟进记录
app.post('/api/leads/:id/follow', auth, async (req, res) => {
  const body = req.body || {};
  if (!body.content) return res.status(400).json({ error: '跟进内容必填' });
  try {
    const [rows] = await pool.query('SELECT follow_records FROM customer_lead WHERE id = ?', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: '客资不存在' });
    let recs = [];
    try { recs = JSON.parse(rows[0].follow_records || '[]'); } catch(e) { recs = []; }
    recs.push({
      date: body.date || new Date().toISOString().slice(0,10),
      follower: body.follower || req.user.display_name,
      content: body.content,
      next: body.next || ''
    });
    await pool.query('UPDATE customer_lead SET follow_records = ? WHERE id = ?', [JSON.stringify(recs), req.params.id]);
    res.json({ ok: true, follow_records: recs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 看板汇总
app.get('/api/dashboard', auth, async (req, res) => {
  const { start, end } = req.query;
  try {
    // 数据范围
    const scope = scopeWhere(req.user, 't');
    let svWhere = scope.sql, svParams = scope.params;
    let lvWhere = scope.sql, lvParams = scope.params;
    let ldWhere = scope.sql, ldParams = scope.params;
    if (start) {
      svWhere += ' AND t.record_date >= ?'; svParams.push(start);
      lvWhere += ' AND t.live_date >= ?'; lvParams.push(start);
      ldWhere += ' AND t.get_date >= ?'; ldParams.push(start);
    }
    if (end) {
      svWhere += ' AND t.record_date <= ?'; svParams.push(end);
      lvWhere += ' AND t.live_date <= ?'; lvParams.push(end);
      ldWhere += ' AND t.get_date <= ?'; ldParams.push(end);
    }

    const [svRows] = await pool.query(
      `SELECT COALESCE(SUM(video_count),0) AS videos, COALESCE(SUM(ad_spend),0) AS spend, COALESCE(SUM(leads_count),0) AS leads FROM short_video t WHERE ${svWhere}`, svParams
    );
    const [lvRows] = await pool.query(
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(ad_spend),0) AS spend, COALESCE(SUM(leads_count),0) AS leads FROM live_stream t WHERE ${lvWhere}`, lvParams
    );
    const [ldRows] = await pool.query(
      `SELECT lead_source, COUNT(*) AS cnt FROM customer_lead t WHERE ${ldWhere} GROUP BY lead_source`, ldParams
    );
    const adWhere = scope.sql === '1=1' ? '1=1' : scope.sql.replace(/created_by/g, 'created_by');
    let adDateSql = '1=1', adParams = [...scope.params];
    if (start) { adDateSql += ' AND spend_date >= ?'; adParams.push(start); }
    if (end)   { adDateSql += ' AND spend_date <= ?'; adParams.push(end); }
    const [adRows] = await pool.query(
      `SELECT * FROM ad_spend WHERE ${adDateSql} ORDER BY spend_date DESC`, adParams
    );

    const svLeads = ldRows.find(r => r.lead_source === 'short_video')?.cnt || 0;
    const liveLeads = ldRows.find(r => r.lead_source === 'live_stream')?.cnt || 0;

    res.json({
      short_video: svRows[0],
      live_stream: lvRows[0],
      leads: { total: svLeads + liveLeads, short_video: svLeads, live_stream: liveLeads },
      ad_spend: adRows,
      reconciliation: {
        short_video_reported: Number(svRows[0].leads),
        short_video_actual: Number(svLeads),
        live_reported: Number(lvRows[0].leads),
        live_actual: Number(liveLeads)
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 静态文件（前端） ============
app.use(express.static(STATIC_DIR));
app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ============ 健康检查 ============
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// ============ 启动 ============
(async () => {
  try {
    await initDB();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`\n🚀 服务已启动: http://localhost:${PORT}`);
      console.log(`   静态目录: ${STATIC_DIR}`);
      console.log(`   健康检查: http://localhost:${PORT}/health\n`);
    });
  } catch (e) {
    console.error('启动失败:', e.message);
    process.exit(1);
  }
})();
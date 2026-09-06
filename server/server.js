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
const DINGTALK_CORPID = process.env.DINGTALK_CORPID || '';
const DINGTALK_APPKEY = process.env.DINGTALK_APPKEY || '';
const DINGTALK_APPSECRET = process.env.DINGTALK_APPSECRET || '';
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
  multipleStatements: true,
  // DATETIME 列原样返回字符串，避免被 Node 进程时区 Date 化后
  // 再按本地时区反序列化造成「记录 20:00 显示 04:00」的 8 小时偏移
  dateStrings: true,
  timezone: '+08:00'
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
        dingtalk_staff_id VARCHAR(64),
        disabled TINYINT(1) DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      CREATE TABLE IF NOT EXISTS short_video (
        id INT AUTO_INCREMENT PRIMARY KEY,
        record_date DATE NOT NULL,
        platforms JSON NOT NULL,
        video_category VARCHAR(32),
        lead_form VARCHAR(32),
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
        live_date DATETIME,
        session_number VARCHAR(32),
        host VARCHAR(64),
        duration_hours DECIMAL(6,2) DEFAULT 0,
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
        INDEX idx_date (live_date),
        INDEX idx_creator (created_by)
      );
      CREATE TABLE IF NOT EXISTS customer_lead (
        id INT AUTO_INCREMENT PRIMARY KEY,
        get_date DATE NOT NULL,
        lead_source VARCHAR(32) NOT NULL,
        customer_name VARCHAR(64) NOT NULL,
        customer_phone VARCHAR(32),
        contact_type VARCHAR(16),
        visit_status VARCHAR(32),
        intent_demand TEXT,
        assigned_to VARCHAR(64),
        follow_status VARCHAR(32) DEFAULT 'pending_contact',
        follow_records JSON,
        lead_form VARCHAR(32),
        community VARCHAR(128),
        consult_content TEXT,
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
      CREATE TABLE IF NOT EXISTS operation_log (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT,
        user_name VARCHAR(64),
        action VARCHAR(64),
        target VARCHAR(64),
        detail TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_time (created_at)
      );
    `);

    // 老库迁移：补列（新建库已含，报错忽略）
    try { await conn.query('ALTER TABLE sys_user ADD COLUMN dingtalk_staff_id VARCHAR(64)'); console.log('✓ sys_user 新增 dingtalk_staff_id'); } catch (e) {}
    try { await conn.query('ALTER TABLE sys_user ADD COLUMN disabled TINYINT(1) DEFAULT 0'); console.log('✓ sys_user 新增 disabled'); } catch (e) {}
    try { await conn.query('ALTER TABLE customer_lead ADD COLUMN contact_type VARCHAR(16)'); console.log('✓ customer_lead 新增 contact_type'); } catch (e) {}
    try { await conn.query('ALTER TABLE customer_lead ADD COLUMN visit_status VARCHAR(32)'); console.log('✓ customer_lead 新增 visit_status'); } catch (e) {}
    // 短视频/直播表在合并重构后字段变化较大，老库补列（新建库已含，报错忽略）
    try { await conn.query('ALTER TABLE short_video ADD COLUMN video_category VARCHAR(32)'); console.log('✓ short_video 新增 video_category'); } catch (e) {}
    try { await conn.query('ALTER TABLE short_video ADD COLUMN lead_form VARCHAR(32)'); console.log('✓ short_video 新增 lead_form'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN session_number VARCHAR(32)'); console.log('✓ live_stream 新增 session_number'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN duration_hours DECIMAL(6,2) DEFAULT 0'); console.log('✓ live_stream 新增 duration_hours'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN sv_spend DECIMAL(10,2) DEFAULT 0'); console.log('✓ live_stream 新增 sv_spend'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN live_spend DECIMAL(10,2) DEFAULT 0'); console.log('✓ live_stream 新增 live_spend'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN omni_spend DECIMAL(10,2) DEFAULT 0'); console.log('✓ live_stream 新增 omni_spend'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN mobile_live_spend DECIMAL(10,2) DEFAULT 0'); console.log('✓ live_stream 新增 mobile_live_spend'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN omni_deal_amount DECIMAL(10,2) DEFAULT 0'); console.log('✓ live_stream 新增 omni_deal_amount'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN omni_deal_count INT DEFAULT 0'); console.log('✓ live_stream 新增 omni_deal_count'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN live_leads INT DEFAULT 0'); console.log('✓ live_stream 新增 live_leads'); } catch (e) {}
    try { await conn.query('ALTER TABLE live_stream ADD COLUMN sv_leads INT DEFAULT 0'); console.log('✓ live_stream 新增 sv_leads'); } catch (e) {}

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
function scopeWhere(user, alias, hasAssignedTo) {
  const a = alias ? alias + '.`created_by`' : '`created_by`';
  const aa = alias ? alias + '.`assigned_to`' : '`assigned_to`';
  switch (user.role) {
    case 'admin':
    case 'supervisor':
      return { sql: '1=1', params: [] };
    case 'salesman':
      // 仅客资表有 assigned_to 列；其余表销售不可见
      if (!hasAssignedTo) return { sql: '1=0', params: [] };
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
    if (u.disabled) return res.status(401).json({ error: '账号已被禁用，请联系管理员' });
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

// ============ 钉钉免登 ============
// 公开：前端判断是否启用钉钉登录
app.get('/api/auth/dingtalk-config', (req, res) => {
  res.json({ enabled: !!(DINGTALK_APPKEY && DINGTALK_APPSECRET), corpId: DINGTALK_CORPID });
});

async function dtGetToken(){
  const r = await (await fetch(`https://oapi.dingtalk.com/gettoken?appkey=${DINGTALK_APPKEY}&appsecret=${DINGTALK_APPSECRET}`)).json();
  if(!r.access_token) throw new Error('钉钉获取 access_token 失败: ' + (r.errmsg || r.error || ''));
  return r.access_token;
}
async function dtGetUserid(code, token){
  const r = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/getuserinfo?access_token=' + token, {
    method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ code })
  })).json();
  if(r.errcode !== 0 || !r.result || !r.result.userid) throw new Error('钉钉获取用户失败: ' + (r.errmsg || ''));
  return r.result;
}
async function dtGetUserName(userid, token){
  try{
    const r = await (await fetch('https://oapi.dingtalk.com/topapi/v2/user/get?access_token=' + token, {
      method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ userid })
    })).json();
    if(r.errcode === 0 && r.result) return r.result.name || userid;
  }catch(e){}
  return userid;
}
function issueToken(u){
  const token = jwt.sign(
    { id:u.id, username:u.username, display_name:u.display_name, role:u.role },
    JWT_SECRET, { expiresIn:'7d' }
  );
  return { token, user:{ id:u.id, username:u.username, display_name:u.display_name, role:u.role } };
}
// 收前端 authCode -> 换 userid -> 映射 sys_user.dingtalk_staff_id -> 发 JWT
// 未匹配到则自动建普通员工(operator)账号
app.post('/api/auth/dingtalk', async (req, res) => {
  const { authCode } = req.body || {};
  if(!DINGTALK_APPKEY || !DINGTALK_APPSECRET) return res.status(500).json({ error:'服务器未配置钉钉应用(AppKey/AppSecret)' });
  if(!authCode) return res.status(400).json({ error:'缺少 authCode' });
  try {
    const token = await dtGetToken();
    const info = await dtGetUserid(authCode, token);
    const userid = info.userid;
    let [rows] = await pool.query('SELECT * FROM sys_user WHERE dingtalk_staff_id = ?', [userid]);
    let u;
    if(rows.length){
      u = rows[0];
      if(u.disabled) return res.status(403).json({ error:'账号已被禁用，请联系管理员' });
    } else {
      const name = await dtGetUserName(userid, token);
      const username = 'dt_' + userid;
      const hash = await bcrypt.hash(Math.random().toString(36).slice(2,10), 10);
      const [ins] = await pool.query(
        'INSERT INTO sys_user (username, password_hash, display_name, role, dingtalk_staff_id) VALUES (?,?,?,?,?)',
        [username, hash, name, 'operator', userid]
      );
      [rows] = await pool.query('SELECT * FROM sys_user WHERE id = ?', [ins.insertId]);
      u = rows[0];
      try { await pool.query('INSERT IGNORE INTO staff(name) VALUES (?)', [name]); } catch(e){}
    }
    res.json(issueToken(u));
  } catch(e){
    res.status(500).json({ error: e.message });
  }
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

// ============ 操作日志 ============
async function logOp(user, action, target, detail) {
  try {
    await pool.query(
      'INSERT INTO operation_log (user_id, user_name, action, target, detail) VALUES (?,?,?,?,?)',
      [user ? user.id : null, user ? user.display_name : '系统', action || '', target || '', detail || '']
    );
  } catch (e) { console.error('logOp failed:', e.message); }
}

// ============ 通用 CRUD 工具 ============
function crudRoutes(config) {
  const router = express.Router();
  router.use(auth);
  const dateCol = config.dateCol;

  // 列表
  router.get('/', async (req, res) => {
    const { start, end, mine } = req.query;
    const scope = scopeWhere(req.user, 't', config.hasAssignedTo);
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
      await logOp(req.user, 'create', config.table, '新增' + (config.name||config.table) + '记录');
      res.json({ id: r.insertId, ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 更新
  router.put('/:id', async (req, res) => {
    if (!canEdit(req.user)) return res.status(403).json({ error: '当前角色无修改权限' });
    try {
      // 权限校验：operator只能改自己的
      const scope = scopeWhere(req.user, '', config.hasAssignedTo);
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
      await logOp(req.user, 'update', config.table, '更新' + (config.name||config.table) + '记录 #' + req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  // 删除
  router.delete('/:id', async (req, res) => {
    if (!canDelete(req.user)) return res.status(403).json({ error: '仅管理员可删除' });
    try {
      await pool.query(`DELETE FROM ${config.table} WHERE id = ?`, [req.params.id]);
      await logOp(req.user, 'delete', config.table, '删除' + (config.name||config.table) + '记录 #' + req.params.id);
      res.json({ ok: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
  });

  return router;
}

// 短视频
const shortVideoRouter = crudRoutes({
  table: 'short_video',
  name: '短视频',
  dateCol: 'record_date',
  dateLabel: '日期',
  jsonCols: ['platforms'],
  hasAssignedTo: false,
  fromBody: (body, user) => ({
    record_date: body.record_date,
    platforms: JSON.stringify(body.platforms || []),
    video_category: body.video_category || '',
    lead_form: body.lead_form || '',
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

// 直播与投流（合并）
const liveRouter = crudRoutes({
  table: 'live_stream',
  name: '直播与投流',
  dateCol: 'live_date',
  dateLabel: '直播日期',
  hasAssignedTo: false,
  fromBody: (body, user) => {
    // 兼容 datetime-local 的 'YYYY-MM-DDTHH:mm' 转 MySQL DATETIME
    let ld = body.live_date;
    if (ld && typeof ld === 'string' && ld.includes('T')) {
      ld = ld.replace('T', ' ') + (ld.length === 16 ? ':00' : '');
    }
    return {
      live_date: ld,
      session_number: body.session_number || '',
      host: body.host || '',
      duration_hours: Number(body.duration_hours) || 0,
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
    };
  }
});
app.use('/api/live', liveRouter);

// 投流消耗独立表已废弃（旧版本兼容保留端点但返回空，提示用 /api/live）
app.get('/api/ad_spend', auth, (req, res) => res.json([]));

// 客资线索（特殊：可分配，含follow_records）
app.use('/api/leads', auth, async (req, res, next) => {
  if (req.method === 'GET') {
    const { start, end, mine, unassigned } = req.query;
    const scope = scopeWhere(req.user, 't', true);
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
  if (!canEdit(req.user) && req.user.role !== 'salesman') return res.status(403).json({ error: '当前角色无录入权限' });
  const body = req.body || {};
  // 销售录入的客资自动归到自己名下
  if (req.user.role === 'salesman') body.assigned_to = req.user.display_name;
  if (!body.get_date) return res.status(400).json({ error: '获取日期必填' });
  if (!body.customer_name) return res.status(400).json({ error: '客户姓名必填' });
  try {
    const [r] = await pool.query(
      `INSERT INTO customer_lead (get_date, lead_source, customer_name, customer_phone, contact_type, intent_demand, assigned_to, follow_status, follow_records, lead_form, community, consult_content, visit_status, created_by) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        body.get_date,
        body.lead_source || 'short_video',
        body.customer_name,
        body.customer_phone || '',
        body.contact_type || '',
        body.intent_demand || '',
        body.assigned_to || '',
        body.follow_status || 'pending_contact',
        JSON.stringify(body.follow_records || []),
        body.lead_form || '',
        body.community || '',
        body.consult_content || '',
        body.visit_status || '',
        req.user.id
      ]
    );
    await logOp(req.user, 'create', 'customer_lead', '新增客资（客户：' + (body.customer_name||'') + '）');
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
    ['get_date','lead_source','customer_name','customer_phone','contact_type','visit_status','intent_demand','assigned_to','follow_status','lead_form','community','consult_content'].forEach(k => {
      if (k in body) { sets.push(`\`${k}\` = ?`); vals.push(body[k]); }
    });
    if ('follow_records' in body) { sets.push('`follow_records` = ?'); vals.push(JSON.stringify(body.follow_records)); }
    if (!sets.length) return res.json({ ok: true });
    vals.push(req.params.id);
    await pool.query(`UPDATE customer_lead SET ${sets.join(',')} WHERE id = ?`, vals);
    await logOp(req.user, 'update', 'customer_lead', '更新客资记录 #' + req.params.id);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 客资删除
app.delete('/api/leads/:id', auth, async (req, res) => {
  if (!canDelete(req.user)) return res.status(403).json({ error: '仅管理员可删除' });
  try {
    await pool.query('DELETE FROM customer_lead WHERE id = ?', [req.params.id]);
    await logOp(req.user, 'delete', 'customer_lead', '删除客资记录 #' + req.params.id);
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
    await logOp(req.user, 'follow', 'customer_lead', '更新了客资跟进情况 #' + req.params.id);
    res.json({ ok: true, follow_records: recs });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 看板汇总
app.get('/api/dashboard', auth, async (req, res) => {
  const { start, end } = req.query;
  try {
    // 数据范围（短视频/直播表无 assigned_to 列，销售不可见；仅客资表按分配人过滤）
    const svScope = scopeWhere(req.user, 't', false);
    const lvScope = scopeWhere(req.user, 't', false);
    const ldScope = scopeWhere(req.user, 't', true);
    let svWhere = svScope.sql, svParams = svScope.params;
    let lvWhere = lvScope.sql, lvParams = lvScope.params;
    let ldWhere = ldScope.sql, ldParams = ldScope.params;
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
      `SELECT COUNT(*) AS sessions, COALESCE(SUM(sv_spend),0)+COALESCE(SUM(live_spend),0)+COALESCE(SUM(omni_spend),0)+COALESCE(SUM(mobile_live_spend),0) AS spend, COALESCE(SUM(live_leads),0)+COALESCE(SUM(sv_leads),0) AS leads FROM live_stream t WHERE ${lvWhere}`, lvParams
    );
    const [ldRows] = await pool.query(
      `SELECT lead_source, COUNT(*) AS cnt FROM customer_lead t WHERE ${ldWhere} GROUP BY lead_source`, ldParams
    );
    // 直播与投流数据来自同一张 live_stream 表
    const lvWhereFull = lvWhere;
    const [adRows] = await pool.query(
      `SELECT * FROM live_stream t WHERE ${lvWhereFull} ORDER BY live_date DESC`, lvParams
    );

    const svLeads = ldRows.find(r => r.lead_source === 'short_video')?.cnt || 0;
    const liveLeads = ldRows.find(r => r.lead_source === 'live_stream')?.cnt || 0;

    res.json({
      short_video: svRows[0],
      live_stream: lvRows[0],
      leads: { total: svLeads + liveLeads, short_video: svLeads, live_stream: liveLeads },
      ad_spend: adRows,  // 兼容旧字段名，实际为合并后的直播投流数据
      reconciliation: {
        short_video_reported: Number(svRows[0].leads),
        short_video_actual: Number(svLeads),
        live_reported: Number(lvRows[0].leads),
        live_actual: Number(liveLeads)
      }
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 操作日志：前端导出时调用记录；管理端读取
app.post('/api/logs', auth, async (req, res) => {
  const { action, target, detail } = req.body || {};
  await logOp(req.user, action || 'action', target || 'export', detail || '');
  res.json({ ok: true });
});
app.get('/api/logs', auth, async (req, res) => {
  if (!['admin','supervisor'].includes(req.user.role)) return res.status(403).json({ error: '无权限查看操作日志' });
  const limit = parseInt(req.query.limit) || 300;
  try {
    const [rows] = await pool.query('SELECT id, user_name, action, target, detail, created_at FROM operation_log ORDER BY created_at DESC, id DESC LIMIT ?', [limit]);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ============ 静态文件（前端） ============
app.use(express.static(STATIC_DIR));
app.get('/', (req, res) => {
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

// ============ 健康检查 ============
app.get('/health', (req, res) => res.json({ ok: true, ts: Date.now() }));

// 批量同步（示例数据/备份恢复）
app.post('/api/sync/:table', auth, async (req, res) => {
  const { table } = req.params;
  const records = req.body?.records || [];
  const mode = req.body?.mode || 'append';  // append | replace
  const map = {
    short_video: { table: 'short_video', dateCol: 'record_date', fromBody: (b,u)=>({
      record_date: b.record_date,
      platforms: JSON.stringify(b.platforms || []),
      video_category: b.video_category || '',
      operator: b.operator || '',
      account: b.account || '',
      video_count: Number(b.video_count) || 0,
      ad_spend: Number(b.ad_spend) || 0,
      leads_count: Number(b.leads_count) || 0,
      remark: b.remark || '',
      created_by: u.id
    })},
    live: { table: 'live_stream', dateCol: 'live_date', fromBody: (b,u)=>{
      let ld = b.live_date;
      if (ld && typeof ld === 'string' && ld.includes('T')) ld = ld.replace('T',' ')+(ld.length===16?':00':'');
      return {
        live_date: ld,
        session_number: b.session_number || '',
        host: b.host || '',
        duration_hours: Number(b.duration_hours) || 0,
        sv_spend: Number(b.sv_spend) || 0,
        live_spend: Number(b.live_spend) || 0,
        omni_spend: Number(b.omni_spend) || 0,
        mobile_live_spend: Number(b.mobile_live_spend) || 0,
        omni_deal_amount: Number(b.omni_deal_amount) || 0,
        omni_deal_count: Number(b.omni_deal_count) || 0,
        live_leads: Number(b.live_leads) || 0,
        sv_leads: Number(b.sv_leads) || 0,
        remark: b.remark || '',
        created_by: u.id
      };
    }},
    leads: { table: 'customer_lead', dateCol: 'get_date', fromBody: (b,u)=>({
      get_date: b.get_date,
      lead_source: b.lead_source || 'short_video',
      customer_name: b.customer_name || '',
      customer_phone: b.customer_phone || '',
      intent_demand: b.intent_demand || '',
      assigned_to: b.assigned_to || '',
      follow_status: b.follow_status || 'pending_contact',
      follow_records: JSON.stringify(b.follow_records || []),
      lead_form: b.lead_form || '',
      community: b.community || '',
      consult_content: b.consult_content || '',
      created_by: u.id
    })}
  };
  const cfg = map[table];
  if (!cfg) return res.status(400).json({ error: '未知表' });
  if (!canEdit(req.user)) return res.status(403).json({ error: '当前角色无录入权限' });
  const conn = await pool.getConnection();
  try {
    if (mode === 'replace') {
      if (req.user.role !== 'admin' && req.user.role !== 'supervisor') return res.status(403).json({ error: '仅管理员可覆盖导入' });
      const scope = scopeWhere(req.user, '');
      if (scope.sql !== '1=1') {
        await conn.query(`DELETE FROM ${cfg.table} WHERE ${scope.sql}`, scope.params);
      } else {
        await conn.query(`DELETE FROM ${cfg.table}`);
      }
    }
    let inserted = 0;
    for (const r of records) {
      const data = cfg.fromBody(r, req.user);
      const cols = Object.keys(data);
      await conn.query(
        `INSERT INTO ${cfg.table} (${cols.map(c=>'`'+c+'`').join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,
        cols.map(c => data[c])
      );
      inserted++;
    }
    res.json({ ok: true, inserted });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    conn.release();
  }
});

// ============ 用户管理（管理员） ============
const ROLES = ['admin', 'supervisor', 'operator', 'salesman', 'viewer'];

// 列出用户（admin/supervisor 可看）
app.get('/api/users', auth, async (req, res) => {
  if (!['admin', 'supervisor'].includes(req.user.role)) return res.status(403).json({ error: '无权限' });
  try {
    const [rows] = await pool.query('SELECT id, username, display_name, role, disabled, created_at FROM sys_user ORDER BY id');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// 创建用户（仅 admin）
app.post('/api/users', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可创建账号' });
  const { username, display_name, role, password } = req.body || {};
  if (!username || !password || !role) return res.status(400).json({ error: '用户名、密码、角色必填' });
  if (!ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
  try {
    const hash = await bcrypt.hash(password, 10);
    const [r] = await pool.query('INSERT INTO sys_user (username, password_hash, display_name, role) VALUES (?,?,?,?)', [username, hash, display_name || username, role]);
    // 同步到 staff 表，便于作为发布人/主播/分配对象
    try { await pool.query('INSERT IGNORE INTO staff (name) VALUES (?)', [display_name || username]); } catch (e) {}
    res.json({ ok: true, id: r.insertId });
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') return res.status(400).json({ error: '用户名或显示名已存在' });
    res.status(500).json({ error: e.message });
  }
});

// 修改用户（仅 admin）：角色 / 禁用 / 改密
app.patch('/api/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可修改账号' });
  const id = parseInt(req.params.id);
  const { display_name, role, disabled, password } = req.body || {};
  if (id === req.user.id && (disabled === true || (role && role !== 'admin'))) {
    return res.status(400).json({ error: '不能禁用自己或把自己降级为非管理员' });
  }
  const sets = []; const vals = [];
  if (display_name !== undefined) { sets.push('display_name=?'); vals.push(display_name); }
  if (role !== undefined) {
    if (!ROLES.includes(role)) return res.status(400).json({ error: '角色无效' });
    sets.push('role=?'); vals.push(role);
  }
  if (disabled !== undefined) { sets.push('disabled=?'); vals.push(disabled ? 1 : 0); }
  if (password) {
    if (password.length < 6) return res.status(400).json({ error: '密码至少 6 位' });
    sets.push('password_hash=?'); vals.push(await bcrypt.hash(password, 10));
  }
  if (sets.length === 0) return res.status(400).json({ error: '无修改项' });
  vals.push(id);
  await pool.query('UPDATE sys_user SET ' + sets.join(', ') + ' WHERE id=?', vals);
  res.json({ ok: true });
});

// 禁用/删除用户（仅 admin）
app.delete('/api/users/:id', auth, async (req, res) => {
  if (req.user.role !== 'admin') return res.status(403).json({ error: '仅管理员可删除账号' });
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: '不能删除自己的账号' });
  await pool.query('UPDATE sys_user SET disabled=1 WHERE id=?', [id]);
  res.json({ ok: true });
});

// 本人修改密码
app.post('/api/auth/change-password', auth, async (req, res) => {
  const { current_password, new_password } = req.body || {};
  if (!current_password || !new_password) return res.status(400).json({ error: '必填项缺失' });
  if (new_password.length < 6) return res.status(400).json({ error: '新密码至少 6 位' });
  try {
    const [rows] = await pool.query('SELECT password_hash FROM sys_user WHERE id=?', [req.user.id]);
    if (!rows.length) return res.status(404).json({ error: '用户不存在' });
    const ok = await bcrypt.compare(current_password, rows[0].password_hash);
    if (!ok) return res.status(400).json({ error: '当前密码不正确' });
    await pool.query('UPDATE sys_user SET password_hash=? WHERE id=?', [await bcrypt.hash(new_password, 10), req.user.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

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
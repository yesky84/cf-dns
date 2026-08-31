const express = require('express');
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');
const axios = require('axios');
const { exec } = require('child_process');

const app = express();
const PORT = process.env.PORT || 3000;

/* ================= 数据目录 & 数据库 ================= */
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

const db = new Database(path.join(dataDir, 'records.db'));
db.pragma('journal_mode = WAL');

/* ================= 建表（核心修复：之前漏建 records 表） ================= */
db.exec(`
CREATE TABLE IF NOT EXISTS accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  email TEXT NOT NULL,
  api_token TEXT NOT NULL,
  zone_name TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

db.exec(`
CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  account_id INTEGER DEFAULT NULL,
  domain TEXT,
  type TEXT DEFAULT 'A',
  content TEXT,
  proxied TEXT DEFAULT 'preserve',
  record_id TEXT DEFAULT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
)`);

/* 兼容旧库：缺列就补，已存在则忽略 */
try { db.exec('ALTER TABLE records ADD COLUMN account_id INTEGER DEFAULT NULL'); } catch (e) {}
try { db.exec('ALTER TABLE records ADD COLUMN record_id TEXT DEFAULT NULL'); } catch (e) {}

app.use(express.json());

/* ================= 单镜像：Node 直接托管前端页面 ================= */
const htmlDir = path.join(__dirname, '..', 'html');
if (fs.existsSync(htmlDir)) app.use(express.static(htmlDir));

/* ================= 日志 ================= */
const logFile = path.join(dataDir, 'update.log');
function addLog(message, level = 'info') {
  const time = new Date().toLocaleString('zh-CN', { hour12: false });
  try { fs.appendFileSync(logFile, `[${time}] [${level}] ${message}\n`); } catch (e) {}
}

/* ================= 账号接口 ================= */
app.get('/api/accounts', (req, res) => {
  try {
    const accounts = db.prepare(
      'SELECT id, name, email, zone_name, created_at FROM accounts ORDER BY id'
    ).all();
    res.json(accounts);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/accounts', (req, res) => {
  try {
    const { name, email, api_token, zone_name } = req.body;
    if (!name || !email || !api_token) {
      return res.status(400).json({ error: '名称、邮箱和 API Token 为必填项' });
    }
    const result = db.prepare(
      'INSERT INTO accounts (name, email, api_token, zone_name) VALUES (?, ?, ?, ?)'
    ).run(name, email, api_token, zone_name || null);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/accounts/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM accounts WHERE id = ?').run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 记录接口 ================= */
app.get('/api/records', (req, res) => {
  try {
    const records = db.prepare(
      'SELECT id, account_id, domain, type, content, proxied AS proxy, record_id, created_at FROM records ORDER BY id'
    ).all();
    res.json(records);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* 全量保存：前端每次编辑后把整张表发过来覆盖保存 */
app.post('/api/records', (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records)) {
      return res.status(400).json({ error: 'records 必须是数组' });
    }
    const saveAll = db.transaction(() => {
      db.prepare('DELETE FROM records').run();
      const insert = db.prepare(
        'INSERT INTO records (account_id, domain, type, content, proxied) VALUES (?, ?, ?, ?, ?)'
      );
      for (const r of records) {
        const domain = r.domain || '';
        const content = r.ip || r.content || '';
        /* 完全空白的行跳过，不落库 */
        if (!domain && !content) continue;
        insert.run(
          r.accountId || null,
          domain,
          r.type || 'A',
          content,
          r.proxy || 'preserve'
        );
      }
    });
    saveAll();
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 提交到 Cloudflare ================= */
app.post('/api/submit', async (req, res) => {
  try {
    const { records } = req.body;
    if (!Array.isArray(records) || records.length === 0) {
      return res.status(400).json({ success: false, error: '没有可提交的记录' });
    }

    const results = [];
    for (const r of records) {
      const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(r.accountId);
      if (!account) {
        results.push({ domain: r.domain, success: false, message: '未找到对应账号，请先创建账号' });
        addLog(`${r.domain} 提交失败：未找到账号`, 'error');
        continue;
      }

      const cfApi = axios.create({
        baseURL: 'https://api.cloudflare.com/client/v4',
        headers: {
          'Authorization': `Bearer ${account.api_token}`,
          'Content-Type': 'application/json'
        }
      });

      try {
        /* --- 1. 找 Zone --- */
        let zone = null;
        if (account.zone_name) {
          const zr = await cfApi.get(`/zones?name=${encodeURIComponent(account.zone_name)}`);
          zone = zr.data.result && zr.data.result[0];
        }
        if (!zone) {
          /* 逐级后缀尝试：a.b.example.com → b.example.com → example.com */
          const parts = (r.domain || '').split('.');
          for (let i = 1; i < parts.length - 1 && !zone; i++) {
            const candidate = parts.slice(i).join('.');
            const zr = await cfApi.get(`/zones?name=${encodeURIComponent(candidate)}`);
            if (zr.data.result && zr.data.result.length > 0) zone = zr.data.result[0];
          }
        }
        if (!zone) {
          results.push({ domain: r.domain, success: false, message: '找不到对应的 Zone，请检查账号 Token 权限或手动填写主域名' });
          addLog(`${r.domain} 提交失败：找不到 Zone`, 'error');
          continue;
        }
        const zoneId = zone.id;

        /* --- 2. 找已有记录 --- */
        let recordId = r.recordId;
        if (!recordId) {
          const listRes = await cfApi.get(
            `/zones/${zoneId}/dns_records?type=${r.type || 'A'}&name=${encodeURIComponent(r.domain)}`
          );
          if (listRes.data.result && listRes.data.result.length > 0) {
            recordId = listRes.data.result[0].id;
          }
        }

        /* --- 3. 构造 payload --- */
        const payload = {
          type: r.type || 'A',
          name: r.domain,
          content: r.ip || r.content
        };
        /* preserve = 不传 proxied 字段，Cloudflare 保持原状 */
        if (r.proxy === 'true') payload.proxied = true;
        else if (r.proxy === 'false') payload.proxied = false;

        /* --- 4. 更新或创建 --- */
        if (recordId) {
          await cfApi.put(`/zones/${zoneId}/dns_records/${recordId}`, payload);
        } else {
          const cr = await cfApi.post(`/zones/${zoneId}/dns_records`, payload);
          recordId = cr.data.result && cr.data.result.id;
        }

        /* --- 5. 回写 record_id，下次直接更新不再查询 --- */
        if (recordId && r.id) {
          try { db.prepare('UPDATE records SET record_id = ? WHERE id = ?').run(recordId, r.id); } catch (e) {}
        }

        results.push({ domain: r.domain, success: true, message: '更新成功' });
        addLog(`${r.domain} (${r.type || 'A'}) 更新成功`);
      } catch (err) {
        const msg = err.response
          ? JSON.stringify(err.response.data.errors || err.response.data)
          : err.message;
        results.push({ domain: r.domain, success: false, message: msg });
        addLog(`${r.domain} 更新失败: ${msg}`, 'error');
      }
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ================= Zone 查询（兼容保留） ================= */
app.get('/api/zone/:accountId/:domainName', async (req, res) => {
  try {
    const account = db.prepare('SELECT * FROM accounts WHERE id = ?').get(req.params.accountId);
    if (!account) return res.status(404).json({ error: '账号不存在' });
    const cfApi = axios.create({
      baseURL: 'https://api.cloudflare.com/client/v4',
      headers: { 'Authorization': `Bearer ${account.api_token}` }
    });
    const zr = await cfApi.get(`/zones?name=${encodeURIComponent(req.params.domainName)}`);
    res.json(zr.data.result && zr.data.result[0] ? zr.data.result[0] : null);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 日志接口 ================= */
app.get('/api/log', (req, res) => {
  try {
    if (!fs.existsSync(logFile)) return res.json([]);
    const content = fs.readFileSync(logFile, 'utf-8');
    const lines = content.trim().split('\n').filter(Boolean).slice(-200).reverse();
    res.json(lines.map(line => {
      const m = line.match(/^\[(.*?)\]\s*\[(\w+)\]\s*(.*)$/);
      if (m) return { time: m[1], level: m[2], message: m[3] };
      return { time: '', level: 'info', message: line };
    }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/log/clear', (req, res) => {
  try {
    fs.writeFileSync(logFile, '');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ================= 网络信息 ================= */
app.get('/api/network-info', (req, res) => {
  exec("ip route get 1.1.1.1 | awk '{print $7; exit}'", (err, stdout) => {
    res.json({ ip: err ? '获取失败' : stdout.trim() });
  });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

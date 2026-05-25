const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'melanite_secret_2025';

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

app.use(cors({ origin: '*', credentials: true }));
app.use(express.json());

// Барні категорії
const BAR_CATEGORIES = ['cocktails', 'beer', 'wine', 'soft', 'strong'];

function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Немає токену' });
  try { req.user = jwt.verify(token, JWT_SECRET); next(); }
  catch { res.status(401).json({ error: 'Невірний токен' }); }
}

async function savePushSub(sub) {
  try {
    await pool.query(
      `INSERT INTO melanite_push_subs (endpoint, sub_data)
       VALUES ($1, $2)
       ON CONFLICT (endpoint) DO UPDATE SET sub_data = $2`,
      [sub.endpoint, JSON.stringify(sub)]
    );
  } catch(e) { console.log('push sub save error:', e.message); }
}

async function getPushSubs() {
  try {
    const { rows } = await pool.query('SELECT sub_data FROM melanite_push_subs');
    return rows.map(r => JSON.parse(r.sub_data));
  } catch { return []; }
}

async function removePushSub(endpoint) {
  try {
    await pool.query('DELETE FROM melanite_push_subs WHERE endpoint = $1', [endpoint]);
  } catch {}
}

app.get('/', (req, res) => {
  res.json({ status: 'Melanite API працює ✅', version: '2.1.0' });
});

// LOGIN
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: 'Введіть логін та пароль' });
  try {
    const { rows } = await pool.query('SELECT * FROM melanite_admin WHERE username = $1', [username]);
    if (!rows.length) return res.status(401).json({ error: 'Невірний логін або пароль' });
    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Невірний логін або пароль' });
    const token = jwt.sign({ id: rows[0].id, username: rows[0].username }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, username: rows[0].username });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── MENU (кухня) ─────────────────────────────────────────────
app.get('/menu', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_menu WHERE is_active = true AND category != ALL($1) ORDER BY category, sort_order, id',
      [BAR_CATEGORIES]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/menu/all', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_menu WHERE category != ALL($1) ORDER BY category, sort_order, id',
      [BAR_CATEGORIES]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/menu', auth, async (req, res) => {
  const { category, name, description, weight, price, is_active, sort_order } = req.body;
  if (!category || !name || !price) return res.status(400).json({ error: 'category, name, price обовʼязкові' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO melanite_menu (category, name, description, weight, price, is_active, sort_order) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *',
      [category, name, description || '', weight || '', price, is_active ?? true, sort_order || 0]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/menu/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { category, name, description, weight, price, is_active, sort_order } = req.body;
  try {
    const { rows } = await pool.query(
      'UPDATE melanite_menu SET category=COALESCE($1,category), name=COALESCE($2,name), description=COALESCE($3,description), weight=COALESCE($4,weight), price=COALESCE($5,price), is_active=COALESCE($6,is_active), sort_order=COALESCE($7,sort_order) WHERE id=$8 RETURNING *',
      [category, name, description, weight, price, is_active, sort_order, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Страву не знайдено' });
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/menu/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM melanite_menu WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.patch('/menu/:id/toggle', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('UPDATE melanite_menu SET is_active = NOT is_active WHERE id=$1 RETURNING *', [req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── BAR (напої) ───────────────────────────────────────────────
// Публічний — тільки активні барні позиції
app.get('/bar', async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_menu WHERE is_active = true AND category = ANY($1) ORDER BY category, sort_order, id',
      [BAR_CATEGORIES]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Адмін — всі барні позиції
app.get('/bar/all', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_menu WHERE category = ANY($1) ORDER BY category, sort_order, id',
      [BAR_CATEGORIES]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Додати барну позицію (той самий /menu endpoint, просто категорія барна)
// Редагування, видалення, toggle — ті самі /menu/:id endpoints

// ── BOOKINGS ─────────────────────────────────────────────────
app.get('/bookings', auth, async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM melanite_bookings ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/bookings', async (req, res) => {
  const { name, phone, date, guests, wishes } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Імʼя та телефон обовʼязкові' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO melanite_bookings (name, phone, date, guests, wishes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, phone, date || null, guests || '', wishes || '']
    );
    const booking = rows[0];

    const subs = await getPushSubs();
    if (subs.length > 0) {
      const payload = JSON.stringify({
        title: '🍽 Нове бронювання!',
        body: `${name} · ${phone} · ${guests || 'гості'} · ${date || 'дата не вказана'}`,
        icon: '/icon-192.png',
        badge: '/icon-192.png',
        data: { url: '/admin.html' }
      });
      for (const sub of subs) {
        try {
          await pool.query(
            'INSERT INTO melanite_notifications (payload, created_at) VALUES ($1, NOW())',
            [payload]
          );
          break;
        } catch {}
      }
    }

    res.status(201).json(booking);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.put('/bookings/:id', auth, async (req, res) => {
  const { status } = req.body;
  try {
    const { rows } = await pool.query('UPDATE melanite_bookings SET status=$1 WHERE id=$2 RETURNING *', [status, req.params.id]);
    res.json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/bookings/:id', auth, async (req, res) => {
  try {
    await pool.query('DELETE FROM melanite_bookings WHERE id = $1', [req.params.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// REVIEWS
app.get('/reviews', async (req, res) => {
  try {
    const { rows } = await pool.query('SELECT * FROM melanite_reviews WHERE is_active = true ORDER BY created_at DESC');
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/reviews', async (req, res) => {
  const { name, rating, text } = req.body;
  if (!name || !rating || !text) return res.status(400).json({ error: 'Всі поля обовʼязкові' });
  try {
    const { rows } = await pool.query(
      'INSERT INTO melanite_reviews (name, rating, text) VALUES ($1,$2,$3) RETURNING *',
      [name, rating, text]
    );
    res.status(201).json(rows[0]);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// PUSH
app.post('/push/subscribe', auth, async (req, res) => {
  try {
    await savePushSub(req.body);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/push/subscribe', auth, async (req, res) => {
  try {
    await removePushSub(req.body.endpoint);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.get('/push/poll', auth, async (req, res) => {
  try {
    const since = req.query.since || new Date(0).toISOString();
    const { rows } = await pool.query(
      'SELECT * FROM melanite_notifications WHERE created_at > $1 ORDER BY created_at DESC LIMIT 10',
      [since]
    );
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// CHANGE PASSWORD
app.put('/admin/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const { rows } = await pool.query('SELECT * FROM melanite_admin WHERE id = $1', [req.user.id]);
    const valid = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Старий пароль невірний' });
    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query('UPDATE melanite_admin SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
    res.json({ success: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, () => {
  console.log(`🖤 Melanite API v2.1 на порту ${PORT}`);

  const https = require('https');
  const SELF_URL = process.env.SELF_URL || 'https://melanite-api.onrender.com';
  setInterval(() => {
    https.get(SELF_URL, (res) => {
      console.log(`♻️ Keep-alive: ${res.statusCode}`);
    }).on('error', () => {});
  }, 14 * 60 * 1000);
});

const express = require('express');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'melanite_secret_2025';

// DB
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// Middleware
app.use(cors({
  origin: ['https://melanite.vercel.app', 'http://localhost:3000', '*'],
  credentials: true
}));
app.use(express.json());

// ── Auth middleware ──────────────────────────────────────────
function auth(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) return res.status(401).json({ error: 'Немає токену' });
  try {
    req.user = jwt.verify(token, JWT_SECRET);
    next();
  } catch {
    res.status(401).json({ error: 'Невірний токен' });
  }
}

// ── ROUTES ───────────────────────────────────────────────────

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'Melanite API працює ✅', version: '1.0.0' });
});

// POST /login
app.post('/login', async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Введіть логін та пароль' });

  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_admin WHERE username = $1', [username]
    );
    if (!rows.length)
      return res.status(401).json({ error: 'Невірний логін або пароль' });

    const valid = await bcrypt.compare(password, rows[0].password_hash);
    if (!valid)
      return res.status(401).json({ error: 'Невірний логін або пароль' });

    const token = jwt.sign(
      { id: rows[0].id, username: rows[0].username },
      JWT_SECRET,
      { expiresIn: '24h' }
    );
    res.json({ token, username: rows[0].username });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu — всі активні страви (публічний)
app.get('/menu', async (req, res) => {
  try {
    const { rows } = await pool.query(
      `SELECT * FROM melanite_menu
       WHERE is_active = true
       ORDER BY category, sort_order, id`
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /menu/all — всі страви (адмін)
app.get('/menu/all', auth, async (req, res) => {
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_menu ORDER BY category, sort_order, id'
    );
    res.json(rows);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// POST /menu — додати страву
app.post('/menu', auth, async (req, res) => {
  const { category, name, description, weight, price, is_active, sort_order } = req.body;
  if (!category || !name || !price)
    return res.status(400).json({ error: 'category, name, price обовʼязкові' });

  try {
    const { rows } = await pool.query(
      `INSERT INTO melanite_menu (category, name, description, weight, price, is_active, sort_order)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [category, name, description || '', weight || '', price, is_active ?? true, sort_order || 0]
    );
    res.status(201).json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /menu/:id — редагувати страву
app.put('/menu/:id', auth, async (req, res) => {
  const { id } = req.params;
  const { category, name, description, weight, price, is_active, sort_order } = req.body;

  try {
    const { rows } = await pool.query(
      `UPDATE melanite_menu SET
        category = COALESCE($1, category),
        name = COALESCE($2, name),
        description = COALESCE($3, description),
        weight = COALESCE($4, weight),
        price = COALESCE($5, price),
        is_active = COALESCE($6, is_active),
        sort_order = COALESCE($7, sort_order)
       WHERE id = $8 RETURNING *`,
      [category, name, description, weight, price, is_active, sort_order, id]
    );
    if (!rows.length) return res.status(404).json({ error: 'Страву не знайдено' });
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE /menu/:id — видалити страву
app.delete('/menu/:id', auth, async (req, res) => {
  const { id } = req.params;
  try {
    await pool.query('DELETE FROM melanite_menu WHERE id = $1', [id]);
    res.json({ success: true, message: 'Страву видалено' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PATCH /menu/:id/toggle — вкл/викл страву
app.patch('/menu/:id/toggle', auth, async (req, res) => {
  const { id } = req.params;
  try {
    const { rows } = await pool.query(
      `UPDATE melanite_menu SET is_active = NOT is_active
       WHERE id = $1 RETURNING *`, [id]
    );
    res.json(rows[0]);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// PUT /admin/password — змінити пароль
app.put('/admin/password', auth, async (req, res) => {
  const { oldPassword, newPassword } = req.body;
  try {
    const { rows } = await pool.query(
      'SELECT * FROM melanite_admin WHERE id = $1', [req.user.id]
    );
    const valid = await bcrypt.compare(oldPassword, rows[0].password_hash);
    if (!valid) return res.status(401).json({ error: 'Старий пароль невірний' });

    const hash = await bcrypt.hash(newPassword, 10);
    await pool.query(
      'UPDATE melanite_admin SET password_hash = $1 WHERE id = $2',
      [hash, req.user.id]
    );
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log(`🖤 Melanite API запущено на порту ${PORT}`);
});

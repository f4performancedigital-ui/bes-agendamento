const express = require('express');
const { google } = require('googleapis');
const nodemailer = require('nodemailer');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
require('dotenv').config();

const app = express();
const db = new Database('agendamentos.db');
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, login TEXT UNIQUE, senha TEXT, role TEXT
  );
  CREATE TABLE IF NOT EXISTS agendamentos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nome TEXT, tel TEXT, email TEXT, assunto TEXT,
    closer TEXT, sdr TEXT, data TEXT, hora TEXT,
    duracao INTEGER, status TEXT DEFAULT 'pendente',
    obs TEXT, meet_link TEXT, calendar_event_id TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
  );
`);

const adminExists = db.prepare('SELECT id FROM users WHERE login = ?').get('admin');
if (!adminExists) {
  const insert = db.prepare('INSERT INTO users (nome, login, senha, role) VALUES (?, ?, ?, ?)');
  insert.run('Admin BES', 'admin', 'admin123', 'admin');
  insert.run('Ana Paula', 'ana', '123456', 'sdr');
  insert.run('Carla Souza', 'carla', '123456', 'sdr');
  insert.run('Fernanda Lima', 'fernanda', '123456', 'sdr');
  insert.run('Dr. Marcos', 'marcos', '123456', 'closer');
  insert.run('Dra. Juliana', 'juliana', '123456', 'closer');
}

const oauth2Client = new google.auth.OAuth2(
  process.env.GOOGLE_CLIENT_ID,
  process.env.GOOGLE_CLIENT_SECRET,
  process.env.GOOGLE_REDIRECT_URI
);

let tokens = null;

app.get('/auth/google', (req, res) => {
  const url = oauth2Client.generateAuthUrl({
    access_type: 'offline',
    scope: [
      'https://www.googleapis.com/auth/calendar',
      'https://www.googleapis.com/auth/gmail.send'
    ]
  });
  res.redirect(url);
});

app.get('/callback', async (req, res) => {
  const { code } = req.query;
  const { tokens: t } = await oauth2Client.getToken(code);
  tokens = t;
  oauth2Client.setCredentials(tokens);
  res.send('<h2>Google conectado! Pode fechar esta aba.</h2>');
});

app.post('/api/login', (req, res) => {
  const { login, senha } = req.body;
  const user = db.prepare('SELECT * FROM users WHERE login = ? AND senha = ?').get(login, senha);
  if (!user) return res.status(401).json({ error: 'Credenciais inválidas' });
  res.json({ id: user.id, nome: user.nome, role: user.role, login: user.login });
});

app.get('/api/users', (req, res) => {
  res.json(db.prepare('SELECT id, nome, login, role FROM users').all());
});

app.post('/api/users', (req, res) => {
  const { nome, login, senha, role } = req.body;
  try {
    const r = db.prepare('INSERT INTO users (nome, login, senha, role) VALUES (?, ?, ?, ?)').run(nome, login, senha, role);
    res.json({ id: r.lastInsertRowid, nome, login, role });
  } catch (e) {
    res.status(400).json({ error: 'Login já existe' });
  }
});

app.get('/api/agendamentos', (req, res) => {
  res.json(db.prepare('SELECT * FROM agendamentos ORDER BY data DESC, hora ASC').all());
});

app.get('/api/agendamentos/slots', (req, res) => {
  const { data } = req.query;
  const ocupados = db.prepare("SELECT hora FROM agendamentos WHERE data = ? AND status != 'cancelado'").all(data);
  res.json(ocupados.map(r => r.hora));
});

app.post('/api/agendamentos', async (req, res) => {
  const { nome, tel, email, assunto, closer, sdr, data, hora, duracao, obs } = req.body;
  let meetLink = '', calendarEventId = '';

  if (tokens) {
    try {
      oauth2Client.setCredentials(tokens);
      const calendar = google.calendar({ version: 'v3', auth: oauth2Client });
      const [year, month, day] = data.split('-');
      const [hh, mm] = hora.split(':');
      const start = new Date(year, month - 1, day, hh, mm);
      const end = new Date(start.getTime() + duracao * 60000);

      const event = await calendar.events.insert({
        calendarId: 'primary',
        conferenceDataVersion: 1,
        requestBody: {
          summary: `Reunião: ${nome} — ${assunto || 'Consulta'}`,
          description: `Lead: ${nome}\nTelefone: ${tel}\nSDR: ${sdr}\nCloser: ${closer}`,
          start: { dateTime: start.toISOString(), timeZone: 'America/Sao_Paulo' },
          end: { dateTime: end.toISOString(), timeZone: 'America/Sao_Paulo' },
          attendees: [{ email }],
          conferenceData: {
            createRequest: { requestId: `bes-${Date.now()}`, conferenceSolutionKey: { type: 'hangoutsMeet' } }
          }
        }
      });

      meetLink = event.data.hangoutLink || '';
      calendarEventId = event.data.id || '';
      await sendEmail({ nome, email, data, hora, closer, meetLink, assunto });
    } catch (err) {
      console.error('Google API error:', err.message);
    }
  }

  const r = db.prepare(`
    INSERT INTO agendamentos (nome, tel, email, assunto, closer, sdr, data, hora, duracao, obs, meet_link, calendar_event_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(nome, tel, email, assunto, closer, sdr, data, hora, duracao, obs, meetLink, calendarEventId);

  res.json({ id: r.lastInsertRowid, meetLink });
});

app.patch('/api/agendamentos/:id', (req, res) => {
  db.prepare('UPDATE agendamentos SET status = ? WHERE id = ?').run(req.body.status, req.params.id);
  res.json({ ok: true });
});

async function sendEmail({ nome, email, data, hora, closer, meetLink, assunto }) {
  if (!tokens) return;
  oauth2Client.setCredentials(tokens);
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const [y, m, d] = data.split('-');
  const body = `Olá, ${nome}!\n\nSeu agendamento foi confirmado.\n\nData: ${d}/${m}/${y}\nHorário: ${hora}\nAdvogado(a): ${closer}\nAssunto: ${assunto || 'Consulta Jurídica'}\n${meetLink ? '\nLink Google Meet:\n' + meetLink : ''}\n\nAtenciosamente,\nEquipe BES Advogados da Gestante`;
  const msg = [`To: ${email}`, `Subject: =?UTF-8?B?${Buffer.from('Agendamento Confirmado — BES Advogados').toString('base64')}?=`, 'MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', Buffer.from(body).toString('base64')].join('\n');
  const encoded = Buffer.from(msg).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  await gmail.users.messages.send({ userId: 'me', requestBody: { raw: encoded } });
}

app.get('/api/stats', (req, res) => {
  const now = new Date();
  const mes = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  const total = db.prepare(`SELECT COUNT(*) as c FROM agendamentos WHERE data LIKE ?`).get(`${mes}%`).c;
  const confirmed = db.prepare(`SELECT COUNT(*) as c FROM agendamentos WHERE data LIKE ? AND status IN ('confirmado','realizado')`).get(`${mes}%`).c;
  const cancelled = db.prepare(`SELECT COUNT(*) as c FROM agendamentos WHERE data LIKE ? AND status = 'cancelado'`).get(`${mes}%`).c;
  const byWeek = [1,2,3,4,5].map(w => db.prepare(`SELECT COUNT(*) as c FROM agendamentos WHERE data LIKE ? AND CAST(substr(data,9,2) AS INTEGER) BETWEEN ? AND ?`).get(`${mes}%`, (w-1)*7+1, w*7).c);
  const bySdr = db.prepare(`SELECT sdr, COUNT(*) as c FROM agendamentos WHERE data LIKE ? GROUP BY sdr`).all(`${mes}%`);
  res.json({ total, confirmed, cancelled, byWeek, bySdr });
});

app.get('/api/google-status', (req, res) => res.json({ connected: !!tokens }));

app.listen(PORT, () => console.log(`BES Agendamentos rodando na porta ${PORT}`));// v2

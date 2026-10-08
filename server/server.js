// server.js
// the file you run, express server, every /api route + serves the public folder

const express = require('express');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const db = require('./db');

const app = express();
const PORT = process.env.PORT || 3000;

// pictures on cards, tests use a throwaway folder for this
const uploadsFolder = process.env.MEMRO_UPLOADS
  || path.join(__dirname, '..', 'data', 'uploads');

fs.mkdirSync(uploadsFolder, { recursive: true });

// bumped up from the 100kb default
app.use(express.json({ limit: '8mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));
app.use('/uploads', express.static(uploadsFolder));

// quill comes from node_modules not a cdn
app.use('/vendor/quill', express.static(
  path.join(__dirname, '..', 'node_modules', 'quill', 'dist')
));

// deleting a card/set doesnt delete its pictures
const KEEP_NEW_PICTURES_FOR = 60 * 60 * 1000;

function tidyUploads() {
  try {
    const inUse = db.picturesInUse();
    const now = Date.now();

    for (const name of fs.readdirSync(uploadsFolder)) {
      if (inUse.has(name)) continue;

      const file = path.join(uploadsFolder, name);
      if (now - fs.statSync(file).mtimeMs < KEEP_NEW_PICTURES_FOR) continue;

      fs.unlinkSync(file);
    }
  } catch (error) {
    // dont let this fail someones delete
    console.error('Could not tidy the uploads folder:', error.message);
  }
}

// login helper

// pulling the token out by hand, express doesnt do cookies
function readToken(req) {
  const header = req.headers.cookie;
  if (!header) return null;
  for (const part of header.split(';')) {
    const [name, value] = part.trim().split('=');
    if (name === 'memro_session') return value;
  }
  return null;
}

// puts the logged in user on the request, or nothing if not logged in
function loadUser(req, res, next) {
  req.user = db.getUserByToken(readToken(req));
  next();
}

// for routes that only make sense logged in
function mustBeLoggedIn(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'You need to log in first.' });
  next();
}

// a set is visible if its mine or public, progress routes use this
function canSeeSet(set, user) {
  return Boolean(set) && (set.is_public === 1 || (user && set.owner_id === user.id));
}

// for routes that change a set, cant edit someone elses
function mustOwnSet(req, res, next) {
  const set = db.getSet(Number(req.params.id));
  if (!set) return res.status(404).json({ error: 'Set not found.' });
  if (set.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'This set belongs to someone else.' });
  }
  req.set = set;
  next();
}

app.use(loadUser);

// accounts

app.post('/api/register', (req, res) => {
  const { username, password, email } = req.body ?? {};

  const name = typeof username === 'string' ? username.trim() : '';

  if (name.length < 3) {
    return res.status(400).json({ error: 'Username needs at least 3 characters.' });
  }
  // upper bound too, someone could just post 100k characters otherwise
  if (name.length > 30) {
    return res.status(400).json({ error: 'Username has to be 30 characters or fewer.' });
  }
  if (typeof password !== 'string' || password.length < 6) {
    return res.status(400).json({ error: 'Password needs at least 6 characters.' });
  }
  if (db.getUserByName(name)) {
    return res.status(409).json({ error: 'That username is already taken.' });
  }

  // email is optional, kept if it looks real, dropped if it doesnt
  const address = typeof email === 'string' ? email.trim() : '';
  const keep = address.length > 0 && address.length <= 120 && /^[^\s@]+@[^\s@]+$/.test(address)
    ? address
    : null;

  const user = db.createUser(name, password, keep);
  const token = db.createSession(user.id);
  res.setHeader('Set-Cookie', `memro_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.status(201).json({ user });
});

app.post('/api/login', (req, res) => {
  const { username, password } = req.body ?? {};
  const row = db.getUserByName((username || '').trim());

  // same error either way
  if (!row || !db.checkPassword(password || '', row.password_hash)) {
    return res.status(401).json({ error: 'Wrong username or password.' });
  }

  const token = db.createSession(row.id);
  res.setHeader('Set-Cookie', `memro_session=${token}; HttpOnly; Path=/; SameSite=Lax`);
  res.json({ user: db.getUserById(row.id) });
});

app.post('/api/logout', (req, res) => {
  const token = readToken(req);
  if (token) db.deleteSession(token);
  res.setHeader('Set-Cookie', 'memro_session=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax');
  res.json({ ok: true });
});

// page calls this on load to check whos logged in
app.get('/api/me', (req, res) => {
  res.json({ user: req.user || null });
});

// saving colours to the account, null resets to default
app.put('/api/theme', mustBeLoggedIn, (req, res) => {
  const { theme } = req.body ?? {};

  if (theme !== null && theme !== undefined) {
    const wanted = ['accent', 'known', 'unknown', 'background'];
    const colour = /^#[0-9a-fA-F]{6}$/;

    // only these 4 keys and real hex colours
    const clean = {};
    for (const key of wanted) {
      if (!colour.test(theme[key] || '')) {
        return res.status(400).json({ error: `${key} must be a colour like #1d2430.` });
      }
      clean[key] = theme[key].toLowerCase();
    }
    return res.json({ user: db.setTheme(req.user.id, clean) });
  }

  res.json({ user: db.setTheme(req.user.id, null) });
});

// sets

// home screen, ?q= filters by text, ?public=1 shows everyones public sets too
app.get('/api/sets', mustBeLoggedIn, (req, res) => {
  const includePublic = req.query.public === '1';
  res.json({ sets: db.findSets(req.user.id, req.query.q, includePublic) });
});

// same list but no owner so only public sets show, this is what a visitor sees
app.get('/api/sets/search', (req, res) => {
  res.json({ sets: db.findSets(null, req.query.q, true) });
});

app.post('/api/sets', mustBeLoggedIn, (req, res) => {
  const { title, description, isPublic } = req.body ?? {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Give the set a title.' });
  }
  res.status(201).json({ set: db.createSet(req.user.id, title.trim(), description, isPublic) });
});

app.get('/api/sets/:id', (req, res) => {
  const set = db.getSet(Number(req.params.id));
  if (!set) return res.status(404).json({ error: 'Set not found.' });

  // private set only visible to its owner
  const mine = Boolean(req.user && set.owner_id === req.user.id);
  if (!canSeeSet(set, req.user)) {
    return res.status(403).json({ error: 'This set is private.' });
  }

  const cards = req.user
    ? db.getCardsWithProgress(set.id, req.user.id)
    : db.getCards(set.id);
  const progress = req.user ? db.getSetProgress(set.id, req.user.id) : null;

  res.json({ set, cards, progress, mine: Boolean(mine) });
});

app.put('/api/sets/:id', mustBeLoggedIn, mustOwnSet, (req, res) => {
  const { title, description, isPublic } = req.body ?? {};
  if (!title || !title.trim()) {
    return res.status(400).json({ error: 'Give the set a title.' });
  }
  res.json({ set: db.updateSet(req.set.id, title.trim(), description, isPublic) });
});

app.delete('/api/sets/:id', mustBeLoggedIn, mustOwnSet, (req, res) => {
  db.deleteSet(req.set.id);
  tidyUploads();
  res.json({ ok: true });
});

// add a set by its share code, gives an editable copy
app.post('/api/sets/add-by-code', mustBeLoggedIn, (req, res) => {
  const { code } = req.body ?? {};
  if (!code) return res.status(400).json({ error: 'Type a code first.' });

  const found = db.getSetByCode(code.trim());
  if (!found) return res.status(404).json({ error: 'No set has that code.' });
  if (found.owner_id === req.user.id) {
    return res.status(400).json({ error: 'That set is already yours.' });
  }

  res.status(201).json({ set: db.copySet(found.id, req.user.id) });
});

// cards

app.post('/api/sets/:id/cards', mustBeLoggedIn, mustOwnSet, (req, res) => {
  const { question, answer } = req.body ?? {};
  if (!question || !question.trim() || !answer || !answer.trim()) {
    return res.status(400).json({ error: 'A card needs both a question and an answer.' });
  }
  res.status(201).json({ card: db.addCard(req.set.id, question.trim(), answer.trim()) });
});

app.put('/api/cards/:cardId', mustBeLoggedIn, (req, res) => {
  const card = db.getCard(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'Card not found.' });

  const set = db.getSet(card.set_id);
  if (set.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'This card belongs to someone else.' });
  }

  const { question, answer } = req.body ?? {};
  if (!question || !answer) {
    return res.status(400).json({ error: 'A card needs both a question and an answer.' });
  }

  const updated = db.updateCard(card.id, question.trim(), answer.trim());
  tidyUploads(); // a picture may have been taken off the card
  res.json({ card: updated });
});

app.delete('/api/cards/:cardId', mustBeLoggedIn, (req, res) => {
  const card = db.getCard(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'Card not found.' });

  const set = db.getSet(card.set_id);
  if (set.owner_id !== req.user.id) {
    return res.status(403).json({ error: 'This card belongs to someone else.' });
  }

  db.deleteCard(card.id);
  tidyUploads();
  res.json({ ok: true });
});

// pictures

// types allowed on disk + what extension each gets
const IMAGE_TYPES = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// browser sends as data url, server decodes/checks/saves it
app.post('/api/images', mustBeLoggedIn, (req, res) => {
  const { data } = req.body ?? {};

  const match = /^data:([\w/+-]+);base64,(.+)$/.exec(data || '');
  if (!match) return res.status(400).json({ error: 'That does not look like a picture.' });

  const extension = IMAGE_TYPES[match[1]];
  if (!extension) {
    return res.status(400).json({ error: 'Pictures have to be png, jpg, gif or webp.' });
  }

  const bytes = Buffer.from(match[2], 'base64');
  if (bytes.length === 0) {
    return res.status(400).json({ error: 'That picture is empty.' });
  }
  if (bytes.length > MAX_IMAGE_BYTES) {
    return res.status(413).json({ error: 'Pictures have to be under 2 MB.' });
  }

  const name = crypto.randomBytes(12).toString('hex') + extension;
  fs.writeFileSync(path.join(uploadsFolder, name), bytes);

  res.status(201).json({ url: '/uploads/' + name });
});

// studying

// runs every time i know / i dont know gets pressed
app.post('/api/cards/:cardId/answer', mustBeLoggedIn, (req, res) => {
  const { status } = req.body ?? {};
  if (status !== 'known' && status !== 'unknown') {
    return res.status(400).json({ error: "status must be 'known' or 'unknown'." });
  }

  const card = db.getCard(Number(req.params.cardId));
  if (!card) return res.status(404).json({ error: 'Card not found.' });

  if (!canSeeSet(db.getSet(card.set_id), req.user)) {
    return res.status(403).json({ error: 'This set is private.' });
  }

  db.setStatus(req.user.id, card.id, status);
  res.json({ progress: db.getSetProgress(card.set_id, req.user.id) });
});

// brings local progress onto the account, signup only not login
app.post('/api/progress/import', mustBeLoggedIn, (req, res) => {
  const { progress } = req.body ?? {};

  if (!progress || typeof progress !== 'object') {
    return res.status(400).json({ error: 'There was nothing to bring over.' });
  }

  let brought = 0;

  for (const [cardId, status] of Object.entries(progress)) {
    if (status !== 'known' && status !== 'unknown') continue;

    // same rules as answering normally, card has to exist + has to be visible
    const card = db.getCard(Number(cardId));
    if (!card || !canSeeSet(db.getSet(card.set_id), req.user)) continue;

    db.setStatus(req.user.id, card.id, status);
    brought++;
  }

  res.json({ brought });
});

app.post('/api/sets/:id/reset', mustBeLoggedIn, (req, res) => {
  const set = db.getSet(Number(req.params.id));
  if (!set) return res.status(404).json({ error: 'Set not found.' });

  if (!canSeeSet(set, req.user)) {
    return res.status(403).json({ error: 'This set is private.' });
  }

  res.json({ progress: db.resetSetProgress(set.id, req.user.id) });
});

// catch-all for /api, otherwise itd fall through to the html page
app.use('/api', (req, res) => res.status(404).json({ error: 'Unknown endpoint.' }));

function start(port = PORT) {
  db.createTables();

  // tidying up from previous runs, old pictures + old logins
  tidyUploads();
  db.removeOldSessions();
  const server = app.listen(port, () => {
    console.log(`Memro is running on http://localhost:${server.address().port}`);
  });
  return server;
}

if (require.main === module) start();

module.exports = { app, start };

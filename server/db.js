// db.js
// all the database stuff, sqlite, one file on disk, normal sql

const { DatabaseSync } = require('node:sqlite');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dataFolder = path.join(__dirname, '..', 'data');
const dbFile = process.env.MEMRO_DB || path.join(dataFolder, 'memro.db');

// makes the data folder if its missing
if (dbFile !== ':memory:' && !fs.existsSync(dataFolder)) {
  fs.mkdirSync(dataFolder, { recursive: true });
}

const db = new DatabaseSync(dbFile);

// deleting a set also deletes its cards this way
db.exec('PRAGMA foreign_keys = ON');

// tables

function createTables() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id            INTEGER PRIMARY KEY,
      username      TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      email         TEXT,
      created_at    TEXT NOT NULL
    );

    -- one row per login, token goes in a cookie
    CREATE TABLE IF NOT EXISTS sessions (
      token      TEXT PRIMARY KEY,
      user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sets (
      id          INTEGER PRIMARY KEY,
      owner_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      title       TEXT NOT NULL,
      description TEXT,
      is_public   INTEGER NOT NULL DEFAULT 0,
      share_code  TEXT NOT NULL UNIQUE,
      created_at  TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS cards (
      id       INTEGER PRIMARY KEY,
      set_id   INTEGER NOT NULL REFERENCES sets(id) ON DELETE CASCADE,
      question TEXT NOT NULL,
      answer   TEXT NOT NULL
    );

    -- status is known or unknown, no row = not seen yet
    CREATE TABLE IF NOT EXISTS progress (
      user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      card_id INTEGER NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
      status  TEXT NOT NULL,
      PRIMARY KEY (user_id, card_id)
    );
  `);

  // colours as json, added manually since this table already existed
  const columns = db.prepare('PRAGMA table_info(users)').all();
  if (!columns.some((c) => c.name === 'theme')) {
    db.exec('ALTER TABLE users ADD COLUMN theme TEXT');
  }
}

function now() {
  return new Date().toISOString();
}

// passwords

// hash with scrypt (built into node), salted
function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function checkPassword(password, stored) {
  const [salt, hash] = stored.split(':');
  const attempt = crypto.scryptSync(password, salt, 64).toString('hex');
  // timingSafeEqual instead of ===
  const a = Buffer.from(hash, 'hex');
  const b = Buffer.from(attempt, 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

// users

function createUser(username, password, email) {
  const stmt = db.prepare(
    'INSERT INTO users (username, password_hash, email, created_at) VALUES (?, ?, ?, ?)'
  );
  const result = stmt.run(username, hashPassword(password), email || null, now());
  return getUserById(result.lastInsertRowid);
}

function getUserByName(username) {
  return db.prepare('SELECT * FROM users WHERE username = ?').get(username);
}

function getUserById(id) {
  return db.prepare(
    'SELECT id, username, email, theme, created_at FROM users WHERE id = ?'
  ).get(id);
}

// saves colours to the account instead of just the browser, null = reset
function setTheme(userId, theme) {
  db.prepare('UPDATE users SET theme = ? WHERE id = ?')
    .run(theme ? JSON.stringify(theme) : null, userId);
  return getUserById(userId);
}

// sessions

function createSession(userId) {
  const token = crypto.randomBytes(24).toString('hex');
  db.prepare('INSERT INTO sessions (token, user_id, created_at) VALUES (?, ?, ?)')
    .run(token, userId, now());
  return token;
}

function getUserByToken(token) {
  if (!token) return undefined;
  const row = db.prepare('SELECT user_id FROM sessions WHERE token = ?').get(token);
  return row ? getUserById(row.user_id) : undefined;
}

function deleteSession(token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

// clears old sessions, doubles as expiry after 30 days
function removeOldSessions(days = 30) {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
  return db.prepare('DELETE FROM sessions WHERE created_at < ?').run(cutoff).changes;
}

// sets

// short code to add someone elses set, no O or 0
function makeShareCode() {
  const letters = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += letters[crypto.randomInt(letters.length)];
  }
  // try again if the code exists already
  const taken = db.prepare('SELECT 1 FROM sets WHERE share_code = ?').get(code);
  return taken ? makeShareCode() : code;
}

function createSet(ownerId, title, description, isPublic) {
  const stmt = db.prepare(
    `INSERT INTO sets (owner_id, title, description, is_public, share_code, created_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  const result = stmt.run(ownerId, title, description || '', isPublic ? 1 : 0, makeShareCode(), now());
  return getSet(result.lastInsertRowid);
}

function getSet(id) {
  return db.prepare(
    `SELECT s.*, u.username AS owner_name,
            (SELECT COUNT(*) FROM cards WHERE cards.set_id = s.id) AS card_count
       FROM sets s
       JOIN users u ON u.id = s.owner_id
      WHERE s.id = ?`
  ).get(id);
}

function getSetByCode(code) {
  const row = db.prepare('SELECT id FROM sets WHERE share_code = ?').get(code.toUpperCase());
  return row ? getSet(row.id) : undefined;
}

// the one query behind every set list in the app
// userId = whose sets count as yours (null if logged out)
// text = search box, includePublic = also show everyone elses public sets
// own sets show first, a public one of mine doesnt show up twice
function findSets(userId, text, includePublic) {
  const like = `%${text || ''}%`;
  return db.prepare(
    `SELECT s.*, u.username AS owner_name,
            (SELECT COUNT(*) FROM cards WHERE cards.set_id = s.id) AS card_count,
            (s.owner_id = ?) AS mine
       FROM sets s
       JOIN users u ON u.id = s.owner_id
      WHERE (s.owner_id = ? OR (? = 1 AND s.is_public = 1))
        AND (s.title LIKE ? OR s.description LIKE ? OR u.username LIKE ?)
      ORDER BY mine DESC, s.created_at DESC`
  ).all(userId, userId, includePublic ? 1 : 0, like, like, like);
}

function updateSet(setId, title, description, isPublic) {
  db.prepare('UPDATE sets SET title = ?, description = ?, is_public = ? WHERE id = ?')
    .run(title, description || '', isPublic ? 1 : 0, setId);
  return getSet(setId);
}

function deleteSet(setId) {
  db.prepare('DELETE FROM sets WHERE id = ?').run(setId);
}

// copying gives an editable version, doesnt touch the original
// runs in a transaction
function copySet(setId, newOwnerId) {
  const original = getSet(setId);
  if (!original) return undefined;

  db.exec('BEGIN');
  try {
    const copy = createSet(
      newOwnerId,
      original.title,
      original.description,
      false // a copy starts private
    );

    for (const card of getCards(setId)) {
      addCard(copy.id, card.question, card.answer);
    }

    db.exec('COMMIT');
    return getSet(copy.id);
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

// cards

function getCards(setId) {
  return db.prepare('SELECT * FROM cards WHERE set_id = ? ORDER BY id').all(setId);
}

function addCard(setId, question, answer) {
  const result = db.prepare('INSERT INTO cards (set_id, question, answer) VALUES (?, ?, ?)')
    .run(setId, question, answer);
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(result.lastInsertRowid);
}

function updateCard(cardId, question, answer) {
  db.prepare('UPDATE cards SET question = ?, answer = ? WHERE id = ?').run(question, answer, cardId);
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
}

function deleteCard(cardId) {
  db.prepare('DELETE FROM cards WHERE id = ?').run(cardId);
}

function getCard(cardId) {
  return db.prepare('SELECT * FROM cards WHERE id = ?').get(cardId);
}

// every picture filename a card still points at
function picturesInUse() {
  const used = new Set();
  const rows = db.prepare(
    "SELECT question, answer FROM cards WHERE question LIKE '%/uploads/%' OR answer LIKE '%/uploads/%'"
  ).all();

  for (const row of rows) {
    for (const found of `${row.question}\n${row.answer}`.matchAll(/\/uploads\/([\w.-]+)/g)) {
      used.add(found[1]);
    }
  }
  return used;
}

// progress

// every card + what this user answered last time, null = not seen yet
function getCardsWithProgress(setId, userId) {
  return db.prepare(
    `SELECT c.id, c.question, c.answer, p.status
       FROM cards c
       LEFT JOIN progress p ON p.card_id = c.id AND p.user_id = ?
      WHERE c.set_id = ?
      ORDER BY c.id`
  ).all(userId, setId);
}

function setStatus(userId, cardId, status) {
  db.prepare(
    `INSERT INTO progress (user_id, card_id, status) VALUES (?, ?, ?)
     ON CONFLICT (user_id, card_id) DO UPDATE SET status = excluded.status`
  ).run(userId, cardId, status);
}

// the 3 numbers behind the progress bar, one query with a left join
function getSetProgress(setId, userId) {
  const row = db.prepare(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN p.status = 'known'   THEN 1 ELSE 0 END) AS known,
            SUM(CASE WHEN p.status = 'unknown' THEN 1 ELSE 0 END) AS unknown
       FROM cards c
       LEFT JOIN progress p ON p.card_id = c.id AND p.user_id = ?
      WHERE c.set_id = ?`
  ).get(userId, setId);

  const known = row.known || 0;
  const unknown = row.unknown || 0;
  return { total: row.total, known, unknown, untouched: row.total - known - unknown };
}

function resetSetProgress(setId, userId) {
  db.prepare(
    'DELETE FROM progress WHERE user_id = ? AND card_id IN (SELECT id FROM cards WHERE set_id = ?)'
  ).run(userId, setId);
  return getSetProgress(setId, userId);
}

module.exports = {
  db,
  createTables,
  hashPassword,
  checkPassword,
  createUser,
  getUserByName,
  getUserById,
  setTheme,
  createSession,
  getUserByToken,
  deleteSession,
  removeOldSessions,
  createSet,
  getSet,
  getSetByCode,
  findSets,
  updateSet,
  deleteSet,
  copySet,
  getCards,
  getCard,
  picturesInUse,
  addCard,
  updateCard,
  deleteCard,
  getCardsWithProgress,
  setStatus,
  getSetProgress,
  resetSetProgress,
};

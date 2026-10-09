// api.test.js, real server on a free port, called like the browser does

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const uploads = fs.mkdtempSync(path.join(os.tmpdir(), 'memro-test-'));

process.env.MEMRO_DB = ':memory:';
process.env.MEMRO_UPLOADS = uploads;

const { start } = require('../server/server');

// port 0 = any free port
const server = start(0);
const base = `http://localhost:${server.address().port}`;

// close the server after, cleans up the folder too
test.after(() => {
  server.close();
  fs.rmSync(uploads, { recursive: true, force: true });
});

// helpers

// wrapper for headers/json parsing, remembers the cookie
function client() {
  let cookie = null;

  return async function call(method, url, body) {
    const options = { method, headers: {} };

    if (body !== undefined) {
      options.headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }
    if (cookie) options.headers.Cookie = cookie;

    const res = await fetch(base + url, options);

    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];

    return { status: res.status, body: await res.json() };
  };
}

// every test makes its own user so they dont clash
let counter = 0;
async function newUser(call) {
  counter++;
  const username = `student${counter}`;
  const res = await call('POST', '/api/register', { username, password: 'password1' });
  assert.strictEqual(res.status, 201);
  return username;
}

// accounts

test('a new user can register and is logged in straight away', async () => {
  const call = client();
  const username = await newUser(call);

  const me = await call('GET', '/api/me');
  assert.strictEqual(me.body.user.username, username);
});

test('the password is never sent back to the browser', async () => {
  const call = client();
  await newUser(call);

  const me = await call('GET', '/api/me');
  assert.strictEqual(me.body.user.password_hash, undefined);
});

test('a short password is rejected', async () => {
  const call = client();
  const res = await call('POST', '/api/register', { username: 'shortpass', password: 'abc' });
  assert.strictEqual(res.status, 400);
});

test('the same username cannot be taken twice', async () => {
  const call = client();
  const username = await newUser(call);

  const again = await client()('POST', '/api/register', { username, password: 'password2' });
  assert.strictEqual(again.status, 409);
});

test('logging in with the wrong password fails', async () => {
  const call = client();
  const username = await newUser(call);

  const res = await call('POST', '/api/login', { username, password: 'wrongwrong' });
  assert.strictEqual(res.status, 401);
});

test('logging in again works and logging out ends the session', async () => {
  const call = client();
  const username = await newUser(call);

  const login = await call('POST', '/api/login', { username, password: 'password1' });
  assert.strictEqual(login.status, 200);

  await call('POST', '/api/logout');
  const me = await call('GET', '/api/me');
  assert.strictEqual(me.body.user, null);
});

test('you cannot list sets when you are not logged in', async () => {
  const call = client();
  const res = await call('GET', '/api/sets');
  assert.strictEqual(res.status, 401);
});

// sets

test('a set can be created, listed, changed and deleted', async () => {
  const call = client();
  await newUser(call);

  const made = await call('POST', '/api/sets', { title: 'Networks', description: 'OSI' });
  assert.strictEqual(made.status, 201);
  const id = made.body.set.id;

  const list = await call('GET', '/api/sets');
  assert.strictEqual(list.body.sets.length, 1);

  const changed = await call('PUT', `/api/sets/${id}`, { title: 'Networks 2', isPublic: true });
  assert.strictEqual(changed.body.set.title, 'Networks 2');
  assert.strictEqual(changed.body.set.is_public, 1);

  const gone = await call('DELETE', `/api/sets/${id}`);
  assert.strictEqual(gone.status, 200);

  const empty = await call('GET', '/api/sets');
  assert.strictEqual(empty.body.sets.length, 0);
});

test('a private set cannot be opened by somebody else', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Private notes' });

  const other = client();
  await newUser(other);

  const res = await other('GET', `/api/sets/${made.body.set.id}`);
  assert.strictEqual(res.status, 403);
});

test('somebody else cannot edit or delete your set', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Mine', isPublic: true });
  const id = made.body.set.id;

  const other = client();
  await newUser(other);

  const edit = await other('PUT', `/api/sets/${id}`, { title: 'Not yours' });
  assert.strictEqual(edit.status, 403);

  const remove = await other('DELETE', `/api/sets/${id}`);
  assert.strictEqual(remove.status, 403);
});

// pictures

// smallest valid png that exists, one transparent pixel
const ONE_PIXEL_PNG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ'
  + 'AAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

test('a picture is saved and comes back as a url that works', async () => {
  const call = client();
  await newUser(call);

  const sent = await call('POST', '/api/images', { data: ONE_PIXEL_PNG });
  assert.strictEqual(sent.status, 201);
  assert.match(sent.body.url, /^\/uploads\/[0-9a-f]{24}\.png$/);

  const fetched = await fetch(base + sent.body.url);
  assert.strictEqual(fetched.status, 200);
  assert.strictEqual(fetched.headers.get('content-type'), 'image/png');
});

test('a card keeps the markup it was written with', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'Written out' });

  const question = 'What are the layers?\n\n- **Physical**\n- Data link\n![](/uploads/x.png)';
  const added = await call('POST', `/api/sets/${made.body.set.id}/cards`, {
    question,
    answer: 'Seven of them.',
  });

  assert.strictEqual(added.body.card.question, question);
});

// colours

const COLOURS = {
  accent: '#5B3B8C',
  known: '#2e7d5b',
  unknown: '#b23a48',
  background: '#f7f3fc',
};

test('the colours a user picks are saved to the account and come back', async () => {
  const call = client();
  await newUser(call);

  const saved = await call('PUT', '/api/theme', { theme: COLOURS });
  assert.strictEqual(saved.status, 200);

  const me = await call('GET', '/api/me');
  assert.deepStrictEqual(JSON.parse(me.body.user.theme), {
    ...COLOURS,
    accent: '#5b3b8c', // stored lower case whatever the picker sent
  });
});

// the home list

test('the public toggle adds other people\'s public sets but not their private ones', async () => {
  const other = client();
  await newUser(other);
  await other('POST', '/api/sets', { title: 'Their public set', isPublic: true });
  await other('POST', '/api/sets', { title: 'Their private set', isPublic: false });

  const call = client();
  await newUser(call);
  await call('POST', '/api/sets', { title: 'My private set' });

  const list = await call('GET', '/api/sets?public=1');
  const titles = list.body.sets.map((s) => s.title);

  assert.ok(titles.includes('My private set'));
  assert.ok(titles.includes('Their public set'));
  assert.ok(!titles.includes('Their private set'));
});

// search

test('search only finds public sets and matches on the title', async () => {
  const call = client();
  await newUser(call);

  await call('POST', '/api/sets', { title: 'Cryptography quiz', isPublic: true });
  await call('POST', '/api/sets', { title: 'Cryptography secret', isPublic: false });

  const res = await call('GET', '/api/sets/search?q=Cryptography');
  const titles = res.body.sets.map((s) => s.title);

  assert.ok(titles.includes('Cryptography quiz'));
  assert.ok(!titles.includes('Cryptography secret'));
});

// sharing

test('adding a set by code gives you your own editable copy', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Shared set', isPublic: true });
  await owner('POST', `/api/sets/${made.body.set.id}/cards`, { question: 'Q1', answer: 'A1' });

  const other = client();
  await newUser(other);

  const added = await other('POST', '/api/sets/add-by-code', { code: made.body.set.share_code });
  assert.strictEqual(added.status, 201);

  const copy = added.body.set;
  assert.strictEqual(copy.title, 'Shared set');
  assert.strictEqual(copy.card_count, 1);
  assert.notStrictEqual(copy.id, made.body.set.id);
  assert.strictEqual(copy.is_public, 0);

  // changing the copy shouldnt touch the original
  await other('PUT', `/api/sets/${copy.id}`, { title: 'My version' });
  const original = await owner('GET', `/api/sets/${made.body.set.id}`);
  assert.strictEqual(original.body.set.title, 'Shared set');
});

// cards

test('cards can be added, changed and deleted', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'Logic' });
  const setId = made.body.set.id;

  const added = await call('POST', `/api/sets/${setId}/cards`, {
    question: 'What is a tautology?',
    answer: 'A formula that is true under every interpretation.',
  });
  assert.strictEqual(added.status, 201);
  const cardId = added.body.card.id;

  const changed = await call('PUT', `/api/cards/${cardId}`, {
    question: 'What is a contradiction?',
    answer: 'A formula that is false under every interpretation.',
  });
  assert.strictEqual(changed.body.card.question, 'What is a contradiction?');

  await call('DELETE', `/api/cards/${cardId}`);
  const set = await call('GET', `/api/sets/${setId}`);
  assert.strictEqual(set.body.cards.length, 0);
});

test('a card needs both a question and an answer', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'Half cards' });

  const noAnswer = await call('POST', `/api/sets/${made.body.set.id}/cards`, { question: 'Q only', answer: '' });
  assert.strictEqual(noAnswer.status, 400);

  // nothing should have been saved
  const set = await call('GET', `/api/sets/${made.body.set.id}`);
  assert.strictEqual(set.body.cards.length, 0);
});

test('somebody else cannot edit or delete a card in your set', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Hands off', isPublic: true });
  const added = await owner('POST', `/api/sets/${made.body.set.id}/cards`, {
    question: 'Whose card is this?',
    answer: 'Not yours.',
  });
  const cardId = added.body.card.id;

  const other = client();
  await newUser(other);

  const edit = await other('PUT', '/api/cards/' + cardId, {
    question: 'Changed it',
    answer: 'Changed it',
  });
  assert.strictEqual(edit.status, 403);

  const remove = await other('DELETE', '/api/cards/' + cardId);
  assert.strictEqual(remove.status, 403);
});

// progress

test('answering a card moves it between the three counts', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'Three cards' });
  const setId = made.body.set.id;

  const cards = [];
  for (const n of [1, 2, 3]) {
    const added = await call('POST', `/api/sets/${setId}/cards`, { question: `Q${n}`, answer: `A${n}` });
    cards.push(added.body.card.id);
  }

  const start = await call('GET', `/api/sets/${setId}`);
  assert.deepStrictEqual(start.body.progress, { total: 3, known: 0, unknown: 0, untouched: 3 });

  await call('POST', `/api/cards/${cards[0]}/answer`, { status: 'known' });
  const after = await call('POST', `/api/cards/${cards[1]}/answer`, { status: 'unknown' });
  assert.deepStrictEqual(after.body.progress, { total: 3, known: 1, unknown: 1, untouched: 1 });

  // answering the same card again should just move it not count twice
  const again = await call('POST', `/api/cards/${cards[1]}/answer`, { status: 'known' });
  assert.deepStrictEqual(again.body.progress, { total: 3, known: 2, unknown: 0, untouched: 1 });
});

test('you cannot answer or reset a card inside somebody else\'s private set', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Private study', isPublic: false });
  const added = await owner('POST', `/api/sets/${made.body.set.id}/cards`, {
    question: 'Secret',
    answer: 'Also secret',
  });

  const other = client();
  await newUser(other);

  const answered = await other('POST', `/api/cards/${added.body.card.id}/answer`, {
    status: 'known',
  });
  assert.strictEqual(answered.status, 403);

  const reset = await other('POST', `/api/sets/${made.body.set.id}/reset`);
  assert.strictEqual(reset.status, 403);
});

test('progress from studying logged out can be brought onto a new account', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Studied first', isPublic: true });

  const cards = [];
  for (const n of [1, 2, 3]) {
    const added = await owner('POST', `/api/sets/${made.body.set.id}/cards`,
      { question: `Q${n}`, answer: `A${n}` });
    cards.push(added.body.card.id);
  }

  // studied with no account then signed up
  const newcomer = client();
  await newUser(newcomer);

  const brought = await newcomer('POST', '/api/progress/import', {
    progress: {
      [cards[0]]: 'known',
      [cards[1]]: 'unknown',
      [cards[2]]: 'nonsense',   // thrown away
      999999: 'known',          // no such card, thrown away
    },
  });

  assert.strictEqual(brought.body.brought, 2);

  const theirs = await newcomer('GET', `/api/sets/${made.body.set.id}`);
  assert.deepStrictEqual(theirs.body.progress, {
    total: 3, known: 1, unknown: 1, untouched: 1,
  });
});

test('two users studying the same set keep separate progress', async () => {
  const owner = client();
  await newUser(owner);
  const made = await owner('POST', '/api/sets', { title: 'Same set', isPublic: true });
  const setId = made.body.set.id;
  const added = await owner('POST', `/api/sets/${setId}/cards`, { question: 'Q', answer: 'A' });

  const other = client();
  await newUser(other);

  // owner knows it, other doesnt
  await owner('POST', `/api/cards/${added.body.card.id}/answer`, { status: 'known' });
  await other('POST', `/api/cards/${added.body.card.id}/answer`, { status: 'unknown' });

  const mine = await owner('GET', `/api/sets/${setId}`);
  const theirs = await other('GET', `/api/sets/${setId}`);
  assert.strictEqual(mine.body.progress.known, 1);
  assert.strictEqual(theirs.body.progress.known, 0);
  assert.strictEqual(theirs.body.progress.unknown, 1);
});

test('reset clears the progress but keeps the cards', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'Reset me' });
  const setId = made.body.set.id;
  const added = await call('POST', `/api/sets/${setId}/cards`, { question: 'Q', answer: 'A' });

  await call('POST', `/api/cards/${added.body.card.id}/answer`, { status: 'known' });
  const res = await call('POST', `/api/sets/${setId}/reset`);

  assert.deepStrictEqual(res.body.progress, { total: 1, known: 0, unknown: 0, untouched: 1 });
});

// bad input

test('a title that is not text gets a json error, not a crash', async () => {
  const call = client();
  await newUser(call);

  const res = await call('POST', '/api/sets', { title: 5 });
  assert.strictEqual(res.status, 400);
  assert.strictEqual(res.body.error, 'Give the set a title.');
});

test('broken json gets a json error back', async () => {
  const res = await fetch(base + '/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{bad',
  });
  assert.strictEqual(res.status, 400);
  assert.strictEqual((await res.json()).error, 'That request was not valid JSON.');
});

test('a card cannot be edited down to blank', async () => {
  const call = client();
  await newUser(call);
  const made = await call('POST', '/api/sets', { title: 'No blanks' });
  const added = await call('POST', `/api/sets/${made.body.set.id}/cards`, { question: 'Q', answer: 'A' });

  const blank = await call('PUT', `/api/cards/${added.body.card.id}`, { question: '   ', answer: '   ' });
  assert.strictEqual(blank.status, 400);

  // card still the same
  const set = await call('GET', `/api/sets/${made.body.set.id}`);
  assert.strictEqual(set.body.cards[0].question, 'Q');
});

test('capitals in a username do not make a second account', async () => {
  const first = await client()('POST', '/api/register', { username: 'Casey', password: 'password1' });
  assert.strictEqual(first.status, 201);

  const again = await client()('POST', '/api/register', { username: 'casey', password: 'password1' });
  assert.strictEqual(again.status, 409);

  const login = await client()('POST', '/api/login', { username: 'CASEY', password: 'password1' });
  assert.strictEqual(login.status, 200);
});

test('a login older than 30 days stops working', async () => {
  const call = client();
  const username = await newUser(call);

  // same in-memory database the server uses, ages this users login
  const { db } = require('../server/db');
  const old = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString();
  db.prepare(
    'UPDATE sessions SET created_at = ? WHERE user_id = (SELECT id FROM users WHERE username = ?)'
  ).run(old, username);

  const me = await call('GET', '/api/me');
  assert.strictEqual(me.body.user, null);
});

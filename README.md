# Memro

A flashcard web app for revising. Make sets of cards, study them, and it keeps
track of which ones you already know.

Built for the Java and Web Development portfolio (DLBCSPJWD01) at IU
Internationale Hochschule.

## What it does

- Sign up and log in, or study public sets without an account
- Make sets of cards, public or private
- Share a set with a 6 character code, other people get their own copy
- Study one card at a time, mark it known or not known
- A progress bar per set: green known, red not known, grey not seen yet
- Dark mode and your own colours, saved to your account
- Works on a phone and with the keyboard

## How the studying works

Known cards drop out and do not come back in that sitting. Cards marked
"I don't know" go back in a pile and come back at a random point. About every
third card is a new one. The code is `pickNext()` in `public/order.js`, kept in its
own file so it can be unit tested.

## Installation

### 1. Install Node.js

You need **Node.js 22.5 or newer**. The database uses `node:sqlite`, which is
built into Node from 22.5, so there is no database server to install.

1. Download the LTS version from https://nodejs.org and install it with the
   default options.
2. Open a new terminal (Command Prompt, PowerShell or Terminal on a Mac) and
   check the version:

   ```
   node --version
   ```

   It should say `v22.5.0` or higher.

### 2. Get the code

Either clone it with git:

```
git clone https://github.com/LuceProckova/memro-portfolio.git
cd memro-portfolio
```

or download it from GitHub with **Code > Download ZIP**, unzip it, and open a
terminal inside the unzipped `memro-portfolio` folder.

### 3. Install the packages

```
npm install
```

This installs Express and Quill into `node_modules`. It needs an internet
connection the first time.

### 4. Start it

```
npm start
```

The terminal should say `Memro is running on http://localhost:3000`.
Open **http://localhost:3000** in a browser. Leave the terminal open while you
use the app, `Ctrl + C` stops it.

If port 3000 is already taken, pick another one:

```
# Mac / Linux
PORT=3001 npm start

# Windows PowerShell
$env:PORT=3001; npm start
```

### 5. Log in

The database in `data/memro.db` comes filled already, eleven sets and 242 cards,
with a demo account:

- username `lucia`
- password `flashcards`

You can also sign up with your own account.

### Starting over

To get the original demo database back, stop the app and run:

```
git checkout data/memro.db
```

If you downloaded the ZIP, copy `data/memro.db` from a fresh download instead.

## Testing

```
npm test
```

Runs 34 tests with the test runner built into Node.

- **29 integration tests** in `tests/api.test.js`. Each one starts the real server
  on a free port and calls it with `fetch`, like the browser does. They use an
  in-memory database, so they never touch `data/memro.db`.
- **5 unit tests** in `tests/order.test.js` for the card order, no server needed.

What they cover:

- **Accounts**: register, log in, log out, short passwords, taken usernames,
  the password hash never being sent back
- **Sets and search**: create, edit, delete, private sets staying private,
  search only finding public sets
- **Sharing and cards**: adding a set by code, editing cards, pictures, other
  people not being able to touch your cards
- **Progress**: the three counts, reset, two users keeping separate progress,
  bringing logged-out progress onto a new account
- **Bad input**: wrong types and broken JSON get a proper error, blank card edits
  are refused, capitals in usernames, logins running out after 30 days
- **Card order**: new cards in order, every third card new, never the same card
  twice in a row, the set finishing

## Folder layout

```
server/server.js     the file you run, express + every /api route
server/db.js         every line of SQL in the project
public/index.html    the whole page, all six pop ups
public/styles.css    the styling, phone first, dark mode
public/app.js        everything the browser does
public/order.js      which card comes next
tests/api.test.js    the integration tests
tests/order.test.js  the unit tests for the card order
data/memro.db        the database, seeded with the demo account
data/uploads/        pictures added to cards, made on first run
```

## Built with

| Part | Choice | Why |
| --- | --- | --- |
| Front end | HTML, CSS, JavaScript | small enough to write by hand, no build step |
| Back end | Node.js with Express | one language for the whole project |
| Database | SQLite through `node:sqlite` | relational data, one file, nothing to install |
| Card editor | Quill | bold, lists and pictures on cards |
| Passwords | scrypt from `node:crypto` | salted and slow on purpose, no extra library |
| Sessions | token in an HttpOnly cookie | the server knows who you are on every request |
| Tests | `node:test` | built into Node |

## The database

| Table | What is in it |
| --- | --- |
| users | id, username (unique), password_hash, email (optional), theme, created_at |
| sessions | token, user_id, created_at |
| sets | id, owner_id, title, description, is_public, share_code (unique), created_at |
| cards | id, set_id, question, answer |
| progress | user_id, card_id, status (`known` or `unknown`) |

A card with no row in `progress` has not been seen yet. Foreign keys are on, so
deleting a set deletes its cards and their progress too.

## Passwords

Each password gets a random 16 byte salt and is hashed with scrypt, stored as
`salt:hash`. The real password is never stored. Logging in compares with
`timingSafeEqual`, and the error is the same whether the username or the
password was wrong. Usernames ignore capitals, and a login lasts 30 days.

## API routes

| Method | Route | What it does |
| --- | --- | --- |
| POST | /api/register | make an account and log in |
| POST | /api/login | log in |
| POST | /api/logout | log out |
| GET | /api/me | who is logged in |
| PUT | /api/theme | save your colours |
| GET | /api/sets | your sets, add `?public=1` for public ones too |
| GET | /api/sets/search?q= | search public sets |
| POST | /api/sets | make a set |
| GET | /api/sets/:id | a set with its cards and progress |
| PUT | /api/sets/:id | edit a set |
| DELETE | /api/sets/:id | delete a set |
| POST | /api/sets/add-by-code | copy a set by its share code |
| POST | /api/sets/:id/cards | add a card |
| PUT | /api/cards/:cardId | edit a card |
| DELETE | /api/cards/:cardId | delete a card |
| POST | /api/images | upload a picture for a card |
| POST | /api/cards/:cardId/answer | mark a card known or unknown |
| POST | /api/progress/import | bring logged-out progress onto your account |
| POST | /api/sets/:id/reset | clear your progress on a set |

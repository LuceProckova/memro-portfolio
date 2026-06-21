const fs = require('node:fs');
const path = require('node:path');
const db = require('./db');

const DEMO_USER = 'lucia';
const DEMO_PASSWORD = 'flashcards';

function main() {
  const force = process.argv.includes('--force');

  db.createTables();

  let user = db.getUserByName(DEMO_USER);

  if (user && !force) {
    console.log(`The user "${DEMO_USER}" already exists, so there is nothing to do.`);
    console.log('Run "npm run seed -- --force" to throw those sets away and do it again.');
    return;
  }

  if (user) {
    // wipe the old ones first so it doesnt just pile up duplicates
    const old = db.findSets(user.id, '', false);
    for (const set of old) db.deleteSet(set.id);
    console.log(`Removed ${old.length} sets that "${DEMO_USER}" already had.`);
  } else {
    user = db.createUser(DEMO_USER, DEMO_PASSWORD, null);
    console.log(`Created the account "${DEMO_USER}" with the password "${DEMO_PASSWORD}".`);
  }

  const file = path.join(__dirname, 'seed-data.json');
  const sets = JSON.parse(fs.readFileSync(file, 'utf8'));

  let cardTotal = 0;

  for (const item of sets) {
    // seeded sets are public or thered be nothing for the search box to find
    const set = db.createSet(user.id, item.title, item.description, true);

    for (const card of item.cards) {
      db.addCard(set.id, card.q, card.a);
    }

    cardTotal += item.cards.length;
    console.log(`  ${item.title} (${item.cards.length} cards, code ${set.share_code})`);
  }

  console.log(`\nDone. ${sets.length} sets and ${cardTotal} cards.`);
}

main();

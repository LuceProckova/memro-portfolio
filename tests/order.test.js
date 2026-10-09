// order.test.js, unit tests for the card order, no server needed

const test = require('node:test');
const assert = require('node:assert');
const { pickNext } = require('../public/order');

// cards just need an id here
const cards = (...ids) => ids.map((id) => ({ id }));

function piles(newIds, retryIds) {
  return { newCards: cards(...newIds), retryCards: cards(...retryIds), sinceNew: 0, current: null };
}

test('new cards come in the order they were written when nothing needs repeating', () => {
  const state = piles([1, 2, 3], []);
  const shown = [pickNext(state), pickNext(state), pickNext(state)].map((c) => c.id);
  assert.deepStrictEqual(shown, [1, 2, 3]);
});

test('every third card is a new one once there are cards to repeat', () => {
  const state = piles([10, 11], [1, 2, 3, 4]);
  const kinds = [];
  for (let i = 0; i < 6; i++) {
    state.current = pickNext(state, () => 0);
    kinds.push(state.current.id >= 10 ? 'new' : 'repeat');
  }
  assert.deepStrictEqual(kinds, ['repeat', 'repeat', 'new', 'repeat', 'repeat', 'new']);
});

test('the card on screen is never shown again straight away', () => {
  for (let run = 0; run < 50; run++) {
    const state = piles([], [1, 2]);
    state.current = { id: 1 };
    const next = pickNext(state);
    assert.strictEqual(next.id, 2);
  }
});

test('the last card not known keeps coming back until it is', () => {
  const state = piles([], [7]);
  state.current = { id: 7 };
  assert.strictEqual(pickNext(state).id, 7);
});

test('nothing left in either pile means the set is finished', () => {
  assert.strictEqual(pickNext(piles([], [])), null);
});

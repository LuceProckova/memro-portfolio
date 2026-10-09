// order.js, which card comes next, own file so it can be unit tested

// state = new pile, repeat pile, repeats since last new, card on screen
function pickNext(state, random = Math.random) {
  const canShowNew = state.newCards.length > 0;
  const canRepeat = state.retryCards.length > 0;

  // every 3rd card new, or straight away if nothing to repeat
  if (canShowNew && (!canRepeat || state.sinceNew >= 2)) {
    state.sinceNew = 0;
    return state.newCards.shift();
  }

  if (!canRepeat) return null; // both piles empty, set finished

  // never the card already on screen
  const others = state.current
    ? state.retryCards.filter((card) => card.id !== state.current.id)
    : state.retryCards;

  // only that one to repeat, show a new one instead
  if (others.length === 0 && canShowNew) {
    state.sinceNew = 0;
    return state.newCards.shift();
  }

  // last card left has to come back
  const pool = others.length ? others : state.retryCards;
  const chosen = pool[Math.floor(random() * pool.length)];

  state.sinceNew++;
  state.retryCards.splice(state.retryCards.indexOf(chosen), 1);
  return chosen;
}

// node needs this for the tests, browser skips it
if (typeof module !== 'undefined') module.exports = { pickNext };

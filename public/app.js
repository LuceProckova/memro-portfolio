// app.js
// everything the browser does, pop ups, studying, talks to /api

// shortcut for document.getElementById
function $(id) {
  return document.getElementById(id);
}

// counts go through here.
function count(number, word) {
  return `${number} ${word}${number === 1 ? '' : 's'}`;
}

// talks to the server
async function api(url, method = 'GET', body) {
  const options = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) options.body = JSON.stringify(body);

  let response;
  try {
    response = await fetch(url, options);
  } catch (error) {
    // fetch's own error message means nothing to anyone, probably server is down
    throw new Error('Could not reach the server. Is it still running?');
  }

  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Something went wrong.');
  return data;
}

// state

let me = null;          // the logged in user, or null
let showPublic = false; // is the "Public sets" toggle switched on
let noticedEmpty = false; // have we already shown a new account the public sets
let currentSet = null;  // the set being studied
let allCards = [];      // every card in that set, with what it is marked as
let newCards = [];      // cards not answered yet, kept in order
let retryCards = [];    // cards answered "I don't know"
let currentCard = null;
let sinceNewCard = 0;   // how many repeats since the last new card

// studying logged out

const LOCAL_PROGRESS = 'memro-progress';

function readLocalProgress() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_PROGRESS)) || {};
  } catch (error) {
    return {}; // a broken value should not stop you studying
  }
}

function localStatuses(setId) {
  return readLocalProgress()[setId] || {};
}

function setLocalStatus(setId, cardId, status) {
  const all = readLocalProgress();
  all[setId] = all[setId] || {};
  all[setId][cardId] = status;
  localStorage.setItem(LOCAL_PROGRESS, JSON.stringify(all));
}

function clearLocalProgress(setId) {
  const all = readLocalProgress();
  delete all[setId];
  localStorage.setItem(LOCAL_PROGRESS, JSON.stringify(all));
}

// when log in, any progres saves, when signed in any progres saved
async function bringLocalProgressAlong() {
  const everything = {};
  for (const cards of Object.values(readLocalProgress())) {
    Object.assign(everything, cards);
  }
  if (Object.keys(everything).length === 0) return;

  try {
    await api('/api/progress/import', 'POST', { progress: everything });
    localStorage.removeItem(LOCAL_PROGRESS);
  } catch (error) {
  }
}

// counting
function countProgress(cards) {
  const known = cards.filter((card) => card.status === 'known').length;
  const unknown = cards.filter((card) => card.status === 'unknown').length;
  return {
    total: cards.length,
    known,
    unknown,
    untouched: cards.length - known - unknown,
  };
}

// writing cards

// Pictures 
function safeImageUrl(url) {
  if (url.startsWith('/uploads/')) return url;
  if (/^https?:\/\//i.test(url)) return url;
  return '';
}

// Links 
function safeLinkUrl(url) {
  if (/^https?:\/\//i.test(url)) return url;
  if (/^mailto:/i.test(url)) return url;
  if (url.startsWith('/uploads/')) return url;
  return '';
}

// markdown thingies
const INLINE_MARKUP = [
  /!\[([^\]]*)\]\(([^)\s]+)\)/.source,   // picture
  /\[([^\]]+)\]\(([^)\s]+)\)/.source,    // link
  /`([^`\n]+)`/.source,                  // code
  /\*\*([^*]+)\*\*/.source,              // bold
  /__([^_]+)__/.source,                  // underline
  /~~([^~]+)~~/.source,                  // strikethrough
  /\*([^*\n]+)\*/.source,                // italic
].join('|');

function renderInline(text, into) {
  const pattern = new RegExp(INLINE_MARKUP, 'g');
  let last = 0;
  let match;

  // handles nested formatting
  const wrap = (tag, inside) => {
    const element = document.createElement(tag);
    renderInline(inside, element);
    into.appendChild(element);
  };

  while ((match = pattern.exec(text)) !== null) {
    if (match.index > last) {
      into.appendChild(document.createTextNode(text.slice(last, match.index)));
    }

    if (match[2] !== undefined) {
      const url = safeImageUrl(match[2]);
      if (url) {
        const image = document.createElement('img');
        image.className = 'rich-image';
        image.src = url;
        image.alt = match[1] || '';
        image.loading = 'lazy';
        into.appendChild(image);
      }
    } else if (match[4] !== undefined) {
      const url = safeLinkUrl(match[4]);
      if (url) {
        const link = document.createElement('a');
        link.href = url;
        link.target = '_blank';
        link.rel = 'noreferrer noopener';
        renderInline(match[3], link);
        into.appendChild(link);
      } else {
        into.appendChild(document.createTextNode(match[3]));
      }
    } else if (match[5] !== undefined) {
      // code stays exactly as written
      const code = document.createElement('code');
      code.textContent = match[5];
      into.appendChild(code);
    } else if (match[6] !== undefined) {
      wrap('strong', match[6]);
    } else if (match[7] !== undefined) {
      wrap('u', match[7]);
    } else if (match[8] !== undefined) {
      wrap('s', match[8]);
    } else {
      wrap('em', match[9]);
    }

    last = pattern.lastIndex;
  }

  if (last < text.length) {
    into.appendChild(document.createTextNode(text.slice(last)));
  }
}

// Turns whole card into headings, quotes, lists, paragraphs and pictures.
function renderRich(text, into) {
  into.innerHTML = '';
  into.classList.add('rich');

  // Lists can sit inside lists
  let stack = [];
  let paragraph = null;
  let quote = null;
  let code = null;

  const closeAll = () => {
    stack = [];
    paragraph = null;
    quote = null;
  };

  for (const line of String(text || '').split('\n')) {
    if (line.trim() === '```') {
      if (code) {
        code = null;
      } else {
        closeAll();
        code = document.createElement('pre');
        into.appendChild(code);
      }
      continue;
    }

    if (code) {
      if (code.firstChild) code.appendChild(document.createTextNode('\n'));
      code.appendChild(document.createTextNode(line));
      continue;
    }

    const point = /^([ \t]*)(?:(?:-|\*(?=\s))\s+|(\d+)[.)]\s+)(.*)$/.exec(line);

    if (point) {
      paragraph = null;
      quote = null;

      const depth = Math.floor(point[1].replace(/\t/g, '  ').length / 2);
      const kind = point[2] ? 'ol' : 'ul';

      while (stack.length && stack[stack.length - 1].depth > depth) stack.pop();

      let open = stack[stack.length - 1];

      if (!open || open.depth < depth || open.kind !== kind) {
        const list = document.createElement(kind);

        // deeper list hangs off the last point above it
        if (open && open.depth < depth) {
          (open.element.lastElementChild || open.element).appendChild(list);
        } else {
          if (open) stack.pop();
          const parent = stack.length
            ? (stack[stack.length - 1].element.lastElementChild
              || stack[stack.length - 1].element)
            : into;
          parent.appendChild(list);
        }

        open = { element: list, kind, depth };
        stack.push(open);
      }

      const item = document.createElement('li');
      renderInline(point[3], item);
      open.element.appendChild(item);
      continue;
    }

    // Anything that is not a point ends the lists
    stack = [];

    const heading = /^#{1,3}\s+(.*)$/.exec(line);
    if (heading) {
      closeAll();
      // Only one size heading
      const title = document.createElement('h3');
      renderInline(heading[1], title);
      into.appendChild(title);
      continue;
    }

    const quoted = /^>\s?(.*)$/.exec(line);
    if (quoted) {
      paragraph = null;
      if (!quote) {
        quote = document.createElement('blockquote');
        into.appendChild(quote);
      } else {
        quote.appendChild(document.createElement('br'));
      }
      renderInline(quoted[1], quote);
      continue;
    }

    quote = null;

    // blank line ends the paragraph
    if (!line.trim()) {
      paragraph = null;
      continue;
    }

    if (paragraph) {
      paragraph.appendChild(document.createElement('br'));
    } else {
      paragraph = document.createElement('p');
      into.appendChild(paragraph);
    }
    renderInline(line, paragraph);
  }
}

// the editor

// turns what is in the box back into the text that gets saved
function editorToText(root) {
  const MARKERS = {
    strong: '**', b: '**',
    em: '*', i: '*',
    u: '__', ins: '__',
    s: '~~', strike: '~~', del: '~~',
  };

  const BLOCKS = ['div', 'p', 'ul', 'ol', 'h1', 'h2', 'h3', 'h4', 'blockquote',
    'li', 'pre'];

  const isBlock = (node) => node.nodeType === Node.ELEMENT_NODE
    && BLOCKS.includes(node.tagName.toLowerCase());

  const isList = (node) => node.nodeType === Node.ELEMENT_NODE
    && ['ul', 'ol'].includes(node.tagName.toLowerCase());

  // Everything that sits inside a line
  function inline(node) {
    if (node.nodeType === Node.TEXT_NODE) return node.nodeValue;
    if (node.nodeType !== Node.ELEMENT_NODE) return '';

    // quill's empty span for drawing bullets/numbers
    if (node.classList && node.classList.contains('ql-ui')) return '';

    const tag = node.tagName.toLowerCase();
    if (tag === 'br') return '\n';
    if (tag === 'img') return `![](${node.getAttribute('src') || ''})`;
    if (tag === 'code') return '`' + node.textContent + '`';

    if (tag === 'a') {
      const href = node.getAttribute('href') || '';
      const text = [...node.childNodes].map(inline).join('');
      return href ? `[${text}](${href})` : text;
    }

    const inside = [...node.childNodes].map(inline).join('');
    if (!inside.trim()) return inside;

    const marker = MARKERS[tag];
    return marker ? marker + inside + marker : inside;
  }

  const lines = [];
  let pending = '';

  const flush = () => {
    if (pending) lines.push(...pending.split('\n'));
    pending = '';
  };

  // Lists can hold lists
  function listBlock(node, baseDepth) {
    const listIsNumbered = node.tagName.toLowerCase() === 'ol';
    const counters = [];

    for (const child of node.children) {
      if (isList(child)) {
        listBlock(child, baseDepth + 1);
        continue;
      }
      if (child.tagName.toLowerCase() !== 'li') continue;

      const marked = child.getAttribute('data-list');
      const indented = /ql-indent-(\d+)/.exec(child.className || '');
      const depth = baseDepth + (indented ? Number(indented[1]) : 0);
      const numbered = marked ? marked === 'ordered' : listIsNumbered;

      // just the point's own words, not nested lists
      const own = [...child.childNodes].filter((inner) => !isList(inner));
      const text = own.map(inline).join('').replace(/\s*\n\s*/g, ' ').trim();
      const indent = '  '.repeat(depth);

      if (numbered) {
        // each depth counts on its own
        counters.length = depth + 1;
        counters[depth] = (counters[depth] || 0) + 1;
        lines.push(`${indent}${counters[depth]}. ${text}`);
      } else {
        lines.push(`${indent}- ${text}`);
      }

      for (const inner of child.children) {
        if (isList(inner)) listBlock(inner, depth + 1);
      }
    }
  }

  function block(node) {
    const tag = node.tagName.toLowerCase();

    if (tag === 'ul' || tag === 'ol') return listBlock(node, 0);

    // code block, quill = divs, browser = pre
    if (tag === 'pre' || (node.classList && node.classList.contains('ql-code-block-container'))) {
      const inner = tag === 'pre'
        ? node.textContent.split('\n')
        : [...node.children].map((line) => line.textContent);

      lines.push('```');
      for (const line of inner) lines.push(line);
      lines.push('```');
      return;
    }

    if (tag === 'h1' || tag === 'h2' || tag === 'h3' || tag === 'h4') {
      lines.push('# ' + inline(node).replace(/\s*\n\s*/g, ' ').trim());
      return;
    }

    if (tag === 'blockquote') {
      // quote can be several lines
      const inner = editorToText(node);
      for (const line of inner.split('\n')) lines.push('> ' + line);
      return;
    }

    // browser puts each line in its own div sometimes
    if ([...node.childNodes].some(isBlock)) {
      walk(node);
      return;
    }
    lines.push(...inline(node).split('\n'));
  }

  function walk(root) {
    for (const child of root.childNodes) {
      if (isBlock(child)) {
        flush();
        block(child);
      } else {
        pending += inline(child);
      }
    }
    flush();
  }

  walk(root);

  return lines
    .join('\n')
    // browser leaves weird spaces behind sometimes, clean those up
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

// used for question + answer boxes, editor is Quill (library, not mine)
// tried writing my own first but it was 200 lines of pain so used a library instead
function makeEditor(label, value, onError, onSave) {
  const wrap = document.createElement('div');
  wrap.className = 'editor';

  const heading = document.createElement('span');
  heading.className = 'editor-label';
  heading.textContent = label;
  wrap.appendChild(heading);

  // quill takes this over
  const holder = document.createElement('div');
  wrap.appendChild(holder);

  const editor = new Quill(holder, {
    theme: 'snow',
    placeholder: label === 'Question' ? 'Type the question' : 'Type the answer',
    modules: {
      toolbar: [
        [{ header: [3, false] }],
        ['bold', 'italic', 'underline', 'strike'],
        ['blockquote', 'code-block'],
        [{ list: 'bullet' }, { list: 'ordered' }],
        [{ indent: '-1' }, { indent: '+1' }],
        ['link', 'image'],
        ['clean'],
      ],
      keyboard: {
        bindings: {
          // enter = new line so ctrl+enter saves instead
          save: {
            key: 'Enter',
            shortKey: true,
            handler: () => {
              if (onSave) onSave();
              return false;
            },
          },
        },
      },
    },
  });

  // load whatever the card already says
  if (value) {
    const built = document.createElement('div');
    renderRich(value, built);
    editor.clipboard.dangerouslyPasteHTML(built.innerHTML, 'silent');
  }

  // sends to server instead of base64ing it into the card
  const file = document.createElement('input');
  file.type = 'file';
  file.accept = 'image/png,image/jpeg,image/gif,image/webp';
  file.hidden = true;

  async function addPicture(chosen) {
    if (!chosen) return;

    let data;
    try {
      data = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = () => reject(new Error('Could not read that file.'));
        reader.readAsDataURL(chosen);
      });
    } catch (error) {
      return onError(error.message);
    }

    try {
      const result = await api('/api/images', 'POST', { data });

      // position worked out before the picture goes in
      const chosenSpot = editor.getSelection(true);
      const at = chosenSpot ? chosenSpot.index : editor.getLength();

      editor.insertEmbed(at, 'image', result.url, 'user');
      editor.setSelection(at + 1, 0);
    } catch (error) {
      onError(error.message);
    }
  }

  file.addEventListener('change', async () => {
    await addPicture(file.files[0]);
    file.value = '';
  });

  editor.getModule('toolbar').addHandler('image', () => file.click());

  // paste/drop a picture works same as the button
  const catchPicture = (event, list) => {
    const picture = [...(list || [])].find((entry) => entry.type.startsWith('image/'));
    if (!picture) return;
    event.preventDefault();
    event.stopPropagation();
    // clipboard needs asking for the file, dropped one already is one
    addPicture(picture.getAsFile ? picture.getAsFile() : picture);
  };

  editor.root.addEventListener('paste', (event) => {
    catchPicture(event, event.clipboardData?.items);
  }, true);

  editor.root.addEventListener('drop', (event) => {
    catchPicture(event, event.dataTransfer?.files);
  }, true);

  wrap.appendChild(file);

  return {
    wrap,
    focus: () => editor.focus(),
    getText: () => editorToText(editor.root),
  };
}

// colours

// user picks 4 colours, everything else works itself out from those

let colours = null; // null means use the colours in the stylesheet

const PRESETS = [
  { name: 'Grape', accent: '#5b3b8c', known: '#2e7d5b', unknown: '#b23a48', background: '#f7f3fc' },
  { name: 'Rose', accent: '#a8365c', known: '#2f7d54', unknown: '#c04b3a', background: '#fdf2f5' },
  { name: 'Sand', accent: '#8a5a20', known: '#4c7a3f', unknown: '#b04a32', background: '#fbf6ee' },
  { name: 'Ocean', accent: '#12657f', known: '#1f7a63', unknown: '#b8452f', background: '#eef6f8' },
  { name: 'Forest', accent: '#2f5d3a', known: '#3b7d4a', unknown: '#a8452c', background: '#f1f6f0' },
  { name: 'Midnight', accent: '#7fb3e8', known: '#4dbb84', unknown: '#e0736a', background: '#14181f' },
];

function toRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}

function toHex({ r, g, b }) {
  const two = (n) => Math.round(Math.max(0, Math.min(255, n))).toString(16).padStart(2, '0');
  return '#' + two(r) + two(g) + two(b);
}

// mixes 2 colours, 0 = first colour, 1 = second
function mix(hexA, hexB, amount) {
  const a = toRgb(hexA);
  const b = toRgb(hexB);
  return toHex({
    r: a.r + (b.r - a.r) * amount,
    g: a.g + (b.g - a.g) * amount,
    b: a.b + (b.b - a.b) * amount,
  });
}

// eyes are more sensitive to green so it's weighted
function isLight(hex) {
  const { r, g, b } = toRgb(hex);
  return (r * 299 + g * 587 + b * 114) / 1000 > 140;
}

// picked colours carry one background, so dark mode has to darken it itself
// or a saved scheme just sits there overriding the .dark class forever
function paint() {
  if (!colours) {
    applyColours(null);
    return;
  }
  const dark = document.body.classList.contains('dark');
  const background = mix(colours.background, dark ? '#000000' : '#ffffff', 0.8);
  applyColours({ ...colours, background });
}

// set directly on body instead of the stylesheet
function applyColours(picked) {
  const names = ['--blue', '--green', '--red', '--bg', '--surface', '--text',
    '--grey-text', '--line', '--untouched'];

  for (const name of names) document.body.style.removeProperty(name);
  if (!picked) return;

  const light = isLight(picked.background);
  const text = light ? '#1d2430' : '#e8ecf2';

  const set = (name, value) => document.body.style.setProperty(name, value);
  set('--blue', picked.accent);
  set('--green', picked.known);
  set('--red', picked.unknown);
  set('--bg', picked.background);
  // cards go nearly white on light bg, just a bit lighter on dark
  set('--surface', mix(picked.background, '#ffffff', light ? 0.75 : 0.08));
  set('--text', text);
  set('--grey-text', mix(text, picked.background, 0.45));
  set('--line', mix(text, picked.background, 0.82));
  set('--untouched', mix(text, picked.background, 0.74));
}

function readPickers() {
  return {
    accent: $('colour-accent').value,
    known: $('colour-known').value,
    unknown: $('colour-unknown').value,
    background: $('colour-background').value,
  };
}

// reads current colours off the page (body, not :root)
function defaultColours() {
  const style = getComputedStyle(document.body);
  const read = (name) => style.getPropertyValue(name).trim();
  return {
    accent: read('--blue'),
    known: read('--green'),
    unknown: read('--red'),
    background: read('--bg'),
  };
}

function fillPickers(picked) {
  const c = picked || defaultColours();
  $('colour-accent').value = c.accent;
  $('colour-known').value = c.known;
  $('colour-unknown').value = c.unknown;
  $('colour-background').value = c.background;
}

// logged in colours save to the account, logged out just this browser
async function saveColours(picked) {
  colours = picked;
  paint();

  if (picked) {
    localStorage.setItem('memro-colours', JSON.stringify(picked));
  } else {
    localStorage.removeItem('memro-colours');
  }

  if (!me) return;

  try {
    await api('/api/theme', 'PUT', { theme: picked });
    $('colours-error').hidden = true;
  } catch (error) {
    showPopupError('colours-error', error.message);
  }
}

function drawPresets() {
  const row = $('preset-row');
  row.innerHTML = '';

  for (const preset of PRESETS) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'preset';

    const swatches = document.createElement('span');
    swatches.className = 'swatches';
    for (const key of ['accent', 'known', 'unknown', 'background']) {
      const dot = document.createElement('span');
      dot.className = 'swatch';
      dot.style.background = preset[key];
      swatches.appendChild(dot);
    }

    const label = document.createElement('span');
    label.textContent = preset.name;

    button.appendChild(swatches);
    button.appendChild(label);
    button.addEventListener('click', () => {
      const { name, ...picked } = preset;
      fillPickers(picked);
      saveColours(picked);
    });
    row.appendChild(button);
  }
}

// pop ups

function openPopup(id) {
  $('overlay').hidden = false;
  for (const popup of document.querySelectorAll('.popup')) popup.hidden = true;
  $(id).hidden = false;
}

function closePopup() {
  // reload the cards after closing
  const wasEditingCards = !$('popup-cards').hidden;

  $('overlay').hidden = true;
  for (const popup of document.querySelectorAll('.popup')) popup.hidden = true;
  for (const box of document.querySelectorAll('.popup-error')) box.hidden = true;

  // reset any delete button still on "really delete"
  for (const holder of document.querySelectorAll('.confirm-holder')) {
    if (holder.putBack) holder.putBack();
  }

  if (wasEditingCards && currentSet) openSet(currentSet.id);
}

function showPopupError(id, message) {
  const box = $(id);
  box.textContent = message;
  box.hidden = false;
}

// who is logged in

function showUser() {
  const loggedIn = Boolean(me);
  $('who').hidden = !loggedIn;
  $('who').textContent = loggedIn ? me.username : '';
  $('logout-btn').hidden = !loggedIn;
  $('login-btn').hidden = loggedIn;
  $('register-btn').hidden = loggedIn;
  $('new-set-btn').hidden = !loggedIn;
  $('add-code-btn').hidden = !loggedIn;
  // logged out theres just public sets
  $('public-btn').hidden = !loggedIn;
}

// account colours win over whatever this browser had saved
function useAccountColours() {
  if (!me || !me.theme) return;
  try {
    colours = JSON.parse(me.theme);
    paint();
    localStorage.setItem('memro-colours', me.theme);
  } catch (error) {
    colours = null; // a broken value should not stop the page loading
  }
}

async function checkWhoIsLoggedIn() {
  const data = await api('/api/me');
  me = data.user;
  showUser();
  useAccountColours();
}

// home screen

function drawSetList(sets, emptyMessage) {
  const list = $('set-list');
  list.innerHTML = '';

  if (sets.length === 0) {
    $('home-hint').textContent = emptyMessage;
    return;
  }
  $('home-hint').textContent = '';

  // only show "yours" tag when the list has other peoples sets too
  const mixed = sets.some((set) => !set.mine);

  for (const set of sets) {
    const box = document.createElement('div');
    box.className = 'set-card';

    // needs to be keyboard reachable, was mouse only before
    box.tabIndex = 0;
    box.setAttribute('role', 'button');

    const title = document.createElement('h3');
    title.textContent = set.title;
    if (set.is_public) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'public';
      title.appendChild(tag);
    }
    if (set.mine && mixed) {
      const tag = document.createElement('span');
      tag.className = 'tag yours';
      tag.textContent = 'yours';
      title.appendChild(tag);
    }

    const info = document.createElement('p');
    info.textContent = `${count(set.card_count, 'card')}, by ${set.owner_name}`
      + (set.description ? ` - ${set.description}` : '');

    box.appendChild(title);
    box.appendChild(info);

    box.addEventListener('click', () => openSet(set.id));
    box.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' && event.key !== ' ') return;
      event.preventDefault(); // space would scroll the page otherwise
      openSet(set.id);
    });

    list.appendChild(box);
  }
}

// toggle setting, used from two places
function setPublicToggle(on) {
  showPublic = on;
  $('public-btn').classList.toggle('on', on);
  $('public-btn').setAttribute('aria-pressed', String(on));
}

// draws the home list based on search text + the public toggle
async function refreshList() {
  const text = $('search-input').value.trim();

  try {
    // logged out its all public anyway
    if (!me) {
      $('home-title').textContent = text ? `Public sets: ${text}` : 'Public sets';
      const found = await api('/api/sets/search?q=' + encodeURIComponent(text));
      return drawSetList(found.sets, 'No public sets matched that.');
    }

    $('home-title').textContent = showPublic ? 'Your sets and public sets' : 'Your sets';

    const data = await api('/api/sets?public=' + (showPublic ? '1' : '0')
      + '&q=' + encodeURIComponent(text));

    // new account has nothing, turn public sets on once
    if (data.sets.length === 0 && !text && !showPublic && !noticedEmpty) {
      noticedEmpty = true;
      setPublicToggle(true);
      await refreshList();
      $('home-hint').textContent = 'You have no sets of your own yet, so these are'
        + ' the public ones. Press "New set" to start your own.';
      return;
    }

    drawSetList(data.sets, text
      ? 'Nothing matched that.'
      : 'You have no sets yet. Press "New set" to make one.');
  } catch (error) {
    // otherwise search with server down just looks broken
    $('set-list').innerHTML = '';
    $('home-hint').textContent = error.message;
  }
}

function showHome() {
  $('study-view').hidden = true;
  $('home-view').hidden = false;
  currentSet = null;
  refreshList();
}

// clears an old search
function showHomeFresh() {
  $('search-input').value = '';
  setPublicToggle(false);
  noticedEmpty = false;
  showHome();
}

// studying

// picks the next card, roughly every 3rd is a new one the rest are repeats
// "i know" cards are dropped for good
function pickNextCard() {
  const canShowNew = newCards.length > 0;
  const canRepeat = retryCards.length > 0;

  if (canShowNew && (!canRepeat || sinceNewCard >= 2)) {
    sinceNewCard = 0;
    return newCards.shift();
  }

  if (canRepeat) {
    // never give back the card already on screen
    const others = currentCard
      ? retryCards.filter((card) => card.id !== currentCard.id)
      : retryCards;

    // else show a new one instead
    if (others.length === 0 && canShowNew) {
      sinceNewCard = 0;
      return newCards.shift();
    }

    // fallback for when theres genuinely nothing else to show
    const pool = others.length ? others : retryCards;
    const chosen = pool[Math.floor(Math.random() * pool.length)];

    sinceNewCard++;
    retryCards.splice(retryCards.indexOf(chosen), 1);
    return chosen;
  }

  return null; // nothing left, the set is finished
}

function drawProgress(progress) {
  const total = progress.total || 1;
  $('bar-known').style.width = (progress.known / total) * 100 + '%';
  $('bar-unknown').style.width = (progress.unknown / total) * 100 + '%';
  $('count-known').textContent = progress.known;
  $('count-unknown').textContent = progress.unknown;
  $('count-left').textContent = progress.untouched;
}

function showCard() {
  currentCard = pickNextCard();

  if (!currentCard) {
    // empty set isnt the same as finished set
    const empty = allCards.length === 0;

    $('finished-title').textContent = empty ? 'No cards yet' : 'All done';
    $('finished-text').textContent = empty
      ? 'This set is empty. Press "Cards" to write the first one.'
      : 'You have marked every card in this set as learned.';
    $('finished-reset-btn').hidden = empty;

    $('card').hidden = true;
    $('answer-buttons').hidden = true;
    $('finished').hidden = false;
    return;
  }

  $('finished').hidden = true;
  $('card').hidden = false;
  renderRich(currentCard.question, $('card-question'));
  renderRich(currentCard.answer, $('card-answer'));
  $('card-answer').hidden = true;
  $('card-hint').hidden = false;
  $('answer-buttons').hidden = true;
  $('card').setAttribute('aria-expanded', 'false');
}

function revealAnswer() {
  if (!currentCard || !$('card-answer').hidden) return;
  $('card-answer').hidden = false;
  $('card-hint').hidden = true;
  $('answer-buttons').hidden = false;
  $('card').setAttribute('aria-expanded', 'true');
}

async function answerCard(status) {
  if (!currentCard) return;
  const card = currentCard;

  // save first, stay put if it fails
  try {
    if (me) {
      const data = await api(`/api/cards/${card.id}/answer`, 'POST', { status });
      drawProgress(data.progress);
    } else {
      setLocalStatus(currentSet.id, card.id, status);
    }
    $('study-error').hidden = true;
  } catch (error) {
    showPopupError('study-error', error.message);
    return;
  }

  // dont know = back in the pile, know = done
  if (status === 'unknown') retryCards.push(card);

  // keep allCards updated, the bar counts come from it when logged out
  const found = allCards.find((one) => one.id === card.id);
  if (found) found.status = status;

  if (!me) drawProgress(countProgress(allCards));

  showCard();
}

async function openSet(id) {
  let data;
  try {
    data = await api('/api/sets/' + id);
  } catch (error) {
    // better to say why than just do nothing
    if (currentSet) return showPopupError('study-error', error.message);
    $('home-hint').textContent = error.message;
    return;
  }

  currentSet = data.set;

  $('home-view').hidden = true;
  $('study-view').hidden = false;
  $('study-title').textContent = data.set.title;
  $('study-sub').textContent = `${count(data.set.card_count, 'card')}, by ${data.set.owner_name}`
    + (data.set.description ? ` - ${data.set.description}` : '');

  // only owner can change a set
  $('edit-set-btn').hidden = !data.mine;
  $('cards-btn').hidden = !data.mine;

  // server knows the status if logged in, browser knows if not
  if (me) {
    allCards = data.cards;
  } else {
    const saved = localStatuses(id);
    allCards = data.cards.map((card) => ({ ...card, status: saved[card.id] || null }));
  }

  $('local-note').hidden = Boolean(me);
  $('study-error').hidden = true;

  // sort cards into the two piles, known ones just get left out
  newCards = allCards.filter((card) => !card.status);
  retryCards = allCards.filter((card) => card.status === 'unknown');
  sinceNewCard = 0;

  drawProgress(me && data.progress ? data.progress : countProgress(allCards));
  showCard();
}

async function resetSet() {
  try {
    if (me) {
      await api(`/api/sets/${currentSet.id}/reset`, 'POST');
    } else {
      clearLocalProgress(currentSet.id);
    }
  } catch (error) {
    return showPopupError('study-error', error.message);
  }
  openSet(currentSet.id);
}

// cards popup

async function openCardsPopup() {
  openPopup('popup-cards');
  $('cards-title').textContent = 'Cards in "' + currentSet.title + '"';
  drawNewCard();
  await drawCardList();
}

// helper since every row needs the same button
function makeButton(label, className, onClick) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = className;
  button.textContent = label;
  button.addEventListener('click', onClick);
  return button;
}

// delete button that asks first, used for cards + sets
function makeDeleteButton(label, onConfirm) {
  const holder = document.createElement('span');
  holder.className = 'confirm-holder';

  const show = (...buttons) => {
    holder.innerHTML = '';
    for (const button of buttons) holder.appendChild(button);
  };

  const ask = makeButton(label, 'ghost-btn small', () => show(sure, cancel));
  const sure = makeButton('Really delete', 'red-btn small', onConfirm);
  const cancel = makeButton('Cancel', 'ghost-btn small', () => show(ask));

  // resets when the window closes
  holder.putBack = () => show(ask);

  show(ask);
  return holder;
}

// one card row, edit swaps it for the editing version below
function readingRow(card, row) {
  row.innerHTML = '';
  row.className = 'card-row';

  const number = document.createElement('span');
  number.className = 'card-number';
  number.textContent = card.position;

  const q = document.createElement('div');
  q.className = 'q';
  renderRich(card.question, q);

  const a = document.createElement('div');
  a.className = 'a';
  renderRich(card.answer, a);

  const buttons = document.createElement('div');
  buttons.className = 'card-row-buttons';

  buttons.appendChild(makeButton('Edit', 'ghost-btn small',
    () => editingRow(card, row)));

  buttons.appendChild(makeDeleteButton('Delete', async () => {
    try {
      await api('/api/cards/' + card.id, 'DELETE');
      await drawCardList();
    } catch (error) {
      showPopupError('cards-error', error.message);
    }
  }));

  row.appendChild(number);
  row.appendChild(q);
  row.appendChild(a);
  row.appendChild(buttons);
}

// same row but editing mode
function editingRow(card, row) {
  row.innerHTML = '';
  row.className = 'card-row editing';

  const fail = (message) => showPopupError('cards-error', message);

  async function save() {
    const asked = question.getText();
    const said = answer.getText();

    if (!asked.trim() || !said.trim()) {
      return fail('A card needs both a question and an answer.');
    }
    try {
      const data = await api('/api/cards/' + card.id, 'PUT', {
        question: asked,
        answer: said,
      });
      $('cards-error').hidden = true;
      readingRow({ ...data.card, position: card.position }, row);
    } catch (error) {
      fail(error.message);
    }
  }

  const question = makeEditor('Question', card.question, fail, save);
  const answer = makeEditor('Answer', card.answer, fail, save);

  const buttons = document.createElement('div');
  buttons.className = 'card-row-buttons';
  buttons.appendChild(makeButton('Save', 'main-btn small', save));
  buttons.appendChild(makeButton('Cancel', 'ghost-btn small',
    () => readingRow(card, row)));

  const note = document.createElement('span');
  note.className = 'editor-hint';
  note.textContent = 'Ctrl and Enter also saves';
  buttons.appendChild(note);

  row.appendChild(question.wrap);
  row.appendChild(answer.wrap);
  row.appendChild(buttons);
  question.focus();
}

// the two boxes for writing a new card
function drawNewCard() {
  const holder = $('new-card');
  holder.innerHTML = '';

  const fail = (message) => showPopupError('cards-error', message);

  async function add() {
    const asked = question.getText();
    const said = answer.getText();

    if (!asked.trim() || !said.trim()) {
      return fail('A card needs both a question and an answer.');
    }
    try {
      await api(`/api/sets/${currentSet.id}/cards`, 'POST', {
        question: asked,
        answer: said,
      });
      $('cards-error').hidden = true;
      await drawCardList();
      drawNewCard(); // empty boxes again, ready for the next one
    } catch (error) {
      fail(error.message);
    }
  }

  const question = makeEditor('Question', '', fail, add);
  const answer = makeEditor('Answer', '', fail, add);

  const buttons = document.createElement('div');
  buttons.className = 'new-card-buttons';

  const addButton = makeButton('Add card', 'main-btn', add);
  addButton.id = 'card-add';
  buttons.appendChild(addButton);

  const note = document.createElement('span');
  note.className = 'editor-hint';
  note.textContent = 'Ctrl and Enter also adds it';
  buttons.appendChild(note);

  holder.appendChild(question.wrap);
  holder.appendChild(answer.wrap);
  holder.appendChild(buttons);
}

async function drawCardList() {
  let data;
  try {
    data = await api('/api/sets/' + currentSet.id);
  } catch (error) {
    return showPopupError('cards-error', error.message);
  }

  const list = $('card-list');
  list.innerHTML = '';

  data.cards.forEach((card, index) => {
    const row = document.createElement('div');
    readingRow({ ...card, position: index + 1 }, row);
    list.appendChild(row);
  });
}

// buttons

$('theme-btn').addEventListener('click', () => {
  document.body.classList.toggle('dark');
  const dark = document.body.classList.contains('dark');
  $('theme-btn').textContent = dark ? 'Light' : 'Dark';
  localStorage.setItem('memro-theme', dark ? 'dark' : 'light');
  paint();
});

$('colours-btn').addEventListener('click', () => {
  fillPickers(colours);
  $('colours-note').textContent = me
    ? 'Saved to your account, so they follow you to another computer.'
    : 'Saved in this browser. Log in and they follow your account instead.';
  openPopup('popup-colours');
});

// saves live while dragging the picker
for (const id of ['colour-accent', 'colour-known', 'colour-unknown', 'colour-background']) {
  $(id).addEventListener('input', () => {
    colours = readPickers();
    paint();
  });
  $(id).addEventListener('change', () => saveColours(readPickers()));
}

$('colours-reset').addEventListener('click', async () => {
  // clear first then read, pickers get defaults from the page
  await saveColours(null);
  fillPickers(null);
});

$('login-btn').addEventListener('click', () => openPopup('popup-login'));
$('register-btn').addEventListener('click', () => openPopup('popup-register'));

$('logout-btn').addEventListener('click', async () => {
  // log out locally either way
  try {
    await api('/api/logout', 'POST');
  } catch (error) {
    $('home-hint').textContent = error.message;
  }
  me = null;
  showUser();
  showHomeFresh();
});

$('login-submit').addEventListener('click', async () => {
  try {
    const data = await api('/api/login', 'POST', {
      username: $('login-username').value,
      password: $('login-password').value,
    });
    me = data.user;
    showUser();
    useAccountColours();
    closePopup();
    showHomeFresh();
  } catch (error) {
    showPopupError('login-error', error.message);
  }
});

$('register-submit').addEventListener('click', async () => {
  try {
    const data = await api('/api/register', 'POST', {
      username: $('register-username').value,
      password: $('register-password').value,
      email: $('register-email').value,
    });
    me = data.user;
    showUser();
    // bring over whatever was picked/answered before
    if (colours) saveColours(colours);
    await bringLocalProgressAlong();
    closePopup();
    showHomeFresh();
  } catch (error) {
    showPopupError('register-error', error.message);
  }
});

// same popup for new set + editing, this remembers which one
let editingSet = null;

$('new-set-btn').addEventListener('click', () => {
  editingSet = null;
  $('popup-set-title').textContent = 'New set';
  $('set-title').value = '';
  $('set-description').value = '';
  $('set-public').checked = false;
  $('set-delete').hidden = true;
  openPopup('popup-set');
});

$('edit-set-btn').addEventListener('click', () => {
  editingSet = currentSet;
  $('popup-set-title').textContent = 'Edit set';
  $('set-title').value = currentSet.title;
  $('set-description').value = currentSet.description || '';
  $('set-public').checked = Boolean(currentSet.is_public);
  $('set-delete').hidden = false;
  openPopup('popup-set');
});

$('set-submit').addEventListener('click', async () => {
  const body = {
    title: $('set-title').value,
    description: $('set-description').value,
    isPublic: $('set-public').checked,
  };

  try {
    if (editingSet) {
      const data = await api('/api/sets/' + editingSet.id, 'PUT', body);
      currentSet = data.set;
      closePopup();
      openSet(currentSet.id);
    } else {
      const data = await api('/api/sets', 'POST', body);
      closePopup();
      openSet(data.set.id);
    }
  } catch (error) {
    showPopupError('set-error', error.message);
  }
});

$('set-delete').appendChild(makeDeleteButton('Delete set', async () => {
  try {
    await api('/api/sets/' + editingSet.id, 'DELETE');
    closePopup();
    showHome();
  } catch (error) {
    showPopupError('set-error', error.message);
  }
}));

$('cards-btn').addEventListener('click', openCardsPopup);

$('share-btn').addEventListener('click', () => {
  $('share-code').textContent = currentSet.share_code;
  $('share-private').hidden = Boolean(currentSet.is_public);
  openPopup('popup-share');
});

$('add-code-btn').addEventListener('click', () => {
  $('code-input').value = '';
  openPopup('popup-code');
});

$('code-submit').addEventListener('click', async () => {
  try {
    const data = await api('/api/sets/add-by-code', 'POST', { code: $('code-input').value });
    closePopup();
    openSet(data.set.id);
  } catch (error) {
    showPopupError('code-error', error.message);
  }
});

$('search-btn').addEventListener('click', refreshList);
$('search-input').addEventListener('keydown', (event) => {
  if (event.key === 'Enter') refreshList();
});

$('public-btn').addEventListener('click', () => {
  // stop offering it automatically once its pressed manually
  noticedEmpty = true;
  setPublicToggle(!showPublic);
  refreshList();
});

$('back-btn').addEventListener('click', showHome);
$('reset-btn').addEventListener('click', resetSet);
$('finished-reset-btn').addEventListener('click', resetSet);

$('card').addEventListener('click', revealAnswer);
$('card').addEventListener('keydown', (event) => {
  if (event.key === 'Enter' || event.key === ' ') {
    event.preventDefault();
    revealAnswer();
  }
});

// space flips the card, left/right grade it, from anywhere in the study screen
document.addEventListener('keydown', (event) => {
  if ($('study-view').hidden || !$('overlay').hidden) return;
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;

  if (event.key === ' ' && $('answer-buttons').hidden) {
    event.preventDefault();
    revealAnswer();
  } else if (!$('answer-buttons').hidden) {
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      answerCard('unknown');
    } else if (event.key === 'ArrowRight') {
      event.preventDefault();
      answerCard('known');
    }
  }
});

$('known-btn').addEventListener('click', () => answerCard('known'));
$('unknown-btn').addEventListener('click', () => answerCard('unknown'));

for (const button of document.querySelectorAll('.close-popup')) {
  button.addEventListener('click', closePopup);
}

// enter submits, except the card editors where enter = new line
const ENTER_SUBMITS = {
  'login-username': 'login-submit',
  'login-password': 'login-submit',
  'register-username': 'register-submit',
  'register-password': 'register-submit',
  'register-email': 'register-submit',
  'set-title': 'set-submit',
  'set-description': 'set-submit',
  'code-input': 'code-submit',
};

for (const [box, button] of Object.entries(ENTER_SUBMITS)) {
  $(box).addEventListener('keydown', (event) => {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    $(button).click();
  });
}

// escape closes whatever popup is open
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !$('overlay').hidden) closePopup();
});

// clicking outside the popup closes it too
$('overlay').addEventListener('click', (event) => {
  if (event.target === $('overlay')) closePopup();
});

// start

async function start() {
  if (localStorage.getItem('memro-theme') === 'dark') {
    document.body.classList.add('dark');
    $('theme-btn').textContent = 'Light';
  }

  // put saved colours on right away
  const saved = localStorage.getItem('memro-colours');
  if (saved) {
    try {
      colours = JSON.parse(saved);
      paint();
    } catch (error) {
      localStorage.removeItem('memro-colours');
    }
  }

  drawPresets();

  try {
    await checkWhoIsLoggedIn();
    await refreshList();
  } catch (error) {
    $('home-hint').textContent = 'Could not reach the server. Is it running?';
  }
}

start();

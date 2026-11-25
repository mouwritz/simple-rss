'use strict';

/* global Feed */

const COLORS = ['', '#e5484d', '#f76b15', '#ffc53d', '#46a758', '#12a594', '#0090ff', '#8e4ec6', '#d6409f'];
const MAX_ITEMS_PER_CHANNEL = 300;
const MAX_ITEMS_SHOWN = 600;
const MAX_NOTIFICATIONS_PER_CHANNEL = 3;
const FETCH_CONCURRENCY = 4;

const state = {
  channels: [],          // { id, url, title, customTitle, color, favorite, initialized, error, lastFetched }
  items: {},             // channelId -> [{ id, title, link, date, summary, content, image, read, firstSeen }]
  settings: { refreshMinutes: 5, theme: 'system', uiFont: 'system', readingFont: 'serif', fontSize: 100 },
  view: 'feed',
  filter: 'all',         // 'all' | 'favorites' | channelId
  selected: null,        // { channelId, itemId }
  refreshing: false,
  lastRefresh: null,
  newColor: '',
};

const FONTS = {
  system: 'system-ui, -apple-system, "Segoe UI", Roboto, Ubuntu, "Helvetica Neue", sans-serif',
  sans: 'Inter, "Helvetica Neue", Helvetica, Arial, sans-serif',
  serif: 'Charter, "Iowan Old Style", Georgia, Cambria, "Times New Roman", serif',
  mono: 'ui-monospace, "Cascadia Code", Consolas, Menlo, monospace',
};

function applyAppearance() {
  const s = state.settings;
  const root = document.documentElement;
  if (s.theme === 'light' || s.theme === 'dark') root.dataset.theme = s.theme;
  else delete root.dataset.theme;
  root.style.setProperty('--font', FONTS[s.uiFont] || FONTS.system);
  root.style.setProperty('--reading', FONTS[s.readingFont] || FONTS.serif);
  root.style.setProperty('--scale', String((Number(s.fontSize) || 100) / 100));
  window.api.setTheme(s.theme);
}

const $ = (sel) => document.querySelector(sel);
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'color') el.style.setProperty('--ch-color', v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) if (kid != null && kid !== false) el.append(kid);
  return el;
}

// ---------- persistence ----------
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    window.api.saveStore({ version: 1, channels: state.channels, items: state.items, settings: state.settings });
  }, 400);
}

async function load() {
  const data = await window.api.loadStore();
  if (data && data.version === 1) {
    state.channels = data.channels || [];
    state.items = data.items || {};
    state.settings = { ...state.settings, ...(data.settings || {}) };
  }
}

// ---------- helpers ----------
const channelById = (id) => state.channels.find((c) => c.id === id);
const channelName = (ch) => ch.customTitle || ch.title || ch.url;

function findItem(channelId, itemId) {
  return (state.items[channelId] || []).find((i) => i.id === itemId) || null;
}

function visibleItems() {
  let chans = state.channels;
  if (state.filter === 'favorites') chans = chans.filter((c) => c.favorite);
  else if (state.filter !== 'all') chans = chans.filter((c) => c.id === state.filter);
  const all = [];
  for (const ch of chans) for (const it of state.items[ch.id] || []) all.push({ ch, it });
  all.sort((a, b) => (b.it.date || b.it.firstSeen) - (a.it.date || a.it.firstSeen));
  return all.slice(0, MAX_ITEMS_SHOWN);
}

const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
function relativeTime(ts) {
  if (!ts) return '';
  const diff = (ts - Date.now()) / 1000;
  const abs = Math.abs(diff);
  if (abs < 60) return rtf.format(Math.round(diff), 'second');
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute');
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour');
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day');
  return new Date(ts).toLocaleDateString();
}
const fullDate = (ts) => (ts ? new Date(ts).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function setStatus(msg) { $('#status').textContent = msg; }

// ---------- fetching ----------
async function fetchFeed(url) {
  const { text, finalUrl } = await window.api.fetchFeed(url);
  try {
    return { feed: Feed.parse(text, finalUrl), url };
  } catch (err) {
    const discovered = Feed.discoverFeedUrl(text, finalUrl);
    if (!discovered || discovered === url) throw err;
    const second = await window.api.fetchFeed(discovered);
    return { feed: Feed.parse(second.text, second.finalUrl), url: discovered };
  }
}

async function refreshChannel(ch) {
  try {
    const { feed } = await fetchFeed(ch.url);
    if (!channelById(ch.id)) return; // deleted while fetching
    ch.title = feed.title || ch.title;
    ch.error = null;
    ch.lastFetched = Date.now();

    const existing = new Map((state.items[ch.id] || []).map((i) => [i.id, i]));
    const fresh = [];
    const now = Date.now();
    for (const it of feed.items) {
      const old = existing.get(it.id);
      if (old) {
        Object.assign(old, it, { read: old.read, firstSeen: old.firstSeen });
      } else {
        const item = { ...it, read: false, firstSeen: now };
        existing.set(it.id, item);
        fresh.push(item);
      }
    }
    state.items[ch.id] = [...existing.values()]
      .sort((a, b) => (b.date || b.firstSeen) - (a.date || a.firstSeen))
      .slice(0, MAX_ITEMS_PER_CHANNEL);

    // Only notify for posts that arrive after the first fetch of a channel.
    if (ch.favorite && ch.initialized && fresh.length) notifyNew(ch, fresh);
    ch.initialized = true;
  } catch (err) {
    ch.error = String(err && err.message ? err.message : err).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
  }
}

function notifyNew(ch, fresh) {
  const name = channelName(ch);
  if (fresh.length > MAX_NOTIFICATIONS_PER_CHANNEL) {
    window.api.notify({
      title: `${fresh.length} new posts in ${name}`,
      body: fresh.slice(0, 3).map((i) => '• ' + i.title).join('\n'),
      channelId: ch.id,
      itemId: fresh[0].id,
    });
    return;
  }
  for (const it of fresh) {
    window.api.notify({ title: `${name}: ${it.title}`, body: it.summary, channelId: ch.id, itemId: it.id });
  }
}

async function refreshAll() {
  if (state.refreshing) return;
  if (!state.channels.length) { scheduleRefresh(); return; }
  state.refreshing = true;
  document.body.classList.add('is-refreshing');
  setStatus('Refreshing…');
  const queue = [...state.channels];
  const total = queue.length;
  let done = 0;
  const worker = async () => {
    while (queue.length) {
      await refreshChannel(queue.shift());
      done++;
      setStatus(`Refreshing ${done}/${total}…`);
      updateList(); // results stream in; no full rebuild
    }
  };
  await Promise.all(Array.from({ length: FETCH_CONCURRENCY }, worker));
  state.refreshing = false;
  state.lastRefresh = Date.now();
  document.body.classList.remove('is-refreshing');
  save();
  renderFilter();
  updateList();
  renderChannels();
  const sel = state.selected;
  if (sel && !findItem(sel.channelId, sel.itemId)) closeReader();
  updateStatus();
  scheduleRefresh();
}

let refreshTimer = null;
function scheduleRefresh() {
  clearTimeout(refreshTimer);
  const mins = Number(state.settings.refreshMinutes);
  if (mins > 0) refreshTimer = setTimeout(refreshAll, mins * 60 * 1000);
  updateStatus();
}

function updateStatus() {
  if (state.refreshing) return;
  const errors = state.channels.filter((c) => c.error).length;
  const parts = [];
  if (state.lastRefresh) parts.push('Updated ' + relativeTime(state.lastRefresh));
  if (errors) parts.push(`${errors} channel${errors > 1 ? 's' : ''} failed`);
  setStatus(parts.join(' · '));
}

// ---------- rendering: feed ----------
function renderFilter() {
  const sel = $('#filter');
  const prev = state.filter;
  sel.replaceChildren(
    h('option', { value: 'all', text: 'All channels' }),
    h('option', { value: 'favorites', text: '★ Favorites' }),
    ...state.channels.map((c) => h('option', { value: c.id, text: channelName(c) }))
  );
  sel.value = [...sel.options].some((o) => o.value === prev) ? prev : 'all';
  state.filter = sel.value;
}

const STAGGER_ROWS = 15;
const STAGGER_MS = 18;
let listEnterTimer = null;

// animate: stagger rows in. Only for full refreshes (startup, filter change, refresh), never for
// incidental re-renders, so the list does not replay its entrance.
function renderList({ animate = false } = {}) {
  const list = $('#item-list');
  const rows = visibleItems();
  clearTimeout(listEnterTimer);
  list.classList.remove('list-enter');
  if (animate) {
    list.classList.add('list-enter');
    listEnterTimer = setTimeout(() => list.classList.remove('list-enter'), STAGGER_ROWS * STAGGER_MS + 400);
  }
  if (!state.channels.length) {
    list.replaceChildren(h('li', { class: 'empty' },
      h('p', { text: 'No channels yet.' }),
      h('button', { class: 'btn btn-primary', onclick: () => switchView('channels'), text: 'Add a channel' })));
    return;
  }
  if (!rows.length) {
    list.replaceChildren(h('li', { class: 'empty' }, h('p', { text: state.refreshing ? 'Loading…' : 'No posts here yet.' })));
    return;
  }
  list.replaceChildren(...rows.map(({ ch, it }, i) => {
    const li = buildRow(ch, it);
    li.style.setProperty('--i', String(Math.min(i, STAGGER_ROWS)));
    return li;
  }));
}

function buildRow(ch, it) {
  const selected = state.selected && state.selected.channelId === ch.id && state.selected.itemId === it.id;
  return h('li', {
    class: ['row', ch.color && 'has-color', it.read && 'is-read', selected && 'is-selected'].filter(Boolean).join(' '),
    color: ch.color || null,
    'data-channel': ch.id,
    'data-item': it.id,
    'aria-selected': selected ? 'true' : 'false',
    onclick: () => select(ch.id, it.id),
  },
  h('div', { class: 'row-title', text: it.title }),
  it.summary ? h('div', { class: 'row-summary', text: it.summary }) : null,
  h('div', { class: 'row-meta' },
    ch.favorite ? h('span', { class: 'star', text: '★' }) : null,
    h('span', { text: channelName(ch) }),
    h('span', { class: 'dot', text: '·' }),
    h('time', { text: relativeTime(it.date || it.firstSeen), title: fullDate(it.date || it.firstSeen) })));
}

// Reconcile the list in place: keeps existing rows, scroll position and selection; only new rows animate.
function updateList() {
  const list = $('#item-list');
  const rows = visibleItems();
  if (!state.channels.length || !rows.length) { renderList(); return; }
  const existing = new Map();
  list.querySelectorAll('.row').forEach((li) => existing.set(li.dataset.channel + '|' + li.dataset.item, li));
  list.querySelectorAll('.empty').forEach((li) => li.remove());
  const animateNew = existing.size > 0;
  let prev = null;
  for (const { ch, it } of rows) {
    const key = ch.id + '|' + it.id;
    let li = existing.get(key);
    if (li) {
      existing.delete(key);
      const fresh = buildRow(ch, it);
      if (li.innerHTML !== fresh.innerHTML) li.innerHTML = fresh.innerHTML;
      li.classList.toggle('is-read', !!it.read);
    } else {
      li = buildRow(ch, it);
      if (animateNew) li.classList.add('is-new');
    }
    const expected = prev ? prev.nextElementSibling : list.firstElementChild;
    if (expected !== li) list.insertBefore(li, expected);
    prev = li;
  }
  for (const li of existing.values()) li.remove();
}

function rowEl(channelId, itemId) {
  return document.querySelector(`.row[data-channel="${CSS.escape(channelId)}"][data-item="${CSS.escape(itemId)}"]`);
}

function webButton(it, extraClass = '') {
  if (!it.link) return null;
  return h('button', {
    type: 'button',
    class: 'btn btn-primary btn-web' + (extraClass ? ' ' + extraClass : ''),
    title: it.link,
    onclick: () => window.api.openExternal(it.link),
  }, 'Open on web', h('span', { class: 'arrow', 'aria-hidden': 'true', text: '↗' }));
}

function renderReader() {
  const reader = $('#reader');
  const sel = state.selected;
  const ch = sel && channelById(sel.channelId);
  const it = ch && findItem(sel.channelId, sel.itemId);
  if (!it) {
    reader.replaceChildren(h('div', { class: 'reader-empty' }, h('p', { text: 'Select a post to read it.' })));
    return;
  }
  const hero = it.image
    ? h('img', {
      class: 'hero', src: it.image, alt: '', referrerpolicy: 'no-referrer',
      onload: (e) => e.target.classList.add('is-loaded'),
      onerror: (e) => e.target.remove(),
    })
    : null;
  const body = h('div', { class: 'content' });
  if (it.content) body.append(Feed.sanitize(it.content, it.link || ch.url, it.image));
  if (!body.textContent.trim() && !body.querySelector('img')) body.append(h('p', { text: it.summary || 'This post has no text.' }));

  reader.replaceChildren(
    h('div', { class: 'reader-inner' },
      h('button', { type: 'button', class: 'reader-close', title: 'Close (Esc)', 'aria-label': 'Close reader', onclick: closeReader, text: '×' }),
      hero,
      h('div', { class: 'reader-head' },
        h('div', { class: 'reader-channel' }, ch.favorite ? h('span', { class: 'star', text: '★ ' }) : null, channelName(ch)),
        h('h1', { text: it.title }),
        h('div', { class: 'reader-meta' },
          h('time', { text: fullDate(it.date || it.firstSeen) }),
          webButton(it))),
      body,
      it.link ? h('div', { class: 'reader-footer' }, webButton(it)) : null));
  reader.scrollTop = 0;
}

function closeReader() {
  state.selected = null;
  document.querySelectorAll('#item-list .row.is-selected').forEach((r) => {
    r.classList.remove('is-selected');
    r.setAttribute('aria-selected', 'false');
  });
  $('#feed-view').classList.add('reader-closed');
  renderReader();
}

function select(channelId, itemId) {
  state.selected = { channelId, itemId };
  $('#feed-view').classList.remove('reader-closed');
  const it = findItem(channelId, itemId);
  if (it && !it.read) { it.read = true; save(); }
  // Update rows in place so CSS transitions (selection, unread dot) can play.
  document.querySelectorAll('#item-list .row.is-selected').forEach((r) => {
    r.classList.remove('is-selected');
    r.setAttribute('aria-selected', 'false');
  });
  let row = rowEl(channelId, itemId);
  if (!row) { renderList(); row = rowEl(channelId, itemId); }
  if (row) {
    row.classList.add('is-selected', 'is-read');
    row.setAttribute('aria-selected', 'true');
    row.scrollIntoView({ block: 'nearest' });
  }
  renderReader();
}

function moveSelection(delta) {
  const rows = visibleItems();
  if (!rows.length) return;
  let idx = rows.findIndex(({ ch, it }) => state.selected && ch.id === state.selected.channelId && it.id === state.selected.itemId);
  idx = idx === -1 ? 0 : Math.max(0, Math.min(rows.length - 1, idx + delta));
  select(rows[idx].ch.id, rows[idx].it.id);
}

// ---------- rendering: channels sub menu ----------
function swatches(current, onPick, name) {
  return COLORS.map((c) => h('button', {
    type: 'button',
    class: 'swatch' + (c ? '' : ' swatch-none') + (c === (current || '') ? ' is-active' : ''),
    color: c || null,
    title: c ? c : 'No color',
    role: 'radio',
    'aria-checked': c === (current || '') ? 'true' : 'false',
    'aria-label': (name ? name + ' color ' : 'Color ') + (c || 'none'),
    onclick: () => onPick(c),
  }));
}

function renderChannels() {
  $('#channel-count').textContent = state.channels.length ? String(state.channels.length) : '';
  positionTabIndicator(); // tab width changes with the count
  const popId = state.justFavorited;
  state.justFavorited = null;
  $('#add-swatches').replaceChildren(...swatches(state.newColor, (c) => { state.newColor = c; renderChannels(); }));

  const list = $('#channel-list');
  if (!state.channels.length) {
    list.replaceChildren(h('li', { class: 'empty small', text: 'No channels registered yet. Add one above.' }));
    return;
  }
  list.replaceChildren(...state.channels.map((ch) => {
    const count = (state.items[ch.id] || []).length;
    const unread = (state.items[ch.id] || []).filter((i) => !i.read).length;
    const del = h('button', { class: 'btn btn-quiet btn-danger', type: 'button', text: 'Delete' });
    del.addEventListener('click', () => {
      if (del.dataset.armed) return removeChannel(ch.id);
      del.dataset.armed = '1';
      del.textContent = 'Confirm delete';
      setTimeout(() => { delete del.dataset.armed; del.textContent = 'Delete'; }, 3000);
    });
    return h('li', { class: 'channel' + (ch.color ? ' has-color' : ''), color: ch.color || null },
      h('div', { class: 'channel-main' },
        h('input', {
          class: 'channel-name', value: channelName(ch), 'aria-label': 'Channel name',
          onchange: (e) => { const v = e.target.value.trim(); ch.customTitle = v && v !== ch.title ? v : ''; save(); render(); },
        }),
        h('div', { class: 'channel-url', text: ch.url, title: ch.url }),
        h('div', { class: 'channel-stats' + (ch.error ? ' has-error' : '') ,
          text: ch.error ? `⚠ ${ch.error}` : `${count} post${count === 1 ? '' : 's'} · ${unread} unread${ch.lastFetched ? ' · checked ' + relativeTime(ch.lastFetched) : ''}` })),
      h('div', { class: 'channel-controls' },
        h('div', { class: 'swatches small', role: 'radiogroup', 'aria-label': 'Channel color' },
          swatches(ch.color, (c) => { ch.color = c; save(); render(); }, channelName(ch))),
        h('button', {
          type: 'button',
          class: 'btn btn-quiet fav' + (ch.favorite ? ' is-on' : ''),
          'aria-pressed': ch.favorite ? 'true' : 'false',
          title: ch.favorite ? 'Favorite: new posts send desktop notifications' : 'Mark as favorite to get desktop notifications',
          onclick: () => { ch.favorite = !ch.favorite; state.justFavorited = ch.id; save(); render(); },
        }, h('span', { class: 'star' + (popId === ch.id ? ' pop' : ''), text: ch.favorite ? '★' : '☆' }), ' Favorite'),
        del));
  }));
}

function setMessage(kind, text) {
  const msg = $('#add-message');
  msg.className = 'message' + (kind ? ' ' + kind : '');
  msg.textContent = text;
  void msg.offsetWidth; // restart the fade-in animation
  msg.classList.add('flash');
}

async function addChannel(url, color, favorite) {
  url = url.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  if (state.channels.some((c) => c.url === url)) { setMessage('error', 'That channel is already registered.'); return false; }
  setMessage('', 'Checking feed…');
  try {
    const { feed, url: feedUrl } = await fetchFeed(url);
    if (state.channels.some((c) => c.url === feedUrl)) { setMessage('error', 'That channel is already registered.'); return false; }
    const ch = { id: uid(), url: feedUrl, title: feed.title, customTitle: '', color, favorite, initialized: false, error: null, lastFetched: null };
    state.channels.push(ch);
    await refreshChannel(ch);
    save();
    render();
    const n = (state.items[ch.id] || []).length;
    setMessage('ok', `Added “${channelName(ch)}” with ${n} post${n === 1 ? '' : 's'}.`);
    return true;
  } catch (err) {
    setMessage('error', 'Could not add: ' + String(err.message || err).replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    return false;
  }
}

function removeChannel(id) {
  state.channels = state.channels.filter((c) => c.id !== id);
  delete state.items[id];
  if (state.selected && state.selected.channelId === id) state.selected = null;
  if (state.filter === id) state.filter = 'all';
  save();
  render();
}

// ---------- view switching ----------
function switchView(view) {
  state.view = view;
  document.querySelectorAll('.tab').forEach((t) => t.setAttribute('aria-selected', String(t.dataset.view === view)));
  $('#feed-view').hidden = view !== 'feed';
  $('#channels-view').hidden = view !== 'channels';
  positionTabIndicator();
  if (view === 'channels') setTimeout(() => $('#add-url').focus(), 0);
}

function positionTabIndicator(instant = false) {
  const ind = $('.tab-indicator');
  const tab = document.querySelector(`.tab[data-view="${state.view}"]`);
  if (!ind || !tab) return;
  if (instant) ind.style.transition = 'none';
  ind.style.width = tab.offsetWidth + 'px';
  ind.style.transform = `translateX(${tab.offsetLeft}px)`;
  if (instant) { void ind.offsetWidth; ind.style.transition = ''; }
}

function render({ animateList = false } = {}) {
  renderFilter();
  renderList({ animate: animateList });
  renderReader();
  $('#feed-view').classList.toggle('reader-closed', !state.selected);
  renderChannels();
  updateStatus();
}

// ---------- wiring ----------
function wire() {
  document.querySelectorAll('.tab').forEach((t) => t.addEventListener('click', () => switchView(t.dataset.view)));
  $('#refresh').addEventListener('click', refreshAll);
  $('#filter').addEventListener('change', (e) => { state.filter = e.target.value; renderList({ animate: true }); });
  $('#mark-all-read').addEventListener('click', () => {
    for (const { it } of visibleItems()) it.read = true;
    save();
    // In place, so the unread dots fade out instead of vanishing.
    document.querySelectorAll('#item-list .row').forEach((r) => r.classList.add('is-read'));
  });

  $('#add-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const input = $('#add-url');
    const btn = e.target.querySelector('button[type="submit"]');
    btn.disabled = true;
    const ok = await addChannel(input.value, state.newColor, $('#add-favorite').checked);
    btn.disabled = false;
    if (ok) { input.value = ''; $('#add-favorite').checked = false; state.newColor = ''; renderChannels(); }
  });

  const interval = $('#refresh-interval');
  interval.value = String(state.settings.refreshMinutes);
  interval.addEventListener('change', () => { state.settings.refreshMinutes = Number(interval.value); save(); scheduleRefresh(); });

  for (const [id, key, num] of [['#theme', 'theme'], ['#ui-font', 'uiFont'], ['#reading-font', 'readingFont'], ['#font-size', 'fontSize', true]]) {
    const el = $(id);
    el.value = String(state.settings[key]);
    el.addEventListener('change', () => {
      state.settings[key] = num ? Number(el.value) : el.value;
      applyAppearance();
      save();
      positionTabIndicator(true);
    });
  }

  $('#test-notification').addEventListener('click', () => {
    window.api.notify({ title: 'Simple RSS', body: 'Notifications are working. Favorite channels will notify you like this.' });
  });

  // Links inside posts open in the system browser.
  $('#reader').addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (!a) return;
    e.preventDefault();
    window.api.openExternal(a.href);
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'r') { e.preventDefault(); refreshAll(); return; }
    if (e.key === 'Escape' && state.view === 'feed' && state.selected) { closeReader(); return; }
    if (state.view !== 'feed' || /input|select|textarea/i.test(document.activeElement.tagName)) return;
    if (e.key === 'ArrowDown' || e.key === 'j') { e.preventDefault(); moveSelection(1); }
    if (e.key === 'ArrowUp' || e.key === 'k') { e.preventDefault(); moveSelection(-1); }
  });

  window.api.onOpenItem(({ channelId, itemId }) => {
    if (!channelId) return;
    switchView('feed');
    if (state.filter !== 'all' && state.filter !== channelId) { state.filter = 'all'; renderFilter(); renderList(); }
    select(channelId, itemId);
  });

  setInterval(() => { if (state.view === 'feed') updateList(); updateStatus(); }, 60 * 1000); // keep "x min ago" fresh
}

(async function start() {
  await load();
  applyAppearance();
  wire();
  render({ animateList: true });
  positionTabIndicator(true);
  window.addEventListener('resize', () => positionTabIndicator(true));
  refreshAll();
})();

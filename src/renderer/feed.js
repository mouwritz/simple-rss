'use strict';

/* Feed parsing (RSS 2.0, RSS 1.0/RDF, Atom) and HTML sanitising.
   Everything here runs on inert DOMParser documents: no scripts run and no images load. */

const Feed = (() => {
  const SUMMARY_LENGTH = 280;

  // ----- small DOM helpers (match by lower-cased nodeName, so "content:encoded" works without namespace lookups)
  const nameOf = (el) => el.nodeName.toLowerCase();
  const children = (el, name) => (el ? [...el.children].filter((c) => nameOf(c) === name) : []);
  const child = (el, name) => children(el, name)[0] || null;
  const text = (el, ...names) => {
    for (const n of names) {
      const c = child(el, n);
      const t = c && c.textContent.trim();
      if (t) return t;
    }
    return '';
  };

  function resolveUrl(value, base) {
    if (!value) return '';
    try {
      const u = new URL(value.trim(), base || undefined);
      return /^https?:$/.test(u.protocol) ? u.href : '';
    } catch {
      return '';
    }
  }

  function htmlToText(html) {
    if (!html) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    doc.querySelectorAll('script, style, noscript').forEach((n) => n.remove());
    return (doc.body.textContent || '').replace(/\s+/g, ' ').trim();
  }

  function truncate(str, max) {
    if (str.length <= max) return str;
    const cut = str.slice(0, max);
    const lastSpace = cut.lastIndexOf(' ');
    return (lastSpace > max * 0.6 ? cut.slice(0, lastSpace) : cut).replace(/[\s.,;:]+$/, '') + '…';
  }

  function parseDate(str) {
    if (!str) return null;
    const t = Date.parse(str);
    return Number.isNaN(t) ? null : t;
  }

  function firstImageInHtml(html, base) {
    if (!html || !/<img/i.test(html)) return '';
    const doc = new DOMParser().parseFromString(html, 'text/html');
    for (const img of doc.querySelectorAll('img')) {
      const w = parseInt(img.getAttribute('width'), 10);
      const h = parseInt(img.getAttribute('height'), 10);
      if ((w && w < 50) || (h && h < 50)) continue; // skip tracking pixels and icons
      const src = resolveUrl(img.getAttribute('data-src') || img.getAttribute('src'), base);
      if (src) return src;
    }
    return '';
  }

  function mediaImage(el, base) {
    const scopes = [el, ...children(el, 'media:group')];
    for (const scope of scopes) {
      const thumb = child(scope, 'media:thumbnail');
      if (thumb && thumb.getAttribute('url')) return resolveUrl(thumb.getAttribute('url'), base);
      for (const mc of children(scope, 'media:content')) {
        const type = mc.getAttribute('type') || '';
        const medium = mc.getAttribute('medium') || '';
        if (medium === 'image' || type.startsWith('image/')) {
          const u = resolveUrl(mc.getAttribute('url'), base);
          if (u) return u;
        }
      }
    }
    for (const enc of [...children(el, 'enclosure'), ...children(el, 'link').filter((l) => l.getAttribute('rel') === 'enclosure')]) {
      if ((enc.getAttribute('type') || '').startsWith('image/')) {
        const u = resolveUrl(enc.getAttribute('url') || enc.getAttribute('href'), base);
        if (u) return u;
      }
    }
    const itunes = child(el, 'itunes:image');
    if (itunes) return resolveUrl(itunes.getAttribute('href'), base);
    return '';
  }

  function atomLink(el) {
    const links = children(el, 'link');
    const alt = links.find((l) => !l.getAttribute('rel') || l.getAttribute('rel') === 'alternate');
    return (alt || links[0])?.getAttribute('href') || '';
  }

  // Atom text constructs can be type="text" (escape it) or html/xhtml.
  function atomHtml(el) {
    if (!el) return '';
    const type = el.getAttribute('type') || 'text';
    if (type === 'xhtml') return el.innerHTML || el.textContent;
    if (type === 'html' || type.includes('html')) return el.textContent;
    return escapeHtml(el.textContent);
  }

  function escapeHtml(s) {
    return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }

  function buildItem({ id, title, link, date, summaryHtml, contentHtml, image }, base) {
    const resolvedLink = resolveUrl(link, base);
    const itemBase = resolvedLink || base;
    const html = contentHtml || summaryHtml || '';
    const summarySource = summaryHtml || contentHtml || '';
    const cleanTitle = htmlToText(title) || '(untitled)';
    return {
      id: (id || resolvedLink || cleanTitle + '|' + (date || '')).trim(),
      title: cleanTitle,
      link: resolvedLink,
      date: parseDate(date),
      summary: truncate(htmlToText(summarySource), SUMMARY_LENGTH),
      content: html,
      image: image || firstImageInHtml(html, itemBase),
    };
  }

  function parseRssItem(el, base) {
    return buildItem({
      id: text(el, 'guid'),
      title: text(el, 'title', 'dc:title'),
      link: text(el, 'link') || child(el, 'atom:link')?.getAttribute('href') || '',
      date: text(el, 'pubdate', 'dc:date', 'a10:updated', 'updated'),
      summaryHtml: text(el, 'description', 'itunes:summary', 'media:description'),
      contentHtml: text(el, 'content:encoded') || text(el, 'description'),
      image: mediaImage(el, base),
    }, base);
  }

  function parseAtomEntry(el, base) {
    return buildItem({
      id: text(el, 'id'),
      title: atomHtml(child(el, 'title')),
      link: atomLink(el),
      date: text(el, 'published', 'updated', 'issued', 'modified'),
      summaryHtml: atomHtml(child(el, 'summary')),
      contentHtml: atomHtml(child(el, 'content')) || atomHtml(child(el, 'summary')),
      image: mediaImage(el, base),
    }, base);
  }

  /** Parse feed XML. Throws if the text is not RSS/Atom. */
  function parse(xmlText, baseUrl) {
    const doc = new DOMParser().parseFromString(xmlText.replace(/^﻿/, '').trimStart(), 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) throw new Error('Not a valid RSS or Atom feed');
    const root = doc.documentElement;
    const rootName = root.localName.toLowerCase();

    if (rootName === 'feed') {
      return {
        title: htmlToText(atomHtml(child(root, 'title'))) || baseUrl,
        link: resolveUrl(atomLink(root), baseUrl),
        items: children(root, 'entry').map((e) => parseAtomEntry(e, baseUrl)),
      };
    }
    if (rootName === 'rss' || rootName === 'rdf') {
      const channel = child(root, 'channel');
      const itemParent = rootName === 'rss' ? channel : root;
      return {
        title: htmlToText(text(channel, 'title')) || baseUrl,
        link: resolveUrl(text(channel, 'link'), baseUrl),
        items: children(itemParent, 'item').map((e) => parseRssItem(e, baseUrl)),
      };
    }
    throw new Error('Not a valid RSS or Atom feed');
  }

  /** If the text is an HTML page, return the URL of its advertised feed, if any. */
  function discoverFeedUrl(htmlText, baseUrl) {
    if (!/<html|<head|<!doctype html/i.test(htmlText.slice(0, 2000))) return '';
    const doc = new DOMParser().parseFromString(htmlText, 'text/html');
    const link = doc.querySelector(
      'link[rel~="alternate"][type="application/rss+xml"], link[rel~="alternate"][type="application/atom+xml"], link[rel~="alternate"][type="application/feed+xml"]'
    );
    return link ? resolveUrl(link.getAttribute('href'), baseUrl) : '';
  }

  // ----- sanitiser: allowlist of tags and attributes. Unknown tags are unwrapped; dangerous ones are dropped.
  const ALLOWED = new Set(('a p br hr b strong i em u s strike del ins sub sup small mark code pre kbd samp ' +
    'blockquote q cite ul ol li dl dt dd h1 h2 h3 h4 h5 h6 img figure figcaption table thead tbody tfoot ' +
    'tr th td caption span div abbr time section article header footer aside details summary center').split(' '));
  const DROP = new Set(('script style iframe frame frameset object embed applet form input button textarea ' +
    'select option link meta base noscript svg math template canvas audio video source track title head').split(' '));
  const ATTRS = { a: ['href', 'title'], img: ['src', 'alt', 'title', 'width', 'height'], td: ['colspan', 'rowspan'], th: ['colspan', 'rowspan'], ol: ['start'], abbr: ['title'] };

  function cleanAttributes(el, tag, base) {
    const keep = ATTRS[tag] || [];
    const lazySrc = tag === 'img' ? el.getAttribute('data-src') || el.getAttribute('data-lazy-src') : null;
    for (const attr of [...el.attributes]) {
      if (!keep.includes(attr.name)) el.removeAttribute(attr.name);
    }
    if (tag === 'a') {
      const raw = el.getAttribute('href') || '';
      const href = /^mailto:/i.test(raw.trim()) ? raw.trim() : resolveUrl(raw, base);
      if (href) el.setAttribute('href', href); else el.removeAttribute('href');
    }
    if (tag === 'img') {
      const src = resolveUrl(lazySrc || el.getAttribute('src'), base);
      const w = parseInt(el.getAttribute('width'), 10);
      const ht = parseInt(el.getAttribute('height'), 10);
      if (!src || w <= 2 || ht <= 2) { el.remove(); return; } // also drops 1×1 tracking pixels
      el.setAttribute('src', src);
      el.setAttribute('loading', 'lazy');
      el.setAttribute('referrerpolicy', 'no-referrer');
    }
  }

  function sanitizeNode(node, base) {
    for (const c of [...node.childNodes]) {
      if (c.nodeType === Node.ELEMENT_NODE) {
        const tag = c.localName;
        if (DROP.has(tag)) { c.remove(); continue; }
        sanitizeNode(c, base);
        if (!ALLOWED.has(tag)) { c.replaceWith(...c.childNodes); continue; }
        cleanAttributes(c, tag, base);
      } else if (c.nodeType !== Node.TEXT_NODE) {
        c.remove(); // comments, processing instructions
      }
    }
  }

  /** Returns a DocumentFragment with safe, owned nodes. Optionally removes an image equal to `skipImage`. */
  function sanitize(html, base, skipImage) {
    const doc = new DOMParser().parseFromString(html || '', 'text/html');
    sanitizeNode(doc.body, base);
    if (skipImage) {
      const dup = [...doc.body.querySelectorAll('img')].find((img) => img.getAttribute('src') === skipImage);
      if (dup) {
        const fig = dup.closest('figure');
        (fig && !fig.textContent.trim() ? fig : dup).remove();
      }
    }
    const frag = document.createDocumentFragment();
    for (const n of [...doc.body.childNodes]) frag.appendChild(document.importNode(n, true));
    return frag;
  }

  return { parse, discoverFeedUrl, sanitize, htmlToText };
})();

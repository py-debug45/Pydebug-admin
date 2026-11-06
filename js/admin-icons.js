// admin-icons.js — tiny dependency-free SVG icon set for the admin app.
// Icons stay inline (no icon font or third-party asset request), so the panel
// renders quickly and remains crisp on high-density mobile screens.
//
// Performance note (this file used to be the panel's worst jank source):
// the legacy-emoji replacer rebuilt a ~60-token RegExp *for every text node*
// and re-walked the DOM synchronously on *every* mutation — rendering a
// 50-row table meant hundreds of regex compilations plus a full tree walk per
// inserted row, on the main thread, while the user was scrolling.
// Now: the regex is compiled once, nodes without any legacy glyph bail out on
// a single cheap test, mutations are batched into one idle/animation-frame
// pass, and the observer is paused while we rewrite nodes so our own changes
// cannot feed back into it.
(function () {
  "use strict";

  const paths = {
    dashboard: '<path d="M4 19V9M10 19V5M16 19v-7M3 19h15"/>',
    code: '<path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 4l-4 16"/>',
    card: '<rect x="2" y="5" width="20" height="14" rx="2"/><path d="M2 10h20"/>',
    message: '<path d="M20 15a3 3 0 0 1-3 3H8l-5 3V6a3 3 0 0 1 3-3h11a3 3 0 0 1 3 3z"/>',
    bell: '<path d="M18 9a6 6 0 0 0-12 0c0 7-3 8-3 8h18s-3-1-3-8M10 21h4"/>',
    bot: '<rect x="5" y="7" width="14" height="12" rx="3"/><path d="M12 3v4M9 12h.01M15 12h.01M9 16h6M2 12h3M19 12h3"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    users: '<circle cx="9" cy="8" r="3"/><path d="M2 20c0-3 3-5 7-5s7 2 7 5M17 11a3 3 0 1 0 0-6M17 15c3 0 5 1.5 5 4"/>',
    logout: '<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4M16 17l5-5-5-5M21 12H9"/>',
    menu: '<path d="M4 6h16M4 12h16M4 18h16"/>',
    lock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3"/>',
    shield: '<path d="M12 3 20 6v5c0 5-3.5 8.5-8 10-4.5-1.5-8-5-8-10V6z"/><path d="m9 12 2 2 4-4"/>',
    key: '<circle cx="8" cy="15" r="4"/><path d="m11 12 8-8M16 7l2 2M14 9l2 2"/>',
    ticket: '<path d="M3 9V7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v2a3 3 0 0 0 0 6v2a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-2a3 3 0 0 0 0-6z"/><path d="M13 6v12"/>',
    eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="2.5"/>',
    eyeOff: '<path d="m3 3 18 18M10.6 6.2A10.8 10.8 0 0 1 12 6c6.5 0 10 6 10 6a18 18 0 0 1-3.1 3.6M6.2 6.3C3.5 8 2 12 2 12s3.5 6 10 6c1.6 0 3-.4 4.2-1"/>',
    refresh: '<path d="M20 11a8 8 0 0 0-14.7-4L3 10M3 5v5h5M4 13a8 8 0 0 0 14.7 4L21 14m0 5v-5h-5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-4-4"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 14h10l1-14M9 7V4h6v3"/>',
    sparkles: '<path d="m12 3-1.2 4.8L6 9l4.8 1.2L12 15l1.2-4.8L18 9l-4.8-1.2zM19 15l-.6 2.4L16 18l2.4.6L19 21l.6-2.4L22 18l-2.4-.6z"/>',
    bug: '<path d="M9 8V6a3 3 0 0 1 6 0v2M7 10H4M20 10h-3M7 14H3M21 14h-4M8 18l-2 3M16 18l2 3M8 8h8a3 3 0 0 1 3 3v3a7 7 0 0 1-14 0v-3a3 3 0 0 1 3-3Z"/>',
    file: '<path d="M6 3h8l4 4v14H6z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    check: '<path d="m5 12 4 4L19 6"/>',
    close: '<path d="M6 6l12 12M18 6 6 18"/>',
    alert: '<path d="M12 3 22 20H2z"/><path d="M12 9v5M12 17v.01"/>',
    chart: '<path d="M4 19V5M4 19h17"/><path d="m7 15 4-4 3 2 5-6"/>',
    money: '<circle cx="12" cy="12" r="9"/><path d="M15 8.5c-.7-.6-1.7-1-3-1-1.7 0-3 .8-3 2s1.3 2 3 2 3 .8 3 2-1.3 2-3 2c-1.3 0-2.3-.4-3-1M12 6v12"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
    heart: '<path d="M20.8 8.8c0 5-8.8 10.2-8.8 10.2S3.2 13.8 3.2 8.8A4.8 4.8 0 0 1 12 6a4.8 4.8 0 0 1 8.8 2.8Z"/>',
    flag: '<path d="M5 21V4M5 5c4-3 7 3 14 0v9c-7 3-10-3-14 0"/>',
    clipboard: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 4V2h6v2M9 10h6M9 14h6M9 18h3"/>',
    download: '<path d="M12 3v12M7 11l5 5 5-5M4 21h16"/>',
    arrowLeft: '<path d="M19 12H5M12 19l-7-7 7-7"/>',
    arrowRight: '<path d="M5 12h14M12 5l7 7-7 7"/>',
    chevronDown: '<path d="m6 9 6 6 6-6"/>',
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/>',
    flask: '<path d="M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4A2 2 0 0 0 19 18l-5-9V3M7 16h10"/>',
    flagIndia: '<path d="M5 21V4M5 5h14l-2 4 2 4H5"/><circle cx="12" cy="9" r="1"/>',
    hand: '<path d="M7 11V6a1.5 1.5 0 0 1 3 0v4-6a1.5 1.5 0 0 1 3 0v6-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v5c0 5-3 8-7 8h-1c-3 0-4-2-6-4l-2-2a1.5 1.5 0 0 1 2-2z"/>',
    trophy: '<path d="M8 4h8v5a4 4 0 0 1-8 0zM12 13v5M8 21h8M5 5H3v2a4 4 0 0 0 4 4M19 5h2v2a4 4 0 0 1-4 4"/>',
    zap: '<path d="M13 2 3 14h8l-1 8 10-12h-8z"/>',
    snow: '<path d="M12 2v20M4.9 6l14.2 12M19.1 6 4.9 18M5 12h14"/><path d="m12 2 1 2M12 2 11 4M12 22l1-2M12 22l-1-2"/>',
    // Sidebar navigation glyphs — kept here so the admin menu never mixes
    // emoji with text symbols (they rendered at different sizes and weights).
    certificate: '<circle cx="12" cy="9" r="5.5"/><path d="m8.6 13.4-.9 7.1 4.3-1.9 4.3 1.9-.9-7.1"/>',
    chat: '<path d="M8 9h8M8 13h5"/><path d="M20 4H4a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3v4l5-4h8a1 1 0 0 0 1-1V5a1 1 0 0 0-1-1Z"/>',
    settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a7.9 7.9 0 0 0 .1-1 7.9 7.9 0 0 0-.1-1l2-1.5-2-3.5-2.4 1a7.9 7.9 0 0 0-1.7-1L15 4H9l-.3 2.5a7.9 7.9 0 0 0-1.7 1l-2.4-1-2 3.5 2 1.5a7.9 7.9 0 0 0 0 2l-2 1.5 2 3.5 2.4-1a7.9 7.9 0 0 0 1.7 1L9 20h6l.3-2.5a7.9 7.9 0 0 0 1.7-1l2.4 1 2-3.5z"/>',
    command: '<path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    note: '<path d="M4 4h11l5 5v11H4z"/><path d="M15 4v5h5M8 13h8M8 17h5"/>',
    filter: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>',
    external: '<path d="M14 3h7v7M21 3l-9 9M10 5H5a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-5"/>',
  };

  const aliases = {
    "🤖": "bot", "🔔": "bell", "👁️": "eye", "👁": "eye", "⚙️": "chart", "⚙": "chart",
    "🔍": "search", "🔎": "search", "🧹": "trash", "👋": "hand", "📰": "file", "❤️": "heart",
    "❤": "heart", "🎯": "target", "💰": "money", "💡": "info", "🚀": "arrowRight", "🧩": "sparkles",
    "✨": "sparkles", "📥": "download", "🇮🇳": "flagIndia", "🕵️": "search", "🕵": "search",
    "🐞": "bug", "🏭": "chart", "⚡": "zap", "🛡️": "shield", "🛡": "shield", "🧪": "flask",
    "📣": "bell", "📝": "file", "🏆": "trophy", "❄️": "snow", "❄": "snow", "✅": "check",
    "✔️": "check", "✔": "check", "❌": "close", "⚠️": "alert", "⚠": "alert", "🔴": "alert",
    "🟡": "alert", "🟢": "check", "⭐": "target", "📄": "file", "🔧": "code", "🥺": "heart",
    "🎟️": "ticket", "🎟": "ticket",
    "↻": "refresh", "✕": "close", "←": "arrowLeft", "→": "arrowRight",
  };

  // Compiled ONCE. Longest tokens first so "👁️" wins over "👁".
  const TOKEN_RE = new RegExp(
    Object.keys(aliases)
      .sort((a, b) => b.length - a.length)
      .map((token) => token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|"),
    "gu"
  );
  // Cheap pre-filter: only strings containing a non-ASCII char can match.
  const NON_ASCII_RE = /[^\x00-\x7F]/;
  const SKIP_TAGS = { SCRIPT: 1, STYLE: 1, TEXTAREA: 1, CODE: 1, PRE: 1, svg: 1, SVG: 1 };

  function adminIcon(name, className) {
    const body = paths[name] || paths.info;
    const cls = className ? `svg-icon ${className}` : "svg-icon";
    return `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${body}</svg>`;
  }

  function iconForToken(token) {
    return adminIcon(aliases[token] || "info");
  }

  function replaceTextNode(node) {
    const value = node.nodeValue;
    if (!value || !NON_ASCII_RE.test(value)) return;
    const parent = node.parentElement;
    if (!parent || SKIP_TAGS[parent.tagName] || parent.closest("svg, [data-keep-emoji]")) return;

    TOKEN_RE.lastIndex = 0;
    if (!TOKEN_RE.test(value)) return;
    TOKEN_RE.lastIndex = 0;

    const fragment = document.createDocumentFragment();
    let last = 0;
    let match;
    while ((match = TOKEN_RE.exec(value))) {
      if (match.index > last) fragment.appendChild(document.createTextNode(value.slice(last, match.index)));
      const holder = document.createElement("span");
      holder.className = "svg-icon-holder";
      holder.innerHTML = iconForToken(match[0]);
      fragment.appendChild(holder);
      last = match.index + match[0].length;
    }
    if (last < value.length) fragment.appendChild(document.createTextNode(value.slice(last)));
    node.parentNode.replaceChild(fragment, node);
  }

  function walk(root) {
    if (!root) return;
    if (root.nodeType === Node.TEXT_NODE) { replaceTextNode(root); return; }
    if (root.nodeType !== Node.ELEMENT_NODE && root.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) return;
    // Skip whole subtrees that cannot contain a legacy glyph — one string
    // test instead of one tree walk + N regex runs.
    if (root.textContent && !NON_ASCII_RE.test(root.textContent)) return;
    if (root.tagName && SKIP_TAGS[root.tagName]) return;

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        return node.nodeValue && NON_ASCII_RE.test(node.nodeValue)
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);
    nodes.forEach(replaceTextNode);
  }

  let observer = null;
  let pending = [];
  let scheduled = false;
  const schedule = window.requestIdleCallback
    ? (fn) => window.requestIdleCallback(fn, { timeout: 250 })
    : (fn) => window.requestAnimationFrame(fn);

  function flush() {
    scheduled = false;
    const batch = pending;
    pending = [];
    if (!batch.length) return;
    // Pause the observer: our own replacements must not re-queue work.
    if (observer) observer.disconnect();
    try {
      batch.forEach(walk);
    } finally {
      if (observer) observer.observe(document.body, { childList: true, subtree: true });
    }
  }

  function queue(node) {
    pending.push(node);
    if (scheduled) return;
    scheduled = true;
    schedule(flush);
  }

  function start() {
    walk(document.body);
    observer = new MutationObserver((mutations) => {
      for (let i = 0; i < mutations.length; i++) {
        const added = mutations[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          const node = added[j];
          if (node.nodeType === Node.TEXT_NODE || node.nodeType === Node.ELEMENT_NODE) queue(node);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
  }

  window.adminIcon = adminIcon;
  window.replaceLegacyAdminIcons = (root) => walk(root || document.body);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", start, { once: true });
  } else {
    start();
  }
})();

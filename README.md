# 📝 MarkDown Momma

### Captures chat history and lets you save to Markdown or Print as PDF.

Ever had a brilliant 47-message deep conversation with Claude, ChatGPT, or Gemini and realized you have no clean way to keep it? Screenshots are ugly. Copy-paste loses formatting. Browser print gives you 90 pages of sidebar and whitespace.

MarkDown Momma fixes that. Click the bookmarklet (or the extension icon), pick the conversation container, and get clean, formatted Markdown — ready to save, print, or archive.

---

## How It Works

1. **Activate** — Click the bookmarklet or extension icon
2. **Select** — On known AI sites, it auto-detects the conversation. On any other site, an AdBlock-style element picker lets you hover and click to select exactly what you want to capture
3. **Preview** — A modal appears with your content rendered as beautifully formatted Markdown. Toggle to raw source if you need it
4. **Export** — Save as `.md`, print it, or save as PDF. Done.

The whole flow takes about three seconds.

## Auto-Detected Platforms

| Platform | Domain |
|----------|--------|
| Claude | claude.ai |
| ChatGPT | chatgpt.com / chat.openai.com |
| Google Gemini | gemini.google.com |
| Microsoft Copilot | copilot.microsoft.com |
| Perplexity | perplexity.ai |

Not on the list? No problem — the element picker works on any webpage.

## Install

### Bookmarklet (no install, works everywhere)

Visit **[rendercorporation.com/mdm](https://rendercorporation.com/mdm/)** and drag the button to your Bookmarks Bar.

That's it. One click on any page from now on.

### Chrome Extension

```bash
git clone https://github.com/webdood/markdown-momma.git
cd markdown-momma
node build.js
```

Then: `chrome://extensions/` → Developer mode → Load unpacked → select `dist/`

### DevTools Console (for restricted pages)

Some pages block bookmarklets and extensions. For those, hit F12 and paste this into the Console:

```js
fetch('https://rendercorporation.com/mdm/turndown.min.js')
  .then(r => r.text())
  .then(t => {
    eval(t);
    fetch('https://rendercorporation.com/mdm/mdm.js')
      .then(r => r.text())
      .then(eval);
  })
```

## Under the Hood

**Auto-Scroll Capture** — AI chat interfaces lazy-load messages as you scroll. MarkDown Momma scrolls the container top-to-bottom in steps, waiting for new content to render at each pause, then captures everything once the DOM stabilizes. No more partial exports.

**Image Handling** — Images within the conversation get captured as inline data URIs so they survive the export. Cross-origin images that can't be canvas-captured get wrapped in clickable links (`target="_top"`) so you can still get to them.

**Clean Conversion** — Strips out buttons, navigation, SVGs, iframes, and other UI chrome. Code blocks come through as plain fenced blocks. The Markdown is clean enough to drop straight into Obsidian, Notion, a GitHub repo, or your own docs.

**Rendered Preview** — The export modal shows your Markdown fully rendered with styled headings, code blocks, tables, blockquotes, and images — not a wall of raw syntax. Toggle to raw view anytime.

## Project Structure

```
markdown-momma/
├── manifest.json        Chrome Extension manifest (MV3)
├── background.js        Service worker — injects scripts on icon click
├── content.js           Core: picker, auto-detect, modal, conversion
├── build.js             Validates manifest, assembles dist/
├── package.json
├── lib/
│   └── turndown.js      HTML→Markdown library (MIT)
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── hosted/              Bookmarklet hosting files
    ├── index.html       Install page with draggable bookmarklet
    ├── mdm.js           Content script (identical to content.js)
    ├── turndown.min.js  Turndown library
    └── bookmarklet.txt  Raw javascript: URL
```

## Adding New Sites

Drop an entry into the `SITE_SELECTORS` array in `content.js`:

```js
{
  name: "Your AI Platform",
  hostPattern: /yourai\.com/,
  selectors: [
    ".chat-container",
    "main"
  ]
}
```

Selectors are tried in order. First match with >100 characters of text content wins. PRs welcome.

## Why "Momma"?

Because she keeps everything together, makes sure nothing gets lost, and handles the messy stuff so you don't have to.

## License

MIT

---

Built by [Render Corporation](https://rendercorporation.com) · [@webdood](https://github.com/webdood)

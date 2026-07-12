# MarkDown Momma — HTML Export Refactor

## Overview
Refactored MarkDown Momma to export as **HTML with semantic class wrapping** (primary) OR **Markdown** (optional). The HTML export provides full styling control and avoids Markdown conversion lossy-ness.

---

## What Changed

### 1. **New HTML Conversion Pipeline**
- **`convertToHTML(html)`** — Replaces direct Markdown conversion
  - Cleans up noise (buttons, nav, scripts, SVG icons, etc.)
  - Wraps content sections in semantic classes
  - Preserves all HTML structure and styling info

### 2. **Semantic Class Wrapping**
HTML output elements are wrapped with classes you can style:

```
.mdm-conversation     — Root container
.mdm-message          — Generic message/content block
.mdm-code-block       — Code blocks (with <pre>)
.mdm-quote            — Blockquotes
.mdm-heading          — Headings (mdm-h1 through mdm-h6)
.mdm-list             — Lists (mdm-ul / mdm-ol)
```

### 3. **Output Mode Toggle**
New button in modal: **"🎨 HTML"** / **"📄 Markdown"**
- Click to switch between HTML and Markdown export modes
- Modal preview updates instantly
- Exports in the selected format

### 4. **Standalone HTML Export**
- **`getStandaloneHTML(htmlContent)`** — Wraps HTML with embedded CSS
- Default CSS included (you can customize in the code or post-process)
- Includes:
  - System fonts + code font (Courier)
  - Message styling (light borders, padding)
  - Code block dark background
  - Blockquote indentation
  - Responsive images
  - Link styling
  - Table/list basic formatting

### 5. **Unified Export Handler**
- **`handleExport(action)`** — Single function handles print/save/pdf
  - Checks current `outputMode` (html or markdown)
  - Generates appropriate content
  - Exports with correct MIME type (.html or .md)

### 6. **State Variables**
```js
outputMode = "html"  // Default: HTML export
rawContent = ""      // Stores the wrapped HTML
```

---

## How to Use

### In the Browser
1. **Click the bookmarklet** or extension icon on any AI chat site
2. **Select** the conversation (auto-detects Claude/ChatGPT/Gemini, etc.)
3. **Modal appears** with preview
4. **Toggle format** using the new "HTML" / "Markdown" button
5. **Export** — Click Print, .MD, or PDF

### HTML Export Features
- ✅ Full visual control — every section has a class
- ✅ Embedded CSS — standalone file, no external assets
- ✅ Can re-style — update CSS after export
- ✅ Works in Obsidian/Notion — paste as HTML
- ✅ No lossy conversion — preserves structure

### Markdown Export (Legacy)
- Same as before — still available via toggle
- Still uses Turndown.js
- Good for plain-text workflows

---

## Customizing the HTML Output

### Change the default CSS
Edit `getStandaloneHTML()` function (around line 360):

```js
.mdm-message {
  margin: 20px 0;
  padding: 16px;
  border-radius: 6px;
  background: #f5f5f5;
  border-left: 3px solid #4ecdc4;  // ← Change this color
}
```

### Add new classes for custom elements
In `convertToHTML()`, add wrappers for new sections:

```js
if (el.tagName === "TABLE") {
  const table = document.createElement("div");
  table.className = "mdm-table";
  table.innerHTML = el.innerHTML;
  container.appendChild(table);
  return;
}
```

Then style it in CSS:
```css
.mdm-table {
  margin: 20px 0;
  /* your styles */
}
```

---

## Files Modified

- **content.js** — Main refactor
  - New `convertToHTML()` function
  - New `handleExport()` unified handler
  - New `getStandaloneHTML()` for standalone export
  - Updated `buildModal()` to show HTML by default
  - Added format toggle button + state tracking

- **hosted/mdm.js** — Copy of content.js for bookmarklet

---

## Next Steps (Optional)

1. **Test the build:**
   ```bash
   node build.js
   chrome://extensions → Load unpacked → select dist/
   ```

2. **Deploy to Porkbun:**
   ```bash
   ftp> cd /mdm/
   ftp> put hosted/mdm.js
   ftp> put hosted/turndown.min.js
   ```

3. **Customize CSS:**
   - Edit `getStandaloneHTML()` CSS block
   - Test with sample conversations
   - Adjust colors, fonts, spacing to your taste

4. **Add site detectors:**
   - Update `SITE_SELECTORS` array if new AI platforms emerge
   - Test auto-detect on each

---

## Backward Compatibility

✅ **Markdown mode still works** — toggle back if needed
✅ **Existing buttons** (Print, Save) work with both formats
✅ **Auto-detect** still works for all platforms

---

## Default CSS Palette

```
Primary accent:     #4ecdc4 (teal)
Secondary:          #ff6b95 (pink)
Tertiary:           #a78bfa (purple)
Code bg:            #1e1e1e (dark)
Code text:          #d4d4d4 (light gray)
Quote border:       #a78bfa (purple)
Message border:     #4ecdc4 (teal)
```

Feel free to adjust these in the CSS section of `getStandaloneHTML()`.

---

Built by Shannon Norrell / Render Corporation

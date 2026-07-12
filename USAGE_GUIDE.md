# MarkDown Momma HTML Export — Quick Guide

## The New Flow

```
┌─────────────────────────────────────────────────────────────┐
│  1. Click Bookmarklet / Extension                           │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  2. Select Conversation Container                           │
│     (auto-detect or element picker)                         │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  3. Auto-scroll & Capture                                   │
│     (accumulates lazy-loaded content)                       │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  4. Convert to HTML + Wrap with Semantic Classes            │
│                                                              │
│  <div class="mdm-message">                                  │
│    <p>User message here...</p>                              │
│  </div>                                                      │
│                                                              │
│  <div class="mdm-code-block">                               │
│    <pre>code here</pre>                                      │
│  </div>                                                      │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  5. Modal Preview                                           │
│                                                              │
│  ┌──── RENDERED ── RAW ──┐  ┌─ 🎨 HTML ── 📄 Markdown ─┐│
│  │                       │  │ (toggle export format)      ││
│  │  [Styled preview]     │  └───────────────────────────┘│
│  │                       │                                 │
│  │ 🖨 Print  💾 .MD  📄 PDF     ✕ Close                  │
│  └───────────────────────┘                                 │
└────────────────┬────────────────────────────────────────────┘
                 │
                 ▼
┌─────────────────────────────────────────────────────────────┐
│  6. Export (HTML or Markdown)                               │
│                                                              │
│  HTML → .html file (standalone, embedded CSS)              │
│  OR                                                          │
│  Markdown → .md file (uses Turndown)                        │
└─────────────────────────────────────────────────────────────┘
```

---

## HTML Output Structure

After capture and conversion, your HTML looks like:

```html
<!DOCTYPE html>
<html>
<head>
  <style>
    /* Embedded CSS here */
    .mdm-message { 
      padding: 16px; 
      border-left: 3px solid #4ecdc4; 
    }
    .mdm-code-block { 
      background: #1e1e1e; 
      color: #d4d4d4; 
    }
    /* ... more styles ... */
  </style>
</head>
<body>
  <div class="mdm-conversation">
    
    <div class="mdm-message">
      <p>What is the capital of France?</p>
    </div>

    <div class="mdm-message">
      <p>The capital of France is Paris...</p>
    </div>

    <div class="mdm-code-block">
      <pre>console.log('Hello, world!');</pre>
    </div>

    <div class="mdm-heading mdm-h2">
      Important Notes
    </div>

    <div class="mdm-quote">
      "This is a blockquote or highlighted section"
    </div>

  </div>
</body>
</html>
```

---

## The CSS Classes You Can Customize

| Class | Purpose | Example |
|-------|---------|---------|
| `.mdm-conversation` | Root container | Wrap all content |
| `.mdm-message` | Any message/content block | User or assistant message |
| `.mdm-code-block` | Code snippets | `<pre>` blocks |
| `.mdm-quote` | Blockquotes/highlights | `> quoted text` |
| `.mdm-heading` | Headings | `# H1`, `## H2`, etc. |
| `.mdm-h1`...`.mdm-h6` | Specific heading levels | Combine with `.mdm-heading` |
| `.mdm-list` | Lists (ul/ol) | Bullet or numbered |
| `.mdm-ul`, `.mdm-ol` | Specific list types | `<ul>` or `<ol>` |

---

## Example: Customizing Message Styling

### Default (in code):
```css
.mdm-message {
  margin: 20px 0;
  padding: 16px;
  border-radius: 6px;
  background: #f5f5f5;
  border-left: 3px solid #4ecdc4;
}
```

### Your custom version (edit after export):
```css
.mdm-message {
  margin: 20px 0;
  padding: 20px;
  border-radius: 12px;
  background: linear-gradient(135deg, #f0f4ff, #f9f5ff);
  border-left: 5px solid #ff6b95;
  box-shadow: 0 2px 8px rgba(0,0,0,0.08);
  font-size: 15px;
  line-height: 1.8;
}
```

---

## Workflow: Edit After Export

1. **Export as HTML** from MarkDown Momma
2. **Open in text editor** (VS Code, Sublime, etc.)
3. **Scroll to `<style>` block** (top of `<head>`)
4. **Customize CSS** for any `.mdm-*` class
5. **Save & open in browser** to preview
6. **Print to PDF** or open in Obsidian/Notion

This gives you **full control** without needing to re-capture.

---

## Switching Back to Markdown

Not happy with HTML? No problem:

1. Click **"📄 Markdown"** button in modal
2. Preview updates to Markdown
3. Export as `.md` file
4. Works exactly like before

---

## Tips & Tricks

### Tip 1: Add Custom Classes in convertToHTML()
Detect new element types and wrap them:

```js
if (el.tagName === "IMG") {
  const imgWrapper = document.createElement("div");
  imgWrapper.className = "mdm-image";
  imgWrapper.appendChild(el.cloneNode(true));
  container.appendChild(imgWrapper);
}
```

Then style:
```css
.mdm-image {
  text-align: center;
  margin: 30px 0;
  padding: 20px;
  background: #f0f0f0;
  border-radius: 8px;
}
```

### Tip 2: Nested Styling
Style content *inside* classes:

```css
.mdm-message p {
  margin: 10px 0;
  font-size: 15px;
}

.mdm-message strong {
  color: #ff6b95;
}

.mdm-code-block pre {
  tab-size: 4;
}
```

### Tip 3: Dark Mode
Add a dark theme CSS option:

```css
@media (prefers-color-scheme: dark) {
  body {
    background: #0a0a14;
    color: #e0e0e0;
  }
  .mdm-message {
    background: #1a1a2e;
    border-left-color: #a78bfa;
  }
  .mdm-code-block {
    background: #000;
  }
}
```

---

## Troubleshooting

### "Modal won't open"
- Check browser console (F12) for errors
- Make sure you're on a known AI site or use element picker
- Try the bookmarklet instead of extension

### "Preview shows raw HTML"
- Click the "RAW" button to toggle to rendered view
- Or switch back to "Markdown" format

### "Export file is empty"
- Check console for errors
- Verify content was captured (preview showed content)
- Try smaller conversation first

### "CSS not applying"
- Make sure you edited the `<style>` block in exported HTML
- Check for typos in class names (case-sensitive)
- Save file and refresh browser

---

## Questions?

Check the original **README.md** for install/general info.

Check **REFACTOR_NOTES.md** for technical details on the code changes.

Built with ❤️ by Shannon Norrell / Render Corporation

# SN_Notes.md — MarkDown Momma Optional Updates To Come

## Reverse Renderer: Computed Style Fingerprinting

### Concept
Instead of manually detecting semantic sections, walk the **actual DOM with `getComputedStyle()`** to extract the visual properties that make elements distinct. Then derive meaningful CSS classes from those findings.

**Workflow:**
```
Pass 1: getComputedStyle() audit
        → Inventory color, font-size, font-weight, padding, margin, 
          border, background, line-height on every element
        → Build a "style fingerprint" catalog

Pass 2: Analyze & Cluster
        → Group similar fingerprints
        → Detect patterns ("this teal color appears 47 times")
        → Derive semantic class names from frequency + context
        → Threshold-based: styles appearing >N times get a class

Pass 3: Rewrite HTML
        → Replace inline/computed styles with derived classes
        → Generate minimal CSS to match original appearance
        → Fallback rare styles to attributes
```

### Benefits
- ✅ Output **actually matches** the source visually (not guessed)
- ✅ Auto-detects platform-specific styling (Claude teal vs ChatGPT orange, etc.)
- ✅ Works across any AI site without manual selectors
- ✅ Baseline CSS is derived, then user customizes from there
- ✅ Reusable classes (`.mdm-color-assistant-message`, `.mdm-font-code`, etc.)

### Challenges
- Grouping strategy: by color alone? size? weight combo? position?
- Class explosion risk (1 class per unique style combo)
- Semantic detection (knowing a teal div is a message, not just styling)
- DOM walking overhead (3 passes on large conversations)
- Maintenance: reverse-rendered CSS needs validation

### Possible Implementation
```js
// Pass 1: Extract styles
function extractStyleInventory(el) {
  const inventory = {};
  const walk = (node) => {
    if (node.nodeType !== 1) return;
    const computed = window.getComputedStyle(node);
    const fingerprint = {
      color: computed.color,
      bgColor: computed.backgroundColor,
      fontSize: computed.fontSize,
      fontWeight: computed.fontWeight,
      padding: computed.padding,
      margin: computed.margin,
      border: computed.border,
      lineHeight: computed.lineHeight
    };
    const key = JSON.stringify(fingerprint);
    inventory[key] = (inventory[key] || 0) + 1;
    Array.from(node.children).forEach(walk);
  };
  walk(el);
  return inventory;
}

// Pass 2: Derive classes from frequencies
function deriveClasses(inventory, threshold = 5) {
  const classes = {};
  Object.entries(inventory).forEach(([fingerprint, count]) => {
    if (count >= threshold) {
      const style = JSON.parse(fingerprint);
      const name = generateClassName(style); // smarter naming
      classes[fingerprint] = name;
    }
  });
  return classes;
}

// Pass 3: Rewrite with classes
function rewriteWithClasses(el, classes) {
  // Replace computed styles with class names
  // Generate CSS to match original
}
```

### Timeline
**Nice to have, not blocking.** Ship current approach first, gather user feedback on styling fidelity. If users need more precision, revisit this.

### Related Tickets
- None yet. This is exploratory.

---

## Other Potential Enhancements

### 0. Icon Rendering Enhancement 🎨 ✅ DONE
Created clean, vectorized icon set from SVG source.

**Completed formats:**
- ✅ `icon.svg` — Source vector (scalable, editable)
- ✅ `icon16.png` — Web/extension (16x16)
- ✅ `icon48.png` — Web/extension (48x48)
- ✅ `icon128.png` — Web/extension (128x128)
- ✅ `icon48.bmp` — Windows bitmap (48x48)
- ✅ `icon128.bmp` — Windows bitmap (128x128)
- ✅ `icon.ico` — Windows icon (multi-resolution 16+48)

**Design:** Clean notebook/document with pink spine, ruled lines, teal brush accent. Uses brand colors (pink #ff6b95, teal #4ecdc4, purple #a78bfa).

**manifest.json:** Updated to reference new PNG icons.

Files all in `icons/` directory. Ready to build/deploy.

---

### 1. Custom CSS Injection Hook
Allow users to pass custom CSS rules at export time:
```js
getStandaloneHTML(htmlContent, customCSS)
```

### 2. Class Name Aliasing
Let users alias `.mdm-*` classes to their own naming:
```js
{
  "mdm-message": "conversation-turn",
  "mdm-code-block": "snippet",
  "mdm-quote": "highlight"
}
```

### 3. Per-Platform Styling
Detect source (Claude/ChatGPT/Gemini) and apply platform-specific CSS defaults.

### 4. Obsidian/Notion Export Optimizations
Special handling for pasting into note-taking apps (strip certain classes, use callouts, etc.)

### 5. Dark Mode Auto-Detection
Detect if user's browser is in dark mode, apply matching theme in export.

### 6. Table Support
Better class wrapping for tables (`.mdm-table`, `.mdm-table-row`, `.mdm-table-cell`).

### 7. Message Attribution Tracking
Detect user vs assistant turns automatically, wrap with `.mdm-role-user` / `.mdm-role-assistant`.

### 8. Conversation Metadata
Inject timestamp, URL, platform into `<meta>` tags for archival purposes.

---

## Notes from Development

- Syntax validation: ✓ (node -c passes)
- No external dependencies added (Turndown already required)
- State tracking: `outputMode` + `rawContent` working as expected
- Modal toggle performance: negligible (instant preview updates)

---

## Testing Checklist (Future)

- [ ] HTML export opens in browser without errors
- [ ] CSS classes render visually similar to source
- [ ] Markdown fallback still works
- [ ] File downloads have correct extensions (.html vs .md)
- [ ] Print-to-PDF works for both formats
- [ ] Multi-site auto-detect (Claude, ChatGPT, Gemini, Copilot, Perplexity)
- [ ] Large conversations (100+ messages) don't timeout
- [ ] Images embed as data URIs in HTML
- [ ] User can edit CSS in exported file and changes persist

---

Built by Shannon Norrell / Render Corporation  
Project: MarkDown Momma v1.0 HTML Export Refactor  
Date: June 11, 2026

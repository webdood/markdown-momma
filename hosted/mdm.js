///////////////////////////////////////////////////////////////////////////////
// content.js - MarkDown Momma content script                               //
// ==========                                                               //
// Element picker + auto-detect + modal preview + export (MD / PDF / Print) //
// Image capture (dataURI inline, external wrapped in href target="_top")   //
// Auto-scroll accumulator for lazy-loaded conversations                    //
// Rendered Markdown preview with Raw/Rendered toggle                       //
///////////////////////////////////////////////////////////////////////////////

(function () {
  "use strict";

  // Guard against double-injection
  if (window.__markdownMommaActive) return;
  window.__markdownMommaActive = true;

  // =========================================================================
  // CONSTANTS
  // =========================================================================

  const HIGHLIGHT_COLOR = "rgba(255, 107, 149, 0.25)";
  const HIGHLIGHT_BORDER = "2px solid #ff6b95";
  const AUTODETECT_BORDER = "2px dashed #4ecdc4";
  const SCROLL_STEP_PX = 600;
  const SCROLL_PAUSE_MS = 800;
  const FILENAME_PREFIX = "MarkDownMomma_";

  ///////////////////////////////////////////////////////////////////////////
  // SITE SELECTORS - auto-detect known AI chat containers                 //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  const SITE_SELECTORS = [
    {
      name: "Claude (claude.ai)",
      hostPattern: /claude\.ai/,
      selectors: [
        "[data-testid='conversation-turn-list']",
        "div.flex-1.flex.flex-col.gap-3",
        "main div[class*='conversation']",
        "main"
      ]
    },
    {
      name: "ChatGPT",
      hostPattern: /chat\.openai\.com|chatgpt\.com/,
      selectors: [
        "div[role='presentation'] main",
        "main .flex.flex-col.items-center",
        "main"
      ]
    },
    {
      name: "Gemini",
      hostPattern: /gemini\.google\.com/,
      selectors: [
        "chat-window",
        "main",
        ".conversation-container"
      ]
    },
    {
      name: "Copilot",
      hostPattern: /copilot\.microsoft\.com/,
      selectors: [
        "#app",
        "main"
      ]
    },
    {
      name: "Perplexity",
      hostPattern: /perplexity\.ai/,
      selectors: [
        "main .flex.flex-col",
        "main"
      ]
    }
  ];

  // =========================================================================
  // STATE
  // =========================================================================

  let pickerActive = false;
  let hoveredEl = null;
  let autoDetectedEl = null;
  let bannerEl = null;
  let modalContainer = null;
  let progressEl = null;
  let previewMode = "rendered"; // "rendered" or "raw"

  // =========================================================================
  // METHODS (alphabetical)
  // =========================================================================

  ///////////////////////////////////////////////////////////////////////////
  // activatePicker - enters element-pick mode with mouseover highlighting //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function activatePicker() {
    pickerActive = true;
    document.addEventListener("mousemove", onPickerMouseMove, true);
    document.addEventListener("click", onPickerClick, true);
    document.addEventListener("keydown", onPickerKeydown, true);
    document.body.style.cursor = "crosshair";
  }

  ///////////////////////////////////////////////////////////////////////////
  // autoDetectContainer - tries known selectors for current hostname      //
  // ====================                                                  //
  ///////////////////////////////////////////////////////////////////////////

  function autoDetectContainer() {
    const host = window.location.hostname;
    for (const site of SITE_SELECTORS) {
      if (!site.hostPattern.test(host)) continue;
      for (const sel of site.selectors) {
        const el = document.querySelector(sel);
        if (el && el.innerText.trim().length > 100) {
          return { el, siteName: site.name };
        }
      }
    }
    return null;
  }

  ///////////////////////////////////////////////////////////////////////////
  // autoScrollAndCapture - scrolls container, accumulates lazy content    //
  // ====================                                                  //
  ///////////////////////////////////////////////////////////////////////////

  async function autoScrollAndCapture(el) {
    const scroller = findScrollableAncestor(el);
    if (!scroller) {
      return el.innerHTML;
    }

    showProgress("Scrolling to top...");
    scroller.scrollTop = 0;
    await sleep(SCROLL_PAUSE_MS);

    let lastHeight = scroller.scrollHeight;
    let stableCount = 0;
    let scrollPos = 0;
    const maxIterations = 500;
    let iteration = 0;

    showProgress("Capturing conversation...");

    while (iteration < maxIterations) {
      iteration++;
      scrollPos += SCROLL_STEP_PX;
      scroller.scrollTop = scrollPos;
      await sleep(SCROLL_PAUSE_MS);

      const currentHeight = scroller.scrollHeight;
      const atBottom = scroller.scrollTop + scroller.clientHeight >= currentHeight - 5;

      if (currentHeight !== lastHeight) {
        lastHeight = currentHeight;
        stableCount = 0;
        updateProgress(`Capturing... ${Math.round((scrollPos / currentHeight) * 100)}%`);
      } else {
        stableCount++;
      }

      if (atBottom && stableCount >= 2) {
        break;
      }
    }

    updateProgress("Processing images...");
    const processedHTML = await captureImagesAsDataURI(el);
    destroyProgress();
    return processedHTML;
  }

  ///////////////////////////////////////////////////////////////////////////
  // buildModal - creates the floating modal with preview + action bar     //
  // ==========                                                            //
  ///////////////////////////////////////////////////////////////////////////

  function buildModal(markdownText) {
    destroyModal();

    modalContainer = document.createElement("div");
    modalContainer.id = "mdm-modal-container";
    modalContainer.innerHTML = getModalHTML();
    document.body.appendChild(modalContainer);

    // Populate both views
    const rawView = modalContainer.querySelector("#mdm-preview-raw");
    const renderedView = modalContainer.querySelector("#mdm-preview-rendered");
    rawView.textContent = markdownText;
    renderedView.innerHTML = renderMarkdown(markdownText);

    // Default to rendered
    setPreviewMode("rendered");

    // Wire toggle
    modalContainer.querySelector("#mdm-btn-toggle").addEventListener("click", () => {
      setPreviewMode(previewMode === "rendered" ? "raw" : "rendered");
    });

    // Wire action buttons
    modalContainer.querySelector("#mdm-btn-print").addEventListener("click", () => handlePrint(markdownText));
    modalContainer.querySelector("#mdm-btn-md").addEventListener("click", () => handleSaveMarkdown(markdownText));
    modalContainer.querySelector("#mdm-btn-pdf").addEventListener("click", () => handleSavePDF(markdownText));
    modalContainer.querySelector("#mdm-btn-close").addEventListener("click", () => shutdown());

    // Backdrop close
    modalContainer.querySelector("#mdm-backdrop").addEventListener("click", () => shutdown());

    // Animate in
    requestAnimationFrame(() => {
      modalContainer.querySelector("#mdm-backdrop").style.opacity = "1";
      modalContainer.querySelector("#mdm-modal").style.transform = "translate(-50%, -50%) scale(1)";
      modalContainer.querySelector("#mdm-modal").style.opacity = "1";
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // captureElement - grabs content (with auto-scroll), converts, shows    //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  async function captureElement(el) {
    const html = await autoScrollAndCapture(el);
    const md = convertToMarkdown(html);
    buildModal(md);
  }

  ///////////////////////////////////////////////////////////////////////////
  // captureImagesAsDataURI - converts all img in element to dataURIs      //
  // ======================                                                //
  ///////////////////////////////////////////////////////////////////////////

  async function captureImagesAsDataURI(el) {
    const clone = el.cloneNode(true);
    const images = clone.querySelectorAll("img");
    const total = images.length;

    if (total > 0) {
      updateProgress(`Processing ${total} image${total > 1 ? "s" : ""}...`);
    }

    let processed = 0;

    for (const img of images) {
      processed++;
      if (total > 3) {
        updateProgress(`Image ${processed}/${total}...`);
      }

      const src = img.getAttribute("src") || "";

      if (img.naturalWidth < 3 && img.naturalHeight < 3) {
        img.remove();
        continue;
      }

      if (src.startsWith("data:")) continue;

      if (src.startsWith("blob:")) {
        wrapImageWithLink(img, src);
        continue;
      }

      try {
        const dataUri = await imageToDataURI(img);
        if (dataUri) {
          img.setAttribute("src", dataUri);
        } else {
          wrapImageWithLink(img, resolveURL(src));
        }
      } catch (e) {
        wrapImageWithLink(img, resolveURL(src));
      }
    }

    return clone.innerHTML;
  }

  ///////////////////////////////////////////////////////////////////////////
  // clearHighlight - removes hover highlight from previously hovered el   //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function clearHighlight() {
    if (hoveredEl) {
      hoveredEl.style.outline = hoveredEl.__mdmOrigOutline || "";
      hoveredEl.style.backgroundColor = hoveredEl.__mdmOrigBg || "";
      delete hoveredEl.__mdmOrigOutline;
      delete hoveredEl.__mdmOrigBg;
      hoveredEl = null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // convertToMarkdown - runs Turndown on HTML string                      //
  // =================                                                     //
  ///////////////////////////////////////////////////////////////////////////

  function convertToMarkdown(html) {
    if (typeof TurndownService === "undefined") {
      console.error("Turndown not loaded");
      return html;
    }

    const td = new TurndownService({
      headingStyle: "atx",
      codeBlockStyle: "fenced",
      bulletListMarker: "-",
      emDelimiter: "_"
    });

    td.addRule("plainCodeBlocks", {
      filter: (node) => {
        return (
          node.nodeName === "PRE" ||
          (node.nodeName === "CODE" && node.parentNode.nodeName === "PRE")
        );
      },
      replacement: (content, node) => {
        if (node.nodeName === "PRE") {
          const code = node.querySelector("code");
          const text = (code || node).textContent;
          return "\n\n```\n" + text.trim() + "\n```\n\n";
        }
        return content;
      }
    });

    td.addRule("imageCapture", {
      filter: "img",
      replacement: (content, node) => {
        const src = node.getAttribute("src") || "";
        const alt = node.getAttribute("alt") || "image";
        return `![${alt}](${src})`;
      }
    });

    td.addRule("linkedImages", {
      filter: (node) => {
        return (
          node.nodeName === "A" &&
          node.getAttribute("data-mdm-imglink") === "true"
        );
      },
      replacement: (content, node) => {
        const href = node.getAttribute("href") || "";
        const img = node.querySelector("img");
        if (img) {
          const alt = img.getAttribute("alt") || "image";
          const src = img.getAttribute("src") || href;
          return `[![${alt}](${src})](${href})`;
        }
        return content;
      }
    });

    td.addRule("stripNoise", {
      filter: (node) => {
        const tag = node.nodeName.toLowerCase();
        return ["button", "nav", "footer", "svg", "iframe", "script", "style", "noscript"].includes(tag);
      },
      replacement: () => ""
    });

    let md = td.turndown(html);
    md = md.replace(/\n{4,}/g, "\n\n\n");
    return md;
  }

  ///////////////////////////////////////////////////////////////////////////
  // deactivatePicker - exits element-pick mode                            //
  // =================                                                     //
  ///////////////////////////////////////////////////////////////////////////

  function deactivatePicker() {
    pickerActive = false;
    clearHighlight();
    document.removeEventListener("mousemove", onPickerMouseMove, true);
    document.removeEventListener("click", onPickerClick, true);
    document.removeEventListener("keydown", onPickerKeydown, true);
    document.body.style.cursor = "";
  }

  ///////////////////////////////////////////////////////////////////////////
  // destroyBanner - removes the auto-detect banner                        //
  // =============                                                         //
  ///////////////////////////////////////////////////////////////////////////

  function destroyBanner() {
    if (bannerEl) {
      bannerEl.remove();
      bannerEl = null;
    }
    if (autoDetectedEl) {
      autoDetectedEl.style.outline = "";
      autoDetectedEl = null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // destroyModal - removes the preview modal                              //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function destroyModal() {
    if (modalContainer) {
      modalContainer.remove();
      modalContainer = null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // destroyProgress - removes the progress indicator                      //
  // ================                                                      //
  ///////////////////////////////////////////////////////////////////////////

  function destroyProgress() {
    if (progressEl) {
      progressEl.remove();
      progressEl = null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // downloadFile - triggers a browser file download                       //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function downloadFile(content, filename, mimeType) {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 200);
  }

  ///////////////////////////////////////////////////////////////////////////
  // drawToDataURI - canvas draw helper                                    //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function drawToDataURI(imgEl) {
    try {
      const canvas = document.createElement("canvas");
      canvas.width = imgEl.naturalWidth || imgEl.width;
      canvas.height = imgEl.naturalHeight || imgEl.height;
      if (canvas.width < 1 || canvas.height < 1) return null;
      const ctx = canvas.getContext("2d");
      ctx.drawImage(imgEl, 0, 0);
      return canvas.toDataURL("image/png");
    } catch (e) {
      return null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // escapeHTML - basic HTML entity escaping                                //
  // ==========                                                            //
  ///////////////////////////////////////////////////////////////////////////

  function escapeHTML(str) {
    return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  ///////////////////////////////////////////////////////////////////////////
  // findScrollableAncestor - walks up the DOM for the scroll container    //
  // ======================                                                //
  ///////////////////////////////////////////////////////////////////////////

  function findScrollableAncestor(el) {
    if (el.scrollHeight > el.clientHeight + 50) return el;
    let node = el.parentElement;
    while (node && node !== document.body && node !== document.documentElement) {
      const style = window.getComputedStyle(node);
      const overflowY = style.overflowY;
      if (
        (overflowY === "auto" || overflowY === "scroll") &&
        node.scrollHeight > node.clientHeight + 50
      ) {
        return node;
      }
      node = node.parentElement;
    }
    const docEl = document.documentElement;
    if (docEl.scrollHeight > docEl.clientHeight + 50) return docEl;
    return null;
  }

  ///////////////////////////////////////////////////////////////////////////
  // generateFilename - builds prefixed filename from page title           //
  // ================                                                      //
  ///////////////////////////////////////////////////////////////////////////

  function generateFilename(extension) {
    const slug = document.title
      .replace(/[^a-z0-9]+/gi, "-")
      .replace(/^-|-$/g, "")
      .substring(0, 60)
      .toLowerCase();
    return `${FILENAME_PREFIX}${slug || "conversation"}.${extension}`;
  }

  ///////////////////////////////////////////////////////////////////////////
  // getModalHTML - returns the full modal markup + embedded styles         //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function getModalHTML() {
    return `
      <style>
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap');

        #mdm-backdrop {
          position: fixed;
          inset: 0;
          background: rgba(0, 0, 0, 0.6);
          backdrop-filter: blur(4px);
          z-index: 2147483640;
          opacity: 0;
          transition: opacity 0.3s ease;
        }

        #mdm-modal {
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%) scale(0.92);
          width: min(88vw, 1020px);
          height: min(85vh, 780px);
          background: #1a1a2e;
          border-radius: 16px;
          z-index: 2147483641;
          display: flex;
          flex-direction: column;
          box-shadow: 0 24px 80px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.08);
          opacity: 0;
          transform-origin: center center;
          transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1),
                      opacity 0.25s ease;
          font-family: 'DM Sans', sans-serif;
          overflow: hidden;
        }

        /* ---- TOP BAR ---- */
        #mdm-topbar {
          display: flex;
          align-items: center;
          justify-content: space-between;
          padding: 12px 20px;
          background: linear-gradient(135deg, #16213e, #1a1a2e);
          border-bottom: 1px solid rgba(255,255,255,0.06);
          flex-shrink: 0;
        }

        #mdm-topbar-title {
          display: flex;
          align-items: center;
          gap: 10px;
          color: #ff6b95;
          font-weight: 700;
          font-size: 15px;
          letter-spacing: 0.5px;
        }

        #mdm-topbar-title .mdm-logo { font-size: 22px; }

        #mdm-btn-group {
          display: flex;
          gap: 6px;
          align-items: center;
        }

        .mdm-btn {
          border: none;
          border-radius: 8px;
          padding: 8px 14px;
          font-family: 'DM Sans', sans-serif;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          transition: all 0.2s ease;
          display: flex;
          align-items: center;
          gap: 5px;
          letter-spacing: 0.3px;
          text-transform: uppercase;
        }

        .mdm-btn:hover {
          transform: translateY(-1px);
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
        .mdm-btn:active { transform: translateY(0); }

        #mdm-btn-toggle {
          background: rgba(255,255,255,0.06);
          color: #aaa;
          border: 1px solid rgba(255,255,255,0.1);
          font-size: 11px;
          padding: 6px 10px;
        }
        #mdm-btn-toggle:hover { background: rgba(255,255,255,0.12); color: #ddd; }

        .mdm-sep {
          width: 1px;
          height: 24px;
          background: rgba(255,255,255,0.08);
          margin: 0 4px;
        }

        #mdm-btn-print { background: #4ecdc4; color: #0a0a14; }
        #mdm-btn-md    { background: #ff6b95; color: #fff; }
        #mdm-btn-pdf   { background: #a78bfa; color: #fff; }
        #mdm-btn-close {
          background: rgba(255,255,255,0.08);
          color: #aaa;
          padding: 8px 12px;
          font-size: 16px;
        }
        #mdm-btn-close:hover { background: #e74c3c; color: #fff; }

        /* ---- PREVIEW AREA ---- */
        #mdm-preview-wrap {
          flex: 1;
          overflow: auto;
          padding: 28px 32px;
        }

        /* Raw view */
        #mdm-preview-raw {
          font-family: 'JetBrains Mono', monospace;
          font-size: 13px;
          line-height: 1.7;
          color: #d4d4d8;
          white-space: pre-wrap;
          word-wrap: break-word;
          tab-size: 2;
          display: none;
          margin: 0;
        }

        /* Rendered view */
        #mdm-preview-rendered {
          font-family: 'DM Sans', sans-serif;
          font-size: 15px;
          line-height: 1.8;
          color: #d4d4d8;
          display: block;
        }

        #mdm-preview-rendered h1 {
          font-size: 26px;
          font-weight: 700;
          color: #ff6b95;
          margin: 32px 0 12px 0;
          padding-bottom: 8px;
          border-bottom: 1px solid rgba(255,107,149,0.15);
        }
        #mdm-preview-rendered h2 {
          font-size: 21px;
          font-weight: 700;
          color: #4ecdc4;
          margin: 28px 0 10px 0;
        }
        #mdm-preview-rendered h3 {
          font-size: 17px;
          font-weight: 700;
          color: #a78bfa;
          margin: 24px 0 8px 0;
        }
        #mdm-preview-rendered h4,
        #mdm-preview-rendered h5,
        #mdm-preview-rendered h6 {
          font-size: 15px;
          font-weight: 700;
          color: #e0e0e0;
          margin: 20px 0 6px 0;
        }

        #mdm-preview-rendered p {
          margin: 0 0 14px 0;
        }

        #mdm-preview-rendered strong {
          color: #f0f0f0;
          font-weight: 700;
        }

        #mdm-preview-rendered em {
          color: #c4b5fd;
          font-style: italic;
        }

        #mdm-preview-rendered a {
          color: #4ecdc4;
          text-decoration: underline;
          text-underline-offset: 3px;
        }

        #mdm-preview-rendered code {
          font-family: 'JetBrains Mono', monospace;
          font-size: 0.88em;
          background: rgba(255,255,255,0.06);
          padding: 2px 6px;
          border-radius: 4px;
          color: #e0c3fc;
        }

        #mdm-preview-rendered pre {
          background: rgba(0,0,0,0.35);
          border: 1px solid rgba(255,255,255,0.06);
          border-radius: 8px;
          padding: 16px 20px;
          margin: 16px 0;
          overflow-x: auto;
        }

        #mdm-preview-rendered pre code {
          background: none;
          padding: 0;
          font-size: 13px;
          line-height: 1.6;
          color: #d4d4d8;
        }

        #mdm-preview-rendered ul,
        #mdm-preview-rendered ol {
          margin: 8px 0 14px 0;
          padding-left: 24px;
        }

        #mdm-preview-rendered li {
          margin-bottom: 6px;
        }

        #mdm-preview-rendered blockquote {
          border-left: 3px solid #ff6b95;
          margin: 14px 0;
          padding: 8px 16px;
          background: rgba(255,107,149,0.05);
          color: #bbb;
        }

        #mdm-preview-rendered hr {
          border: none;
          border-top: 1px solid rgba(255,255,255,0.08);
          margin: 24px 0;
        }

        #mdm-preview-rendered img {
          max-width: 100%;
          border-radius: 8px;
          margin: 12px 0;
        }

        #mdm-preview-rendered table {
          border-collapse: collapse;
          width: 100%;
          margin: 14px 0;
        }
        #mdm-preview-rendered th,
        #mdm-preview-rendered td {
          border: 1px solid rgba(255,255,255,0.1);
          padding: 8px 12px;
          text-align: left;
        }
        #mdm-preview-rendered th {
          background: rgba(255,255,255,0.04);
          font-weight: 600;
          color: #e0e0e0;
        }

        /* ---- FOOTER ---- */
        #mdm-footer {
          padding: 8px 20px;
          display: flex;
          justify-content: space-between;
          align-items: center;
          color: #555;
          font-size: 11px;
          border-top: 1px solid rgba(255,255,255,0.04);
          flex-shrink: 0;
        }

        #mdm-char-count {
          color: #666;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
        }

        /* ---- TOAST ---- */
        #mdm-toast {
          position: fixed;
          bottom: 80px;
          left: 50%;
          transform: translateX(-50%) translateY(20px);
          background: #4ecdc4;
          color: #0a0a14;
          padding: 10px 20px;
          border-radius: 8px;
          font-family: 'DM Sans', sans-serif;
          font-size: 13px;
          font-weight: 600;
          z-index: 2147483647;
          opacity: 0;
          transition: all 0.3s ease;
          pointer-events: none;
        }
        #mdm-toast.mdm-show {
          opacity: 1;
          transform: translateX(-50%) translateY(0);
        }

        /* ---- SCROLLBAR ---- */
        #mdm-preview-wrap::-webkit-scrollbar { width: 8px; }
        #mdm-preview-wrap::-webkit-scrollbar-track { background: transparent; }
        #mdm-preview-wrap::-webkit-scrollbar-thumb {
          background: rgba(255,255,255,0.12);
          border-radius: 4px;
        }
        #mdm-preview-wrap::-webkit-scrollbar-thumb:hover {
          background: rgba(255,255,255,0.2);
        }
      </style>

      <div id="mdm-backdrop"></div>
      <div id="mdm-modal">
        <div id="mdm-topbar">
          <div id="mdm-topbar-title">
            <span class="mdm-logo">\u{1F4DD}</span>
            MarkDown Momma
          </div>
          <div id="mdm-btn-group">
            <button class="mdm-btn" id="mdm-btn-toggle">\u{1F4CB} RAW</button>
            <div class="mdm-sep"></div>
            <button class="mdm-btn" id="mdm-btn-print">\u{1F5A8}\uFE0F Print</button>
            <button class="mdm-btn" id="mdm-btn-md">\u{1F4BE} .MD</button>
            <button class="mdm-btn" id="mdm-btn-pdf">\u{1F4C4} PDF</button>
            <div class="mdm-sep"></div>
            <button class="mdm-btn" id="mdm-btn-close">\u2715</button>
          </div>
        </div>
        <div id="mdm-preview-wrap">
          <pre id="mdm-preview-raw"></pre>
          <div id="mdm-preview-rendered"></div>
        </div>
        <div id="mdm-footer">
          <span>MarkDown Momma v1.0</span>
          <span id="mdm-char-count"></span>
        </div>
      </div>
      <div id="mdm-toast"></div>
    `;
  }

  ///////////////////////////////////////////////////////////////////////////
  // getRenderedPageHTML - builds a full styled HTML page from markdown     //
  // ==================                                                    //
  // Used for Print and PDF export so they look great, not raw text.       //
  ///////////////////////////////////////////////////////////////////////////

  function getRenderedPageHTML(md, title) {
    const rendered = renderMarkdown(md);
    return `<!DOCTYPE html>
<html><head>
  <meta charset="utf-8">
  <title>${escapeHTML(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap');
    * { box-sizing: border-box; }
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 820px;
      margin: 40px auto;
      padding: 0 24px;
      line-height: 1.75;
      color: #1a1a1a;
      font-size: 15px;
    }
    h1 { font-size: 26px; margin: 32px 0 12px; border-bottom: 2px solid #eee; padding-bottom: 8px; }
    h2 { font-size: 21px; margin: 28px 0 10px; color: #333; }
    h3 { font-size: 17px; margin: 24px 0 8px; color: #444; }
    p { margin: 0 0 14px; }
    code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em;
      background: #f4f4f5;
      padding: 2px 6px;
      border-radius: 4px;
    }
    pre {
      background: #f8f8fa;
      border: 1px solid #e8e8ec;
      border-radius: 8px;
      padding: 16px 20px;
      overflow-x: auto;
      margin: 16px 0;
    }
    pre code { background: none; padding: 0; font-size: 13px; line-height: 1.6; }
    blockquote {
      border-left: 3px solid #ccc;
      margin: 14px 0;
      padding: 8px 16px;
      color: #666;
    }
    ul, ol { padding-left: 24px; margin: 8px 0 14px; }
    li { margin-bottom: 6px; }
    hr { border: none; border-top: 1px solid #ddd; margin: 24px 0; }
    img { max-width: 100%; border-radius: 6px; margin: 12px 0; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; }
    th, td { border: 1px solid #ddd; padding: 8px 12px; text-align: left; }
    th { background: #f4f4f5; font-weight: 600; }
    a { color: #2563eb; }
    @media print {
      body { margin: 20px; font-size: 12px; line-height: 1.5; }
      pre { font-size: 10px; }
      h1 { font-size: 20px; }
      h2 { font-size: 16px; }
    }
  </style>
</head>
<body>
  ${rendered}
</body></html>`;
  }

  ///////////////////////////////////////////////////////////////////////////
  // handlePrint - opens a print-friendly window with rendered markdown    //
  // ===========                                                           //
  ///////////////////////////////////////////////////////////////////////////

  function handlePrint(md) {
    const printWin = window.open("", "_blank");
    if (!printWin) {
      showToast("Pop-up blocked! Please allow pop-ups for this site.");
      return;
    }
    printWin.document.write(getRenderedPageHTML(md, FILENAME_PREFIX + "Print"));
    printWin.document.close();
    printWin.focus();
    // Wait for fonts to load before printing
    setTimeout(() => printWin.print(), 800);
  }

  ///////////////////////////////////////////////////////////////////////////
  // handleSaveMarkdown - downloads the text as a .md file                 //
  // ==================                                                    //
  ///////////////////////////////////////////////////////////////////////////

  function handleSaveMarkdown(md) {
    const filename = generateFilename("md");
    downloadFile(md, filename, "text/markdown");
    showToast(`Saved ${filename}`);
  }

  ///////////////////////////////////////////////////////////////////////////
  // handleSavePDF - opens rendered markdown for Print-to-PDF              //
  // =============                                                         //
  ///////////////////////////////////////////////////////////////////////////

  function handleSavePDF(md) {
    const filename = generateFilename("pdf");
    const pdfWin = window.open("", "_blank");
    if (!pdfWin) {
      showToast("Pop-up blocked! Please allow pop-ups for this site.");
      return;
    }
    pdfWin.document.write(getRenderedPageHTML(md, filename));
    pdfWin.document.close();
    pdfWin.focus();
    setTimeout(() => pdfWin.print(), 800);
  }

  ///////////////////////////////////////////////////////////////////////////
  // imageToDataURI - draws an img to canvas and returns dataURI           //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function imageToDataURI(imgEl) {
    return new Promise((resolve) => {
      if (!imgEl.complete || !imgEl.naturalWidth) {
        const tempImg = new Image();
        tempImg.crossOrigin = "anonymous";
        tempImg.onload = () => resolve(drawToDataURI(tempImg));
        tempImg.onerror = () => resolve(null);
        tempImg.src = imgEl.src;
        return;
      }
      resolve(drawToDataURI(imgEl));
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // renderMarkdown - converts markdown string to styled HTML              //
  // ==============                                                        //
  // Lightweight renderer covering: headings, bold, italic, inline code,   //
  // code blocks, links, images, lists (ul/ol), blockquotes, hr, tables,   //
  // and paragraphs. No external dependency needed.                        //
  ///////////////////////////////////////////////////////////////////////////

  function renderMarkdown(md) {
    let html = "";
    const lines = md.split("\n");
    let i = 0;
    let inList = false;
    let listTag = "";

    while (i < lines.length) {
      const line = lines[i];

      // Fenced code block
      if (line.trim().startsWith("```")) {
        if (inList) { html += `</${listTag}>`; inList = false; }
        let codeLines = [];
        i++;
        while (i < lines.length && !lines[i].trim().startsWith("```")) {
          codeLines.push(escapeHTML(lines[i]));
          i++;
        }
        i++; // skip closing ```
        html += `<pre><code>${codeLines.join("\n")}</code></pre>\n`;
        continue;
      }

      // Horizontal rule
      if (/^(-{3,}|\*{3,}|_{3,})\s*$/.test(line.trim())) {
        if (inList) { html += `</${listTag}>`; inList = false; }
        html += "<hr>\n";
        i++;
        continue;
      }

      // Headings
      const headingMatch = line.match(/^(#{1,6})\s+(.+)/);
      if (headingMatch) {
        if (inList) { html += `</${listTag}>`; inList = false; }
        const level = headingMatch[1].length;
        const text = renderInline(headingMatch[2]);
        html += `<h${level}>${text}</h${level}>\n`;
        i++;
        continue;
      }

      // Blockquote
      if (line.trim().startsWith("> ")) {
        if (inList) { html += `</${listTag}>`; inList = false; }
        let quoteLines = [];
        while (i < lines.length && lines[i].trim().startsWith("> ")) {
          quoteLines.push(lines[i].trim().substring(2));
          i++;
        }
        html += `<blockquote><p>${renderInline(quoteLines.join(" "))}</p></blockquote>\n`;
        continue;
      }

      // Unordered list item
      const ulMatch = line.match(/^(\s*)[-*+]\s+(.*)/);
      if (ulMatch) {
        if (!inList || listTag !== "ul") {
          if (inList) html += `</${listTag}>`;
          html += "<ul>";
          inList = true;
          listTag = "ul";
        }
        html += `<li>${renderInline(ulMatch[2])}</li>\n`;
        i++;
        continue;
      }

      // Ordered list item
      const olMatch = line.match(/^(\s*)\d+\.\s+(.*)/);
      if (olMatch) {
        if (!inList || listTag !== "ol") {
          if (inList) html += `</${listTag}>`;
          html += "<ol>";
          inList = true;
          listTag = "ol";
        }
        html += `<li>${renderInline(olMatch[2])}</li>\n`;
        i++;
        continue;
      }

      // Close list if we're no longer in list items
      if (inList) {
        html += `</${listTag}>`;
        inList = false;
      }

      // Table detection
      if (line.includes("|") && i + 1 < lines.length && /^\|?[\s-:|]+\|?$/.test(lines[i + 1].trim())) {
        html += renderTable(lines, i);
        // Skip past table rows
        i++;  // header
        i++;  // separator
        while (i < lines.length && lines[i].trim().startsWith("|")) {
          i++;
        }
        continue;
      }

      // Empty line
      if (line.trim() === "") {
        i++;
        continue;
      }

      // Paragraph — accumulate contiguous non-empty lines
      let paraLines = [];
      while (i < lines.length && lines[i].trim() !== "" && !lines[i].match(/^#{1,6}\s/) && !lines[i].trim().startsWith("```") && !lines[i].trim().startsWith("> ") && !lines[i].match(/^[-*+]\s/) && !lines[i].match(/^\d+\.\s/) && !/^(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i].trim())) {
        paraLines.push(lines[i]);
        i++;
      }
      if (paraLines.length > 0) {
        html += `<p>${renderInline(paraLines.join("\n"))}</p>\n`;
      }
    }

    if (inList) html += `</${listTag}>`;

    return html;
  }

  ///////////////////////////////////////////////////////////////////////////
  // renderInline - converts inline markdown (bold, italic, code, links)   //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function renderInline(text) {
    let out = escapeHTML(text);

    // Images: ![alt](src)
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');

    // Links: [text](url)
    out = out.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_top">$1</a>');

    // Bold + italic: ***text*** or ___text___
    out = out.replace(/\*{3}(.+?)\*{3}/g, "<strong><em>$1</em></strong>");
    out = out.replace(/_{3}(.+?)_{3}/g, "<strong><em>$1</em></strong>");

    // Bold: **text** or __text__
    out = out.replace(/\*{2}(.+?)\*{2}/g, "<strong>$1</strong>");
    out = out.replace(/_{2}(.+?)_{2}/g, "<strong>$1</strong>");

    // Italic: *text* or _text_
    out = out.replace(/\*(.+?)\*/g, "<em>$1</em>");
    out = out.replace(/(^|\s)_(.+?)_(\s|$)/g, "$1<em>$2</em>$3");

    // Inline code: `text`
    out = out.replace(/`([^`]+)`/g, "<code>$1</code>");

    // Line breaks
    out = out.replace(/\n/g, "<br>");

    return out;
  }

  ///////////////////////////////////////////////////////////////////////////
  // renderTable - parses a markdown table starting at line index          //
  // ===========                                                           //
  ///////////////////////////////////////////////////////////////////////////

  function renderTable(lines, startIdx) {
    const parseRow = (line) => {
      return line.split("|").map(cell => cell.trim()).filter(cell => cell !== "");
    };

    const headers = parseRow(lines[startIdx]);
    // skip separator line (startIdx + 1)
    let html = "<table><thead><tr>";
    for (const h of headers) {
      html += `<th>${renderInline(h)}</th>`;
    }
    html += "</tr></thead><tbody>";

    let j = startIdx + 2;
    while (j < lines.length && lines[j].trim().startsWith("|")) {
      const cells = parseRow(lines[j]);
      html += "<tr>";
      for (const c of cells) {
        html += `<td>${renderInline(c)}</td>`;
      }
      html += "</tr>";
      j++;
    }

    html += "</tbody></table>\n";
    return html;
  }

  ///////////////////////////////////////////////////////////////////////////
  // resolveURL - resolves a relative URL to absolute                      //
  // ==========                                                            //
  ///////////////////////////////////////////////////////////////////////////

  function resolveURL(src) {
    try {
      return new URL(src, window.location.href).href;
    } catch (e) {
      return src;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // setPreviewMode - toggles between raw and rendered preview             //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function setPreviewMode(mode) {
    previewMode = mode;
    if (!modalContainer) return;

    const rawView = modalContainer.querySelector("#mdm-preview-raw");
    const renderedView = modalContainer.querySelector("#mdm-preview-rendered");
    const toggleBtn = modalContainer.querySelector("#mdm-btn-toggle");

    if (mode === "raw") {
      rawView.style.display = "block";
      renderedView.style.display = "none";
      toggleBtn.innerHTML = "\u{2728} RENDERED";
    } else {
      rawView.style.display = "none";
      renderedView.style.display = "block";
      toggleBtn.innerHTML = "\u{1F4CB} RAW";
    }

    // Update char count
    const rawText = rawView.textContent || "";
    const countEl = modalContainer.querySelector("#mdm-char-count");
    if (countEl) {
      const lines = rawText.split("\n").length;
      const chars = rawText.length;
      countEl.textContent = `${lines.toLocaleString()} lines \u00B7 ${chars.toLocaleString()} chars`;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // showAutoDetectBanner - displays banner when a container is found      //
  // ====================                                                  //
  ///////////////////////////////////////////////////////////////////////////

  function showAutoDetectBanner(el, siteName) {
    autoDetectedEl = el;
    el.style.outline = AUTODETECT_BORDER;

    bannerEl = document.createElement("div");
    bannerEl.id = "mdm-banner";
    bannerEl.innerHTML = `
      <style>
        #mdm-banner {
          position: fixed;
          top: 16px;
          left: 50%;
          transform: translateX(-50%);
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          color: #e0e0e0;
          padding: 14px 24px;
          border-radius: 12px;
          z-index: 2147483645;
          font-family: 'DM Sans', -apple-system, sans-serif;
          font-size: 14px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
          display: flex;
          align-items: center;
          gap: 12px;
          animation: mdmSlideIn 0.4s cubic-bezier(0.34, 1.56, 0.64, 1);
        }
        @keyframes mdmSlideIn {
          from { opacity: 0; transform: translateX(-50%) translateY(-20px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        #mdm-banner button {
          border: none;
          border-radius: 6px;
          padding: 6px 14px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          transition: all 0.15s;
        }
        #mdm-banner button:hover { transform: translateY(-1px); }
        .mdm-banner-accept { background: #4ecdc4; color: #0a0a14; }
        .mdm-banner-pick   { background: #ff6b95; color: #fff; }
        .mdm-banner-cancel  { background: rgba(255,255,255,0.08); color: #aaa; }
      </style>
      <span>\u{1F4DD}</span>
      <span>Detected <strong style="color:#4ecdc4">${siteName}</strong> conversation</span>
      <button class="mdm-banner-accept">CAPTURE THIS</button>
      <button class="mdm-banner-pick">PICK DIFFERENT</button>
      <button class="mdm-banner-cancel">CANCEL</button>
    `;
    document.body.appendChild(bannerEl);

    bannerEl.querySelector(".mdm-banner-accept").addEventListener("click", () => {
      destroyBanner();
      captureElement(el);
    });
    bannerEl.querySelector(".mdm-banner-pick").addEventListener("click", () => {
      destroyBanner();
      activatePicker();
    });
    bannerEl.querySelector(".mdm-banner-cancel").addEventListener("click", () => {
      shutdown();
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // showProgress - creates the floating progress indicator                //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function showProgress(text) {
    destroyProgress();
    progressEl = document.createElement("div");
    progressEl.id = "mdm-progress";
    progressEl.innerHTML = `
      <style>
        #mdm-progress {
          position: fixed;
          bottom: 24px;
          left: 50%;
          transform: translateX(-50%);
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          color: #4ecdc4;
          padding: 12px 24px;
          border-radius: 10px;
          z-index: 2147483646;
          font-family: 'DM Sans', -apple-system, sans-serif;
          font-size: 13px;
          font-weight: 600;
          box-shadow: 0 8px 32px rgba(0,0,0,0.4), 0 0 0 1px rgba(78,205,196,0.2);
          display: flex;
          align-items: center;
          gap: 10px;
          animation: mdmSlideUp 0.3s ease-out;
        }
        @keyframes mdmSlideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        #mdm-progress-spinner {
          width: 16px; height: 16px;
          border: 2px solid rgba(78,205,196,0.3);
          border-top-color: #4ecdc4;
          border-radius: 50%;
          animation: mdmSpin 0.8s linear infinite;
        }
        @keyframes mdmSpin { to { transform: rotate(360deg); } }
      </style>
      <div id="mdm-progress-spinner"></div>
      <span id="mdm-progress-text">${text}</span>
    `;
    document.body.appendChild(progressEl);
  }

  ///////////////////////////////////////////////////////////////////////////
  // showToast - brief feedback message at bottom of screen                //
  // =========                                                             //
  ///////////////////////////////////////////////////////////////////////////

  function showToast(msg) {
    const toast = document.querySelector("#mdm-toast");
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.add("mdm-show");
    setTimeout(() => toast.classList.remove("mdm-show"), 2500);
  }

  ///////////////////////////////////////////////////////////////////////////
  // sleep - promise-based delay                                           //
  // =====                                                                 //
  ///////////////////////////////////////////////////////////////////////////

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  ///////////////////////////////////////////////////////////////////////////
  // updateProgress - updates the progress indicator text                  //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function updateProgress(text) {
    if (progressEl) {
      const span = progressEl.querySelector("#mdm-progress-text");
      if (span) span.textContent = text;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // wrapImageWithLink - wraps an img in <a href target="_top">            //
  // =================                                                     //
  ///////////////////////////////////////////////////////////////////////////

  function wrapImageWithLink(imgEl, href) {
    const a = document.createElement("a");
    a.href = href;
    a.target = "_top";
    a.setAttribute("data-mdm-imglink", "true");
    imgEl.parentNode.insertBefore(a, imgEl);
    a.appendChild(imgEl);
  }

  // =========================================================================
  // EVENT HANDLERS
  // =========================================================================

  ///////////////////////////////////////////////////////////////////////////
  // onPickerClick - captures the clicked element and converts             //
  // =============                                                         //
  ///////////////////////////////////////////////////////////////////////////

  function onPickerClick(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
    const target = hoveredEl || e.target;
    clearHighlight();
    deactivatePicker();
    captureElement(target);
  }

  ///////////////////////////////////////////////////////////////////////////
  // onPickerKeydown - ESC exits picker mode                               //
  // ===============                                                       //
  ///////////////////////////////////////////////////////////////////////////

  function onPickerKeydown(e) {
    if (e.key === "Escape") {
      deactivatePicker();
      shutdown();
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // onPickerMouseMove - highlights element under cursor                   //
  // ==================                                                    //
  ///////////////////////////////////////////////////////////////////////////

  function onPickerMouseMove(e) {
    const target = document.elementFromPoint(e.clientX, e.clientY);
    if (!target || target === hoveredEl) return;
    if (
      target.closest("#mdm-banner") ||
      target.closest("#mdm-modal-container") ||
      target.closest("#mdm-progress")
    ) return;

    clearHighlight();
    hoveredEl = target;
    hoveredEl.__mdmOrigOutline = hoveredEl.style.outline;
    hoveredEl.__mdmOrigBg = hoveredEl.style.backgroundColor;
    hoveredEl.style.outline = HIGHLIGHT_BORDER;
    hoveredEl.style.backgroundColor = HIGHLIGHT_COLOR;
  }

  ///////////////////////////////////////////////////////////////////////////
  // shutdown - full cleanup, removes all injected UI and state            //
  // ========                                                              //
  ///////////////////////////////////////////////////////////////////////////

  function shutdown() {
    deactivatePicker();
    destroyBanner();
    destroyModal();
    destroyProgress();
    window.__markdownMommaActive = false;
  }

  // =========================================================================
  // **** MAIN - entry point                                              ****
  // =========================================================================

  function main() {
    const detected = autoDetectContainer();
    if (detected) {
      showAutoDetectBanner(detected.el, detected.siteName);
    } else {
      activatePicker();
    }
  }

  main();
})();

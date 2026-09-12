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
  const MIN_CONTENT_LENGTH = 200;
  const CONFIRM_BORDER = "3px solid #4ecdc4";

  ///////////////////////////////////////////////////////////////////////////
  // SITE SELECTORS - auto-detect known AI chat containers                 //
  // ==============                                                        //
  // Selectors tried in order per site. First match with >100 chars wins.  //
  // If all miss, heuristic fallback runs (see findConversationHeuristic). //
  ///////////////////////////////////////////////////////////////////////////

  const SITE_SELECTORS = [
    {
      name: "Claude (claude.ai)",
      hostPattern: /claude\.ai/,
      selectors: [
        "[data-testid='conversation-turn-list']",
        "div[class*='ConversationContent']",
        "div[class*='conversation']",
        "div.flex-1.flex.flex-col.gap-3",
        "[role='main'] > div > div > div",
        "main"
      ]
    },
    {
      name: "ChatGPT",
      hostPattern: /chat\.openai\.com|chatgpt\.com/,
      selectors: [
        "[role='presentation'] main div[class*='react-scroll']",
        "div[role='presentation'] main",
        "main .flex.flex-col.items-center",
        "main"
      ]
    },
    {
      name: "Gemini",
      hostPattern: /gemini\.google\.com/,
      selectors: [
        "infinite-scroller",
        "chat-window",
        ".conversation-container",
        "main"
      ]
    },
    {
      name: "Copilot",
      hostPattern: /copilot\.microsoft\.com/,
      selectors: [
        "cib-serp",
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
    },
    {
      name: "Grok",
      hostPattern: /grok\.com|x\.com\/i\/grok/,
      selectors: [
        "main [class*='conversation']",
        "main"
      ]
    },
    {
      name: "Google AI (Search)",
      hostPattern: /www\.google\.com|google\.com/,
      // aioh=1 is the definitive AI Mode indicator; udm=50 is a fallback
      urlPattern: /\/search\?[^#]*[?&](aioh=1|udm=50)\b/,   // keep in sync with isGoogleAIMode()
      // Google's jsname/class attributes are build-hashed and rotate on
      // every deploy, so we do NOT hardcode them. The finder locates the
      // thread structurally from the rendered turn-heading UI copy.
      finder: findGoogleAIThread,
      selectors: [
        // Legacy AI Overview selectors — deep fallbacks only
        "[data-async-id='air_answers']",
        "[data-attrid='wa:/summary']",
        "div[class*='ai-overview']",
        "#rcnt",
        "#center_col"
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
  let confirmBarEl = null;
  let selectedEl = null;
  let modalContainer = null;
  let progressEl = null;
  let previewMode = "rendered"; // "rendered" or "raw"
  const oRefTitles = new Map();  // url -> descriptive title (Google AI aria-labels)

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

    // Try explicit selectors first
    for (const site of SITE_SELECTORS) {
      if (!site.hostPattern.test(host)) continue;

      // If a urlPattern is specified, also check the full URL
      if (site.urlPattern && !site.urlPattern.test(window.location.href)) continue;

      // Structural finder (site-specific, selector-free) wins if it hits
      if (typeof site.finder === "function") {
        try {
          const found = site.finder();
          if (found && found.offsetHeight > 0 && found.innerText.trim().length > 100) {
            return { el: found, siteName: site.name };
          }
        } catch (e) { /* finder failed, fall through to selectors */ }
      }

      for (const sel of site.selectors) {
        try {
          const el = document.querySelector(sel);
          // Skip zero-height elements (visible in DOM but not rendered content)
          if (el && el.offsetHeight > 0 && el.innerText.trim().length > 100) {
            // Run the scorer to see if this is actually a good pick
            const score = scoreConversationNode(el);
            if (score > 0) {
              return { el, siteName: site.name };
            }
          }
        } catch (e) {
          // Selector might be invalid on this page, skip
        }
      }

      // Selectors all missed — try heuristic for this known site
      const heuristic = findConversationHeuristic();
      if (heuristic) {
        return { el: heuristic, siteName: site.name + " (detected)" };
      }
    }
    return null;
  }

  ///////////////////////////////////////////////////////////////////////////
  // destroyConfirmBar - removes the selection confirmation bar            //
  // ==================                                                    //
  ///////////////////////////////////////////////////////////////////////////

  function destroyConfirmBar() {
    if (confirmBarEl) {
      confirmBarEl.remove();
      confirmBarEl = null;
    }
    if (selectedEl) {
      selectedEl.style.outline = selectedEl.__mdmOrigOutline || "";
      selectedEl.style.backgroundColor = selectedEl.__mdmOrigBg || "";
      selectedEl.style.outlineOffset = "";
      selectedEl.style.transition = "";
      delete selectedEl.__mdmOrigOutline;
      delete selectedEl.__mdmOrigBg;
      selectedEl = null;
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // findBestContainer - walks UP the DOM from a clicked node, scores     //
  //                     each ancestor, returns the best conversation      //
  //                     container candidate                               //
  // ==================                                                    //
  // Scoring favors: text length, number of substantial children with      //
  // repeated structure (conversation turns), scrollability, and depth     //
  // from body (not too shallow, not too deep).                            //
  ///////////////////////////////////////////////////////////////////////////

  function findBestContainer(startEl) {
    let best = startEl;
    let bestScore = scoreConversationNode(startEl);
    let node = startEl.parentElement;
    let climbs = 0;
    const maxClimbs = 15;

    while (node && node !== document.body && node !== document.documentElement && climbs < maxClimbs) {
      const score = scoreConversationNode(node);

      // Take this node if it scores higher, but stop climbing once
      // we hit a node that's clearly "too big" (nearly the whole page)
      const nodeTextLen = node.innerText.trim().length;
      const bodyTextLen = document.body.innerText.trim().length;
      if (nodeTextLen > bodyTextLen * 0.95) break;

      if (score > bestScore) {
        best = node;
        bestScore = score;
      }

      node = node.parentElement;
      climbs++;
    }

    return best;
  }

  ///////////////////////////////////////////////////////////////////////////
  // findGoogleAIThread - locates the Google AI Mode conversation thread  //
  //                      without relying on build-hashed jsname/classes  //
  // ==================                                                    //
  // Primary: [data-xid='aim-mars-turn-root'] per turn → LCA is thread.  //
  // Fallback: every AI turn renders the copy "AI Mode reply for <q>".   //
  // Collect the elements owning that text, take their lowest common      //
  // ancestor, then walk up until the "You said:" prompt copy is inside   //
  // too. Returns the smallest element containing the whole thread.      //
  ///////////////////////////////////////////////////////////////////////////

  function findGoogleAIThread() {
    const REPLY_RX  = /^\s*AI Mode reply for/i;
    const PROMPT_RX = /You said:/i;

    // --- 0. Preferred: semantic per-turn roots (data-xid is product-level
    //        markup, not a build hash). Thread = LCA of all turn roots.
    const aRoots = [...document.querySelectorAll("[data-xid='aim-mars-turn-root']")]
      .filter(el => el.offsetHeight > 0);
    if (aRoots.length === 1) return aRoots[0];
    if (aRoots.length > 1) {
      let oNode = aRoots[0].parentElement;
      while (oNode && oNode !== document.body && !aRoots.every(r => oNode.contains(r))) {
        oNode = oNode.parentElement;
      }
      if (oNode && oNode !== document.body) return oNode;
    }

    // --- Fallback: locate by rendered turn-heading copy --------------------

    // --- 1. Elements whose OWN text starts with the reply copy -----------
    const aTurnEls = [];
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let oNode;
    const aHidden = [];
    while ((oNode = walker.nextNode())) {
      if (!REPLY_RX.test(oNode.nodeValue)) continue;
      const oEl = oNode.parentElement;
      if (!oEl) continue;
      (oEl.offsetHeight > 0 ? aTurnEls : aHidden).push(oEl);
    }
    // Prefer rendered headings; fall back to sr-only copies if that's all
    if (aTurnEls.length === 0) aTurnEls.push(...aHidden);
    if (aTurnEls.length === 0) return null;

    // --- 2. Lowest common ancestor of all turn elements ------------------
    const ancestors = (oEl) => {
      const a = [];
      for (let n = oEl; n; n = n.parentElement) a.push(n);
      return a;
    };
    let aCommon = ancestors(aTurnEls[0]);
    for (let i = 1; i < aTurnEls.length; i++) {
      const oSet = new Set(ancestors(aTurnEls[i]));
      aCommon = aCommon.filter(n => oSet.has(n));
    }
    let oLCA = aCommon[0] || null;
    if (!oLCA) return null;

    // --- 3. Climb until the "You said:" prompt copy is inside as well ----
    //        (single-turn: LCA is the heading itself; multi-turn: LCA may
    //        sit below the first user question)
    let nGuard = 0;
    while (oLCA && oLCA !== document.body && nGuard++ < 12 &&
           !PROMPT_RX.test(oLCA.textContent || "")) {   // textContent: sees sr-only copy
      oLCA = oLCA.parentElement;
    }

    // --- 4. Never return the whole page -----------------------------------
    if (!oLCA || oLCA === document.body || oLCA === document.documentElement) {
      return aCommon[0] || null;
    }
    return oLCA;
  }

  ///////////////////////////////////////////////////////////////////////////
  // findConversationHeuristic - selector-free conversation finder         //
  // ==========================                                            //
  // Scans all elements looking for the one that scores highest as a       //
  // conversation container. Used as fallback when explicit selectors      //
  // miss.                                                                 //
  ///////////////////////////////////////////////////////////////////////////

  function findConversationHeuristic() {
    // Candidates: scrollable containers with substantial text
    const candidates = [];

    // Check all elements with overflow scroll/auto that contain text
    const allEls = document.querySelectorAll("main, article, section, [role='main'], [role='log'], div");
    for (const el of allEls) {
      const textLen = el.innerText.trim().length;
      if (textLen < MIN_CONTENT_LENGTH) continue;

      // Skip tiny elements and our own UI
      if (el.closest("#mdm-banner") || el.closest("#mdm-modal-container")) continue;

      const score = scoreConversationNode(el);
      if (score > 0) {
        candidates.push({ el, score });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by score descending, return the winner
    candidates.sort((a, b) => b.score - a.score);
    return candidates[0].el;
  }

  ///////////////////////////////////////////////////////////////////////////
  // highlightSelected - shows outline on the currently selected element   //
  // ==================                                                    //
  ///////////////////////////////////////////////////////////////////////////

  function highlightSelected(el) {
    // Clear previous
    if (selectedEl && selectedEl !== el) {
      selectedEl.style.outline = selectedEl.__mdmOrigOutline || "";
      selectedEl.style.backgroundColor = selectedEl.__mdmOrigBg || "";
      selectedEl.style.outlineOffset = "";
      delete selectedEl.__mdmOrigOutline;
      delete selectedEl.__mdmOrigBg;
    }

    selectedEl = el;
    selectedEl.__mdmOrigOutline = selectedEl.style.outline;
    selectedEl.__mdmOrigBg = selectedEl.style.backgroundColor;
    selectedEl.style.outline = HIGHLIGHT_BORDER;
    selectedEl.style.backgroundColor = HIGHLIGHT_COLOR;
    selectedEl.style.outlineOffset = "2px";

    // Scroll the element into view so you can see what you picked
    selectedEl.scrollIntoView({ behavior: "smooth", block: "center" });

    // Brief flash to draw the eye — pulse the outline thicker then back
    selectedEl.style.transition = "outline-width 0.15s ease";
    selectedEl.style.outlineWidth = "5px";
    setTimeout(() => {
      if (selectedEl === el) {
        selectedEl.style.outlineWidth = "2px";
      }
    }, 250);
  }

  ///////////////////////////////////////////////////////////////////////////
  // scoreConversationNode - scores an element as conversation container   //
  // ======================                                                //
  // Returns 0 for clearly wrong, higher is better. Factors:               //
  //   - total text length (more is better, up to a point)                 //
  //   - number of substantial child blocks (conversation turns)           //
  //   - structural repetition (siblings with similar tag/class shapes)    //
  //   - is a scrollable container                                         //
  //   - penalize: inputs, textareas, navs, single-child wrappers         //
  ///////////////////////////////////////////////////////////////////////////

  function scoreConversationNode(el) {
    if (!el || el === document.body || el === document.documentElement) return 0;

    const tag = el.tagName.toLowerCase();

    // Instant disqualifiers
    if (["input", "textarea", "button", "nav", "footer", "header", "script", "style", "svg"].includes(tag)) {
      return 0;
    }

    // Disqualify if it's an input area (chat input box)
    if (el.getAttribute("contenteditable") === "true") return 0;
    if (el.getAttribute("role") === "textbox") return 0;

    // Disqualify if it contains a textarea/contenteditable as primary content
    const editables = el.querySelectorAll("textarea, [contenteditable='true'], [role='textbox']");
    const textLen = el.innerText.trim().length;
    if (editables.length > 0 && textLen < 500) return 0;

    let score = 0;

    // Text length scoring (log scale — 10K chars and 100K chars shouldn't be 10x apart)
    if (textLen < MIN_CONTENT_LENGTH) return 0;
    score += Math.min(Math.log10(textLen) * 15, 80);

    // Count substantial child blocks (>50 chars each)
    const children = Array.from(el.children);
    const substantialChildren = children.filter(c => {
      return c.innerText && c.innerText.trim().length > 50;
    });
    const turnCount = substantialChildren.length;

    // Conversation-like: multiple substantial children
    if (turnCount >= 2) score += Math.min(turnCount * 8, 60);
    if (turnCount < 2) score -= 20;

    // Structural repetition bonus — do siblings share similar shapes?
    if (substantialChildren.length >= 3) {
      const shapes = substantialChildren.map(c => c.tagName + "." + (c.className || "").split(" ").sort().join("."));
      const uniqueShapes = new Set(shapes).size;
      const repetitionRatio = 1 - (uniqueShapes / shapes.length);
      score += repetitionRatio * 40; // 1.0 = perfect repetition = +40
    }

    // Scrollable container bonus
    const style = window.getComputedStyle(el);
    const overflowY = style.overflowY;
    if ((overflowY === "auto" || overflowY === "scroll") && el.scrollHeight > el.clientHeight + 50) {
      score += 25;
    }

    // Semantic tag bonus
    if (["main", "article", "section"].includes(tag)) score += 10;
    if (el.getAttribute("role") === "main" || el.getAttribute("role") === "log") score += 10;

    // Penalize if nearly all the text is from a single child (wrapper div)
    if (children.length === 1 && children[0].innerText) {
      const childTextLen = children[0].innerText.trim().length;
      if (childTextLen > textLen * 0.9) score -= 15;
    }

    return Math.max(score, 0);
  }

  ///////////////////////////////////////////////////////////////////////////
  // showConfirmBar - shows the Wider/Narrower/Confirm bar after picking  //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  function showConfirmBar(el) {
    destroyConfirmBar();
    highlightSelected(el);

    const textLen = el.innerText.trim().length;
    const tag = el.tagName.toLowerCase();
    const childCount = el.children.length;
    const score = scoreConversationNode(el);

    confirmBarEl = document.createElement("div");
    confirmBarEl.id = "mdm-confirm-bar";
    confirmBarEl.innerHTML = `
      <style>
        #mdm-confirm-bar {
          position: fixed;
          bottom: 20px;
          left: 50%;
          transform: translateX(-50%);
          background: linear-gradient(135deg, #1a1a2e, #16213e);
          color: #e0e0e0;
          padding: 12px 20px;
          border-radius: 12px;
          z-index: 2147483645;
          font-family: 'DM Sans', -apple-system, sans-serif;
          font-size: 13px;
          box-shadow: 0 12px 40px rgba(0,0,0,0.4), 0 0 0 1px rgba(255,255,255,0.08);
          display: flex;
          align-items: center;
          gap: 10px;
          animation: mdmSlideUp 0.3s ease-out;
          max-width: 90vw;
        }
        @keyframes mdmSlideUp {
          from { opacity: 0; transform: translateX(-50%) translateY(20px); }
          to   { opacity: 1; transform: translateX(-50%) translateY(0); }
        }
        #mdm-confirm-bar .mdm-info {
          color: #888;
          font-family: 'JetBrains Mono', monospace;
          font-size: 11px;
          white-space: nowrap;
        }
        #mdm-confirm-bar .mdm-info strong {
          color: #4ecdc4;
        }
        #mdm-confirm-bar button {
          border: none;
          border-radius: 6px;
          padding: 6px 12px;
          font-size: 12px;
          font-weight: 600;
          cursor: pointer;
          font-family: inherit;
          transition: all 0.15s;
        }
        #mdm-confirm-bar button:hover { transform: translateY(-1px); }
        .mdm-cb-wider  { background: #a78bfa; color: #fff; }
        .mdm-cb-narrower { background: #f59e0b; color: #0a0a14; }
        .mdm-cb-confirm { background: #4ecdc4; color: #0a0a14; }
        .mdm-cb-cancel  { background: rgba(255,255,255,0.08); color: #aaa; }
        .mdm-cb-wider:disabled, .mdm-cb-narrower:disabled {
          opacity: 0.3;
          cursor: not-allowed;
          transform: none !important;
        }
      </style>
      <span>\u{1F4DD}</span>
      <span class="mdm-info">
        <strong>&lt;${tag}&gt;</strong>
        ${textLen.toLocaleString()} chars \u00B7
        ${childCount} children \u00B7
        score ${Math.round(score)}
      </span>
      <button class="mdm-cb-wider" id="mdm-cb-wider">\u2B06 Wider</button>
      <button class="mdm-cb-narrower" id="mdm-cb-narrower">\u2B07 Narrower</button>
      <button class="mdm-cb-confirm" id="mdm-cb-confirm">\u2714 Capture</button>
      <button class="mdm-cb-cancel" id="mdm-cb-cancel">\u2715</button>
    `;
    document.body.appendChild(confirmBarEl);

    // Disable wider if parent is body
    const parent = el.parentElement;
    if (!parent || parent === document.body || parent === document.documentElement) {
      confirmBarEl.querySelector("#mdm-cb-wider").disabled = true;
    }

    // Disable narrower if no substantial children
    const substantialKids = Array.from(el.children).filter(c => c.innerText && c.innerText.trim().length > 50);
    if (substantialKids.length === 0) {
      confirmBarEl.querySelector("#mdm-cb-narrower").disabled = true;
    }

    // Wire buttons
    confirmBarEl.querySelector("#mdm-cb-wider").addEventListener("click", () => {
      const p = el.parentElement;
      if (p && p !== document.body && p !== document.documentElement) {
        showConfirmBar(p);
      }
    });

    confirmBarEl.querySelector("#mdm-cb-narrower").addEventListener("click", () => {
      // Find the child with the most text content
      const kids = Array.from(el.children).filter(c => c.innerText && c.innerText.trim().length > 50);
      if (kids.length > 0) {
        kids.sort((a, b) => b.innerText.trim().length - a.innerText.trim().length);
        showConfirmBar(kids[0]);
      }
    });

    confirmBarEl.querySelector("#mdm-cb-confirm").addEventListener("click", () => {
      const captureTarget = selectedEl;
      destroyConfirmBar();
      captureElement(captureTarget);
    });

    confirmBarEl.querySelector("#mdm-cb-cancel").addEventListener("click", () => {
      destroyConfirmBar();
      shutdown();
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // autoScrollAndCapture - scrolls container, accumulates lazy content    //
  // ====================                                                  //
  ///////////////////////////////////////////////////////////////////////////

  async function autoScrollAndCapture(el) {
    const scroller = findScrollContainer(el);
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
  // cleanGoogleAI - strips Google AI Mode UI chrome from converted md   //
  // =============                                                        //
  // Removes: tab nav, share dialogs, feedback buttons, sidebar history, //
  // input bar, duplicated source card blocks, privacy boilerplate.      //
  // Called only on google.com captures (detected by hostname).          //
  ///////////////////////////////////////////////////////////////////////////

  function cleanGoogleAI(sMd) {
    // ── Pass 1: line-level chrome to drop outright ───────────────────────
    const aDrop = [
      /^\[$/,                                                  // orphan "[" from block anchors
      /^\]\((\/search\?|https?:\/\/(www\.|maps\.|accounts\.|myactivity\.)?google\.com)/, // orphan "](…google…)"
      /^\[\]\(https?:\/\/[^)]*google\.com[^)]*\)$/,            // empty-text links into Google
      /^\[[^\]]*\]\(https?:\/\/(www\.google\.com\/search-personalization|myactivity\.google\.com)[^)]*\)$/,
      /^(All|Videos|Forums|Images|Shopping|Short videos|News|Web|Books|Maps|Pro|More)$/,
      /^AI Mode$/i,
      /^(Good response|Bad response)$/i,
      /^(Copy|Copied|Edit|Ask about|Share|Share public link)$/i,
      /^Copied(Failed to copy)?Copy$/i,
      /^Copied to clipboard/i, /^Failed to copy/i,
      /^A copy of this chat/i, /^Thanks for letting us know$/i,
      /^Google may use account/i, /^For legal issues/i,
      /^AI responses may include mistakes/i,
      /^This public link shares/i, /^You can delete this link/i, /^Can.t copy the link/i,
      /^(Facebook|Gmail|X|Reddit|WhatsApp)$/,
      /^Show (less|all)$/i, /^Shared$/i, /^\d+ files?$/i,
      /^(Open|Close) sidebar$/i, /^New thread$/i, /^See your Search history$/i,
      /^AI Mode history$/i, /^Personalization$/i, /^Settings$/i,
      /^Notebooks?$/i, /^Untitled notebook$/i, /^Recent$/i, /^More options$/i,
      /^Something went wrong\. Your history/i,
      /^(Microphone|Stop|Retry|Send|Transcribing\.*)$/i,
      /^Add files, tools/i, /^My Ad Center$/i,
      /^Use code with caution\.?$/i,
      /^\d{1,2}:\d{2}$/, /^\d+[ms]$/,                          // video duration / age chips
    ];
    const isImg  = (t) => /^!\[/.test(t);
    const domain = (url) => (url.match(/^https?:\/\/([^/?#]+)/) || [,""])[1].replace(/^www\./, "");

    const aIn  = sMd.split("\n");
    const aOut = [];
    let   oSeenCards = new Set();      // per-turn dedupe of source cards
    let   nTitleAt   = -1;             // index of the conversation H1 in aOut
    const lastNonEmpty = () => { for (let j = aOut.length - 1; j >= 0; j--) if (aOut[j].trim()) return j; return -1; };

    for (let i = 0; i < aIn.length; i++) {
      let s = aIn[i];
      let t = s.trim();
      if (aDrop.some(rx => rx.test(t))) continue;
      let m;

      // Conversation title → H1 (remember where, for the pre-title strip)
      if ((m = t.match(/^(#+\s*)?AI Mode Conversation:\s*(.+)$/i))) {
        nTitleAt = aOut.length;
        aOut.push(`# ${m[2].trim()}`, ""); continue;
      }

      // Reply heading → label the preceding prompt "## You", emit "## AI Mode"
      if (/^(#+\s*)?AI Mode reply for\b/i.test(t)) {
        const j = lastNonEmpty();
        if (j >= 0 && !/^#/.test(aOut[j].trim())) aOut.splice(j, 0, "", "## You", "");
        aOut.push("", "## AI Mode", "");
        oSeenCards = new Set();          // new turn → new card set
        continue;
      }

      // "You said: q" → q
      s = s.replace(/^\s*You said:\s*/i, ""); t = s.trim();

      // Source card: "- [](url)" then name / title / snippet on following lines
      if ((m = t.match(/^([-*]\s+)\[\]\((https?:[^)\s]+)\)$/))) {
        const url = m[2];
        const aMeta = [];
        let k = i + 1;
        while (k < aIn.length && aMeta.length < 3 && k - i < 10) {
          const u = aIn[k].trim();
          if (u && !isImg(u) && !aDrop.some(rx => rx.test(u))) aMeta.push(u);
          k++;
        }
        i = k - 1;                                          // consume card lines
        if (oSeenCards.has(url)) continue;                  // show-all/show-less dupe
        oSeenCards.add(url);
        const [sSite = domain(url), sTitle = domain(url), sSnip = ""] = aMeta;
        const jp = lastNonEmpty();
        if (jp >= 0 && !/^[-*]\s+\[/.test(aOut[jp].trim())) aOut.push("");   // blank before list
        aOut.push(`- [${sTitle}](${url})` + (sSnip ? ` — ${sSnip}` : "") + (sSite && sSite !== sTitle ? ` *(${sSite})*` : ""));
        continue;
      }

      // Inline empty-text citations → domain label so annotateRefs numbers them
      s = s.replace(/\[\]\((https?:\/\/[^)\s]+)\)/g, (mm, url) => `[${domain(url)}](${url})`);
      t = s.trim();

      // Consecutive duplicate paragraph (sr-only prompt + visible prompt)
      const j = lastNonEmpty();
      if (t && j >= 0 && aOut[j].trim() === t) continue;

      aOut.push(s);
    }

    // Anything above the conversation title is sidebar/nav that slipped through
    // (only when we actually saw the title — never match '# ' inside code)
    if (nTitleAt > 0) aOut.splice(0, nTitleAt);

    return aOut.join("\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  ///////////////////////////////////////////////////////////////////////////
  // annotateRefs - injects ^(N) superscript marks into converted markdown //
  //               and builds a matching numbered References appendix      //
  // ===============                                                       //
  // Collects <a href> in DOM order, dedupes by URL, keeps only HTTP(S).  //
  // Returns "" when no qualifying links found (no section appended).      //
  ///////////////////////////////////////////////////////////////////////////

  function annotateRefs(sMd) {
    const oUrlToIdx = new Map();
    const aRefs     = [];
    let   nNext     = 1;

    // Match [text](url) — skip image links (preceded by !)
    const sAnnotated = sMd.replace(
      /(?<!!)(\[([^\]]+)\])\((https?:[^)]+)\)/g,
      (sMatch, sBracketText, sText, sUrl) => {
        let nIdx;
        if (oUrlToIdx.has(sUrl)) {
          nIdx = oUrlToIdx.get(sUrl);
          // Upgrade the appendix label if a more descriptive one shows up
          // later (e.g. Google source-card title after a domain-only inline)
          const oRef = aRefs[nIdx - 1];
          if (sText.length > oRef.sLabel.length) oRef.sLabel = sText;
        } else {
          nIdx = nNext++;
          oUrlToIdx.set(sUrl, nIdx);
          aRefs.push({ nIdx, sUrl, sLabel: oRefTitles.get(sUrl) || sText });
        }
        return `[${sText}](${sUrl})^(${nIdx})`;
      }
    );

    if (aRefs.length === 0) return { sMd, sBlock: "" };

    let sBlock = "\n\n---\n\n## References\n\n";
    aRefs.forEach(oRef => {
      sBlock += `${oRef.nIdx}. [${oRef.sLabel}](${oRef.sUrl})\n`;
    });
    return { sMd: sAnnotated, sBlock };
  }

  ///////////////////////////////////////////////////////////////////////////
  // captureElement - grabs content (with auto-scroll), converts, shows    //
  // ==============                                                        //
  ///////////////////////////////////////////////////////////////////////////

  async function captureElement(el) {
    const html = await autoScrollAndCapture(el);
    let md = convertToMarkdown(html);

    // Google AI Mode: strip UI chrome before annotating refs
    if (isGoogleAIMode()) {
      md = cleanGoogleAI(md);
    }

    const { sMd: sMdAnnotated, sBlock: sRefsBlock } = annotateRefs(md);
    md = sRefsBlock ? (sMdAnnotated + sRefsBlock) : md;
    buildModal(md);
  }

  ///////////////////////////////////////////////////////////////////////////
  // flattenShadowRoots - recursively extracts shadow DOM content          //
  // ===================                                                   //
  // Walks a cloned tree and replaces elements that had shadow roots with  //
  // their shadow content inlined. Call on a clone, not the live DOM.      //
  ///////////////////////////////////////////////////////////////////////////

  function flattenShadowRoots(el) {
    // Walk the LIVE element tree to find shadow roots, then inject
    // their content into the corresponding cloned nodes.
    // Since cloneNode doesn't copy shadow DOMs, we do it manually.
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_ELEMENT);
    const shadowHosts = [];

    let node = walker.nextNode();
    while (node) {
      if (node.shadowRoot) {
        shadowHosts.push(node);
      }
      node = walker.nextNode();
    }

    // For each shadow host, grab the shadow innerHTML
    for (const host of shadowHosts) {
      const shadowHTML = host.shadowRoot.innerHTML;
      // Inject shadow content as regular children
      const wrapper = document.createElement("div");
      wrapper.setAttribute("data-mdm-shadow", "true");
      wrapper.innerHTML = shadowHTML;
      host.appendChild(wrapper);
    }
  }

  ///////////////////////////////////////////////////////////////////////////
  // captureImagesAsDataURI - converts all img in element to dataURIs      //
  // ======================                                                //
  ///////////////////////////////////////////////////////////////////////////

  async function captureImagesAsDataURI(el) {
    // Flatten any shadow DOM content into the live element BEFORE cloning
    flattenShadowRoots(el);

    const clone = el.cloneNode(true);
    // Order matters: prepGoogleAIClone's hidden-node prune walks live and
    // clone index-parallel, so it must see an UNMODIFIED clone. Ad prune after.
    if (isGoogleAIMode()) prepGoogleAIClone(el, clone);   // Google AI Mode only
    pruneAdMarkup(clone);                                  // all providers
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

      // Skip decorative chrome: logos, nav icons, favicons, etc.
      if (isDecorativeImage(img)) {
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
          // Preserve fence info string from class="language-x" / lang-x
          // (on <code> or <pre>) or data-language= — all providers
          const sCls = ((code && code.className) || "") + " " + (node.className || "");
          const m    = sCls.match(/(?:^|\s)(?:language|lang)-([A-Za-z0-9+#.-]+)/);
          const sLang = (m && m[1]) || node.getAttribute("data-language") ||
                        (code && code.getAttribute("data-language")) || "";
          return "\n\n```" + sLang.toLowerCase() + "\n" + text.trim() + "\n```\n\n";
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

    // Preserve <cite> content — strip the wrapper, keep the text
    const bGoogleAI = isGoogleAIMode();   // scopes Google-only Turndown rules

    td.addRule("citations", {
      filter: "cite",
      replacement: (content) => content
    });

    td.addRule("stripNoise", {
      filter: (node) => {
        const tag = node.nodeName.toLowerCase();
        // Also strip Google AI Mode chrome elements by aria-label / data attrs
      if (bGoogleAI) {
        const sLabel = (node.getAttribute && node.getAttribute("aria-label") || "").toLowerCase();
        if (/share|feedback|good response|bad response|copy link|sidebar|history/i.test(sLabel)) return true;
        if (node.getAttribute && node.getAttribute("data-async-id") === "ftr") return true;  // Google footer
      }
      return ["button", "nav", "header", "aside", "footer", "svg", "iframe", "script", "style", "noscript"].includes(tag);
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
  // findScrollContainer - finds the scrollable container for an element    //
  // ====================                                                  //
  // Looks UP (ancestors) first, then DOWN (descendants) if nothing found. //
  // This handles the case where the user went "wider" past the actual     //
  // scroll container — the scroller is now a child, not a parent.         //
  ///////////////////////////////////////////////////////////////////////////

  function findScrollContainer(el) {
    // Check if the element itself scrolls
    if (el.scrollHeight > el.clientHeight + 50) return el;

    // Walk UP — classic ancestor search
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

    // Walk DOWN — find scrollable descendants (user went "wider")
    const scrollableChild = findScrollableDescendant(el);
    if (scrollableChild) return scrollableChild;

    // Last resort: documentElement
    const docEl = document.documentElement;
    if (docEl.scrollHeight > docEl.clientHeight + 50) return docEl;

    return null;
  }

  ///////////////////////////////////////////////////////////////////////////
  // findScrollableDescendant - searches children for a scroll container   //
  // ========================                                              //
  // BFS through descendants looking for the largest scrollable element.   //
  ///////////////////////////////////////////////////////////////////////////

  function findScrollableDescendant(el) {
    let best = null;
    let bestArea = 0;

    // BFS with depth limit to avoid scanning thousands of nodes
    const queue = [{ node: el, depth: 0 }];
    const maxDepth = 6;

    while (queue.length > 0) {
      const { node, depth } = queue.shift();
      if (depth > maxDepth) continue;

      for (const child of node.children) {
        // Skip our own injected UI
        if (child.id && child.id.startsWith("mdm-")) continue;

        const style = window.getComputedStyle(child);
        const overflowY = style.overflowY;

        if (
          (overflowY === "auto" || overflowY === "scroll") &&
          child.scrollHeight > child.clientHeight + 50
        ) {
          const area = child.scrollHeight * child.clientWidth;
          if (area > bestArea) {
            best = child;
            bestArea = area;
          }
        }

        queue.push({ node: child, depth: depth + 1 });
      }
    }

    return best;
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

        sup.mdm-ref {
          font-size: 0.72em;
          font-weight: 700;
          letter-spacing: -0.02em;
          vertical-align: super;
          line-height: 0;
        }
        sup.mdm-ref a.mdm-cite {
          color: #f59e0b;
          text-decoration: none;
          transition: color 0.15s;
        }
        sup.mdm-ref a.mdm-cite:hover { color: #fbbf24; text-decoration: underline; }
        /* References section target highlight */
        li[id^="mdm-ref-"]:target {
          background: rgba(245,158,11,0.12);
          border-radius: 4px;
          outline: 1px solid rgba(245,158,11,0.3);
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

        /* ---- PRINT — preserve dark theme when Ctrl+P from claude.ai ---- */
        @media print {
          #mdm-backdrop { display: none !important; }
          #mdm-modal {
            position: static !important;
            width: 100% !important;
            height: auto !important;
            transform: none !important;
            overflow: visible !important;
            border-radius: 0 !important;
            box-shadow: none !important;
            background: #1a1a2e !important;
            print-color-adjust: exact;
            -webkit-print-color-adjust: exact;
          }
          #mdm-topbar  { display: none !important; }
          #mdm-footer  { display: none !important; }
          #mdm-toast   { display: none !important; }
          #mdm-preview-wrap {
            overflow: visible !important;
            max-height: none !important;
            height: auto !important;
            padding: 24px 32px !important;
          }
          #mdm-preview-rendered { display: block !important; }
          #mdm-preview-raw      { display: none  !important; }
          /* no horizontal overflow → no shrink-to-fit */
          #mdm-preview-rendered pre { white-space: pre-wrap !important; word-break: break-all !important; overflow: visible !important; }
          #mdm-preview-rendered p, #mdm-preview-rendered li, #mdm-preview-rendered td { overflow-wrap: anywhere; }
          #mdm-preview-rendered table { table-layout: fixed; max-width: 100%; }
          #mdm-preview-rendered h1 { color: #ff6b95 !important; }
          #mdm-preview-rendered h2 { color: #4ecdc4 !important; }
          #mdm-preview-rendered h3 { color: #a78bfa !important; }
          #mdm-preview-rendered pre { background: rgba(0,0,0,0.4) !important; }
          #mdm-preview-rendered code { background: rgba(255,255,255,0.08) !important; }
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

  function getRenderedPageHTML(md, title, bForPDF) {
    const rendered = renderMarkdown(md);
    return `<!DOCTYPE html>
<html class="${bForPDF ? 'mdm-pdf' : ''}"><head>
  <meta charset="utf-8">
  <title>${escapeHTML(title)}</title>
  <style>
    @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400&family=DM+Sans:ital,wght@0,400;0,500;0,700;1,400&display=swap');
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'DM Sans', -apple-system, BlinkMacSystemFont, sans-serif;
      max-width: 820px;
      margin: 40px auto;
      padding: 0 32px 60px;
      line-height: 1.8;
      color: #d4d4d8;
      background: #1a1a2e;
      font-size: 15px;
      /* Force background colour through print-to-PDF */
      print-color-adjust: exact;
      -webkit-print-color-adjust: exact;
    }
    h1 { font-size: 26px; font-weight: 700; color: #ff6b95; margin: 36px 0 12px;
         border-bottom: 1px solid rgba(255,107,149,0.2); padding-bottom: 8px; }
    h2 { font-size: 21px; font-weight: 700; color: #4ecdc4; margin: 28px 0 10px; }
    h3 { font-size: 17px; font-weight: 700; color: #a78bfa; margin: 22px 0 8px; }
    h4, h5, h6 { font-size: 15px; font-weight: 700; color: #e0e0e0; margin: 18px 0 6px; }
    p { margin: 0 0 14px; }
    strong { color: #f0f0f0; }
    em { color: #c4b5fd; }
    a { color: #4ecdc4; text-underline-offset: 3px; }
    sup.mdm-ref { font-size: 0.72em; color: #f59e0b; font-weight: 700; vertical-align: super; line-height: 0; }
    code {
      font-family: 'JetBrains Mono', monospace;
      font-size: 0.88em;
      background: rgba(255,255,255,0.08);
      padding: 2px 6px;
      border-radius: 4px;
      color: #e0c3fc;
    }
    pre {
      background: rgba(0,0,0,0.4);
      border: 1px solid rgba(255,255,255,0.08);
      border-radius: 8px;
      padding: 16px 20px;
      overflow-x: auto;
      margin: 16px 0;
    }
    pre code { background: none; padding: 0; font-size: 13px; line-height: 1.6; color: #d4d4d8; }
    blockquote {
      border-left: 3px solid #ff6b95;
      margin: 14px 0;
      padding: 8px 16px;
      background: rgba(255,107,149,0.06);
      color: #bbb;
    }
    ul, ol { padding-left: 24px; margin: 8px 0 14px; }
    li { margin-bottom: 6px; }
    hr { border: none; border-top: 1px solid rgba(255,255,255,0.1); margin: 28px 0; }
    img { max-width: 100%; border-radius: 6px; margin: 12px 0; }
    table { border-collapse: collapse; width: 100%; margin: 14px 0; }
    th, td { border: 1px solid rgba(255,255,255,0.1); padding: 8px 12px; text-align: left; }
    th { background: rgba(255,255,255,0.06); font-weight: 600; color: #e0e0e0; }
    /* Long unbreakable content (pasted logs, wide tables, URLs) must wrap.
       Any element wider than the page makes Chrome shrink-to-fit the WHOLE
       document, so text goes tiny and sits in the left third of each page. */
    p, li, td, th, h1, h2, h3, h4, code, a { overflow-wrap: anywhere; word-break: break-word; }
    pre { white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; overflow: visible; max-width: 100%; }
    table { table-layout: fixed; max-width: 100%; }
    img, svg, video, canvas { max-width: 100%; height: auto; }
    @page { size: auto; margin: 0.5in; }
    @media print {
      html, body { width: auto !important; max-width: none !important; margin: 0 !important; overflow-x: hidden !important; }
      body { padding: 0 !important; font-size: 12px; }
      pre  { font-size: 10px; }
      h1   { font-size: 20px; }
      h2   { font-size: 16px; }
      h1, h2, h3, h4 { break-after: avoid; }
      pre, blockquote, table, li { break-inside: avoid; }
    }
    /* Print-to-paper: strip dark background so ink isn't wasted.       */
    /* PDF path skips this block via a JS-injected class on <html>.     */
    html:not(.mdm-pdf) body,
    html:not(.mdm-pdf) pre,
    html:not(.mdm-pdf) pre code,
    html:not(.mdm-pdf) blockquote,
    html:not(.mdm-pdf) th,
    html:not(.mdm-pdf) td {
      background: initial !important;
      background-color: initial !important;
    }
    html:not(.mdm-pdf) body  { color: #1a1a1a !important; }
    html:not(.mdm-pdf) h1    { color: #d63060 !important; border-color: #d63060 !important; }
    html:not(.mdm-pdf) h2    { color: #1a8a7a !important; }
    html:not(.mdm-pdf) h3    { color: #5b3ea8 !important; }
    html:not(.mdm-pdf) a     { color: #1a5f7a !important; }
    html:not(.mdm-pdf) code  { background: #f4f4f5 !important; color: #333 !important; }
    html:not(.mdm-pdf) pre   { border: 1px solid #ddd !important; }
    html:not(.mdm-pdf) sup.mdm-ref a { color: #b45309 !important; }
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
    pdfWin.document.write(getRenderedPageHTML(md, filename, true));
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
  // isDecorativeImage - returns true if an img is UI chrome and should   //
  //                     be excluded from the captured markdown output     //
  // =================                                                     //
  // Guards (evaluated on the clone — attributes/tree are preserved):     //
  //   ancestor tag is header|footer|nav|aside                            //
  //   self or ancestor has aria-hidden=true                              //
  //   role=presentation or role=none                                     //
  //   no alt text AND intrinsic/attribute size < 64 px                  //
  //   src path matches logo|icon|avatar|badge|favicon|sprite|pixel       //
  ///////////////////////////////////////////////////////////////////////////

  function isDecorativeImage(oImg) {
    // --- Ancestor semantic tag check (works in detached clone) -----------
    const oSkip = { header: 1, footer: 1, nav: 1, aside: 1 };
    let oAnc = oImg.parentElement;
    while (oAnc) {
      const sTag = oAnc.tagName ? oAnc.tagName.toLowerCase() : "";
      if (oSkip[sTag]) return true;
      if (oAnc.getAttribute && oAnc.getAttribute("aria-hidden") === "true") return true;
      oAnc = oAnc.parentElement;
    }

    // --- Self attribute checks -------------------------------------------
    if (oImg.getAttribute("aria-hidden") === "true") return true;
    const sRole = oImg.getAttribute("role") || "";
    if (sRole === "presentation" || sRole === "none") return true;

    // --- Alt text + size check ------------------------------------------
    const sAlt = (oImg.getAttribute("alt") || "").trim();
    const nW   = oImg.naturalWidth  || parseInt(oImg.getAttribute("width")  || "0", 10);
    const nH   = oImg.naturalHeight || parseInt(oImg.getAttribute("height") || "0", 10);
    if (!sAlt && nW > 0 && nW < 64 && nH > 0 && nH < 64) return true;

    // --- src path pattern check -----------------------------------------
    const sSrc = (oImg.getAttribute("src") || "").toLowerCase();
    if (/\/(logo|icon|avatar|badge|favicon|sprite|placeholder|pixel|spacer|close)/.test(sSrc)) return true;
    if (/\.ico(\?|#|$)/.test(sSrc)) return true;

    return false;
  }

  ///////////////////////////////////////////////////////////////////////////
  // isGoogleAIMode - true only on Google Search "AI Mode" result pages   //
  // ==============                                                       //
  // Requires /search path + aioh=1|udm=50. Excludes gemini.google.com    //
  // (path /app) so Gemini captures never run the Google-specific cleanup //
  ///////////////////////////////////////////////////////////////////////////

  function isGoogleAIMode() {
    const h = window.location.hostname;
    return /(^|\.)google\.[a-z.]+$/i.test(h) &&
           !/^gemini\./i.test(h) &&
           /^\/search/.test(window.location.pathname) &&
           /[?&](aioh=1|udm=50)\b/.test(window.location.href);
  }

  ///////////////////////////////////////////////////////////////////////////
  // prepGoogleAIClone - DOM-level cleanup of a Google AI Mode capture     //
  // =================                                                     //
  // Runs on the CLONE, using the LIVE element for computed visibility.   //
  // Evidence-based (full page dump, Sep 2026):                            //
  //   1. drop nodes that are display:none / visibility:hidden / aria-    //
  //      hidden — Turndown can't see CSS, so hidden DOM otherwise leaks  //
  //   2. drop semantic chrome by ARIA role: dialog (share/about), status //
  //      + alert (copy toasts), progressbar, textbox (input plate),      //
  //      tooltip, menu, non-anchor buttons (Show all / More / feedback)  //
  //   3. citations are <a> with EMPTY text and a descriptive aria-label; //
  //      set visible text to the host and harvest the title for the     //
  //      References appendix via oRefTitles                             //
  //   4. role=heading divs → real <hN>; aria-level 2 is the user prompt  //
  //      → <p>; first turn's <h2>You said:…</h2> → <p>                   //
  //   5. code blocks carry a sibling language chip ("bash") → fold it   //
  //      into <code class="language-x"> so Turndown emits ```bash        //
  ///////////////////////////////////////////////////////////////////////////

  function prepGoogleAIClone(oLive, oClone) {
    oRefTitles.clear();

    // --- 1. Hidden-node prune — MUST run first: index-parallel walk needs
    //        the clone untouched so it mirrors the live tree exactly
    const aL = oLive.querySelectorAll("*");
    const aC = oClone.querySelectorAll("*");
    if (aL.length !== aC.length) {
      console.warn(`[MDM] hidden-node prune skipped: live ${aL.length} vs clone ${aC.length} nodes (clone mutated before prune?)`);
    } else {
      for (let i = 0; i < aL.length; i++) {
        const l = aL[i];
        if (l.getAttribute("aria-hidden") === "true") { aC[i].remove(); continue; }
        const cs = window.getComputedStyle(l);
        if (cs.display === "none" || cs.visibility === "hidden") aC[i].remove();
      }
    }

    // --- 1b. Turn allowlist: a direct child of the thread root is kept only
    //        if it looks like a turn (user prompt or AI reply). Anything
    //        else sitting between turns — ad unit, promo card, upsell — is
    //        dropped without needing to know what it is. Inverted rule:
    //        denylists grow forever; the turn signature does not.
    //        Only applied when the root IS the thread (data-xid marker) so a
    //        manual picker selection of some inner element is left alone.
    if (oClone.getAttribute("data-xid") === "aim-mars-turn-root") {
      const isTurn = (n) =>
        n.querySelector("[role='heading'][aria-level='2'], h2, h3") !== null ||
        /You said:|AI Mode reply for/i.test(n.textContent);
      let nDropped = 0;
      [...oClone.children].forEach(n => {
        if (n.tagName === "SCRIPT" || n.tagName === "STYLE") { n.remove(); return; }
        if (!n.textContent.trim()) return;          // empty shells are harmless
        if (!isTurn(n)) { n.remove(); nDropped++; }
      });
      if (nDropped) console.log(`[MDM] Google AI turn allowlist: dropped ${nDropped} non-turn block(s)`);
    }

    // --- 2. Semantic chrome ---------------------------------------------
    oClone.querySelectorAll(
      "[role='dialog'],[role='status'],[role='alert'],[role='progressbar']," +
      "[role='textbox'],[role='tooltip'],[role='menu'],[role='button']"
    ).forEach(n => { if (n.tagName !== "A") n.remove(); });

    // --- 3. Citation anchors: label + harvest titles ---------------------
    oClone.querySelectorAll("a[href^='http']").forEach(a => {
      const sHref = a.getAttribute("href");
      const sAria = (a.getAttribute("aria-label") || "").trim();
      if (a.textContent.trim() || !sAria) return;
      let s = sAria
        .replace(/\.?\s*(Related results|Opens in new tab\.?)\s*$/i, "")
        .replace(/,\s*Video,\s*watch on YouTube\s*$/i, "")
        .trim();
      // "Site (+N) - Title" form: keep the title half
      const m = s.match(/^(.{1,40}?)(?:\s*\(\+\d+\))?\s+-\s+(.+)$/);
      if (m && /Related results/i.test(sAria)) s = m[2].trim();
      const sTitle = s.replace(/\.$/, "");
      oRefTitles.set(sHref, sTitle);
      const sHost = (sHref.match(/^https?:\/\/([^/?#]+)/) || [, "link"])[1].replace(/^www\./, "");
      const oCard = a.closest("[data-xid='aim-aside-initial-corroboration-container'] li, [data-xid='aim-aside-initial-corroboration-container'] [role='listitem']");
      if (oCard) {
        // Source card: collapse the whole card to "Title (host)" link
        a.textContent = `${sTitle} (${sHost})`;
        oCard.textContent = "";
        oCard.appendChild(a);
      } else {
        a.textContent = sHost;             // inline citation: keep it short
      }
    });

    // --- 2b. Response action bar (copy / share / thumbs / more). Container
    //         is hash-classed; the buttons carry stable aria-labels. Remove
    //         the smallest ancestor that holds the thumbs pair and no content.
    //         Reply bodies always carry strong/code/lists/headings; the bar
    //         and its footer (disclaimer, feedback form) carry none, so
    //         "content-free" is the stop condition. Text-length cap as belt.
    const sContent = "p,pre,code,strong,em,ul,ol,table,img,blockquote,h1,h2,h3,h4,h5,h6,[role='heading']";
    oClone.querySelectorAll("[aria-label='Good response']").forEach(oUp => {
      let oBest = null, n = oUp.parentElement;
      for (let k = 0; n && n !== oClone && k < 10; k++, n = n.parentElement) {
        if (n.querySelector(sContent) || n.textContent.length > 2000) break;
        if (n.querySelector("[aria-label='Bad response']")) oBest = n;
      }
      if (oBest) oBest.remove();
    });

    // --- 3b. Corroboration side panel: titles are harvested above; the
    //         panel itself duplicates the inline citations and renders as a
    //         floating column (wide whitespace in export). Delete it.
    oClone.querySelectorAll("[data-xid='aim-aside-initial-corroboration-container']")
      .forEach(n => n.remove());

    // --- 4. Headings --------------------------------------------------
    oClone.querySelectorAll("[role='heading']").forEach(h => {
      const n = parseInt(h.getAttribute("aria-level") || "3", 10);
      const r = document.createElement(n <= 2 ? "p" : "h" + Math.min(n, 6));
      r.innerHTML = h.innerHTML;
      h.replaceWith(r);
    });
    oClone.querySelectorAll("h2").forEach(h => {
      if (!/^\s*You said:/i.test(h.textContent)) return;
      const p = document.createElement("p");
      p.textContent = h.textContent.replace(/^\s*You said:\s*/i, "");
      h.replaceWith(p);
    });

    // --- 5. Code fence language chips ----------------------------------
    oClone.querySelectorAll("pre").forEach(pre => {
      let oWrap = pre.parentElement, sLang = null, oChip = null;
      for (let k = 0; k < 3 && oWrap && !sLang; k++, oWrap = oWrap.parentElement) {
        for (const c of oWrap.querySelectorAll("*")) {
          if (c === pre || pre.contains(c) || c.contains(pre) || c.children.length) continue;
          const t = c.textContent.trim();
          if (/^[a-z0-9+#.-]{1,15}$/i.test(t)) { sLang = t.toLowerCase(); oChip = c; break; }
        }
      }
      if (oChip) oChip.remove();
      let code = pre.querySelector("code");
      if (!code) { code = document.createElement("code"); code.textContent = pre.textContent; pre.textContent = ""; pre.appendChild(code); }
      if (sLang) code.className = "language-" + sLang;
    });
  }

  ///////////////////////////////////////////////////////////////////////////
  // pruneAdMarkup - removes advertising units by the markers ads carry   //
  // =============                                                         //
  // Cross-provider, marker-based, deliberately small. Ads must be        //
  // labelled for regulatory reasons, so the labels are stable even when  //
  // the surrounding class names are not. Runs on the clone.              //
  ///////////////////////////////////////////////////////////////////////////

  function pruneAdMarkup(oClone) {
    const sSel = [
      "iframe", "ins.adsbygoogle", "amp-ad",
      "[data-text-ad]", "[data-ad-slot]", "[data-ad-client]", "[data-ad]",
      "[data-google-query-id]", "[id^='google_ads_']", "[id^='div-gpt-ad']",
      "#tads", "#tadsb", "#bottomads", ".ads-ad",
      "[aria-label='Ad']", "[aria-label='Ads']", "[aria-label='Sponsored']",
      "[aria-label^='Ad ']", "[aria-label^='Sponsored ']",
      "[data-sponsored]", "[data-promo]"
    ].join(",");
    let nRemoved = 0;
    oClone.querySelectorAll(sSel).forEach(n => { n.remove(); nRemoved++; });
    if (nRemoved) console.log(`[MDM] pruneAdMarkup: removed ${nRemoved} ad node(s)`);
  }

  ///////////////////////////////////////////////////////////////////////////
  // renderMarkdown - converts markdown string to styled HTML              //
  // ==============                                                        //
  // Lightweight renderer covering: headings, bold, italic, inline code,   //
  // code blocks, links, images, lists (ul/ol), blockquotes, hr, tables,   //
  // and paragraphs. No external dependency needed.                        //
  ///////////////////////////////////////////////////////////////////////////

  function renderMarkdown(md) {
    // Post-process: if a ## References section exists, inject id attrs
    // into its <li> items so superscript anchors can jump to them.
    // We do this AFTER the full render via a tiny DOM walk on the result.
    function injectRefIds(sHtml) {
      // Find the References <ol> or <li> block after the last <h2>References
      let nRefH = sHtml.lastIndexOf('<h2>References</h2>');
      if (nRefH === -1) return sHtml;
      let nIdx = 1;
      return sHtml.slice(0, nRefH) +
        sHtml.slice(nRefH).replace(/<li>/g, () => `<li id="mdm-ref-${nIdx++}">`);
    }
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

    return injectRefIds(html);
  }

  ///////////////////////////////////////////////////////////////////////////
  // renderInline - converts inline markdown (bold, italic, code, links)   //
  // ============                                                          //
  ///////////////////////////////////////////////////////////////////////////

  function renderInline(text) {
    let out = escapeHTML(text);

    // Images: ![alt](src)
    out = out.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">');

    // Superscript ref marks: ^(1), ^(2a) etc — before link replacement
    out = out.replace(/\^\((\d+[a-z]?)\)/g,
      (m, n) => `<sup class="mdm-ref"><a href="#mdm-ref-${n}" class="mdm-cite">(${n})</a></sup>`);

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
      showConfirmBar(el);
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

    // Smart climb: find the best conversation container
    const best = findBestContainer(target);

    // Show confirmation bar so user can navigate wider/narrower
    showConfirmBar(best);
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
    destroyConfirmBar();
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

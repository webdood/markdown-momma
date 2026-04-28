///////////////////////////////////////////////////////////////////////////////
// background.js - MarkDown Momma service worker                            //
// =============                                                            //
// Handles toolbar icon click → injects picker + modal into active tab      //
///////////////////////////////////////////////////////////////////////////////

chrome.action.onClicked.addListener(async (tab) => {
  try {
    // Inject Turndown library first
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["lib/turndown.js"]
    });

    // Inject the content script
    await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      files: ["content.js"]
    });
  } catch (err) {
    console.error("MarkDown Momma injection failed:", err);
  }
});

///////////////////////////////////////////////////////////////////////////////
// build.js - MarkDown Momma manifest assembler & build script              //
// ========                                                                 //
// Assembles a ready-to-load Chrome extension in dist/                      //
// Run: node build.js                                                       //
///////////////////////////////////////////////////////////////////////////////

const fs = require("fs");
const path = require("path");
const https = require("https");

const ROOT = __dirname;
const DIST = path.join(ROOT, "dist");
const TURNDOWN_CDN = "https://cdn.jsdelivr.net/npm/turndown@7.2.0/dist/turndown.js";

// =========================================================================
// METHODS (alphabetical)
// =========================================================================

///////////////////////////////////////////////////////////////////////////
// assembleManifest - reads manifest.json, validates required fields      //
// ================                                                      //
///////////////////////////////////////////////////////////////////////////

function assembleManifest() {
  const manifestPath = path.join(ROOT, "manifest.json");

  if (!fs.existsSync(manifestPath)) {
    die("manifest.json not found in project root");
  }

  const raw = fs.readFileSync(manifestPath, "utf-8");
  let manifest;

  try {
    manifest = JSON.parse(raw);
  } catch (e) {
    die(`manifest.json parse error: ${e.message}`);
  }

  // Validate required Manifest V3 fields
  const required = ["manifest_version", "name", "version"];
  for (const field of required) {
    if (!manifest[field]) {
      die(`manifest.json missing required field: "${field}"`);
    }
  }

  if (manifest.manifest_version !== 3) {
    warn(`manifest_version is ${manifest.manifest_version}, expected 3`);
  }

  // Validate referenced files exist
  validateManifestRefs(manifest);

  log(`Manifest OK: ${manifest.name} v${manifest.version} (MV${manifest.manifest_version})`);
  return manifest;
}

///////////////////////////////////////////////////////////////////////////
// copyDir - recursively copies a directory                              //
// =======                                                               //
///////////////////////////////////////////////////////////////////////////

function copyDir(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const entries = fs.readdirSync(src, { withFileTypes: true });

  for (const entry of entries) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);

    if (entry.name === "dist" || entry.name === "node_modules" || entry.name === ".git") {
      continue;
    }

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

///////////////////////////////////////////////////////////////////////////
// die - logs error and exits                                            //
// ===                                                                   //
///////////////////////////////////////////////////////////////////////////

function die(msg) {
  console.error(`\n  ERROR: ${msg}\n`);
  process.exit(1);
}

///////////////////////////////////////////////////////////////////////////
// downloadFile - fetches a URL to a local path via https                 //
// ============                                                          //
///////////////////////////////////////////////////////////////////////////

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    log(`Downloading ${url}...`);
    const file = fs.createWriteStream(destPath);
    https.get(url, (res) => {
      // Handle redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }

      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode} fetching ${url}`));
      }

      res.pipe(file);
      file.on("finish", () => {
        file.close();
        const size = fs.statSync(destPath).size;
        log(`Downloaded ${path.basename(destPath)} (${(size / 1024).toFixed(1)}KB)`);
        resolve();
      });
    }).on("error", (err) => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}

///////////////////////////////////////////////////////////////////////////
// generatePlaceholderIcon - creates a simple PNG icon if none exists     //
// ========================                                               //
// Generates a minimal 1-color PNG (no external deps). Only used as a    //
// fallback — real icons should be in icons/                              //
///////////////////////////////////////////////////////////////////////////

function generatePlaceholderIcon(size, destPath) {
  // Minimal valid PNG: 1x1 magenta pixel, scaled conceptually
  // For a real build, replace with actual designed icons
  warn(`Generating placeholder ${size}x${size} icon at ${path.basename(destPath)}`);

  // Create a minimal PNG manually (uncompressed, valid)
  const png = createMinimalPNG(size);
  fs.writeFileSync(destPath, png);
}

///////////////////////////////////////////////////////////////////////////
// createMinimalPNG - generates a tiny valid PNG buffer                   //
// ================                                                      //
///////////////////////////////////////////////////////////////////////////

function createMinimalPNG(size) {
  // For placeholder purposes, write a 1x1 pink PNG
  // Real icons are already in icons/ — this is just the safety net
  const { createCanvas } = (() => {
    try { return require("canvas"); } catch (e) { return {}; }
  })();

  if (createCanvas) {
    const canvas = createCanvas(size, size);
    const ctx = canvas.getContext("2d");
    // Dark circle with "MD" text
    ctx.fillStyle = "#1a1a2e";
    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 1, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = "#4ecdc4";
    ctx.font = `bold ${Math.floor(size * 0.4)}px sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText("MD", size / 2, size / 2);
    return canvas.toBuffer("image/png");
  }

  // Absolute minimal fallback: 1x1 transparent PNG
  // (Chrome will show a blank icon but won't error)
  return Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVQI12NgAAIABQAB" +
    "Nl7BcQAAAABJRU5ErkJggg==",
    "base64"
  );
}

///////////////////////////////////////////////////////////////////////////
// log - styled console output                                           //
// ===                                                                   //
///////////////////////////////////////////////////////////////////////////

function log(msg) {
  console.log(`  \x1b[36m✓\x1b[0m ${msg}`);
}

///////////////////////////////////////////////////////////////////////////
// validateManifestRefs - checks that files referenced in manifest exist  //
// ====================                                                   //
///////////////////////////////////////////////////////////////////////////

function validateManifestRefs(manifest) {
  const filesToCheck = [];

  // Background service worker
  if (manifest.background && manifest.background.service_worker) {
    filesToCheck.push(manifest.background.service_worker);
  }

  // Content scripts
  if (manifest.content_scripts) {
    for (const cs of manifest.content_scripts) {
      if (cs.js) filesToCheck.push(...cs.js);
      if (cs.css) filesToCheck.push(...cs.css);
    }
  }

  // Web accessible resources
  if (manifest.web_accessible_resources) {
    for (const war of manifest.web_accessible_resources) {
      if (war.resources) filesToCheck.push(...war.resources);
    }
  }

  // Icons
  if (manifest.icons) {
    filesToCheck.push(...Object.values(manifest.icons));
  }
  if (manifest.action && manifest.action.default_icon) {
    if (typeof manifest.action.default_icon === "string") {
      filesToCheck.push(manifest.action.default_icon);
    } else {
      filesToCheck.push(...Object.values(manifest.action.default_icon));
    }
  }

  const missing = [];
  for (const f of filesToCheck) {
    const fullPath = path.join(ROOT, f);
    if (!fs.existsSync(fullPath)) {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    warn(`Manifest references missing files:\n    ${missing.join("\n    ")}`);
    return missing;
  }

  return [];
}

///////////////////////////////////////////////////////////////////////////
// warn - styled warning output                                          //
// ====                                                                  //
///////////////////////////////////////////////////////////////////////////

function warn(msg) {
  console.warn(`  \x1b[33m⚠\x1b[0m ${msg}`);
}

// =========================================================================
// **** MAIN                                                            ****
// =========================================================================

async function main() {
  console.log("\n  \x1b[1m📝 MarkDown Momma — Build\x1b[0m\n");

  // 1. Clean and create dist/
  if (fs.existsSync(DIST)) {
    fs.rmSync(DIST, { recursive: true });
  }
  fs.mkdirSync(DIST, { recursive: true });
  log("Cleaned dist/");

  // 2. Validate manifest
  const manifest = assembleManifest();

  // 3. Ensure Turndown library exists
  const turndownSrc = path.join(ROOT, "lib", "turndown.js");
  if (!fs.existsSync(turndownSrc)) {
    fs.mkdirSync(path.join(ROOT, "lib"), { recursive: true });
    try {
      await downloadFile(TURNDOWN_CDN, turndownSrc);
    } catch (e) {
      die(`Failed to download Turndown: ${e.message}`);
    }
  } else {
    const size = fs.statSync(turndownSrc).size;
    if (size < 1000) {
      warn(`turndown.js looks too small (${size} bytes), re-downloading...`);
      try {
        await downloadFile(TURNDOWN_CDN, turndownSrc);
      } catch (e) {
        die(`Failed to download Turndown: ${e.message}`);
      }
    } else {
      log(`Turndown OK (${(size / 1024).toFixed(1)}KB)`);
    }
  }

  // 4. Ensure icons exist
  const iconDir = path.join(ROOT, "icons");
  fs.mkdirSync(iconDir, { recursive: true });
  const iconSizes = { 16: "icon16.png", 48: "icon48.png", 128: "icon128.png" };
  for (const [size, filename] of Object.entries(iconSizes)) {
    const iconPath = path.join(iconDir, filename);
    if (!fs.existsSync(iconPath)) {
      generatePlaceholderIcon(parseInt(size), iconPath);
    } else {
      log(`Icon OK: ${filename}`);
    }
  }

  // 5. Copy everything to dist/ (excluding dist, node_modules, .git, build files)
  const exclude = new Set(["dist", "node_modules", ".git", "build.js", "package.json", "package-lock.json", "README.md"]);
  const entries = fs.readdirSync(ROOT, { withFileTypes: true });

  for (const entry of entries) {
    if (exclude.has(entry.name)) continue;

    const srcPath = path.join(ROOT, entry.name);
    const destPath = path.join(DIST, entry.name);

    if (entry.isDirectory()) {
      copyDir(srcPath, destPath);
    } else {
      fs.copyFileSync(srcPath, destPath);
    }
  }

  log("Copied extension files to dist/");

  // 6. Final validation — check all manifest refs resolve in dist/
  const distManifest = JSON.parse(fs.readFileSync(path.join(DIST, "manifest.json"), "utf-8"));
  const missingInDist = [];

  const checkFile = (f) => {
    if (!fs.existsSync(path.join(DIST, f))) missingInDist.push(f);
  };

  if (distManifest.background?.service_worker) checkFile(distManifest.background.service_worker);
  if (distManifest.icons) Object.values(distManifest.icons).forEach(checkFile);
  if (distManifest.action?.default_icon) {
    const di = distManifest.action.default_icon;
    if (typeof di === "string") checkFile(di);
    else Object.values(di).forEach(checkFile);
  }
  if (distManifest.web_accessible_resources) {
    for (const war of distManifest.web_accessible_resources) {
      if (war.resources) war.resources.forEach(checkFile);
    }
  }

  if (missingInDist.length > 0) {
    die(`dist/ is missing files referenced by manifest:\n    ${missingInDist.join("\n    ")}`);
  }

  // 7. Summary
  const fileCount = countFiles(DIST);
  const totalSize = dirSize(DIST);

  console.log(`
  \x1b[32m✅ Build complete!\x1b[0m

  Output:    ${DIST}
  Files:     ${fileCount}
  Size:      ${(totalSize / 1024).toFixed(1)}KB

  \x1b[2mTo install in Chrome:\x1b[0m
  1. Open chrome://extensions/
  2. Enable "Developer mode"
  3. Click "Load unpacked"
  4. Select the \x1b[1mdist/\x1b[0m folder
`);
}

///////////////////////////////////////////////////////////////////////////
// countFiles - recursively counts files in a directory                   //
// ==========                                                            //
///////////////////////////////////////////////////////////////////////////

function countFiles(dir) {
  let count = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      count += countFiles(path.join(dir, entry.name));
    } else {
      count++;
    }
  }
  return count;
}

///////////////////////////////////////////////////////////////////////////
// dirSize - recursively sums file sizes in a directory                   //
// =======                                                               //
///////////////////////////////////////////////////////////////////////////

function dirSize(dir) {
  let size = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      size += dirSize(p);
    } else {
      size += fs.statSync(p).size;
    }
  }
  return size;
}

main().catch((e) => die(e.message));

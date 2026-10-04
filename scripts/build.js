#!/usr/bin/env node
/**
 * PatchWiki build script
 * Reads every .md file under /tutorials/
 * Writes /dist/tutorials/ chunk files + index.json manifest
 */

const fs   = require('fs');
const path = require('path');

const TUTORIALS_DIR = path.join(__dirname, '..', 'tutorials');
const DIST_DIR      = path.join(__dirname, '..', 'dist');
const INDEX_SRC     = path.join(__dirname, '..', 'index.html');
const CHUNK_SIZE    = 50; // tutorials per chunk file

const TAG_RULES = [
  { tag: 'online',  keywords: ['onlinefix','online fix','online patch','online multiplayer','goldberg','steamemu','steam_emu','gbe_fork','lan play','p2p','steam p2p','sseon','online co-op','online-fix'] },
  { tag: 'bypass',  keywords: ['bypass','steam emulator','steam_api','steam api','steam_appid','skidrow','codex','fitgirl','reloaded','crack','cracked','pirated','scene release','spacewar'] },
  { tag: 'coop',    keywords: ['co-op','coop','co op','multiplayer','hamachi','zerotier','zero tier','parsec','lan party','join session','invite friend','virtual lan','netplay'] },
  { tag: 'crack',   keywords: ['crack patch','scene group','plaza','empress','repack','nfo','.nfo','release group','fairlight','razor1911','patch only','crack only','bin patch'] },
  { tag: 'drm',     keywords: ['denuvo','drm','eac','easy anti-cheat','battleye','battle eye','vac','valve anti-cheat','steam drm','anti-tamper','protection','steamworks'] }
];

function detectTags(text) {
  const lower = text.toLowerCase();
  const found = new Set();
  for (const rule of TAG_RULES) {
    if (rule.keywords.some(kw => lower.includes(kw))) found.add(rule.tag);
  }
  // also keep original tags if they're one of our known ones
  return [...found];
}

function parseFrontmatter(raw) {
  const fm = {};
  let body = raw;
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) fm[m[1].trim()] = m[2].trim();
    }
    body = fmMatch[2];
  }
  return { fm, body };
}

function parseTitle(md) {
  const m = md.match(/^#\s+(.+)/m);
  return m ? m[1].trim() : '';
}

function parseDesc(md) {
  const lines = md.split('\n');
  let inCode = false;
  for (const line of lines) {
    if (line.startsWith('```')) { inCode = !inCode; continue; }
    if (inCode) continue;
    const t = line.trim();
    if (!t || t.startsWith('#') || t.startsWith('>') || t.startsWith('|') ||
        t.startsWith('-') || t.startsWith('*') || /^\d+\./.test(t)) continue;
    if (t.length > 20) return t.replace(/\*\*/g,'').replace(/\*/g,'').replace(/`/g,'').substring(0, 160);
  }
  return '';
}

function parseVersion(md) {
  for (const line of md.split('\n')) {
    const m = line.match(/(?:version|v)\s*[\d]+[\d.]+/i) || line.match(/v[\d]+\.[\d.]+/i);
    if (m) return line.replace(/[*#>_`]/g,'').trim().substring(0, 60);
  }
  return '';
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}

function walk(dir) {
  let files = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) files = files.concat(walk(full));
    else if (entry.name.endsWith('.md')) files.push(full);
  }
  return files;
}

function build() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  // Create dist/data/ folder for chunks
  const dataDir = path.join(DIST_DIR, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const mdFiles = fs.existsSync(TUTORIALS_DIR) ? walk(TUTORIALS_DIR) : [];
  console.log(`Found ${mdFiles.length} tutorial(s) in /tutorials/`);

  const tutorials = [];

  for (const file of mdFiles) {
    const raw  = fs.readFileSync(file, 'utf8');
    const { fm, body } = parseFrontmatter(raw);
    const filename = path.basename(file, '.md');
    const relPath  = path.relative(TUTORIALS_DIR, file).replace(/\\/g, '/').replace(/\.md$/, '');
    const slugPath = slugify(relPath.replace(/\//g, '-'));

    const title   = fm.title   || parseTitle(body)   || filename;
    const game    = fm.game    || title.split('—')[0].split('-')[0].trim();
    const author  = fm.author  || 'Anonymous';
    const version = fm.version || parseVersion(body);
    const desc    = fm.desc    || fm.description || parseDesc(body) || `Tutorial: ${title}`;
    const date    = fm.date    || fs.statSync(file).mtime.toISOString().split('T')[0];
    const id      = fm.id      || slugPath;

    // Tags: frontmatter wins if present, otherwise auto-detect
    let tags;
    if (fm.tags) {
      tags = fm.tags.split(',').map(t => t.trim()).filter(Boolean);
      // normalize to our tag names
      const normalized = detectTags(raw);
      tags = [...new Set([...tags, ...normalized])];
    } else {
      tags = detectTags(raw);
      if (tags.length === 0) tags = ['general'];
    }

    // Store full content separately (in chunk), index entry has no content
    tutorials.push({ id, title, game, desc, tags, author, version, date, content: body });
  }

  // Sort newest first
  tutorials.sort((a, b) => b.date.localeCompare(a.date));

  // ── Split into chunks ──────────────────────────────────────────
  // Index = all entries WITHOUT content (for grid display)
  // Chunks = batches WITH content (loaded on-demand when reading a tutorial)
  const index = tutorials.map(({ content, ...rest }) => rest);

  // Write index.json (no content = small file)
  const indexPath = path.join(DIST_DIR, 'index.json');
  const indexStr = JSON.stringify(index, null, 2);
  fs.writeFileSync(indexPath, indexStr, 'utf8');
  console.log(`Wrote index.json — ${tutorials.length} entries, ${(Buffer.byteLength(indexStr)/1024).toFixed(1)} KB`);

  // Write chunk files with content
  const chunks = [];
  for (let i = 0; i < tutorials.length; i += CHUNK_SIZE) {
    const chunk = tutorials.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE);
    const chunkPath = path.join(dataDir, `chunk-${chunkNum}.json`);
    const chunkStr = JSON.stringify(chunk, null, 2);
    fs.writeFileSync(chunkPath, chunkStr, 'utf8');
    chunks.push({ file: `data/chunk-${chunkNum}.json`, ids: chunk.map(t => t.id) });
    console.log(`  chunk-${chunkNum}.json — ${chunk.length} tutorials, ${(Buffer.byteLength(chunkStr)/1024).toFixed(1)} KB`);
  }

  // Write manifest.json (maps tutorial id → chunk file)
  const manifest = {};
  for (const chunk of chunks) {
    for (const id of chunk.ids) manifest[id] = chunk.file;
  }
  fs.writeFileSync(path.join(DIST_DIR, 'manifest.json'), JSON.stringify(manifest), 'utf8');
  console.log(`Wrote manifest.json — ${Object.keys(manifest).length} id→chunk mappings`);

  // Keep tutorials.json for backwards compat (index only, no content)
  fs.writeFileSync(path.join(DIST_DIR, 'tutorials.json'), indexStr, 'utf8');

  // Copy index.html
  fs.copyFileSync(INDEX_SRC, path.join(DIST_DIR, 'index.html'));

  // Copy assets folder if present
  const assetsSrc = path.join(TUTORIALS_DIR, 'assets');
  const assetsDist = path.join(DIST_DIR, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, assetsDist, { recursive: true });
    console.log(`Copied assets to dist/assets`);
  }

  // Copy favicon if present
  const icoSrc = path.join(__dirname, '..', 'steamunlock_wannabe.ico');
  if (fs.existsSync(icoSrc)) {
    fs.copyFileSync(icoSrc, path.join(DIST_DIR, 'steamunlock_wannabe.ico'));
  }

  console.log('\nBuild complete ✓');
}

build();
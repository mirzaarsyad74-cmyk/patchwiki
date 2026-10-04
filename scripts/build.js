#!/usr/bin/env node
/**
 * PatchWiki build script
 * Reads every .md file under /tutorials/
 * Extracts Steam AppID and normalized game titles
 * Writes /dist/ and root data chunk files + index.json manifest
 */

const fs   = require('fs');
const path = require('path');

const ROOT_DIR      = path.join(__dirname, '..');
const TUTORIALS_DIR = path.join(ROOT_DIR, 'tutorials');
const DIST_DIR      = path.join(ROOT_DIR, 'dist');
const INDEX_SRC     = path.join(ROOT_DIR, 'index.html');
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
  return [...found];
}

function parseFrontmatter(raw) {
  const fm = {};
  let body = raw;
  const fmMatch = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (fmMatch) {
    for (const line of fmMatch[1].split('\n')) {
      const m = line.match(/^(\w+)\s*:\s*(.+)$/);
      if (m) fm[m[1].trim().toLowerCase()] = m[2].trim();
    }
    body = fmMatch[2];
  }
  return { fm, body };
}

function extractAppId(fm, filename, title, game, body) {
  if (fm.appid || fm.steam_appid || fm.app_id) {
    const n = parseInt(fm.appid || fm.steam_appid || fm.app_id, 10);
    if (!isNaN(n) && n > 0) return n;
  }
  const fullText = [filename, title, game, (body || '').slice(0, 400)].join(' ');

  const mParen = fullText.match(/[\(\[]\s*(\d{3,9})\s*[\)\]]/);
  if (mParen) return parseInt(mParen[1], 10);

  const mDash = fullText.match(/[-:]\s*(\d{3,9})\b/);
  if (mDash) return parseInt(mDash[1], 10);

  const mFileNum = filename.match(/^(\d{3,9})$/);
  if (mFileNum) return parseInt(mFileNum[1], 10);

  const mAppWord = fullText.match(/(?:appid|app)\s*[:=]?\s*(\d{3,9})\b/i);
  if (mAppWord) return parseInt(mAppWord[1], 10);

  const mIso = fullText.match(/\b(\d{4,8})\b/);
  if (mIso) return parseInt(mIso[1], 10);

  const mLink = (body || '').match(/store\.steampowered\.com\/app\/(\d{3,9})/i);
  if (mLink) return parseInt(mLink[1], 10);

  return null;
}

function cleanGameName(rawGame, rawTitle, filename) {
  let g = (rawGame || rawTitle || filename || '').trim();
  g = g.replace(/^#+\s*/, '');
  g = g.replace(/^\s*[\(\[]\s*\d{3,9}\s*[\)\]]\s*/, '');
  g = g.replace(/^Added\s+(?:DENUVO?|DENUV0?|DENU|EA)?\s*(?:bypass\s+for\s+|bypass\s+|online\s+patch\s+for\s+|online\s+patch\s+)?/i, '');
  g = g.replace(/^AppID\s+\d+\s*\(([^)]+)\)/i, '$1');
  g = g.replace(/^(?:UBISOFT\s+)?BYPASS\s+FOR\s+/i, '');
  g = g.replace(/^FOR\s+/i, '');
  g = g.replace(/[\(\[]\s*\d{3,9}\s*[\)\]]/g, '');
  g = g.replace(/[-:]\s*\d{3,9}\b/g, '');
  g = g.replace(/^\s*\d{4,9}\s+/, '');
  g = g.replace(/\b(?:DENUV0?|DENUVO?|DENU|EA|UBISOFT)\s+BYPASS\b/gi, '');
  g = g.replace(/\b(?:ONLINE\s+PATCH|ONLINE\s+FIX|ONLINE\s+CO-OP|ONLINE\s+METHOD|ONLINE)\b/gi, '');
  g = g.replace(/\b(?:SEAMLESS\s+CO-OP|MULTIPLAYER\s+MOD\s+TUTORIAL|MULTIPLAYER)\b/gi, '');
  g = g.replace(/\b(?:BYPASS|GUIDE|TUTORIAL|FIX|UPDATED\s+INSTRUCTION|UPDATE\s+[\d.]+)\b/gi, '');
  g = g.replace(/^[-:\s,()\[\]]+|[-:\s,()\[\]]+$/g, '').trim();
  if (g.includes('(') && !g.includes(')')) g += ')';
  return g || rawGame || rawTitle || 'Unknown Game';
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
    if (entry.isDirectory()) {
      if (entry.name !== 'assets') files = files.concat(walk(full));
    } else if (entry.name.endsWith('.md')) {
      files.push(full);
    }
  }
  return files;
}

function build() {
  if (!fs.existsSync(DIST_DIR)) fs.mkdirSync(DIST_DIR, { recursive: true });

  const dataDir = path.join(DIST_DIR, 'data');
  if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });

  const rootDataDir = path.join(ROOT_DIR, 'data');
  if (!fs.existsSync(rootDataDir)) fs.mkdirSync(rootDataDir, { recursive: true });

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
    const appId   = extractAppId(fm, filename, title, fm.game, body);
    const game    = cleanGameName(fm.game, title, filename);
    const author  = fm.author  || 'Community';
    const version = fm.version || parseVersion(body);
    const desc    = fm.desc    || fm.description || parseDesc(body) || `Tutorial for ${game}`;
    const date    = fm.date    || fs.statSync(file).mtime.toISOString().split('T')[0];
    const id      = fm.id      || slugPath;

    let tags;
    if (fm.tags) {
      tags = fm.tags.split(',').map(t => t.trim()).filter(Boolean);
      const normalized = detectTags(raw);
      tags = [...new Set([...tags, ...normalized])];
    } else {
      tags = detectTags(raw);
      if (tags.length === 0) tags = ['general'];
    }

    tutorials.push({ id, appId, title, game, desc, tags, author, version, date, content: body });
  }

  tutorials.sort((a, b) => b.date.localeCompare(a.date));

  const index = tutorials.map(({ content, ...rest }) => rest);

  const indexStr = JSON.stringify(index, null, 2);
  fs.writeFileSync(path.join(DIST_DIR, 'index.json'), indexStr, 'utf8');
  fs.writeFileSync(path.join(ROOT_DIR, 'index.json'), indexStr, 'utf8');
  console.log(`Wrote index.json - ${tutorials.length} entries, ${(Buffer.byteLength(indexStr)/1024).toFixed(1)} KB`);

  const chunks = [];
  for (let i = 0; i < tutorials.length; i += CHUNK_SIZE) {
    const chunk = tutorials.slice(i, i + CHUNK_SIZE);
    const chunkNum = Math.floor(i / CHUNK_SIZE);
    const chunkFileName = `chunk-${chunkNum}.json`;
    const chunkStr = JSON.stringify(chunk, null, 2);

    fs.writeFileSync(path.join(dataDir, chunkFileName), chunkStr, 'utf8');
    fs.writeFileSync(path.join(rootDataDir, chunkFileName), chunkStr, 'utf8');

    chunks.push({ file: `data/${chunkFileName}`, ids: chunk.map(t => t.id) });
    console.log(`  ${chunkFileName} - ${chunk.length} tutorials, ${(Buffer.byteLength(chunkStr)/1024).toFixed(1)} KB`);
  }

  const manifest = {};
  for (const chunk of chunks) {
    for (const id of chunk.ids) manifest[id] = chunk.file;
  }
  const manifestStr = JSON.stringify(manifest, null, 2);
  fs.writeFileSync(path.join(DIST_DIR, 'manifest.json'), manifestStr, 'utf8');
  fs.writeFileSync(path.join(ROOT_DIR, 'manifest.json'), manifestStr, 'utf8');
  console.log(`Wrote manifest.json - ${Object.keys(manifest).length} id mappings`);

  fs.writeFileSync(path.join(DIST_DIR, 'tutorials.json'), indexStr, 'utf8');
  fs.writeFileSync(path.join(ROOT_DIR, 'tutorials.json'), indexStr, 'utf8');

  fs.copyFileSync(INDEX_SRC, path.join(DIST_DIR, 'index.html'));

  const assetsSrc = path.join(TUTORIALS_DIR, 'assets');
  const assetsDist = path.join(DIST_DIR, 'assets');
  if (fs.existsSync(assetsSrc)) {
    fs.cpSync(assetsSrc, assetsDist, { recursive: true });
    console.log(`Copied assets to dist/assets`);
  }

  const icoSrc = path.join(ROOT_DIR, 'steamunlock_wannabe.ico');
  if (fs.existsSync(icoSrc)) {
    fs.copyFileSync(icoSrc, path.join(DIST_DIR, 'steamunlock_wannabe.ico'));
  }

  console.log('\nBuild complete!');
}

build();

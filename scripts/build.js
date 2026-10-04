#!/usr/bin/env node
/**
 * Static Site & Data Index Builder for Tutorial
 *
 * Reads all .md files from /tutorials/, parses frontmatter and markdown body,
 * extracts Steam AppID, cleans game names, tags, and generates:
 *   - /dist/index.html
 *   - /dist/index.json   (Full tutorial index for CloudRedirect & Millennium Plugin)
 *   - /dist/manifest.json (Chunk route map)
 *   - /dist/data/chunk-*.json (Chunked tutorial data)
 */

const fs   = require('fs');
const path = require('path');

const ROOT_DIR      = path.join(__dirname, '..');
const TUTORIALS_DIR = path.join(ROOT_DIR, 'tutorials');
const DIST_DIR      = path.join(ROOT_DIR, 'dist');
const INDEX_SRC     = path.join(ROOT_DIR, 'index.html');
const CHUNK_SIZE    = 20;

// Tag detection rules
const TAG_RULES = [
  { tag: 'online',  keywords: ['onlinefix','online fix','online patch','online multiplayer','goldberg','steamemu','steam_emu','gbe_fork','lan play','p2p','steam p2p','sseon','online co-op','online-fix'] },
  { tag: 'bypass',  keywords: ['bypass','steam emulator','steam_api','steam api','steam_appid','skidrow','codex','fitgirl','reloaded','crack','cracked','pirated','scene release','spacewar'] },
  { tag: 'coop',    keywords: ['co-op','coop','co op','multiplayer','hamachi','zerotier','zero tier','parsec','lan party','join session','invite friend','virtual lan','netplay','seamless co-op'] },
  { tag: 'crack',   keywords: ['crack patch','scene group','plaza','empress','repack','nfo','.nfo','release group','fairlight','razor1911','patch only','crack only','bin patch'] },
  { tag: 'drm',     keywords: ['denuvo','drm','eac','easy anti-cheat','battleye','battle eye','vac','valve anti-cheat','steam drm','anti-tamper','protection','steamworks','ubisoft','ea app'] }
];

const KNOWN_GAME_APPIDS = {
  'elden ring': 1245620,
  'palworld': 1623730,
  'carx street': 1114150,
  'beamng.drive': 284160,
  'beamng drive': 284160,
  'grand theft auto v': 271590,
  'gta v': 271590,
  'gta 5': 271590,
  'grand theft auto v legacy': 271590,
  'monster hunter world': 582010,
  'monster hunter: world': 582010,
  'hogwarts legacy': 990080,
  'cyberpunk 2077': 1091500,
  'black myth: wukong': 2358720,
  'black myth wukong': 2358720,
  'lies of p': 1627720,
  'it takes two': 1426210,
  'no mans sky': 275850,
  "no man's sky": 275850,
  'planet coaster': 493340,
  'planet zoo': 703080,
  'payday 3': 1272080,
  'pay day 3': 1272080,
  'red dead redemption 2': 1174180,
  'rdr2': 1174180,
  'red dead redemption': 2668510,
  'resident evil 6': 221040,
  'resident evil 9': 3764200,
  're9': 3764200,
  'metaphor refantazio': 2679460,
  'dirt 4': 421020,
  'assassins creed odyssey': 812140,
  "assassin's creed odyssey": 812140,
  "assassin's creed mirage": 3035570,
  "assassin's creed shadows": 3159330,
  "assassin's creed shadow": 3159330,
  "assassin's creed rogue": 311560,
  "assassin's creed syndicate": 368500,
  "assassin's creed black flag": 3751950,
  'atomic heart': 668580,
  'battlefield 6': 2807960,
  'call of duty black ops 6': 1938090,
  'call of duty modern warfare iii': 3595270,
  'call of duty world at war': 10090,
  'call of duty black ops cold war': 1985810,
  'company of heroes 3': 1677280,
  'crimson desert': 2419900,
  'dead or alive 6 last round': 4144680,
  'diablo ii': 2536520,
  'ea sports college football 27': 4032350,
  'f1 22': 1692250,
  'f1 25': 3059520,
  'far cry 5': 552520,
  'fifa 22': 1506830,
  'forza horizon 6': 2483190,
  'inazuma eleven victory road': 2799860,
  'jurassic world evolution 3': 2958130,
  'mafia the old country': 1941540,
  'microsoft flight simulator': 1250410,
  'nba 2k14': 255480,
  'need for speed undercover': 17430,
  'persona 4 golden': 111300,
  'prison architect': 233450,
  'star wars jedi survivor': 1774580,
  'steep': 460920,
  'suicide squad kill the justice league': 315210,
  'unravel two': 1225570,
  'watch dogs 2': 447040,
  'wild hearts': 1938010,
  'wreckfest 2': 1203190,
  'lords of the fallen': 1501750
};

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
    for (const line of fmMatch[1].split(/\r?\n/)) {
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
  const fullText = [filename || '', title || '', game || '', (body || '').slice(0, 1000)].join(' ');

  const mLink = fullText.match(/(?:store\.steampowered\.com|steamcommunity\.com)\/app\/(\d{3,9})/i);
  if (mLink) return parseInt(mLink[1], 10);

  const mAppWord = fullText.match(/(?:appid|app\s*id|steam_appid)\s*[:=]?\s*(\d{3,9})\b/i);
  if (mAppWord) return parseInt(mAppWord[1], 10);

  const mParen = fullText.match(/[\(\[]\s*(\d{3,9})\s*[\)\]]/);
  if (mParen) return parseInt(mParen[1], 10);

  const mDash = fullText.match(/[-:]\s*(\d{3,9})\b/);
  if (mDash) return parseInt(mDash[1], 10);

  const mPunct = fullText.match(/[!#]+\s*(\d{4,9})\b/);
  if (mPunct) return parseInt(mPunct[1], 10);

  const mFileNum = (filename || '').match(/^(\d{3,9})$/);
  if (mFileNum) return parseInt(mFileNum[1], 10);

  const mIso = (title || '').match(/\b(\d{4,8})\b/);
  if (mIso) return parseInt(mIso[1], 10);

  const cleanTitleLower = (game || title || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [knownName, knownId] of Object.entries(KNOWN_GAME_APPIDS)) {
    if (cleanTitleLower.includes(knownName) || knownName.includes(cleanTitleLower)) {
      return knownId;
    }
  }

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
  g = g.replace(/!+\s*\d{4,9}\b/g, '');
  g = g.replace(/^\s*\d{4,9}\s+/, '');
  g = g.replace(/\b(?:DENUV0?|DENUVO?|DENU|EA|UBISOFT)\s+BYPASS\b/gi, '');
  g = g.replace(/\b(?:ONLINE\s+PATCH|ONLINE\s+FIX|ONLINE\s+CO-OP|ONLINE\s+METHOD|ONLINE)\b/gi, '');
  g = g.replace(/\b(?:SEAMLESS\s+CO-OP|MULTIPLAYER\s+MOD\s+TUTORIAL|MULTIPLAYER)\b/gi, '');
  g = g.replace(/\b(?:BYPASS|GUIDE|TUTORIAL|FIX|UPDATED\s+INSTRUCTION|UPDATE\s+[\d.]+|RELEASE\s+DATE[^\)]*)\b/gi, '');
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
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tutorial';
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
    const version = fm.version || parseVersion(body) || '1.0';
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

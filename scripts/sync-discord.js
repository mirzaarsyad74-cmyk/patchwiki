#!/usr/bin/env node
/**
 * Discord Channel & Forum Scraper for Tutorial / CloudRedirect
 *
 * Automatically fetches guides from Discord Forum & Text channels,
 * supports both Bot tokens and User Account tokens (using Discord web client endpoints),
 * filters out casual chat while capturing all guides, downloads assets (splitting files >45MB),
 * formats them with full CloudRedirect-compatible YAML frontmatter (appId, title, game, desc, tags),
 * and saves/overwrites them as .md files inside /tutorials/.
 */

const fs   = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────
const RAW_CHANNELS = process.env.DISCORD_CHANNEL_IDS || process.env.DISCORD_CHANNEL_ID || '1498980524297818142';
const CHANNEL_IDS  = RAW_CHANNELS.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

const RAW_EXTRA_THREADS = process.env.EXTRA_THREAD_IDS || '1512676091373031507';
const EXTRA_THREAD_IDS  = RAW_EXTRA_THREADS.split(/[,;\s]+/).map(s => s.trim()).filter(Boolean);

const GUILD_ID   = process.env.DISCORD_GUILD_ID   || '333191744873299978';
const RAW_TOKEN  = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();

const ROOT_DIR      = path.join(__dirname, '..');
const TUTORIALS_DIR = path.join(ROOT_DIR, 'tutorials');
const ASSETS_DIR    = path.join(TUTORIALS_DIR, 'assets');
const DATA_DIR      = path.join(ROOT_DIR, 'data');
const STATE_FILE    = path.join(DATA_DIR, 'discord_sync_state.json');

const DISCORD_API   = 'https://discord.com/api/v10';
const CHUNK_SIZE_BYTES = 45 * 1024 * 1024; // 45 MB chunk limit for safe GitHub upload

const FORCE_OVERWRITE = process.argv.includes('--force') ||
                        process.argv.includes('--overwrite') ||
                        process.env.OVERWRITE_ALL === 'true';

// Tag auto-detection rules matching build.js
const TAG_RULES = [
  { tag: 'online',  keywords: ['onlinefix','online fix','online patch','online multiplayer','goldberg','steamemu','steam_emu','gbe_fork','lan play','p2p','steam p2p','sseon','online co-op','online-fix'] },
  { tag: 'bypass',  keywords: ['bypass','steam emulator','steam_api','steam api','steam_appid','skidrow','codex','fitgirl','reloaded','crack','cracked','pirated','scene release','spacewar'] },
  { tag: 'coop',    keywords: ['co-op','coop','co op','multiplayer','hamachi','zerotier','zero tier','parsec','lan party','join session','invite friend','virtual lan','netplay','seamless co-op'] },
  { tag: 'crack',   keywords: ['crack patch','scene group','plaza','empress','repack','nfo','.nfo','release group','fairlight','razor1911','patch only','crack only','bin patch'] },
  { tag: 'drm',     keywords: ['denuvo','drm','eac','easy anti-cheat','battleye','battle eye','vac','valve anti-cheat','steam drm','anti-tamper','protection','steamworks','ubisoft','ea app'] }
];

// Fallback dictionary for common Steam games if AppID is omitted from thread title
const KNOWN_GAME_APPIDS = {
  'onimusha way of the sword': 2638890,
  'onimusha: way of the sword': 2638890,
  'onimusha': 2638890,
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

function extractAppId(filename, title, game, body) {
  const fullText = [filename || '', title || '', game || '', (body || '').slice(0, 5000)].join(' ');
  
  // 1. Steam store, community, or steamdb URL
  const mLink = fullText.match(/(?:store\.steampowered\.com|steamcommunity\.com|steamdb\.info)\/app\/(\d{3,9})/i);
  if (mLink) return parseInt(mLink[1], 10);

  // 2. Explicit appid label
  const mAppWord = fullText.match(/(?:appid|app\s*id|steam_appid)\s*[:=]?\s*(\d{3,9})\b/i);
  if (mAppWord) return parseInt(mAppWord[1], 10);

  // 3. Parentheses or brackets: (1234560) or [1234560]
  const mParen = fullText.match(/[\(\[]\s*(\d{3,9})\s*[\)\]]/);
  if (mParen) return parseInt(mParen[1], 10);

  // 4. Dash or colon suffix: - 1234560 or : 1234560
  const mDash = fullText.match(/[-:]\s*(\d{3,9})\b/);
  if (mDash) return parseInt(mDash[1], 10);

  // 5. Attached exclamation/punctuation: !!3764200
  const mPunct = fullText.match(/[!#]+\s*(\d{4,9})\b/);
  if (mPunct) return parseInt(mPunct[1], 10);

  // 6. Filename pure number
  const mFileNum = (filename || '').match(/^(\d{3,9})$/);
  if (mFileNum) return parseInt(mFileNum[1], 10);

  // 7. Standalone number in title
  const mIso = (title || '').match(/\b(\d{4,8})\b/);
  if (mIso) return parseInt(mIso[1], 10);

  // 8. Known game title lookup
  const cleanTitleLower = (game || title || '').toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
  for (const [knownName, knownId] of Object.entries(KNOWN_GAME_APPIDS)) {
    const cleanKnown = knownName.toLowerCase().replace(/['’]/g, '').replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
    if (cleanTitleLower.includes(cleanKnown) || cleanKnown.includes(cleanTitleLower)) {
      return knownId;
    }
  }

  return null;
}

function cleanGameName(rawGame, rawTitle, filename) {
  let g = (rawGame || rawTitle || filename || '').trim();
  if (/^how\s+to\b/i.test(g) || /^#?(?:HV|VBS|Cloud|Steam)/i.test(g)) {
    return g.replace(/^#+\s*/, '').replace(/\s+/g, ' ').trim();
  }
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
  g = g.replace(/^[-:\s,()\[\]]+|[-:\s,()\[\]]+$/g, '').replace(/\s+/g, ' ').trim();
  if (g.includes('(') && !g.includes(')')) g += ')';
  return g || rawGame || rawTitle || 'Unknown Game';
}

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function slugify(str) {
  return str.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'tutorial';
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Authentication Detection ─────────────────────────────────────────────
async function resolveAuthHeader(token) {
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN. Please set the DISCORD_TOKEN secret or environment variable.');
  }

  if (token.startsWith('Bot ') || token.startsWith('Bearer ')) {
    return token;
  }

  console.log('Testing Discord authentication format...');

  // 1. Try Bot token format first
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: {
        'Authorization': `Bot ${token}`,
        'User-Agent': 'Tutorial-Sync/1.0'
      }
    });
    if (res.ok) {
      console.log('Authenticated successfully as Discord Bot.');
      return `Bot ${token}`;
    }
  } catch (err) {}

  // 2. Try User token format
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: {
        'Authorization': token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (res.ok) {
      const u = await res.json().catch(() => ({}));
      console.log(`Authenticated successfully with User Token (${u.username || 'User'}).`);
      return token;
    }
  } catch (err) {}

  throw new Error('Failed to authenticate with Discord API (both Bot and User token checks returned 401 Unauthorized). Please check your DISCORD_TOKEN.');
}

// ── Discord Fetch with Rate-Limit Handling ───────────────────────────────
async function discordFetch(endpoint, authHeader) {
  const url = endpoint.startsWith('http') ? endpoint : `${DISCORD_API}${endpoint}`;
  
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader,
        'User-Agent': authHeader.startsWith('Bot ') ? 'Tutorial-Sync/1.0' : 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json'
      }
    });

    if (res.status === 429) {
      const data = await res.json().catch(() => ({}));
      const retryAfter = Math.ceil((data.retry_after || 2) * 1000) + 500;
      console.warn(`Rate limited by Discord. Waiting ${retryAfter}ms before retry...`);
      await sleep(retryAfter);
      continue;
    }

    if (!res.ok) {
      const errorText = await res.text().catch(() => '');
      throw new Error(`Discord API error ${res.status} on ${endpoint}: ${errorText}`);
    }

    return await res.json();
  }

  throw new Error(`Max retries exceeded for ${endpoint}`);
}

// ── Download Asset with Automatic Chunk Splitting (>45MB) ────────────────
async function downloadAsset(url, safeFilename, reportedSize) {
  const destPath = path.join(ASSETS_DIR, safeFilename);

  // Check if file or its parts already exist
  if (!FORCE_OVERWRITE) {
    if (fs.existsSync(destPath)) {
      const st = fs.statSync(destPath);
      return {
        isSplit: false,
        files: [`assets/${safeFilename}`],
        totalSize: st.size,
        partSizes: [st.size],
        baseName: safeFilename
      };
    }
    const part1 = path.join(ASSETS_DIR, `${safeFilename}.part01`);
    if (fs.existsSync(part1)) {
      const partFiles = [];
      const partSizes = [];
      let totalSize = 0;
      let idx = 1;
      while (true) {
        const pName = `${safeFilename}.part${String(idx).padStart(2, '0')}`;
        const pPath = path.join(ASSETS_DIR, pName);
        if (!fs.existsSync(pPath)) break;
        const pst = fs.statSync(pPath);
        partFiles.push(`assets/${pName}`);
        partSizes.push(pst.size);
        totalSize += pst.size;
        idx++;
      }
      return {
        isSplit: true,
        files: partFiles,
        totalSize,
        partSizes,
        baseName: safeFilename
      };
    }
  }

  console.log(`  Downloading asset: ${safeFilename} (${reportedSize ? (reportedSize / (1024*1024)).toFixed(1) + ' MB' : 'unknown size'})...`);

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  Failed to download asset ${url}: HTTP ${res.status}`);
      return { fallbackUrl: url };
    }

    const buffer = Buffer.from(await res.arrayBuffer());
    const totalSize = buffer.length;

    if (totalSize <= CHUNK_SIZE_BYTES) {
      fs.writeFileSync(destPath, buffer);
      console.log(`  Saved asset: assets/${safeFilename} (${(totalSize / (1024*1024)).toFixed(1)} MB)`);
      return {
        isSplit: false,
        files: [`assets/${safeFilename}`],
        totalSize,
        partSizes: [totalSize],
        baseName: safeFilename
      };
    }

    // Split file into chunks <= 45MB so GitHub push never fails and no asset is ignored
    const numParts = Math.ceil(totalSize / CHUNK_SIZE_BYTES);
    console.log(`  File exceeds 45 MB limit (${(totalSize / (1024*1024)).toFixed(1)} MB). Splitting into ${numParts} parts...`);
    const partFiles = [];
    const partSizes = [];

    for (let i = 0; i < numParts; i++) {
      const start = i * CHUNK_SIZE_BYTES;
      const end = Math.min((i + 1) * CHUNK_SIZE_BYTES, totalSize);
      const slice = buffer.subarray(start, end);
      const partName = `${safeFilename}.part${String(i + 1).padStart(2, '0')}`;
      const partPath = path.join(ASSETS_DIR, partName);
      fs.writeFileSync(partPath, slice);
      partFiles.push(`assets/${partName}`);
      partSizes.push(slice.length);
      console.log(`    Wrote ${partName} (${(slice.length / (1024*1024)).toFixed(1)} MB)`);
    }

    return {
      isSplit: true,
      files: partFiles,
      totalSize,
      partSizes,
      baseName: safeFilename
    };
  } catch (err) {
    console.warn(`  Error downloading asset ${safeFilename}: ${err.message}`);
    return { fallbackUrl: url };
  }
}

// ── State Management ─────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {}
  }
  return { lastSync: null, syncedItems: {} };
}

function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Forum Thread Retrieval (User Token & Bot Token Compatible) ───────────
async function getForumThreads(channelId, authHeader) {
  const threadMap = new Map();

  // Strategy 1: Guild active threads (/guilds/{GUILD_ID}/threads/active) - Bot tokens
  try {
    const activeData = await discordFetch(`/guilds/${GUILD_ID}/threads/active`, authHeader);
    const activeThreads = (activeData.threads || []).filter(t => t.parent_id === channelId);
    for (const t of activeThreads) threadMap.set(t.id, t);
    if (activeThreads.length > 0) {
      console.log(`  [Strategy 1 - Guild Active] Found ${activeThreads.length} active thread(s).`);
    }
  } catch (err) {
    console.log(`  [Strategy 1 - Guild Active] Skipped (${err.message}). Using client forum search...`);
  }

  // Strategy 2: User token client forum search (archived=false for active threads)
  // This is the EXACT endpoint Discord Web Client uses when browsing active forum posts!
  try {
    let offset = 0;
    let hasMore = true;
    let searchActiveCount = 0;
    while (hasMore && offset < 500) {
      const searchRes = await discordFetch(`/channels/${channelId}/threads/search?archived=false&sort_by=last_message_time&sort_order=desc&limit=25&offset=${offset}`, authHeader);
      const threads = searchRes.threads || [];
      for (const t of threads) {
        if (!threadMap.has(t.id)) {
          threadMap.set(t.id, t);
          searchActiveCount++;
        }
      }
      if (searchRes.has_more && threads.length > 0) {
        offset += threads.length;
        await sleep(350);
      } else {
        hasMore = false;
      }
    }
    console.log(`  [Strategy 2 - Forum Search Active] Found ${searchActiveCount} active thread(s).`);
  } catch (err) {
    console.warn(`  [Strategy 2 - Forum Search Active] Warning: ${err.message}`);
  }

  // Strategy 3: Channel-level threads/active endpoint
  try {
    const chanActive = await discordFetch(`/channels/${channelId}/threads/active`, authHeader);
    const threads = chanActive.threads || (Array.isArray(chanActive) ? chanActive : []);
    let count = 0;
    for (const t of threads) {
      if (!threadMap.has(t.id)) {
        threadMap.set(t.id, t);
        count++;
      }
    }
    if (count > 0) console.log(`  [Strategy 3 - Channel Active] Found ${count} additional active thread(s).`);
  } catch (err) {}

  // Strategy 4: Archived Public Threads (/channels/{id}/threads/archived/public)
  try {
    let beforeTimestamp = null;
    let hasMore = true;
    let archivedCount = 0;

    while (hasMore) {
      const query = beforeTimestamp ? `?before=${encodeURIComponent(beforeTimestamp)}&limit=100` : '?limit=100';
      const archivedData = await discordFetch(`/channels/${channelId}/threads/archived/public${query}`, authHeader);
      const threads = archivedData.threads || [];
      for (const t of threads) {
        if (!threadMap.has(t.id)) {
          threadMap.set(t.id, t);
          archivedCount++;
        }
      }

      if (archivedData.has_more && threads.length > 0) {
        const lastThread = threads[threads.length - 1];
        beforeTimestamp = lastThread.thread_metadata?.archive_timestamp;
        await sleep(300);
      } else {
        hasMore = false;
      }
    }
    console.log(`  [Strategy 4 - Archived Public] Found ${archivedCount} archived thread(s).`);
  } catch (err) {
    console.warn(`  [Strategy 4 - Archived Public] Warning: ${err.message}`);
  }

  // Strategy 5: Archived Private Threads (/channels/{id}/users/@me/threads/archived/private)
  try {
    const privData = await discordFetch(`/channels/${channelId}/users/@me/threads/archived/private?limit=100`, authHeader);
    const threads = privData.threads || [];
    for (const t of threads) {
      if (!threadMap.has(t.id)) threadMap.set(t.id, t);
    }
  } catch (err) {}

  return threadMap;
}

// ── Thread Processor (Formats CloudRedirect-Compatible Guides) ────────────
async function processThread(threadId, thread, authHeader, state) {
  const lastEdited = thread.thread_metadata?.archive_timestamp || thread.last_message_id;
  const prev = state.syncedItems[threadId];

  const gameTitle = (thread.name || `Guide-${threadId}`).trim();
  const safeBase = sanitizeFilename(gameTitle);
  const slug = slugify(gameTitle);
  const filename = `${safeBase || threadId}.md`;
  const filePath = path.join(TUTORIALS_DIR, filename);

  // Check if up to date unless FORCE_OVERWRITE is set or file is missing
  if (!FORCE_OVERWRITE && prev && prev.lastEdited === lastEdited && fs.existsSync(filePath)) {
    return false;
  }

  console.log(`\nProcessing thread: "${thread.name}" (${threadId})`);
  await sleep(200);

  // Fetch messages inside the thread (paginate if > 100)
  let messages = [];
  try {
    let beforeMsgId = null;
    let hasMore = true;
    while (hasMore && messages.length < 300) {
      const q = beforeMsgId ? `?before=${beforeMsgId}&limit=100` : '?limit=100';
      const batch = await discordFetch(`/channels/${threadId}/messages${q}`, authHeader);
      if (!batch || batch.length === 0) break;
      messages = messages.concat(batch);
      beforeMsgId = batch[batch.length - 1].id;
      if (batch.length < 100) hasMore = false;
      await sleep(200);
    }
    messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // oldest first
  } catch (err) {
    console.warn(`Could not fetch messages for thread ${threadId}: ${err.message}`);
    return false;
  }

  if (messages.length === 0) return false;

  const firstMsg = messages[0];
  const authorName = firstMsg.author?.global_name || firstMsg.author?.username || 'Community';
  const date = (firstMsg.timestamp || new Date().toISOString()).split('T')[0];

  // Combine message content and attachments
  let bodySections = [];

  for (const msg of messages) {
    let text = msg.content || '';

    // Process attachments
    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const ext = path.extname(att.filename || '').toLowerCase() || '.png';
        const safeAttName = `${slug}_${att.id}${ext}`;
        const assetRes = await downloadAsset(att.url, safeAttName, att.size);

        if (assetRes.fallbackUrl) {
          text += `\n\n[Download ${att.filename}](${assetRes.fallbackUrl})\n`;
        } else if (!assetRes.isSplit) {
          const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(ext);
          if (isImg) {
            text += `\n\n![Attached Image](${assetRes.files[0]})\n`;
          } else {
            const sizeLabel = att.size ? ` (${(att.size / (1024 * 1024)).toFixed(1)} MB)` : '';
            text += `\n\n[Download ${att.filename}${sizeLabel}](${assetRes.files[0]})\n`;
          }
        } else {
          // File is split into parts (>45MB)
          const totalMb = (assetRes.totalSize / (1024 * 1024)).toFixed(1);
          const partLinks = assetRes.files.map((p, idx) => {
            const pMb = (assetRes.partSizes[idx] / (1024 * 1024)).toFixed(1);
            return `- [Download Part ${idx + 1} (${pMb} MB)](${p})`;
          }).join('\n');

          text += `\n\n### Download ${att.filename} (${totalMb} MB)\n` +
                  `> **Note:** This file exceeds 45 MB and has been split into ${assetRes.files.length} parts for direct download:\n` +
                  `${partLinks}\n\n` +
                  `**To recombine on Windows (CMD):**\n` +
                  `\`\`\`cmd\ncopy /b "${safeAttName}.part*" "${att.filename}"\n\`\`\`\n` +
                  `**To recombine on Linux / Mac:**\n` +
                  `\`\`\`bash\ncat "${safeAttName}.part"* > "${att.filename}"\n\`\`\`\n`;
        }
      }
    }

    if (text.trim()) {
      bodySections.push(text.trim());
    }
  }

  const fullContent = bodySections.join('\n\n---\n\n');
  const detectedTags = detectTags(`${gameTitle} ${fullContent}`);
  const tagsStr = detectedTags.length > 0 ? detectedTags.join(', ') : 'general';

  const appId = extractAppId(safeBase, gameTitle, gameTitle, fullContent);
  const cleanGame = cleanGameName(gameTitle, gameTitle, safeBase);

  // Create a clean summary description
  let summaryDesc = `Tutorial and guide for ${cleanGame}.`;
  for (const line of fullContent.split('\n')) {
    const trimmed = line.trim().replace(/[*#>`_-]/g, '').trim();
    if (trimmed.length > 25 && !trimmed.startsWith('http') && !trimmed.startsWith('![')) {
      summaryDesc = trimmed.slice(0, 160);
      break;
    }
  }

  // Format CloudRedirect-compatible YAML frontmatter
  const mdContent = `---
id: ${slug}
title: ${gameTitle}
game: ${cleanGame}
${appId ? `appid: ${appId}\n` : ''}author: ${authorName}
version: 1.0
desc: ${summaryDesc}
tags: ${tagsStr}
date: ${date}
---

# ${gameTitle}

${fullContent}
`;

  fs.writeFileSync(filePath, mdContent, 'utf8');
  console.log(`  Wrote tutorial to tutorials/${filename} [AppID: ${appId || 'N/A'}]`);

  state.syncedItems[threadId] = {
    lastEdited,
    filename,
    title: gameTitle,
    appId: appId || null,
    syncedAt: new Date().toISOString()
  };
  return true;
}

// ── Text Channel Processor (Extracts Real Guides, Ignores Casual Chatter) ─
async function processTextChannel(channelId, channelInfo, authHeader, state) {
  console.log(`Processing Text Channel #${channelInfo.name || channelId} (${channelId})...`);

  // 1. Also check if the text channel has any active/archived threads
  try {
    const textThreads = await getForumThreads(channelId, authHeader);
    if (textThreads.size > 0) {
      console.log(`  Found ${textThreads.size} thread(s) attached to this text channel.`);
      for (const [threadId, thread] of textThreads.entries()) {
        await processThread(threadId, thread, authHeader, state);
      }
    }
  } catch (err) {}

  // 2. Fetch pinned messages (pinned messages in tutorial channels are key guides)
  const pinnedIds = new Set();
  try {
    const pins = await discordFetch(`/channels/${channelId}/pins`, authHeader);
    console.log(`  Found ${pins.length} pinned message(s).`);
    for (const p of pins) pinnedIds.add(p.id);
  } catch (err) {}

  // 3. Fetch message history with pagination (up to 500 messages)
  let allMessages = [];
  let beforeId = null;
  let hasMore = true;

  while (hasMore && allMessages.length < 500) {
    const query = beforeId ? `?before=${beforeId}&limit=100` : '?limit=100';
    try {
      const msgs = await discordFetch(`/channels/${channelId}/messages${query}`, authHeader);
      if (!msgs || msgs.length === 0) break;
      allMessages = allMessages.concat(msgs);
      beforeId = msgs[msgs.length - 1].id;
      if (msgs.length < 100) hasMore = false;
      await sleep(250);
    } catch (err) {
      console.warn(`  Failed fetching messages batch: ${err.message}`);
      break;
    }
  }
  console.log(`  Retrieved ${allMessages.length} total messages from #${channelInfo.name || channelId}.`);

  // 4. Filter for real guides / tutorials vs casual chat
  const guideMessages = allMessages.filter(msg => {
    if (pinnedIds.has(msg.id)) return true;
    const text = (msg.content || '').toLowerCase();
    const hasAttachments = msg.attachments && msg.attachments.length > 0;
    const hasAppId = extractAppId('', msg.content, '', msg.content) !== null;
    const hasGuideKeyword = /(?:bypass|online\s*fix|onlinefix|online\s*patch|steam\s*emu|goldberg|tutorial|guide|install|how\s*to\s*play|instructions|crack)/i.test(text);

    // Ignore short chat/banter
    const isShortChat = text.length < 50 && !hasAttachments && !hasAppId;
    const isChatter = /^(?:hi|hello|hey|thanks|thank you|ty|gg|is it working|work\?|help|plz|pls|anyone|what|yes|no|ok|cool|nice|lol|lmao)\b/i.test(text.trim());

    if (isShortChat || (isChatter && !hasAttachments && !hasAppId)) return false;

    return hasAttachments || hasAppId || hasGuideKeyword;
  });

  console.log(`  Identified ${guideMessages.length} guide/tutorial message(s) from chat history.`);

  let count = 0;
  for (const msg of guideMessages) {
    if (!msg.content && (!msg.attachments || msg.attachments.length === 0)) continue;

    const lastEdited = msg.edited_timestamp || msg.timestamp;
    const prev = state.syncedItems[msg.id];

    const firstLine = msg.content.split('\n')[0].replace(/^[#*\s]+/, '').trim();
    const gameTitle = firstLine.slice(0, 80) || `Guide-${msg.id}`;
    const safeBase = sanitizeFilename(gameTitle);
    const slug = slugify(gameTitle);
    const filename = `${safeBase || msg.id}.md`;
    const filePath = path.join(TUTORIALS_DIR, filename);

    if (!FORCE_OVERWRITE && prev && prev.lastEdited === lastEdited && fs.existsSync(filePath)) {
      continue;
    }

    const authorName = msg.author?.global_name || msg.author?.username || 'Community';
    const date = (msg.timestamp || new Date().toISOString()).split('T')[0];

    let text = msg.content || '';

    if (msg.attachments && msg.attachments.length > 0) {
      for (const att of msg.attachments) {
        const ext = path.extname(att.filename || '').toLowerCase() || '.png';
        const safeAttName = `${slug}_${att.id}${ext}`;
        const assetRes = await downloadAsset(att.url, safeAttName, att.size);

        if (assetRes.fallbackUrl) {
          text += `\n\n[Download ${att.filename}](${assetRes.fallbackUrl})\n`;
        } else if (!assetRes.isSplit) {
          const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(ext);
          if (isImg) {
            text += `\n\n![Attached Image](${assetRes.files[0]})\n`;
          } else {
            const sizeLabel = att.size ? ` (${(att.size / (1024 * 1024)).toFixed(1)} MB)` : '';
            text += `\n\n[Download ${att.filename}${sizeLabel}](${assetRes.files[0]})\n`;
          }
        } else {
          const totalMb = (assetRes.totalSize / (1024 * 1024)).toFixed(1);
          const partLinks = assetRes.files.map((p, idx) => {
            const pMb = (assetRes.partSizes[idx] / (1024 * 1024)).toFixed(1);
            return `- [Download Part ${idx + 1} (${pMb} MB)](${p})`;
          }).join('\n');

          text += `\n\n### Download ${att.filename} (${totalMb} MB)\n` +
                  `> **Note:** This file exceeds 45 MB and has been split into ${assetRes.files.length} parts for direct download:\n` +
                  `${partLinks}\n\n` +
                  `**To recombine on Windows (CMD):**\n` +
                  `\`\`\`cmd\ncopy /b "${safeAttName}.part*" "${att.filename}"\n\`\`\`\n` +
                  `**To recombine on Linux / Mac:**\n` +
                  `\`\`\`bash\ncat "${safeAttName}.part"* > "${att.filename}"\n\`\`\`\n`;
        }
      }
    }

    const detectedTags = detectTags(`${gameTitle} ${text}`);
    const tagsStr = detectedTags.length > 0 ? detectedTags.join(', ') : 'general';

    const appId = extractAppId(safeBase, gameTitle, gameTitle, text);
    const cleanGame = cleanGameName(gameTitle, gameTitle, safeBase);

    let summaryDesc = `Tutorial and guide for ${cleanGame}.`;
    for (const line of text.split('\n')) {
      const trimmed = line.trim().replace(/[*#>`_-]/g, '').trim();
      if (trimmed.length > 25 && !trimmed.startsWith('http') && !trimmed.startsWith('![')) {
        summaryDesc = trimmed.slice(0, 160);
        break;
      }
    }

    const mdContent = `---
id: ${slug}
title: ${gameTitle}
game: ${cleanGame}
${appId ? `appid: ${appId}\n` : ''}author: ${authorName}
version: 1.0
desc: ${summaryDesc}
tags: ${tagsStr}
date: ${date}
---

# ${gameTitle}

${text}
`;

    fs.writeFileSync(filePath, mdContent, 'utf8');
    console.log(`  Wrote tutorial to tutorials/${filename} [AppID: ${appId || 'N/A'}]`);

    state.syncedItems[msg.id] = {
      lastEdited,
      filename,
      title: gameTitle,
      appId: appId || null,
      syncedAt: new Date().toISOString()
    };
    count++;
    await sleep(150);
  }

  return count;
}

// ── Main Sync Logic ──────────────────────────────────────────────────────
async function main() {
  console.log('=== Tutorial Discord Channel Scraper for CloudRedirect ===');
  console.log(`Channel(s)      : ${CHANNEL_IDS.join(', ')}`);
  console.log(`Guild ID        : ${GUILD_ID}`);
  console.log(`Extra Threads   : ${EXTRA_THREAD_IDS.join(', ')}`);
  console.log(`Force Overwrite : ${FORCE_OVERWRITE}`);

  if (!fs.existsSync(TUTORIALS_DIR)) fs.mkdirSync(TUTORIALS_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const authHeader = await resolveAuthHeader(RAW_TOKEN);
  const state = loadState();
  let newOrUpdatedCount = 0;

  // Process configured channels
  for (const chanId of CHANNEL_IDS) {
    let channelInfo = null;
    try {
      channelInfo = await discordFetch(`/channels/${chanId}`, authHeader);
      console.log(`\n========================================`);
      console.log(`Channel #${channelInfo.name} (${chanId}, type: ${channelInfo.type})`);
      console.log(`========================================`);
    } catch (err) {
      console.warn(`Could not fetch channel details directly for ${chanId}: ${err.message}`);
    }

    const isForum = channelInfo && (channelInfo.type === 15 || channelInfo.type === 16);

    if (isForum) {
      console.log('Detected Discord Forum channel. Fetching active & archived forum threads...');
      const threadMap = await getForumThreads(chanId, authHeader);
      console.log(`Total forum threads to process: ${threadMap.size}`);

      for (const [threadId, thread] of threadMap.entries()) {
        const updated = await processThread(threadId, thread, authHeader, state);
        if (updated) newOrUpdatedCount++;
      }
    } else {
      const added = await processTextChannel(chanId, channelInfo || { name: chanId, type: 0 }, authHeader, state);
      newOrUpdatedCount += added;
    }
  }

  // Process explicit extra threads (guarantees specific guides like Onimusha are fetched)
  if (EXTRA_THREAD_IDS.length > 0) {
    console.log(`\n========================================`);
    console.log(`Checking Explicit Extra Threads (${EXTRA_THREAD_IDS.length})...`);
    console.log(`========================================`);

    for (const threadId of EXTRA_THREAD_IDS) {
      const prev = state.syncedItems[threadId];
      if (!prev || FORCE_OVERWRITE) {
        try {
          const thread = await discordFetch(`/channels/${threadId}`, authHeader);
          console.log(`Found explicit thread: "${thread.name}" (${threadId})`);
          const updated = await processThread(threadId, thread, authHeader, state);
          if (updated) newOrUpdatedCount++;
        } catch (err) {
          console.warn(`Could not fetch explicit thread ${threadId}: ${err.message}`);
        }
      }
    }
  }

  state.lastSync = new Date().toISOString();
  saveState(state);

  console.log(`\n=== Sync Finished! ${newOrUpdatedCount} guide(s) created or updated for CloudRedirect. ===`);
}

main().catch(err => {
  console.error('\nSync failed with error:');
  console.error(err.message || err);
  process.exit(1);
});

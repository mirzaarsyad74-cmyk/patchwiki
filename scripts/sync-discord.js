#!/usr/bin/env node
/**
 * Discord Channel / Forum Scraper for PatchWiki
 *
 * Automatically fetches guides from a Discord channel or forum (default: 1498980524297818142),
 * downloads attachments to /tutorials/assets/, formats them with frontmatter,
 * and saves them as .md files inside /tutorials/.
 *
 * Supports both Discord Bot Tokens and User Account Tokens.
 */

const fs   = require('fs');
const path = require('path');

// ── Configuration ────────────────────────────────────────────────────────
const CHANNEL_ID = process.env.DISCORD_CHANNEL_ID || '1498980524297818142';
const GUILD_ID   = process.env.DISCORD_GUILD_ID   || '333191744873299978';
const RAW_TOKEN  = (process.env.DISCORD_TOKEN || process.env.DISCORD_BOT_TOKEN || '').trim();

const ROOT_DIR      = path.join(__dirname, '..');
const TUTORIALS_DIR = path.join(ROOT_DIR, 'tutorials');
const ASSETS_DIR    = path.join(TUTORIALS_DIR, 'assets');
const DATA_DIR      = path.join(ROOT_DIR, 'data');
const STATE_FILE    = path.join(DATA_DIR, 'discord_sync_state.json');

const DISCORD_API   = 'https://discord.com/api/v10';

// Tag auto-detection rules matching build.js
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

function sanitizeFilename(name) {
  return name
    .replace(/[<>:"/\\|?*\x00-\x1F]/g, '') // remove illegal filesystem characters
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Authentication Detection ─────────────────────────────────────────────
async function resolveAuthHeader(token) {
  if (!token) {
    throw new Error('Missing DISCORD_TOKEN. Please set the DISCORD_TOKEN secret or environment variable.');
  }

  // If already prefixed with 'Bot ' or 'Bearer '
  if (token.startsWith('Bot ') || token.startsWith('Bearer ')) {
    return token;
  }

  console.log('Testing Discord authentication format...');

  // 1. Try Bot token format first
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: {
        'Authorization': `Bot ${token}`,
        'User-Agent': 'PatchWiki-Sync/1.0'
      }
    });
    if (res.ok) {
      console.log('Authenticated successfully as Discord Bot.');
      return `Bot ${token}`;
    }
  } catch (err) {
    // continue to test user token
  }

  // 2. Try User token format (without 'Bot ')
  try {
    const res = await fetch(`${DISCORD_API}/users/@me`, {
      headers: {
        'Authorization': token,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
      }
    });
    if (res.ok) {
      console.log('Authenticated successfully with User Token.');
      return token;
    }
  } catch (err) {
    // failure handled below
  }

  throw new Error('Failed to authenticate with Discord API (both Bot and User token checks returned 401 Unauthorized). Please check your DISCORD_TOKEN.');
}

// ── Discord Fetch with Rate-Limit Handling ──────────────────────────────
async function discordFetch(endpoint, authHeader) {
  const url = endpoint.startsWith('http') ? endpoint : `${DISCORD_API}${endpoint}`;
  
  for (let attempt = 0; attempt < 5; attempt++) {
    const res = await fetch(url, {
      headers: {
        'Authorization': authHeader,
        'User-Agent': 'PatchWiki-Sync/1.0',
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

// ── Download Asset File ──────────────────────────────────────────────────
async function downloadAsset(url, filename) {
  const destPath = path.join(ASSETS_DIR, filename);
  if (fs.existsSync(destPath)) {
    return `assets/${filename}`;
  }

  try {
    const res = await fetch(url);
    if (!res.ok) {
      console.warn(`  Failed to download asset ${url}: HTTP ${res.status}`);
      return url; // fallback to original url if download fails
    }
    const buffer = Buffer.from(await res.arrayBuffer());
    fs.writeFileSync(destPath, buffer);
    console.log(`  Downloaded asset: assets/${filename}`);
    return `assets/${filename}`;
  } catch (err) {
    console.warn(`  Error downloading asset ${url}: ${err.message}`);
    return url;
  }
}

// ── State Management ─────────────────────────────────────────────────────
function loadState() {
  if (fs.existsSync(STATE_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'));
    } catch (e) {
      console.warn('Could not parse sync state file, starting fresh.');
    }
  }
  return { lastSync: null, syncedItems: {} };
}

function saveState(state) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf8');
}

// ── Main Sync Logic ──────────────────────────────────────────────────────
async function main() {
  console.log('=== PatchWiki Discord Channel Scraper ===');
  console.log(`Channel ID : ${CHANNEL_ID}`);
  console.log(`Guild ID   : ${GUILD_ID}`);

  if (!fs.existsSync(TUTORIALS_DIR)) fs.mkdirSync(TUTORIALS_DIR, { recursive: true });
  if (!fs.existsSync(ASSETS_DIR)) fs.mkdirSync(ASSETS_DIR, { recursive: true });

  const authHeader = await resolveAuthHeader(RAW_TOKEN);
  const state = loadState();
  let newOrUpdatedCount = 0;

  // 1. Inspect channel to determine if it's a Forum (type 15) or regular channel
  let channelInfo = null;
  try {
    channelInfo = await discordFetch(`/channels/${CHANNEL_ID}`, authHeader);
    console.log(`Channel Name: #${channelInfo.name} (type: ${channelInfo.type})`);
  } catch (err) {
    console.warn(`Could not fetch channel details directly: ${err.message}. Attempting thread/message fallbacks...`);
  }

  const isForum = channelInfo && (channelInfo.type === 15 || channelInfo.type === 16);

  if (isForum) {
    console.log('Detected Discord Forum channel. Fetching forum threads...');
    const threadMap = new Map();

    // A. Active threads
    try {
      const activeData = await discordFetch(`/guilds/${GUILD_ID}/threads/active`, authHeader);
      const activeThreads = (activeData.threads || []).filter(t => t.parent_id === CHANNEL_ID);
      for (const t of activeThreads) threadMap.set(t.id, t);
      console.log(`Found ${activeThreads.length} active thread(s) in this forum.`);
    } catch (err) {
      console.warn(`Warning: Could not fetch active threads from guild: ${err.message}`);
    }

    // B. Archived public threads
    try {
      let beforeTimestamp = null;
      let hasMore = true;
      let archivedCount = 0;

      while (hasMore) {
        const query = beforeTimestamp ? `?before=${encodeURIComponent(beforeTimestamp)}&limit=100` : '?limit=100';
        const archivedData = await discordFetch(`/channels/${CHANNEL_ID}/threads/archived/public${query}`, authHeader);
        const threads = archivedData.threads || [];
        for (const t of threads) threadMap.set(t.id, t);
        archivedCount += threads.length;

        if (archivedData.has_more && threads.length > 0) {
          const lastThread = threads[threads.length - 1];
          beforeTimestamp = lastThread.thread_metadata?.archive_timestamp;
          await sleep(300);
        } else {
          hasMore = false;
        }
      }
      console.log(`Found ${archivedCount} archived thread(s) in this forum.`);
    } catch (err) {
      console.warn(`Warning: Could not fetch archived threads: ${err.message}`);
    }

    console.log(`Total threads to process: ${threadMap.size}`);

    // Process each thread
    for (const [threadId, thread] of threadMap.entries()) {
      const lastEdited = thread.thread_metadata?.archive_timestamp || thread.last_message_id;
      const prev = state.syncedItems[threadId];

      if (prev && prev.lastEdited === lastEdited) {
        continue; // Up to date
      }

      console.log(`\nProcessing thread: "${thread.name}" (${threadId})`);
      await sleep(250);

      // Fetch messages inside the thread
      let messages = [];
      try {
        messages = await discordFetch(`/channels/${threadId}/messages?limit=100`, authHeader);
        messages.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp)); // oldest first
      } catch (err) {
        console.warn(`Could not fetch messages for thread ${threadId}: ${err.message}`);
        continue;
      }

      if (messages.length === 0) continue;

      const firstMsg = messages[0];
      const authorName = firstMsg.author?.global_name || firstMsg.author?.username || 'Community';
      const date = (firstMsg.timestamp || new Date().toISOString()).split('T')[0];
      const gameTitle = thread.name.trim();

      // Combine message content and attachments
      let bodySections = [];
      const slug = sanitizeFilename(gameTitle).toLowerCase().replace(/\s+/g, '-');

      for (const msg of messages) {
        let text = msg.content || '';

        // Process attachments
        if (msg.attachments && msg.attachments.length > 0) {
          for (const att of msg.attachments) {
            const ext = path.extname(att.filename || '').toLowerCase() || '.png';
            const safeAttName = `${slug}_${att.id}${ext}`;
            const localRel = await downloadAsset(att.url, safeAttName);

            const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(ext);
            if (isImg) {
              text += `\n\n![Attached Image](${localRel})\n`;
            } else {
              text += `\n\n[Download ${att.filename}](${localRel})\n`;
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

      const mdContent = `---
game: ${gameTitle}
author: ${authorName}
version: Unknown
tags: ${tagsStr}
date: ${date}
---

# ${gameTitle}

${fullContent}
`;

      const safeBase = sanitizeFilename(gameTitle);
      const filename = `${safeBase || threadId}.md`;
      const filePath = path.join(TUTORIALS_DIR, filename);

      fs.writeFileSync(filePath, mdContent, 'utf8');
      console.log(`  ✓ Wrote tutorial to tutorials/${filename}`);

      state.syncedItems[threadId] = {
        lastEdited,
        filename,
        title: gameTitle,
        syncedAt: new Date().toISOString()
      };
      newOrUpdatedCount++;
    }

  } else {
    // Regular text channel (type 0 or announcement)
    console.log('Fetching messages from channel...');
    const messages = await discordFetch(`/channels/${CHANNEL_ID}/messages?limit=100`, authHeader);
    console.log(`Retrieved ${messages.length} message(s).`);

    for (const msg of messages) {
      if (!msg.content && (!msg.attachments || msg.attachments.length === 0)) continue;

      const lastEdited = msg.edited_timestamp || msg.timestamp;
      const prev = state.syncedItems[msg.id];
      if (prev && prev.lastEdited === lastEdited) continue;

      const authorName = msg.author?.global_name || msg.author?.username || 'Community';
      const date = (msg.timestamp || new Date().toISOString()).split('T')[0];

      // Extract title from first line of message
      const firstLine = msg.content.split('\n')[0].replace(/^[#*\s]+/, '').trim();
      const gameTitle = firstLine || `Guide-${msg.id}`;
      const slug = sanitizeFilename(gameTitle).toLowerCase().replace(/\s+/g, '-');

      let text = msg.content || '';

      if (msg.attachments && msg.attachments.length > 0) {
        for (const att of msg.attachments) {
          const ext = path.extname(att.filename || '').toLowerCase() || '.png';
          const safeAttName = `${slug}_${att.id}${ext}`;
          const localRel = await downloadAsset(att.url, safeAttName);

          const isImg = /\.(png|jpg|jpeg|webp|gif)$/i.test(ext);
          if (isImg) {
            text += `\n\n![Attached Image](${localRel})\n`;
          } else {
            text += `\n\n[Download ${att.filename}](${localRel})\n`;
          }
        }
      }

      const detectedTags = detectTags(`${gameTitle} ${text}`);
      const tagsStr = detectedTags.length > 0 ? detectedTags.join(', ') : 'general';

      const mdContent = `---
game: ${gameTitle}
author: ${authorName}
version: Unknown
tags: ${tagsStr}
date: ${date}
---

# ${gameTitle}

${text}
`;

      const safeBase = sanitizeFilename(gameTitle);
      const filename = `${safeBase || msg.id}.md`;
      const filePath = path.join(TUTORIALS_DIR, filename);

      fs.writeFileSync(filePath, mdContent, 'utf8');
      console.log(`  ✓ Wrote tutorial to tutorials/${filename}`);

      state.syncedItems[msg.id] = {
        lastEdited,
        filename,
        title: gameTitle,
        syncedAt: new Date().toISOString()
      };
      newOrUpdatedCount++;
      await sleep(150);
    }
  }

  state.lastSync = new Date().toISOString();
  saveState(state);

  console.log(`\n=== Sync Finished! ${newOrUpdatedCount} guide(s) created or updated. ===`);
}

main().catch(err => {
  console.error('\nSync failed with error:');
  console.error(err.message || err);
  process.exit(1);
});

# Contributing to Tutorial

Thanks for writing a guide! Here's how to get it published.

---

## The short version

1. Fork this repo
2. Add your `.md` file to the `tutorials/` folder
3. Open a Pull Request
4. Once merged → GitHub Action auto-deploys → your guide goes live

---

## Writing your tutorial

### Option A — Use the website editor

Go to the wiki and click **Contribute**. Write or paste your markdown, let the tag auto-detector run, then copy the generated `.md` file shown at the bottom.

### Option B — Write it manually

Create a file like `tutorials/your-game-title-patch-name.md`.

**Filename rules:**
- Lowercase, hyphens only, no spaces
- Format: `game-name-method.md`
- Examples: `elden-ring-onlinefix.md`, `baldurs-gate-3-goldberg-coop.md`

---

## Frontmatter (optional but recommended)

Add a YAML block at the very top of your file:

```yaml
---
game: Elden Ring
author: your_username
version: OnlineFix v3.1 / ER 1.13
tags: online, coop
date: 2025-12-01
---
```

If you skip frontmatter, the build script auto-detects everything from your content.

**Available tags:** `online` · `bypass` · `coop` · `crack` · `drm`

---

## File structure

```
tutorials/
  ├── elden-ring-onlinefix.md
  ├── baldurs-gate-3-goldberg-online.md
  └── your-new-guide.md          ← add yours here
```

---

## Good tutorial checklist

- [ ] Starts with `# Game Name — Method` as the H1 title
- [ ] Includes a **Requirements** section
- [ ] Numbered steps, clear and concise
- [ ] Mentions tested game version and tool version
- [ ] Has a **Troubleshooting** section for common errors
- [ ] No broken links, no malware, no scam sites

---

## What happens after you submit?

1. Maintainer reviews the PR
2. If approved → merged into `main`
3. GitHub Action runs `scripts/build.js` — reads all `.md` files, builds `tutorials.json`
4. Site deploys to GitHub Pages automatically
5. Your guide appears on the wiki within ~60 seconds of merge

---

## Questions?

Open an issue or find us on Discord.

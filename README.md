# Tutorial

Community-driven tutorial and guide library for online patches, DRM bypasses, and game co-op emulation guides.

**Live site:** https://mirzaarsyad74-cmyk.github.io/patchwiki/

---

## How it works

```
tutorials/*.md
      │
      ▼  (on push to main)
GitHub Action runs scripts/build.js
      │
      ▼
dist/tutorials.json  +  dist/index.html
      │
      ▼
GitHub Pages serves the site
```

- All tutorials live as plain `.md` files in `tutorials/`
- The build script parses frontmatter + auto-detects tags from content
- The site fetches `tutorials.json` at runtime — no server needed

## Contributing

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

**Short version:** fork → add `.md` to `tutorials/` → open PR → merge = live.

## Local development

```bash
node scripts/build.js    # builds dist/
# then open dist/index.html in a browser
# or: npx serve dist
```

## Repo structure

```
patchwiki/
├── index.html              # the entire wiki UI (single file)
├── tutorials/              # one .md file per tutorial
│   └── *.md
├── scripts/
│   └── build.js            # builds tutorials.json from .md files
├── .github/
│   ├── workflows/
│   │   └── deploy.yml      # CI: build + deploy to Pages on merge
│   └── PULL_REQUEST_TEMPLATE/
│       └── tutorial.md     # PR checklist for contributors
├── CONTRIBUTING.md
└── README.md
```

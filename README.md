# Redline

A standalone PDF markup application for construction documents — mark up drawings,
submittals, and contracts like a desktop PDF editor such as Adobe Acrobat, with a
built-in OCR engine that runs entirely on your machine.

No cloud. No plugins. No subscription. Your documents never leave your computer.

## Features

- **Built-in OCR** — scanned sheets become searchable text automatically, powered by a
  vendored PP-OCRv5 model running on-device (CPU). Open a scan, it reads; open a book,
  it reads page-at-a-time instead of churning for hours.
- **Markup** — highlight, underline, strikeout, freehand pen, lines, arrows, boxes,
  revision clouds, polygons, polylines, and callouts.
- **Measure** — distance and area, with scale calibration and standard architectural /
  engineering / metric scale presets.
- **Stamps** — fixed, custom-text, dynamic (`{date}` / `{time}` / `{author}`), and image stamps.
- **Comments** — per-annotation notes with author, threaded replies, and CSV / PDF export.
- **Page operations** — insert, combine, extract, split, and delete pages.
- **Text tools** — select, copy, and find (Ctrl+F) across OCR'd pages.
- **Send** — email (opens a compose window), a configurable handoff (drop folder and/or HTTP POST), or LocalSend.
- **Undo / redo** — every edit is journaled.

## Install

Download the installer for your platform from
[Releases](https://github.com/timlcode/redline/releases):

- Linux: `Redline-<version>-x86_64.AppImage`
- macOS: `Redline-<version>.dmg`
- Windows: `Redline-<version>.exe`

Linux AppImages need `libfuse2` (usually a one-line install on most distros).

## Build from source

```bash
npm install
npm run electron     # run the desktop app
npm test             # run the test suite
npm run dist:linux   # build a Linux AppImage
```

## Settings

The sender address and handoff targets live in `settings.json` inside the app data folder. That file stays on your machine. Copy [`settings.example.json`](settings.example.json) there and edit it.

- Desktop app: Electron's user-data directory. On Linux that is usually `~/.config/redline`.
- `npm start`: `$REDLINE_DATA_DIR`, or `~/.local/share/redline` when that variable is unset.

```json
{
  "author": "Your name",
  "email": "user@example.com",
  "handoff": {
    "dropFolder": "/absolute/path/to/folder",
    "endpoint": "https://example.com/inbound"
  }
}
```

- `author` — name stored on new comments.
- `email` — Thunderbird identity used as the From address. Leave it empty to choose the account in the compose window.
- `handoff.dropFolder` — absolute path (a leading `~` is fine). A handoff copies the PDF here and will not overwrite an existing file (`name.pdf`, then `name-1.pdf`, and so on). Leave it empty to skip the copy.
- `handoff.endpoint` — `http` or `https` URL. A handoff POSTs the PDF as `application/pdf` with a `Content-Disposition` filename. The endpoint must answer with a 2xx status. Leave it empty to skip the POST.

Handoff runs every target that is set. At least one of `dropFolder` or `endpoint` is required before that send option is available. Email and LocalSend do not use this block.

## How it's built

- [Electron](https://www.electronjs.org/) — desktop shell
- [MuPDF](https://mupdf.com/) — PDF rendering and annotations
- [ONNX Runtime](https://onnxruntime.ai/) + a vendored PP-OCRv5 model — on-device OCR

License: AGPL-3.0-or-later. See [LICENSE](LICENSE) and [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md).

---

Adobe and Acrobat are registered trademarks of Adobe Inc. Redline is an independent
project and is not affiliated with or endorsed by Adobe.

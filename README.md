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
- **Redact** — mark a rectangle or selected text, or search every page for a word, a phrase, phone numbers, email addresses, social security numbers, or dollar amounts. Accept or reject each match, then apply. Applying permanently removes the text, drawings, and the picture pixels under each box. The box can be black, white, or red, with optional wording such as REDACTED. You can also remove hidden information: document details, attachments, scripts, hidden layers, comments, and older saved copies. The result is saved as a new file, and the original is left as it was.
- **Measure** — distance and area, with scale calibration and standard architectural /
  engineering / metric scale presets.
- **Stamps** — fixed, custom-text, dynamic (`{date}` / `{time}` / `{author}`), and image stamps.
- **Comments** — per-annotation notes with author, threaded replies, and CSV / PDF export.
- **Page operations** — insert, combine, extract, split, and delete pages.
- **Fill in forms** — type in text fields, check boxes, pick a radio button or a dropdown, and tab from field to field. Built for pay applications (a cover sheet plus a continuation sheet) and lien waivers.
- **Sign** — draw, type, or import a picture of a signature or initials. Save it on this computer and reuse it. Drag it onto the page, then move or resize it. Save writes it into the page. Signing with a certificate is not included.
- **Flatten** — bake filled fields and markup into the page so they are no longer editable, on demand or the next time you save.
- **Print** — print the pages you choose (Ctrl+P). The printed copy is flattened; the open file is not.
- **Reduce file size** — shrink pictures to a chosen sharpness (300 down to 72 dpi) and see the size before and after.
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

Reusable signatures and initials are pictures in a `signatures` folder inside that same app data folder. They are never stored in the project and are not written into a PDF until you place one and save.

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

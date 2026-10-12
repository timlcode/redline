#!/usr/bin/env python3
# Native file chooser for Redline. Prints the chosen path, or nothing on cancel.
import sys

import gi

gi.require_version("Gtk", "3.0")
from gi.repository import Gtk  # noqa: E402

mode = sys.argv[1] if len(sys.argv) > 1 else "open"
# modes: open (one PDF), save, files (several PDFs/images, one path per line), folder
if mode in ("save", "save-any"):
    action, title, accept = Gtk.FileChooserAction.SAVE, "Save PDF" if mode == "save" else "Save file", "Save"
elif mode == "folder":
    action, title, accept = Gtk.FileChooserAction.SELECT_FOLDER, "Choose a folder", "Choose"
elif mode == "files":
    action, title, accept = Gtk.FileChooserAction.OPEN, "Choose PDFs or images", "Add"
else:
    action, title, accept = Gtk.FileChooserAction.OPEN, "Open PDF", "Open"
dialog = Gtk.FileChooserNative.new(title, None, action, accept, "Cancel")
if mode not in ("folder", "save-any"):
    filt = Gtk.FileFilter()
    if mode == "files":
        filt.set_name("PDF and images")
        for pat in ("*.pdf", "*.PDF", "*.jpg", "*.jpeg", "*.JPG", "*.JPEG", "*.png", "*.PNG", "*.tif", "*.tiff", "*.TIF", "*.bmp", "*.gif"):
            filt.add_pattern(pat)
        for mt in ("application/pdf", "image/jpeg", "image/png", "image/tiff", "image/bmp", "image/gif"):
            filt.add_mime_type(mt)
    else:
        filt.set_name("PDF")
        filt.add_pattern("*.pdf")
        filt.add_pattern("*.PDF")
        filt.add_mime_type("application/pdf")
    dialog.add_filter(filt)
if mode == "files":
    dialog.set_select_multiple(True)
if mode in ("save", "save-any"):
    dialog.set_do_overwrite_confirmation(True)
    dialog.set_current_name(sys.argv[2] if len(sys.argv) > 2 and sys.argv[2] else "marked.pdf")
if len(sys.argv) > 3 and sys.argv[3]:
    dialog.set_current_folder(sys.argv[3])
resp = dialog.run()
if resp == Gtk.ResponseType.ACCEPT:
    if mode == "files":
        for f in dialog.get_filenames():
            print(f)
    else:
        print(dialog.get_filename() or "")
dialog.destroy()

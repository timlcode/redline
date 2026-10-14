import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {
  PAGE_GAP,
  PAGE_PAD,
  bookmarkScroll,
  dominantPage,
  fitZoom,
  pageHoldsCenter,
  flattenOutline,
  initialCollapsed,
  isContinuous,
  layoutDocument,
  pagesNearView,
  toggleCollapsed,
} from "../public/view.mjs";

const letter = (n = 4) => Array.from({ length: n }, () => ({ width: 612, height: 792 }));

test("the page lists page modes, document tabs, and a bookmarks panel", () => {
  const html = fs.readFileSync(new URL("../public/index.html", import.meta.url), "utf8");
  const app = fs.readFileSync(new URL("../public/app.js", import.meta.url), "utf8");
  for (const mode of ["single", "two", "continuous", "continuous-two"]) {
    assert.match(html, new RegExp(`data-display="${mode}"`));
  }
  assert.match(html, /id="doctabs"/);
  assert.match(html, /id="outline"/);
  assert.match(html, /id="btn-thumbs"/);
  assert.match(html, /Fit Page/);
  assert.match(app, /This PDF has no bookmarks/);
  assert.match(app, /pagesNearView/);
  assert.match(app, /closeTab/);
});

test("single page lays out only the focused page", () => {
  const layout = layoutDocument(letter(), "single", 1, { focus: 2 });
  assert.deepEqual(layout.pages.map((p) => p.index), [2]);
  assert.equal(layout.pages[0].x, PAGE_PAD);
  assert.equal(layout.pages[0].y, PAGE_PAD);
  assert.equal(layout.pages[0].w, 612);
  assert.equal(layout.pages[0].h, 792);
  assert.equal(isContinuous("single"), false);
});

test("two pages shows the focused pair side by side", () => {
  const first = layoutDocument(letter(), "two", 1, { focus: 0 });
  assert.deepEqual(first.pages.map((p) => p.index), [0, 1]);
  assert.equal(first.pages[1].x, PAGE_PAD + 612 + PAGE_GAP);
  assert.equal(first.pages[1].y, first.pages[0].y);
  const next = layoutDocument(letter(), "two", 1, { focus: 2 });
  assert.deepEqual(next.pages.map((p) => p.index), [2, 3]);
  const odd = layoutDocument(letter(3), "two", 1, { focus: 2 });
  assert.deepEqual(odd.pages.map((p) => p.index), [2]);
});

test("continuous stacks every page and continuous two pages pairs them", () => {
  const cont = layoutDocument(letter(), "continuous", 1);
  assert.equal(cont.pages.length, 4);
  assert.equal(cont.pages[1].x, cont.pages[0].x);
  assert.ok(cont.pages[1].y >= cont.pages[0].y + cont.pages[0].h + PAGE_GAP - 0.1);
  const facing = layoutDocument(letter(), "continuous-two", 1);
  assert.deepEqual(facing.pages.map((p) => p.index), [0, 1, 2, 3]);
  assert.equal(facing.pages[1].y, facing.pages[0].y);
  assert.ok(facing.pages[2].y > facing.pages[0].y);
  assert.equal(facing.pages[2].x, facing.pages[0].x);
  assert.equal(facing.pages[3].x, facing.pages[1].x);
  const tail = layoutDocument(letter(3), "continuous-two", 1);
  assert.equal(tail.pages.length, 3);
  assert.equal(tail.pages[2].x, tail.pages[0].x);
});

test("fit width and fit page follow the display mode", () => {
  const pages = letter();
  const view = { pages, focus: 0, viewW: 800, viewH: 600 };
  const width = fitZoom({ ...view, mode: "single", fit: "width" });
  const page = fitZoom({ ...view, mode: "single", fit: "page" });
  assert.equal(width, Math.round(((800 - PAGE_PAD * 2) / 612) * 100) / 100);
  assert.equal(page, Math.round(Math.min((800 - PAGE_PAD * 2) / 612, (600 - PAGE_PAD * 2) / 792) * 100) / 100);
  assert.ok(page < width);
  const two = fitZoom({ ...view, mode: "two", fit: "width" });
  const facing = fitZoom({ ...view, mode: "continuous-two", fit: "width" });
  assert.ok(two < width);
  assert.equal(facing, two);
  const fitPageSpread = fitZoom({ ...view, mode: "continuous-two", fit: "page" });
  assert.ok(fitPageSpread <= two);
});

test("continuous only treats pages near the viewport as visible", () => {
  const pages = letter(300);
  const layout = layoutDocument(pages, "continuous", 1);
  assert.equal(layout.pages.length, 300);
  const near = pagesNearView(layout, 0, 800, 400);
  assert.ok(near.length > 0 && near.length < 8, `near ${near.length}`);
  assert.equal(near[0], 0);
  assert.ok(!near.includes(299));
  assert.equal(dominantPage(layout, 0, 800), 0);
  const last = layout.pages[299];
  const atEnd = pagesNearView(layout, last.y, 800, 200);
  assert.ok(atEnd.includes(299));
  assert.ok(!atEnd.includes(0));
  const jump = bookmarkScroll(layout, 10, { x: 40, y: 80 }, 1, 800);
  assert.ok(jump.top >= layout.pages[10].y);
  assert.ok(jump.top < layout.pages[10].y + 80);
});

test("an explicit page stays current while it still crosses the screen", () => {
  const layout = layoutDocument(letter(6), "continuous-two", 1);
  const right = layout.pages.find((p) => p.index === 3);
  const scrollTop = right.y - 16;
  assert.equal(pageHoldsCenter(layout, 3, scrollTop, 700), true);
  assert.notEqual(dominantPage(layout, scrollTop, 700), 3);
  const past = right.y + right.h + 40;
  assert.equal(pageHoldsCenter(layout, 3, past, 700), false);
});

test("bookmark rows collapse, expand, and keep their destination page", () => {
  const outline = [
    {
      title: "Parent",
      page: 0,
      y: 92,
      children: [{ title: "Child", page: 2, x: 72, y: 400, children: [] }],
    },
    { title: "Sibling", page: 1, children: [] },
  ];
  const collapsed = initialCollapsed(outline);
  assert.deepEqual(flattenOutline(outline, collapsed).map((r) => r.title), ["Parent", "Sibling"]);
  const open = toggleCollapsed(collapsed, "0");
  const rows = flattenOutline(outline, open);
  assert.deepEqual(rows.map((r) => r.title), ["Parent", "Child", "Sibling"]);
  assert.equal(rows[1].page, 2);
  assert.equal(rows[1].depth, 1);
  assert.equal(rows[1].y, 400);
  const shut = toggleCollapsed(open, "0");
  assert.deepEqual(flattenOutline(outline, shut).map((r) => r.title), ["Parent", "Sibling"]);
});

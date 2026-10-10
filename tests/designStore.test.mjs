import test from "node:test";
import assert from "node:assert/strict";
import { buildShareRequest, removeDesign, restoreDesigns, serializeDesigns, upsertDesign } from "../designStore.ts";

const original = {
  id: "design-1", title: "First", symbol: "✦", imageUri: null,
  background: "#F4C542", targetPackage: "com.example.app", targetLabel: "Example", updatedAt: 1,
};

test("saving a new design prepends it without losing existing designs", () => {
  const second = { ...original, id: "design-2", title: "Second" };
  assert.deepEqual(upsertDesign([original], second, null), [second, original]);
});

test("editing replaces the existing design instead of duplicating it", () => {
  const updated = { ...original, title: "Updated", updatedAt: 2 };
  const result = upsertDesign([original], updated, original.id);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "Updated");
  assert.equal(result[0].id, original.id);
});

test("deleting removes only the selected design", () => {
  const second = { ...original, id: "design-2" };
  assert.deepEqual(removeDesign([original, second], original.id), [second]);
});

test("serialization and restoration preserve the complete saved design", () => {
  const restored = restoreDesigns(serializeDesigns([original]));
  assert.deepEqual(restored, [original]);
  assert.deepEqual(restoreDesigns(null), []);
});

test("restoration rejects malformed shape rather than silently corrupting the library", () => {
  assert.throws(() => restoreDesigns('{"not":"an array"}'), /must be an array/);
  assert.throws(() => restoreDesigns("{"), SyntaxError);
});

test("share payload preserves the composed image inputs", () => {
  assert.deepEqual(buildShareRequest("file:///icon.png", "☀", "#F4C542"), {
    iconUri: "file:///icon.png", symbol: "☀", backgroundColor: "#F4C542",
  });
  assert.equal(buildShareRequest(null, "", "#F4C542").symbol, "✦");
});

// ---------------------------------------------------------------- 0.2.0 additions
import {
  base64ToBytes, buildBackup, duplicateDesign, filterDesigns, mergeDesigns,
  normalizeHex, parseBackup, sanitizeDesigns, unusedImageUris,
} from "../designStore.ts";

test("normalizeHex accepts 3 and 6 digit colors with or without #", () => {
  assert.equal(normalizeHex("#f4c542"), "#F4C542");
  assert.equal(normalizeHex("abc"), "#AABBCC");
  assert.equal(normalizeHex("  #1F2A44 "), "#1F2A44");
  assert.equal(normalizeHex("#12"), null);
  assert.equal(normalizeHex("zzzzzz"), null);
  assert.equal(normalizeHex(""), null);
});

test("sanitizeDesigns drops invalid entries and duplicate ids instead of corrupting the library", () => {
  const result = sanitizeDesigns([original, null, 5, { id: "", title: "x" }, { id: "no-title" }, { ...original, title: "Dup" }]);
  assert.equal(result.length, 1);
  assert.equal(result[0].title, "First");
});

test("sanitizeDesigns repairs missing or invalid optional fields", () => {
  const [fixed] = sanitizeDesigns([{ id: "a", title: "T", background: "not-a-color", imageUri: "" }]);
  assert.equal(fixed.background, "#F4C542");
  assert.equal(fixed.imageUri, null);
  assert.equal(fixed.symbol, "✦");
  assert.equal(fixed.targetPackage, null);
  assert.equal(fixed.updatedAt, 0);
});

test("duplicateDesign inserts a copy right after the original and keeps titles within 40 chars", () => {
  const second = { ...original, id: "design-2", title: "Second" };
  const result = duplicateDesign([original, second], original.id, "copy-1", 99, "(copy)");
  assert.deepEqual(result.map((d) => d.id), ["design-1", "copy-1", "design-2"]);
  assert.equal(result[1].title, "First (copy)");
  assert.equal(result[1].updatedAt, 99);
  const long = { ...original, title: "x".repeat(40) };
  assert.ok(duplicateDesign([long], long.id, "c", 1, "(copy)")[1].title.length <= 40);
  assert.equal(duplicateDesign([original], "missing", "c", 1, "(copy)").length, 1);
});

test("mergeDesigns only adds designs that are not already present", () => {
  const second = { ...original, id: "design-2" };
  const merged = mergeDesigns([original], [{ ...original, title: "Changed" }, second]);
  assert.equal(merged.added, 1);
  assert.deepEqual(merged.designs.map((d) => d.id), ["design-1", "design-2"]);
  assert.equal(merged.designs[0].title, "First");
});

test("filterDesigns matches title and target app, case-insensitively", () => {
  const second = { ...original, id: "design-2", title: "Music", targetLabel: "Spotify" };
  assert.deepEqual(filterDesigns([original, second], "spot").map((d) => d.id), ["design-2"]);
  assert.deepEqual(filterDesigns([original, second], "FIRST").map((d) => d.id), ["design-1"]);
  assert.equal(filterDesigns([original, second], "  ").length, 2);
});

test("unusedImageUris only reports images no remaining design uses", () => {
  const a = { ...original, id: "a", imageUri: "file:///a.png" };
  const b = { ...original, id: "b", imageUri: "file:///a.png" };
  const c = { ...original, id: "c", imageUri: "file:///c.png" };
  assert.deepEqual(unusedImageUris([a, b, c], [b]), ["file:///c.png"]);
  assert.deepEqual(unusedImageUris([a, b], []), ["file:///a.png"]);
  assert.deepEqual(unusedImageUris([original], []), []);
});

test("base64ToBytes decodes like Buffer, including padding cases", () => {
  for (const text of ["", "a", "ab", "abc", "abcd", "hello world!", "\u0000\u00ff\u0010"]) {
    const bytes = Buffer.from(text, "latin1");
    assert.deepEqual([...base64ToBytes(bytes.toString("base64"))], [...bytes]);
  }
  assert.throws(() => base64ToBytes("abcde"), /length/);
});

test("v2 backup round-trips designs together with their images", () => {
  const withImage = { ...original, id: "img", imageUri: "file:///x.png" };
  const text = buildBackup([original, withImage], { img: { base64: "AAEC", ext: "png" } }, 123);
  const parsed = parseBackup(text);
  assert.deepEqual(parsed.designs.map((d) => d.id), ["design-1", "img"]);
  assert.deepEqual(parsed.images, { img: { base64: "AAEC", ext: "png" } });
  assert.equal(JSON.parse(text).version, 2);
});

test("old array backups still import (without images) and bad files are rejected", () => {
  const parsed = parseBackup(serializeDesigns([original]));
  assert.deepEqual(parsed.designs, [original]);
  assert.deepEqual(parsed.images, {});
  assert.throws(() => parseBackup('{"hello":1}'), /Unrecognized/);
  assert.throws(() => parseBackup("null"), /Unrecognized/);
  assert.throws(() => parseBackup("not json"), SyntaxError);
});

test("backup image entries with unsafe extensions or empty data are ignored", () => {
  const text = JSON.stringify({ version: 2, designs: [
    { ...original, id: "a", image: { base64: "AAEC", ext: "exe" } },
    { ...original, id: "b", image: { base64: "", ext: "png" } },
    { ...original, id: "c", image: { base64: "AAEC", ext: "JPG" } },
  ] });
  assert.deepEqual(parseBackup(text).images, { c: { base64: "AAEC", ext: "jpg" } });
});

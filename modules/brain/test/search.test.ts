import { test } from "node:test";
import assert from "node:assert/strict";
import { fold, search, searchTerms } from "../src/search.js";
import { brainStore } from "./fixtures.js";

const names = (store: ReturnType<typeof brainStore>["store"], ...q: string[]) => search(store.list(), searchTerms(...q)).map((h) => h.page.name);

test("a topic finds the fact filed on another page", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.create({ name: "Home", type: "place", body: "Wifi password is on the router label" }, "user");
  store.create({ name: "Car", body: "Blue Volvo" }, "user");
  assert.deepEqual(names(store, "wifi password"), ["Home"]);
});

test("search ignores case and accents", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.create({ name: "Mornings", body: "Coffee at the Café de Jaren" }, "user");
  assert.equal(fold("Café ÉCOLE"), "cafe ecole");
  assert.deepEqual(names(store, "CAFE"), ["Mornings"]);
});

test("short words and English and Dutch stopwords are dropped", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  assert.deepEqual(searchTerms("wat is de verjaardag van Anouk?"), ["verjaardag", "anouk"]);
  assert.deepEqual(searchTerms("what is the birthday of my sister"), ["birthday", "sister"]);
  store.create({ name: "Anouk", type: "person", body: "Verjaardagen: 3 november" }, "user");
  store.create({ name: "Notes", body: "wat van de het een" }, "user");
  // "verjaardag" also matches inside "verjaardagen".
  assert.deepEqual(names(store, "wat is de verjaardag van Anouk"), ["Anouk"]);
  assert.deepEqual(searchTerms("de het een van en"), []);
  assert.deepEqual(names(store, "de het een"), []);
});

test("a name or alias hit outranks a body mention; ties go to the most recently updated", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.create({ name: "Family", body: "Anouk is my sister" }, "user");
  store.create({ name: "Sister", aliases: ["Anouk"], type: "person" }, "user");
  assert.deepEqual(names(store, "anouk"), ["Sister", "Family"]);
  store.create({ name: "Trip A", body: "boat" }, "user");
  store.create({ name: "Trip B", body: "boat" }, "user");
  assert.deepEqual(names(store, "boat"), ["Trip B", "Trip A"]);
});

test("the profile and deleted pages are never hits", (t) => {
  const { store, close } = brainStore();
  t.after(close);
  store.save("profile", { ...store.profile(), body: "Likes boats" }, "user");
  const gone = store.create({ name: "Boat", body: "boats" }, "user");
  store.softDelete(gone.id, "user");
  assert.deepEqual(names(store, "boats"), []);
});

test("a query of 9 words uses the first 8", () => {
  const terms = searchTerms("alpha bravo charlie delta echo foxtrot golf hotel india");
  assert.deepEqual(terms, ["alpha", "bravo", "charlie", "delta", "echo", "foxtrot", "golf", "hotel"]);
  assert.deepEqual(searchTerms("alpha alpha ALPHA bravo"), ["alpha", "bravo"]);
});

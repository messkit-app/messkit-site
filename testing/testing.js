// The tester checklist page (messkit-app/messkit#535, part of #531).
//
// A tester on Messkit Dev opens https://messkit.app/testing/, gives the email
// they use for TestFlight and the build they are testing, and works through
// the checks they still owe. Every answer is saved the moment it is tapped.
//
// It talks to one edge function, tester-checks, on the dev Supabase project.
// Its contract is in the app repo, docs/spec/api-contracts.md → tester-checks:
//   POST {email}                                        → the checks owed
//   POST {email, check_id, upload: true, ext}            → a signed upload URL
//   POST {email, check_id, check_version, build, status, note?, screenshot_path?}
//
// The email lives in this phone's localStorage and is never put in a URL.
// The page holds no secrets.

"use strict";

// ---- Config: everything here is public by design. ------------------------
// The function runs with verify_jwt off, so it needs no key: no anon key is
// sent, and its CORS allows only the content-type header. If the gateway ever
// wants one, dev's anon (publishable) key goes here and in an `apikey` header,
// and the function's Access-Control-Allow-Headers must list `apikey`.
const CONFIG = {
  functionUrl: "https://jqggxppcqmnkgclawvqe.supabase.co/functions/v1/tester-checks",
  // connect-src in index.html's CSP must name this same host.
  supabaseOrigin: "https://jqggxppcqmnkgclawvqe.supabase.co",
  timeoutMs: 20000,
  // Screenshots are shrunk to this on their long side before upload.
  maxImageSide: 1600,
  jpegQuality: 0.85,
  // The qa-screenshots bucket's limit.
  maxUploadBytes: 5 * 1024 * 1024,
};

const KEY_EMAIL = "messkit.tester.email";
const KEY_BUILD = "messkit.tester.build";
const KEY_ANSWERED = "messkit.tester.answered";

const BUILD = /^[0-9A-Za-z.+_-]{1,64}$/;
const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

const STATUS_WORDS = { pass: "Pass", fail: "Fail", skip: "Couldn’t try" };

// ---- Storage --------------------------------------------------------------

const store = {
  get(key) {
    try { return localStorage.getItem(key); } catch { return null; }
  },
  set(key, value) {
    try { localStorage.setItem(key, value); } catch { /* private mode: this visit only */ }
  },
  remove(key) {
    try { localStorage.removeItem(key); } catch { /* nothing to do */ }
  },
};

// {build: {"<check id>@<version>": status}}: what was answered on this phone,
// so a check answered for this build stays answered on a reload. (The
// function keeps a failed check owed, so it would otherwise come back.)
function answeredFor(build) {
  try {
    const all = JSON.parse(store.get(KEY_ANSWERED) || "{}");
    return all && typeof all === "object" && all[build] && typeof all[build] === "object" ? all[build] : {};
  } catch {
    return {};
  }
}

function rememberAnswer(build, check, status) {
  let all = {};
  try { all = JSON.parse(store.get(KEY_ANSWERED) || "{}") || {}; } catch { all = {}; }
  // Only this build's answers matter; older builds' are dropped.
  const mine = typeof all[build] === "object" && all[build] !== null ? all[build] : {};
  mine[`${check.id}@${check.version}`] = status;
  store.set(KEY_ANSWERED, JSON.stringify({ [build]: mine }));
}

// "0.2.14 (52)", as TestFlight shows it, becomes "0.2.14+52", as pubspec has it.
function normaliseBuild(raw) {
  const s = String(raw || "").trim();
  const m = /^v?(\d+(?:\.\d+)*)\s*\(\s*(\d+)\s*\)$/.exec(s);
  const b = m ? `${m[1]}+${m[2]}` : s.replace(/\s+/g, "");
  return BUILD.test(b) ? b : null;
}

function displayBuild(b) {
  const m = /^(.+)\+(\d+)$/.exec(b);
  return m ? `${m[1]} (${m[2]})` : b;
}

// ---- The function ---------------------------------------------------------

class CallError extends Error {
  constructor(kind, http, body) {
    super(kind);
    this.kind = kind; // offline | network | timeout | bad_request | stale | forbidden | unavailable | server
    this.http = http;
    this.body = body;
  }
}

async function fetchWithTimeout(url, init) {
  if (!navigator.onLine) throw new CallError("offline", 0, null);
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), CONFIG.timeoutMs);
  try {
    return await fetch(url, { ...init, signal: ctl.signal, credentials: "omit", referrerPolicy: "no-referrer" });
  } catch (e) {
    if (ctl.signal.aborted) throw new CallError("timeout", 0, null);
    throw new CallError(navigator.onLine ? "network" : "offline", 0, null);
  } finally {
    clearTimeout(timer);
  }
}

async function call(body) {
  const res = await fetchWithTimeout(CONFIG.functionUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  let json = null;
  try { json = await res.json(); } catch { json = null; }
  if (res.ok) return json || {};
  const status = json && typeof json.status === "string" ? json.status : "";
  if (res.status === 400) throw new CallError("bad_request", 400, json);
  if (res.status === 409) throw new CallError("stale", 409, json);
  if (res.status === 403) throw new CallError(status === "unavailable" ? "unavailable" : "forbidden", 403, json);
  throw new CallError("server", res.status, json);
}

function sayError(e, what) {
  switch (e && e.kind) {
    case "offline": return `You’re offline, so ${what}. Try again when you’re back online.`;
    case "network": return `Couldn’t reach the server, so ${what}. Check your connection and try again.`;
    case "timeout": return `The server took too long to answer, so ${what}. Try again.`;
    case "forbidden": return `The server refused this page, so ${what}. Open it at messkit.app/testing.`;
    case "unavailable": return `This server isn’t the test one, so ${what}.`;
    case "bad_request": return `The server didn’t accept that, so ${what}. Reload the page and try again.`;
    case "server": return `The server had a problem, so ${what}. Try again in a minute.`;
    case "image": return e.message;
    default: return `Something went wrong, so ${what}. Try again.`;
  }
}

// ---- Screenshots ----------------------------------------------------------

async function decodeImage(file) {
  if (typeof createImageBitmap === "function") {
    try { return await createImageBitmap(file, { imageOrientation: "from-image" }); } catch { /* try an <img> */ }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = "async";
    img.src = url;
    await img.decode();
    return img;
  } finally {
    // The pixels are decoded; the object URL is no longer needed.
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

function imageError(message) {
  const e = new Error(message);
  e.kind = "image";
  return e;
}

// The image, shrunk to maxImageSide on its long side, as a JPEG.
async function shrink(file) {
  let source;
  try {
    source = await decodeImage(file);
  } catch {
    source = null;
  }
  if (source === null) {
    // A format this browser can't draw: send it as it is if the bucket takes it.
    const ext = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/heic": "heic" }[file.type];
    if (ext && file.size <= CONFIG.maxUploadBytes) return { blob: file, ext, type: file.type };
    throw imageError("This browser couldn’t read that image. Try a screenshot (PNG or JPEG) instead.");
  }
  const w = source.width || source.naturalWidth;
  const h = source.height || source.naturalHeight;
  const scale = Math.min(1, CONFIG.maxImageSide / Math.max(w, h));
  const cw = Math.max(1, Math.round(w * scale));
  const ch = Math.max(1, Math.round(h * scale));
  const canvas = document.createElement("canvas");
  canvas.width = cw;
  canvas.height = ch;
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff"; // a transparent PNG gets white, not black, as a JPEG
  ctx.fillRect(0, 0, cw, ch);
  ctx.drawImage(source, 0, 0, cw, ch);
  if (typeof source.close === "function") source.close();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", CONFIG.jpegQuality));
  if (!blob) throw imageError("Couldn’t shrink that image. Try another one.");
  if (blob.size > CONFIG.maxUploadBytes) throw imageError("That image is too large to send, even shrunk.");
  return { blob, ext: "jpg", type: "image/jpeg" };
}

async function uploadScreenshot(email, checkId, image) {
  const signed = await call({ email, check_id: checkId, upload: true, ext: image.ext });
  if (typeof signed.signed_url !== "string" || typeof signed.path !== "string") {
    throw new CallError("server", 200, signed);
  }
  // Only ever send a tester's image to the project's own storage.
  if (new URL(signed.signed_url).origin !== CONFIG.supabaseOrigin) throw new CallError("server", 200, null);
  const res = await fetchWithTimeout(signed.signed_url, {
    method: "PUT",
    headers: { "Content-Type": image.type, "x-upsert": "false" },
    body: image.blob,
  });
  if (!res.ok) throw new CallError(res.status >= 500 ? "server" : "bad_request", res.status, null);
  return signed.path;
}

// ---- The page -------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const state = {
  email: null,
  build: null,
  name: null,
  checks: [], // what the function says is owed
  cards: new Map(), // check id → card
};

function show(id, on) { $(id).hidden = !on; }

function showOnly(ids) {
  for (const id of ["signin", "loading", "load-error", "done"]) show(id, ids.includes(id));
  if (!ids.includes("checks")) $("checks").replaceChildren();
}

function setWho() {
  if (!state.email) { show("who", false); return; }
  $("who-text").textContent = `${state.email} · build ${displayBuild(state.build)}`;
  show("who", true);
}

function signIn(message) {
  state.name = null;
  $("title").textContent = "Tester checks";
  $("lede").textContent = "For people testing Messkit Dev through TestFlight.";
  show("lede", true);
  show("who", false);
  showOnly(["signin"]);
  $("email").value = state.email || store.get(KEY_EMAIL) || "";
  $("build").value = state.build ? displayBuild(state.build) : "";
  const err = $("signin-error");
  err.textContent = message || "";
  err.hidden = !message;
  $("signin-go").disabled = false;
  ($("email").value ? $("build") : $("email")).focus();
}

function onSignIn(ev) {
  ev.preventDefault();
  const email = $("email").value.trim().toLowerCase();
  const build = normaliseBuild($("build").value);
  if (!EMAIL.test(email)) return signIn("That doesn’t look like an email address.");
  if (!build) {
    state.email = email;
    return signIn("Type the build as TestFlight shows it, for example 0.2.14 (52).");
  }
  state.email = email;
  state.build = build;
  store.set(KEY_EMAIL, email);
  store.set(KEY_BUILD, build);
  load();
}

function notYou() {
  store.remove(KEY_EMAIL);
  store.remove(KEY_ANSWERED);
  state.email = null;
  signIn("");
  $("email").value = "";
  $("email").focus();
}

async function load(notice) {
  showOnly(["loading"]);
  setWho();
  try {
    const res = await call({ email: state.email });
    state.name = typeof res.name === "string" && res.name.trim() ? res.name.trim() : null;
    state.checks = Array.isArray(res.checks) ? res.checks : [];
    render(notice);
  } catch (e) {
    if (e.kind === "bad_request") {
      // Unknown, removed or malformed: the function doesn't say which.
      store.remove(KEY_EMAIL);
      return signIn("That email isn’t on the tester list. Use the one TestFlight invited, or ask whoever invited you to add it.");
    }
    showOnly(["load-error"]);
    $("load-error-text").textContent = sayError(e, "your checks didn’t load");
    $("load-retry").focus();
  }
}

function render(notice) {
  const answered = answeredFor(state.build);
  const owed = state.checks.filter((c) => !answered[`${c.id}@${c.version}`]);
  state.cards.clear();
  const list = $("checks");
  list.replaceChildren(...owed.map((c) => buildCard(c)));
  showOnly(owed.length === 0 ? ["done", "checks"] : ["checks"]);
  const hi = state.name ? `Hi ${state.name}` : "Hi";
  $("title").textContent = owed.length === 0
    ? `${hi}: nothing left for this build`
    : `${hi}: ${owed.length} ${owed.length === 1 ? "check" : "checks"} for this build`;
  $("lede").textContent = notice || "Tap Pass, Fail or Couldn’t try on each check; it’s saved straight away. Add a note or a screenshot first if something’s wrong.";
  show("lede", owed.length > 0 || Boolean(notice));
  setWho();
}

function remaining() {
  let n = 0;
  for (const card of state.cards.values()) if (!card.saved) n += 1;
  return n;
}

function updateProgress() {
  const n = remaining();
  const hi = state.name ? `Hi ${state.name}` : "Hi";
  if (n === 0) {
    $("title").textContent = `${hi}: all done`;
    show("lede", false);
    show("done", true);
    $("done").scrollIntoView({ behavior: "smooth", block: "start" });
  } else {
    $("title").textContent = `${hi}: ${n} ${n === 1 ? "check" : "checks"} left for this build`;
    show("done", false);
  }
}

let cardSeq = 0;

function buildCard(check) {
  const el = document.getElementById("check-template").content.firstElementChild.cloneNode(true);
  const seq = ++cardSeq;
  el.dataset.check = check.id;
  el.querySelector(".area").textContent = check.area;
  el.querySelector(".steps").textContent = check.steps;
  el.querySelector(".expected").textContent = check.expected;

  const note = el.querySelector(".note");
  note.id = `note-${seq}`;
  el.querySelector(".note-label").htmlFor = note.id;

  const card = {
    check,
    el,
    saved: null, // the status saved for it, once one is
    shotPath: null,
    shotUrl: null,
    busy: false,
    retry: null,
  };
  state.cards.set(check.id, card);

  const input = el.querySelector(".shot-input");
  el.querySelector(".shot-add").addEventListener("click", () => input.click());
  input.addEventListener("change", () => {
    const file = input.files && input.files[0];
    input.value = "";
    if (file) addScreenshot(card, file);
  });
  el.querySelector(".shot-remove").addEventListener("click", () => removeScreenshot(card));
  for (const b of el.querySelectorAll(".answer")) {
    b.addEventListener("click", () => answer(card, b.dataset.status));
  }
  el.querySelector(".card-retry").addEventListener("click", () => { if (card.retry) card.retry(); });
  return el;
}

function setBusy(card, busy) {
  card.busy = busy;
  for (const b of card.el.querySelectorAll("button, textarea")) b.disabled = busy;
}

function cardError(card, message, retry) {
  const box = card.el.querySelector(".card-error");
  card.retry = retry;
  if (!message) { box.hidden = true; return; }
  card.el.querySelector(".card-error-text").textContent = message;
  box.hidden = false;
}

function removeScreenshot(card) {
  if (card.shotUrl) URL.revokeObjectURL(card.shotUrl);
  card.shotPath = null;
  card.shotUrl = null;
  card.el.querySelector(".shot-preview").hidden = true;
  card.el.querySelector(".shot-add").hidden = false;
  cardError(card, "");
}

async function addScreenshot(card, file) {
  const el = card.el;
  if (card.shotUrl) URL.revokeObjectURL(card.shotUrl);
  card.shotPath = null;
  card.shotUrl = null;
  cardError(card, "");
  setBusy(card, true);
  const status = el.querySelector(".shot-status");
  status.textContent = "Getting it ready…";
  el.querySelector(".shot-add").hidden = true;
  el.querySelector(".shot-preview").hidden = false;
  const img = el.querySelector(".shot-preview img");
  img.removeAttribute("src");
  try {
    const image = await shrink(file);
    card.shotUrl = URL.createObjectURL(image.blob);
    img.src = card.shotUrl;
    status.textContent = "Sending…";
    card.shotPath = await uploadScreenshot(state.email, card.check.id, image);
    status.textContent = card.saved ? "Screenshot sent. Tap an answer again to attach it." : "Screenshot attached.";
  } catch (e) {
    status.textContent = "Not sent.";
    cardError(card, sayError(e, "the screenshot wasn’t sent"), () => addScreenshot(card, file));
  } finally {
    setBusy(card, false);
  }
}

async function answer(card, status) {
  if (card.busy) return;
  const el = card.el;
  cardError(card, "");
  setBusy(card, true);
  const saved = el.querySelector(".saved");
  saved.hidden = false;
  saved.textContent = "Saving…";
  const body = {
    email: state.email,
    check_id: card.check.id,
    check_version: card.check.version,
    build: state.build,
    status,
  };
  const note = el.querySelector(".note").value.trim();
  if (note) body.note = note;
  if (card.shotPath) body.screenshot_path = card.shotPath;
  try {
    await call(body);
    card.saved = status;
    rememberAnswer(state.build, card.check, status);
    for (const b of el.querySelectorAll(".answer")) {
      b.classList.toggle("chosen", b.dataset.status === status);
      b.setAttribute("aria-pressed", String(b.dataset.status === status));
    }
    el.classList.add("answered");
    const extras = [note ? "your note" : "", card.shotPath ? "the screenshot" : ""].filter(Boolean).join(" and ");
    saved.textContent = `Saved: ${STATUS_WORDS[status]}${extras ? `, with ${extras}` : ""}.`;
    setBusy(card, false);
    updateProgress();
  } catch (e) {
    setBusy(card, false);
    if (e.kind === "stale") {
      // The check changed since the page loaded: show its new version.
      return load("One check was changed while you had this page open, so the list has been reloaded. Please look at it again.");
    }
    saved.hidden = !card.saved;
    if (card.saved) saved.textContent = `Saved earlier: ${STATUS_WORDS[card.saved]}.`;
    cardError(card, sayError(e, "your answer wasn’t saved"), () => answer(card, status));
  }
}

function onlineChanged() {
  show("offline", !navigator.onLine);
}

function start() {
  $("signin").addEventListener("submit", onSignIn);
  $("not-you").addEventListener("click", notYou);
  $("change-build").addEventListener("click", () => {
    signIn("");
    $("build").select();
  });
  $("load-retry").addEventListener("click", () => load());
  window.addEventListener("online", onlineChanged);
  window.addEventListener("offline", onlineChanged);
  onlineChanged();

  // A link may carry the build (?build=0.2.14+52), never the email.
  const params = new URLSearchParams(location.search);
  const fromLink = normaliseBuild(params.get("build"));
  if (fromLink) store.set(KEY_BUILD, fromLink);
  if (params.has("email")) {
    // Not accepted from a URL; drop it from the address bar and history.
    params.delete("email");
    const q = params.toString();
    history.replaceState(null, "", location.pathname + (q ? `?${q}` : "") + location.hash);
  }

  state.email = store.get(KEY_EMAIL);
  state.build = normaliseBuild(store.get(KEY_BUILD));
  if (state.email && state.build) load();
  else signIn("");
}

start();

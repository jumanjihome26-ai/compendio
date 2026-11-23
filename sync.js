/* =====================================================================
   sync.js · V8 · SINCRONIZACIÓN CON DROPBOX (carpeta propia de la app)
   Parte 1 (núcleo, sin red): migración del JSON, marcas de modificación,
           registro de borrados y fusión de cambios.
   Parte 2 (Dropbox): conexión OAuth (PKCE, sin secreto), descarga/subida con
           control de versión (rev), copias en Dropbox y estado.
   Parte 3 (interfaz): botón «Sincronizar» y ventana de Dropbox.
   Las listas siguen guardándose en local (carpeta en Windows, navegador en
   móvil/iPad). Dropbox es el punto de encuentro, no la fuente de trabajo:
   sin conexión todo funciona igual y se sincroniza al recuperarla.
   ===================================================================== */
(function (root) {
  "use strict";
  const EPOCH = "1970-01-01T00:00:00.000Z";   // marca de los datos anteriores a V8
  const TOMB_DAYS = 90;                       // los borrados se recuerdan 90 días
  const APP_KEY = "d9qdjwitsfvtlko";          // identificador público de la app de Dropbox
  const FILE_PATH = "/Compendio-del-Baluarte.json";
  const norm = v => String(v || "").trim().normalize("NFC").toLocaleLowerCase("es");
  const clone = o => JSON.parse(JSON.stringify(o));
  let nowFn = () => new Date().toISOString();
  const nowIso = () => nowFn();

  /* ---------------------------------------------------------------
     PARTE 1 · NÚCLEO
     --------------------------------------------------------------- */
  const hList = l => JSON.stringify([l.name || "", l.description || "", l.illustration || ""]);
  const hTask = t => JSON.stringify([t.text || "", !!t.done]);
  const hTpl = t => JSON.stringify([t.name || "", t.description || "", t.illustration || "", (t.tasks || []).map(x => [x.id, x.text || "", !!x.done])]);

  // Migración compatible: solo AÑADE campos (updatedAt, deleted, schema). No quita ni cambia nada más.
  function ensureStamps(d) {
    let changed = false;
    if (!Array.isArray(d.deleted)) { d.deleted = []; changed = true; }
    for (const l of d.lists || []) {
      if (!l.updatedAt) { l.updatedAt = EPOCH; changed = true; }
      for (const t of l.tasks || []) if (!t.updatedAt) { t.updatedAt = EPOCH; changed = true; }
    }
    for (const t of d.templates || []) if (!t.updatedAt) { t.updatedAt = EPOCH; changed = true; }
    if (d.schema !== 2) { d.schema = 2; changed = true; }
    return changed;
  }

  function makeBaseline(d) {
    const b = { lists: new Map(), templates: new Map() };
    for (const l of d.lists || []) b.lists.set(l.id, { h: hList(l), name: norm(l.name), tasks: new Map((l.tasks || []).map(t => [t.id, hTask(t)])) });
    for (const t of d.templates || []) b.templates.set(t.id, { h: hTpl(t), name: norm(t.name) });
    return b;
  }

  // Compara los datos actuales con la «foto» anterior: sella lo modificado y anota lo borrado.
  // Así no hace falta tocar cada punto del programa que modifica listas o tareas.
  function stampChanges(d, base) {
    if (!base) return makeBaseline(d);
    const now = nowIso();
    if (!Array.isArray(d.deleted)) d.deleted = [];
    const tomb = d.deleted;
    const setTomb = (type, id, extra) => {
      for (let i = tomb.length - 1; i >= 0; i--) if (tomb[i].type === type && tomb[i].id === id) tomb.splice(i, 1);
      tomb.push(Object.assign({ type, id, deletedAt: now }, extra || {}));
    };
    const clearTomb = (type, id) => { for (let i = tomb.length - 1; i >= 0; i--) if (tomb[i].type === type && tomb[i].id === id) tomb.splice(i, 1); };
    const lists = d.lists || [];
    const curIds = new Set(lists.map(l => l.id));
    const curNames = new Set(lists.map(l => norm(l.name)));
    for (const l of lists) {
      const b = base.lists.get(l.id);
      if (!b) { l.updatedAt = now; for (const t of l.tasks || []) t.updatedAt = now; clearTomb("list", l.id); continue; }
      if (hList(l) !== b.h) l.updatedAt = now;
      const seen = new Set();
      for (const t of l.tasks || []) {
        seen.add(t.id);
        const bh = b.tasks.get(t.id);
        if (bh === undefined || bh !== hTask(t)) { t.updatedAt = now; if (bh === undefined) clearTomb("task", t.id); }
      }
      for (const tid of b.tasks.keys()) if (!seen.has(tid)) setTomb("task", tid, { listId: l.id });
    }
    for (const [id, b] of base.lists) {
      if (curIds.has(id)) continue;
      if (!curNames.has(b.name)) setTomb("list", id, { name: b.name });
      else for (const tid of b.tasks.keys()) setTomb("task", tid, { listId: id });   // sustitución (p. ej. importar): la lista sigue, pero sus tareas anteriores quedan como borradas
    }
    const tpls = d.templates || [];
    const curT = new Set(tpls.map(t => t.id)), curTN = new Set(tpls.map(t => norm(t.name)));
    for (const t of tpls) {
      const b = base.templates.get(t.id);
      if (!b || hTpl(t) !== b.h) { t.updatedAt = now; if (!b) clearTomb("template", t.id); }
    }
    for (const [id, b] of base.templates) if (!curT.has(id) && !curTN.has(b.name)) setTomb("template", id, { name: b.name });
    return makeBaseline(d);
  }

  const effTime = l => { let m = l.updatedAt || EPOCH; for (const t of l.tasks || []) if ((t.updatedAt || EPOCH) > m) m = t.updatedAt; return m; };
  const canon = d => JSON.stringify([d.lists, d.templates || [], (d.deleted || []).slice().sort((a, b) => (a.type + a.id).localeCompare(b.type + b.id))]);

  // Fusión de dos copias de los datos. Gana el cambio MÁS RECIENTE de cada tarea / lista / plantilla.
  // En empate gana `remote` (la copia de Dropbox). Un borrado solo gana si es más reciente que el elemento.
  function mergeData(local, remote) {
    const stats = { listsAdded: 0, listsUpdated: 0, listsRemoved: 0, tasksAdded: 0, tasksUpdated: 0, tasksRemoved: 0, templatesAdded: 0, templatesUpdated: 0, templatesRemoved: 0 };
    const limit = new Date(Date.now() - TOMB_DAYS * 86400000).toISOString();
    const tombs = new Map();
    for (const t of [].concat(local.deleted || [], remote.deleted || [])) {
      const k = t.type + ":" + t.id, o = tombs.get(k);
      if (!o || t.deletedAt > o.deletedAt) tombs.set(k, t);
    }
    for (const [k, t] of tombs) if (t.deletedAt < limit) tombs.delete(k);
    // Una lista editada DESPUÉS de que otro dispositivo la borrase se conserva; se sella con la fecha de esa actividad
    // para que, si luego se vacían sus tareas, el borrado antiguo no vuelva a eliminarla.
    const revive = (list, eff, ...ids) => { if (ids.some(i => tombs.has("list:" + i)) && eff > (list.updatedAt || EPOCH)) list.updatedAt = eff; };
    const killed = (type, id, time) => { const t = tombs.get(type + ":" + id); return !!t && t.deletedAt > time; };

    const L = clone(local.lists || []), R = clone(remote.lists || []);
    const usedR = new Set(), pairs = [], rById = new Map(R.map(x => [x.id, x]));
    for (const l of L) { const r = rById.get(l.id); if (r) { pairs.push([l, r, false]); usedR.add(r); } }
    const paired = new Set(pairs.map(p => p[0]));
    const rByName = new Map();
    for (const r of R) if (!usedR.has(r)) { const k = norm(r.name); if (k && !rByName.has(k)) rByName.set(k, r); }
    for (const l of L) {
      if (paired.has(l)) continue;
      const k = norm(l.name), r = k && rByName.get(k);
      if (r && !usedR.has(r)) { pairs.push([l, r, true]); usedR.add(r); paired.add(l); rByName.delete(k); }
    }
    const merged = [];
    for (const [l, r, byName] of pairs) {
      const rWins = (r.updatedAt || EPOCH) >= (l.updatedAt || EPOCH);
      const base = rWins ? r : l, other = rWins ? l : r;
      const out = Object.assign({}, base);
      if (byName) out.id = [l.id, r.id].sort()[0];
      if (l.createdAt && r.createdAt) out.createdAt = l.createdAt < r.createdAt ? l.createdAt : r.createdAt;
      out.updatedAt = base.updatedAt || EPOCH;
      const tasks = mergeTasks(l.tasks || [], r.tasks || [], byName, killed, stats);
      out.tasks = tasks;
      const eff = effTime(out);
      if (killed("list", l.id, eff) || killed("list", r.id, eff)) { stats.listsRemoved++; continue; }
      revive(out, eff, l.id, r.id);
      if (rWins && hList(r) !== hList(l)) stats.listsUpdated++;
      out.__o = R.indexOf(r); merged.push(out);
    }
    const prune = list => { const keep = (list.tasks || []).filter(t => !killed("task", t.id, t.updatedAt || EPOCH)); stats.tasksRemoved += (list.tasks || []).length - keep.length; list.tasks = keep; };
    L.forEach((l, i) => { if (!paired.has(l)) {
      prune(l); const eff = effTime(l);
      if (killed("list", l.id, eff)) stats.listsRemoved++; else { revive(l, eff, l.id); l.__o = 1e6 + i; merged.push(l); }
    } });
    R.forEach((r, i) => { if (!usedR.has(r)) {
      prune(r); const eff = effTime(r);
      if (killed("list", r.id, eff)) { stats.listsRemoved++; return; }
      revive(r, eff, r.id); r.__o = i; merged.push(r); stats.listsAdded++;
    } });
    merged.sort((a, b) => a.__o - b.__o); merged.forEach(x => { delete x.__o; });

    // plantillas
    const LT = clone(local.templates || []), RT = clone(remote.templates || []), mt = [];
    const rtId = new Map(RT.map(x => [x.id, x])), usedRT = new Set(), tp = [];
    for (const t of LT) { const r = rtId.get(t.id); if (r) { tp.push([t, r]); usedRT.add(r); } }
    const pl = new Set(tp.map(p => p[0])), rtName = new Map();
    for (const r of RT) if (!usedRT.has(r)) { const k = norm(r.name); if (k && !rtName.has(k)) rtName.set(k, r); }
    for (const t of LT) { if (pl.has(t)) continue; const k = norm(t.name), r = k && rtName.get(k); if (r && !usedRT.has(r)) { tp.push([t, r]); usedRT.add(r); pl.add(t); rtName.delete(k); } }
    for (const [t, r] of tp) {
      const w = (r.updatedAt || EPOCH) >= (t.updatedAt || EPOCH) ? r : t;
      const o = Object.assign({}, w); if (t.id !== r.id) o.id = [t.id, r.id].sort()[0];
      if (killed("template", t.id, o.updatedAt || EPOCH) || killed("template", r.id, o.updatedAt || EPOCH)) { stats.templatesRemoved++; continue; }
      if (w === r && hTpl(r) !== hTpl(t)) stats.templatesUpdated++;
      o.__o = RT.indexOf(r); mt.push(o);
    }
    LT.forEach((t, i) => { if (!pl.has(t)) { if (killed("template", t.id, t.updatedAt || EPOCH)) stats.templatesRemoved++; else { t.__o = 1e6 + i; mt.push(t); } } });
    RT.forEach((r, i) => { if (!usedRT.has(r)) { if (killed("template", r.id, r.updatedAt || EPOCH)) stats.templatesRemoved++; else { r.__o = i; mt.push(r); stats.templatesAdded++; } } });
    mt.sort((a, b) => a.__o - b.__o); mt.forEach(x => { delete x.__o; });

    const data = { format: "compendio-baluarte", version: 1, schema: 2, exportedAt: nowIso(), lists: merged, templates: mt, deleted: [...tombs.values()] };
    return { data, stats };
  }

  function mergeTasks(lt, rt, byName, killed, stats) {
    // lt = tareas locales, rt = tareas remotas. El orden resultante es el de Dropbox y, al final, las tareas que solo existen en local.
    const rid = new Map(rt.map(t => [t.id, t])), usedR = new Set(), pairOfL = new Map();
    for (const t of lt) { const x = rid.get(t.id); if (x) { pairOfL.set(t, x); usedR.add(x); } }
    if (byName) {   // listas creadas por separado con el mismo nombre: se emparejan también las tareas con el mismo texto
      const rText = new Map();
      for (const x of rt) if (!usedR.has(x)) { const k = norm(x.text); if (k && !rText.has(k)) rText.set(k, x); }
      for (const t of lt) { if (pairOfL.has(t)) continue; const k = norm(t.text), x = k && rText.get(k); if (x && !usedR.has(x)) { pairOfL.set(t, x); usedR.add(x); rText.delete(k); } }
    }
    const pairOfR = new Map([...pairOfL].map(([t, x]) => [x, t]));
    const out = [], emitted = new Set();
    const emit = (item, isFromRemote) => {
      if (emitted.has(item)) return; emitted.add(item);
      const mate = isFromRemote ? pairOfR.get(item) : pairOfL.get(item);
      if (mate) {
        emitted.add(mate);
        const l = isFromRemote ? mate : item, r = isFromRemote ? item : mate;
        const w = (r.updatedAt || EPOCH) >= (l.updatedAt || EPOCH) ? r : l;
        if (killed("task", l.id, w.updatedAt || EPOCH) || killed("task", r.id, w.updatedAt || EPOCH)) { stats.tasksRemoved++; return; }
        if (w === r && hTask(r) !== hTask(l)) stats.tasksUpdated++;
        out.push(Object.assign({}, w));
        return;
      }
      if (killed("task", item.id, item.updatedAt || EPOCH)) { stats.tasksRemoved++; return; }
      if (isFromRemote) stats.tasksAdded++;
      out.push(item);
    };
    for (const t of rt) emit(t, true);
    for (const t of lt) emit(t, false);
    return out;
  }

  /* ---------------------------------------------------------------
     PARTE 2 · DROPBOX
     --------------------------------------------------------------- */
  let host = null, auth = null, ignoredList = [], state = {}, running = null, rerun = false, timer = null, kvdb = null, listeners = [];
  const status = { connected: false, busy: false, error: null, pending: false, lastSyncAt: null, lastResult: null };

  function kvOpen() {
    return new Promise((res, rej) => {
      if (kvdb) return res(kvdb);
      const q = indexedDB.open("CompendioSync", 1);
      q.onupgradeneeded = () => q.result.createObjectStore("kv");
      q.onsuccess = () => { kvdb = q.result; res(kvdb); };
      q.onerror = () => rej(q.error);
    });
  }
  async function kvOp(mode, fn) {
    const db = await kvOpen();
    return new Promise((res, rej) => {
      const tx = db.transaction("kv", mode); let r;
      try { r = fn(tx.objectStore("kv")); } catch (e) { rej(e); return; }
      tx.oncomplete = () => res(r ? r.result : undefined); tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error);
    });
  }
  const kvGet = k => kvOp("readonly", s => s.get(k));
  const kvSet = (k, v) => kvOp("readwrite", s => s.put(v, k));
  const kvDel = k => kvOp("readwrite", s => s.delete(k));
  const stKey = () => "state:" + (host && host.instance || "x");
  const saveState = () => kvSet(stKey(), state).catch(() => {});
  const notify = () => listeners.forEach(f => { try { f(status); } catch (e) { /* noop */ } });
  function setStatus(p) { Object.assign(status, p); notify(); }
  const mkErr = (code, message, extra) => Object.assign(new Error(message || code), { code }, extra || {});

  const b64url = buf => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  async function newPkce() {
    const rnd = crypto.getRandomValues(new Uint8Array(48));
    const verifier = b64url(rnd);
    const challenge = b64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
    const url = "https://www.dropbox.com/oauth2/authorize?client_id=" + APP_KEY + "&response_type=code&code_challenge=" + challenge + "&code_challenge_method=S256&token_access_type=offline";
    await kvSet("pkce", { verifier, challenge, url, createdAt: Date.now() });   // se guarda: si iOS recarga la app mientras vas a Dropbox, el código sigue valiendo
    return { verifier, challenge, url };
  }
  async function tokenRequest(params) {
    let res;
    try { res = await fetch("https://api.dropboxapi.com/oauth2/token", { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(params).toString() }); }
    catch (e) { throw mkErr("network", "No se pudo contactar con Dropbox (¿sin conexión, o el navegador bloquea la conexión?)."); }
    let j = {}; try { j = await res.json(); } catch (e) { /* noop */ }
    if (!res.ok) throw mkErr(j.error === "invalid_grant" ? "invalid_grant" : "auth", (j.error_description || j.error || ("Error " + res.status)));
    return j;
  }
  function storeTokens(j, prev) {
    auth = { access_token: j.access_token, refresh_token: j.refresh_token || (prev && prev.refresh_token), expires_at: Date.now() + Math.max(60, (j.expires_in || 14400) - 120) * 1000 };
    return kvSet("auth", auth);
  }
  let pk = null;   // la clave PKCE se genera UNA vez por intento y se reutiliza aunque la ventana se repinte
  async function getPkce() {
    if (!pk) { const saved = await kvGet("pkce").catch(() => null); if (saved && saved.url && Date.now() - saved.createdAt < 9 * 60 * 1000) pk = { verifier: saved.verifier, challenge: saved.challenge, url: saved.url, t: saved.createdAt }; }
    if (!pk || Date.now() - pk.t > 9 * 60 * 1000) pk = Object.assign(await newPkce(), { t: Date.now() });
    return pk;
  }
  async function connectWithCode(code) {
    const p = await kvGet("pkce");
    if (!p) throw mkErr("pkce", "Vuelve a pulsar «Abrir Dropbox» y repite el proceso.");
    const j = await tokenRequest({ code: String(code || "").trim(), grant_type: "authorization_code", code_verifier: p.verifier, client_id: APP_KEY });
    if (!j.refresh_token) throw mkErr("auth", "Dropbox no ha devuelto una conexión duradera. Comprueba que la app tiene los permisos activados y vuelve a intentarlo.");
    await storeTokens(j); await kvDel("pkce"); pk = null;
    state = {}; await saveState();
    setStatus({ connected: true, error: null });
  }
  async function disconnect() { auth = null; await kvDel("auth"); state = {}; await kvDel(stKey()); setStatus({ connected: false, error: null, pending: false, lastSyncAt: null, lastResult: null }); }
  async function accessToken() {
    if (!auth) throw mkErr("no-auth", "Dropbox no está conectado en este dispositivo.");
    if (auth.expires_at > Date.now()) return auth.access_token;
    try { const j = await tokenRequest({ grant_type: "refresh_token", refresh_token: auth.refresh_token, client_id: APP_KEY }); await storeTokens(j, auth); }
    catch (e) { if (e.code === "invalid_grant") { await disconnect(); throw mkErr("reconnect", "La conexión con Dropbox ha caducado o se ha revocado. Vuelve a conectar."); } throw e; }
    return auth.access_token;
  }
  async function dbxFetch(url, init, retry) {
    init.headers = Object.assign({}, init.headers || {}, { Authorization: "Bearer " + await accessToken() });
    let res;
    try { res = await fetch(url, init); } catch (e) { throw mkErr("network", "No se pudo contactar con Dropbox (¿sin conexión, o el navegador bloquea la conexión?)."); }
    if (res.status === 401 && !retry) { auth.expires_at = 0; return dbxFetch(url, init, true); }
    if (res.ok) return res;
    let body = {}; try { body = await res.json(); } catch (e) { /* noop */ }
    const summary = String(body.error_summary || "");
    if (res.status === 409 && /path\/not_found|not_found/.test(summary)) throw mkErr("not_found", summary);
    if (res.status === 409 && /conflict/.test(summary)) throw mkErr("conflict", summary);
    if (/missing_scope/.test(summary) || (res.status === 401 && body.error && /scope/.test(JSON.stringify(body.error)))) throw mkErr("scope", "Faltan permisos en la app de Dropbox (files.content.read/write y files.metadata.read/write).");
    if (res.status === 429) throw mkErr("rate", "Dropbox pide esperar un momento. Se reintentará.");
    throw mkErr("api", "Dropbox respondió con un error (" + res.status + "): " + (summary || "sin detalles"));
  }
  const argHeader = o => JSON.stringify(o).replace(/[\u007f-\uffff]/g, c => "\\u" + ("0000" + c.charCodeAt(0).toString(16)).slice(-4));
  async function remoteGet() {
    let meta;
    try {
      const r = await dbxFetch("https://api.dropboxapi.com/2/files/get_metadata", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: FILE_PATH }) });
      meta = await r.json();
    } catch (e) { if (e.code === "not_found") return null; throw e; }
    const r2 = await dbxFetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { "Dropbox-API-Arg": argHeader({ path: "rev:" + meta.rev }) } });
    return { text: await r2.text(), rev: meta.rev };
  }
  async function remotePut(text, rev, path, autorename) {
    const arg = { path: path || FILE_PATH, mode: rev ? { ".tag": "update", "update": rev } : { ".tag": "add" }, autorename: !!autorename, mute: true };
    const r = await dbxFetch("https://content.dropboxapi.com/2/files/upload", { method: "POST", headers: { "Dropbox-API-Arg": argHeader(arg), "Content-Type": "application/octet-stream" }, body: new Blob([text], { type: "application/octet-stream" }) });
    return await r.json();
  }
  /* ---------- Ilustraciones (V8.1): carpeta /ILUSTRACIONES de la app en Dropbox ----------
     Se SUBE lo que este dispositivo tiene y Dropbox no, y se BAJA lo que Dropbox tiene y este dispositivo no.
     Nunca se sobrescribe ni se borra ninguna imagen (ni local ni en Dropbox). */
  const IMG_OK = /\.(png|jpe?g|webp|gif|svg|avif)$/i;
  const safeName = n => typeof n === "string" && n.length > 0 && n.length < 120 && IMG_OK.test(n) && !/[\\/]/.test(n);
  const MIME = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp", gif: "image/gif", svg: "image/svg+xml", avif: "image/avif" };
  const mimeOf = n => MIME[(n.split(".").pop() || "").toLowerCase()] || "application/octet-stream";
  async function listRemoteImages() {
    const out = new Map();
    let r;
    try { r = await dbxFetch("https://api.dropboxapi.com/2/files/list_folder", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/ILUSTRACIONES", recursive: false, limit: 2000 }) }); }
    catch (e) { if (e.code === "not_found") return out; throw e; }
    let j = await r.json();
    for (;;) {
      for (const e of j.entries || []) if (e[".tag"] === "file" && safeName(e.name)) out.set(e.name, { size: e.size || 0 });
      if (!j.has_more) break;
      j = await (await dbxFetch("https://api.dropboxapi.com/2/files/list_folder/continue", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ cursor: j.cursor }) })).json();
    }
    return out;
  }
  async function syncImages(opts) {
    const im = host.images; if (!im) return null;
    const missingRefs = () => { const have = im.names(); return im.referenced().filter(n => !have.has(n)); };
    await im.refresh();
    const need = !opts.auto || state.imagesDirty || missingRefs().length > 0 || !state.imagesAt || Date.now() - state.imagesAt > 10 * 60 * 1000;
    if (!need) return null;
    const remote = await listRemoteImages();
    const have = im.names(), ignored = new Set(ignoredList), LIMIT = 40;
    let sent = 0, got = 0, errors = 0, left = 0;
    for (const n of im.candidates()) {                       // subir
      if (remote.has(n) || !safeName(n)) continue;
      if (sent >= LIMIT) { left++; continue; }
      try {
        const f = await im.read(n); if (!f) continue;
        await remotePut(f.data, null, "/ILUSTRACIONES/" + n, false); sent++; remote.set(n, {});
      } catch (e) { if (e.code === "network" || e.code === "reconnect") throw e; if (e.code !== "conflict") errors++; }
    }
    const refs = new Set(im.referenced());                    // bajar (primero las que usan las listas)
    const todo = [...remote.keys()].filter(n => !have.has(n) && !ignored.has(n)).sort((a, b) => (refs.has(b) ? 1 : 0) - (refs.has(a) ? 1 : 0));
    for (const n of todo) {
      if (got >= LIMIT) { left++; continue; }
      try {
        const r = await dbxFetch("https://content.dropboxapi.com/2/files/download", { method: "POST", headers: { "Dropbox-API-Arg": argHeader({ path: "/ILUSTRACIONES/" + n }) } });
        const buf = await r.arrayBuffer();
        if (await im.write(n, buf, mimeOf(n))) got++;
      } catch (e) { if (e.code === "network" || e.code === "reconnect") throw e; errors++; }
    }
    state.imagesAt = Date.now(); state.imagesDirty = left > 0; state.imageError = errors ? errors + " imagen(es) no se pudieron sincronizar." : null;
    if (left) rerun = true;
    if (got) { await waitQuiet(opts.auto); await im.refresh(); im.changed(); }
    return { sent, got, errors };
  }
  const saveIgnored = () => kvSet("ignored", ignoredList).catch(() => {});   // lista GLOBAL del dispositivo: no se pierde al cambiar de versión
  function ignoreImage(n) { ignoredList = Array.from(new Set(ignoredList.concat([n]))); saveIgnored(); }
  function unignoreImage(n) { if (ignoredList.includes(n)) { ignoredList = ignoredList.filter(x => x !== n); saveIgnored(); } }
  function imagesChanged() { state.imagesDirty = true; saveState(); schedule(1500); }
  const stampName = () => { const d = new Date(), p = n => String(n).padStart(2, "0"); return d.getFullYear() + "-" + p(d.getMonth() + 1) + "-" + p(d.getDate()) + "_" + p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds()); };
  const today = () => new Date().toISOString().slice(0, 10);

  // Espera a que la persona no esté escribiendo ni tenga una ventana abierta (solo en sincronizaciones automáticas)
  async function waitQuiet(auto) {
    if (!auto || typeof document === "undefined") return true;
    for (let i = 0; i < 60; i++) {
      const a = document.activeElement;
      const typing = a && /^(INPUT|TEXTAREA)$/.test(a.tagName) && a.type !== "file" && a.value;
      if (!document.querySelector("dialog[open]") && !typing) return true;
      await new Promise(r => setTimeout(r, 1000));
    }
    return false;
  }

  async function doSync(opts) {
    if (!auth) throw mkErr("no-auth", "Dropbox no está conectado en este dispositivo.");
    if (typeof navigator !== "undefined" && navigator.onLine === false) { setStatus({ pending: true, error: null }); return { offline: true }; }
    setStatus({ busy: true, error: null });
    let result = null;
    try {
      for (let attempt = 0; attempt < 4; attempt++) {
        host.stamp();
        const local = clone(host.get());
        const remote = await remoteGet();
        let remoteData = null, merge;
        if (remote) {
          try { remoteData = JSON.parse(remote.text); } catch (e) { throw mkErr("bad-remote", "El archivo de Dropbox no es un JSON válido. No se ha modificado."); }
          if (!remoteData || !Array.isArray(remoteData.lists)) throw mkErr("bad-remote", "El archivo de Dropbox no tiene la estructura del Compendio. No se ha modificado.");
          remoteData.templates = Array.isArray(remoteData.templates) ? remoteData.templates : [];
          ensureStamps(remoteData);
          merge = mergeData(local, remoteData);
        } else {
          merge = { data: Object.assign({ format: "compendio-baluarte", version: 1, schema: 2, exportedAt: nowIso() }, clone({ lists: local.lists, templates: local.templates || [], deleted: local.deleted || [] })), stats: {} };
        }
        const remoteChanged = !remoteData || canon(merge.data) !== canon(remoteData);
        if (remoteChanged) {
          // copia en Dropbox (máx. 1 al día EN TOTAL: el día de la última copia viaja dentro del propio archivo) de lo que había antes de cambiarlo
          const doneDay = remoteData && remoteData.lastRemoteBackup;
          if (remote && doneDay !== today()) {
            try { await remotePut(remote.text, null, "/BACKUP/BK_Compendio-del-Baluarte_" + stampName() + ".json", true); merge.data.lastRemoteBackup = today(); } catch (e) { if (e.code === "network" || e.code === "reconnect") throw e; }
          } else if (doneDay) merge.data.lastRemoteBackup = doneDay;
          try { const m = await remotePut(JSON.stringify(merge.data, null, 2), remote ? remote.rev : null); state.rev = m.rev; }
          catch (e) { if (e.code === "conflict" && attempt < 3) continue; throw e; }
        } else if (remote) state.rev = remote.rev;
        // aplicar en este dispositivo
        const quiet = await waitQuiet(opts && opts.auto);
        if (!quiet) { setStatus({ busy: false, pending: true }); return { deferred: true }; }
        host.stamp();
        const cur = clone(host.get());
        const fin = mergeData(cur, merge.data);
        const differs = canon(fin.data) !== canon(cur);
        if (differs) {
          if (!state.localBackupDay || state.localBackupDay !== today() || !state.firstDone) {
            try { await host.backup("ANTES_DE_SINCRONIZAR"); state.localBackupDay = today(); } catch (e) { /* la copia es una protección; no debe impedir sincronizar */ }
          }
          await host.replace(fin.data);
        }
        if (canon(cur) !== canon(local) || canon(fin.data) !== canon(merge.data)) rerun = true;   // el usuario cambió algo durante la sincronización
        state.firstDone = true; state.lastSyncAt = Date.now();
        result = { stats: remote ? fin.stats : { firstUpload: true }, applied: differs, uploaded: remoteChanged };
        try { result.images = await syncImages(opts || {}); }       // las imágenes nunca impiden que los datos se sincronicen
        catch (e) { if (e.code === "network" || e.code === "reconnect") throw e; state.imageError = "Imágenes: " + e.message; }
        break;
      }
      state.lastResult = summarize(result);
      await saveState();
      setStatus({ busy: false, pending: false, error: null, lastSyncAt: state.lastSyncAt, lastResult: state.lastResult });
      return result;
    } catch (e) {
      setStatus({ busy: false, error: e.message, pending: e.code === "network" });
      throw e;
    }
  }
  function summarize(r) {
    if (!r) return "";
    if (r.stats && r.stats.firstUpload) return "Primera sincronización: tus datos se han subido a Dropbox.";
    const s = r.stats || {}, parts = [];
    const add = (n, one, many) => { if (n) parts.push(n + " " + (n === 1 ? one : many)); };
    add(s.listsAdded, "lista nueva", "listas nuevas"); add(s.listsUpdated, "lista actualizada", "listas actualizadas"); add(s.listsRemoved, "lista eliminada", "listas eliminadas");
    add(s.tasksAdded, "tarea nueva", "tareas nuevas"); add(s.tasksUpdated, "tarea actualizada", "tareas actualizadas"); add(s.tasksRemoved, "tarea eliminada", "tareas eliminadas");
    add(s.templatesAdded + s.templatesUpdated, "plantilla", "plantillas");
    const got = parts.length ? "Recibido: " + parts.join(", ") + "." : "";
    const sent = r.uploaded ? "Tus cambios se han enviado a Dropbox." : "";
    const im = r.images && (r.images.sent || r.images.got) ? "Ilustraciones: " + (r.images.got ? r.images.got + " recibida(s)" : "") + (r.images.got && r.images.sent ? ", " : "") + (r.images.sent ? r.images.sent + " enviada(s)" : "") + "." : "";
    return (got + " " + sent + " " + im).trim() || "Todo estaba al día.";
  }
  function syncNow(opts) {
    if (running) { rerun = true; return running; }
    running = doSync(opts || {}).finally(() => { running = null; if (rerun) { rerun = false; schedule(1500); } });
    return running;
  }
  function schedule(ms) {
    if (!auth) return;
    clearTimeout(timer);
    timer = setTimeout(() => { syncNow({ auto: true }).catch(() => {}); }, ms == null ? 4000 : ms);
  }

  async function init(h) {
    host = h;
    try {
      auth = await kvGet("auth") || null;
      state = (await kvGet(stKey())) || {};
      ignoredList = (await kvGet("ignored")) || [];
      if (state.ignoredImages && state.ignoredImages.length) { ignoredList = Array.from(new Set(ignoredList.concat(state.ignoredImages))); delete state.ignoredImages; saveIgnored(); }
      status.connected = !!auth; status.lastSyncAt = state.lastSyncAt || null; status.lastResult = state.lastResult || null;
    } catch (e) { console.warn("Sync:", e); }
    notify();
    if (typeof window !== "undefined") {
      window.addEventListener("online", () => schedule(1000));
      document.addEventListener("visibilitychange", () => { if (document.visibilityState === "visible" && (!state.lastSyncAt || Date.now() - state.lastSyncAt > 60000)) schedule(1500); });
      setInterval(() => { if (document.visibilityState === "visible") schedule(500); }, 5 * 60 * 1000);
    }
    if (auth) schedule(1500);
  }

  /* ---------------------------------------------------------------
     PARTE 3 · INTERFAZ
     --------------------------------------------------------------- */
  function ui() {
    const $ = id => document.getElementById(id);
    const btn = $("syncBtn"), dlg = $("syncDialog"), body = $("syncBody");
    if (!btn || !dlg) return;
    const fmt = ts => ts ? new Date(ts).toLocaleString("es-ES", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" }) : "—";
    const esc = s => String(s == null ? "" : s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
    function paintButton() {
      const st = !status.connected ? "off" : status.busy ? "busy" : status.error && !status.pending ? "error" : status.pending ? "pending" : "ok";
      btn.dataset.state = st;
      btn.title = { off: "Conectar con Dropbox", busy: "Sincronizando…", error: "Error de sincronización", pending: "Cambios pendientes de sincronizar", ok: "Sincronizado" }[st];
      const s = $("syncStatus"); if (s) s.textContent = { off: "", busy: "☁ Sincronizando…", error: "☁ Error al sincronizar", pending: "☁ Pendiente", ok: "☁ Sincronizado " + fmt(status.lastSyncAt) }[st];
    }
    async function paintDialog() {
      if (!dlg.open) return;
      if (!status.connected) {
        const draft = ($("syncCode") || {}).value || "";
        let p = null; try { p = await getPkce(); } catch (e) { /* noop */ }
        body.innerHTML = '<p class="sync-p">Conecta tu Dropbox para tener tus listas al día en todos tus dispositivos. La app solo usa su propia carpeta dentro de <b>Apps</b> de tu Dropbox. Sin conexión a Internet todo sigue funcionando y se sincroniza al volver.</p>' +
          '<ol class="sync-steps"><li>Pulsa <b>Abrir Dropbox</b>: se abrirá una pestaña nueva. Inicia sesión y pulsa <b>Permitir</b>.</li><li>Dropbox te mostrará un <b>código</b>. Cópialo y pégalo aquí.</li></ol>' +
          (p ? '<a class="primary-btn sync-open" id="syncAuthLink" href="' + p.url + '" target="_blank" rel="noopener">Abrir Dropbox…</a>' : '<p class="sync-err">No se pudo preparar la conexión en este navegador.</p>') +
          '<label class="sync-lab">Código de Dropbox</label><input id="syncCode" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Pega aquí el código">' +
          '<div class="modal-actions"><button type="button" class="primary-btn" id="syncConnect">Conectar</button></div>' + (status.error ? '<p class="sync-err">' + esc(status.error) + '</p>' : "");
        if ($("syncCode")) $("syncCode").value = draft;
        const go = $("syncConnect");
        if (go) go.onclick = async () => {
          const code = ($("syncCode").value || "").trim(); if (!code) { setStatus({ error: "Pega primero el código que te muestra Dropbox." }); return; }
          go.disabled = true; go.textContent = "Conectando…";
          try { await connectWithCode(code); paintDialog(); syncNow({}).catch(() => {}); } catch (e) { setStatus({ error: e.message }); go.disabled = false; go.textContent = "Conectar"; }
        };
      } else {
        body.innerHTML = '<p class="sync-ok">● Conectado a Dropbox</p>' +
          '<p class="sync-p">Última sincronización: <b>' + fmt(status.lastSyncAt) + '</b>' + (status.busy ? " (sincronizando…)" : "") + '</p>' +
          (status.lastResult ? '<p class="sync-p sync-res">' + esc(status.lastResult) + '</p>' : "") + (state.imageError ? '<p class="sync-p sync-small">' + esc(state.imageError) + '</p>' : "") +
          (status.error ? '<p class="sync-err">' + esc(status.error) + '</p>' : "") +
          (status.pending && !status.error ? '<p class="sync-p">Hay cambios pendientes: se enviarán cuando haya conexión.</p>' : "") +
          '<p class="sync-p sync-small">Se sincroniza sola al abrir la app, unos segundos después de cada cambio y al recuperar la conexión. Las copias de seguridad automáticas (máx. 1 al día) van a la carpeta BACKUP de Dropbox.</p>' +
          '<div class="modal-actions"><button type="button" class="quiet-btn" id="syncDisc">Desconectar este dispositivo</button><button type="button" class="primary-btn" id="syncNowBtn">Sincronizar ahora</button></div>';
        $("syncNowBtn").onclick = async () => { $("syncNowBtn").disabled = true; try { await syncNow({}); } catch (e) { /* se muestra en el estado */ } paintDialog(); };
        $("syncDisc").onclick = async () => { if (confirm("¿Desconectar Dropbox en ESTE dispositivo?\n\nTus listas se quedan aquí y en Dropbox; solo se detiene la sincronización de este dispositivo.")) { await disconnect(); paintDialog(); } };
      }
    }
    btn.onclick = () => { dlg.showModal(); paintDialog(); };
    $("syncClose").onclick = () => dlg.close();
    dlg.addEventListener("click", e => { if (e.target !== dlg) return; const r = dlg.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dlg.close(); });
    listeners.push(() => { paintButton(); if (dlg.open && !(document.activeElement && document.activeElement.id === "syncCode")) paintDialog(); });
    paintButton();
  }

  const api = { ignoredImages: () => ignoredList.slice(), clearIgnored: async () => { ignoredList = []; state.imagesDirty = true; await saveIgnored(); await saveState(); return auth ? syncNow({}) : null; }, ignoreImage, unignoreImage, imagesChanged, _setNow: f => { nowFn = f; }, EPOCH, ensureStamps, makeBaseline, stampChanges, mergeData, canon, init, ui, syncNow, schedule, connectWithCode, disconnect, status: () => status, onStatus: f => listeners.push(f), _hash: { hList, hTask, hTpl } };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  root.Sync = api;
})(typeof window !== "undefined" ? window : globalThis);

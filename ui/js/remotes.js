// Remote manager modal: list / test / delete cloud accounts and add new ones
// through rclone's own config API (config/providers, config/create, config/update).
// Public contract: window.Remotes = { open(), onChange(cb) }
(function () {
  'use strict';

  const esc = (s) => api.fmt.escape(s);

  // ---------- provider metadata ----------
  const LABELS = {
    drive: ['Google Drive', 'google'],
    onedrive: ['Microsoft OneDrive', 'microsoft'],
    dropbox: ['Dropbox', 'dropbox'],
    box: ['Box', 'box'],
    pcloud: ['pCloud', 'cloud'],
    mega: ['MEGA', 'cloud'],
    s3: ['Amazon S3 and S3-compatible', 'hdd-stack'],
    b2: ['Backblaze B2', 'cloud'],
    sftp: ['SFTP (SSH server)', 'hdd-network'],
    webdav: ['WebDAV (Nextcloud, ownCloud...)', 'hdd-network'],
    protondrive: ['Proton Drive', 'shield-lock'],
    koofr: ['Koofr', 'cloud'],
    iclouddrive: ['iCloud Drive', 'apple'],
    ftp: ['FTP', 'hdd-network'],
    azureblob: ['Azure Blob Storage', 'microsoft'],
    azurefiles: ['Azure Files', 'microsoft'],
    'google photos': ['Google Photos', 'google'],
    'google cloud storage': ['Google Cloud Storage', 'google'],
    smb: ['SMB / network share', 'hdd-network'],
    yandex: ['Yandex Disk', 'cloud'],
    jottacloud: ['Jottacloud', 'cloud'],
    sharefile: ['Citrix ShareFile', 'cloud'],
    hidrive: ['HiDrive', 'cloud'],
    zoho: ['Zoho WorkDrive', 'cloud'],
    mailru: ['Mail.ru Cloud', 'cloud'],
    swift: ['OpenStack Swift', 'cloud'],
    http: ['HTTP (read-only)', 'globe'],
    local: ['Local disk', 'hdd'],
    alias: ['Alias (shortcut to another remote)', 'link-45deg'],
    union: ['Union (merge remotes)', 'diagram-3'],
    combine: ['Combine remotes', 'diagram-3'],
    crypt: ['Crypt (encrypt a remote)', 'lock'],
    chunker: ['Chunker', 'puzzle'],
    compress: ['Compress', 'archive'],
    hasher: ['Hasher', 'hash'],
    cache: ['Cache', 'lightning'],
    memory: ['Memory (temporary)', 'cpu'],
    archive: ['Archive reader', 'archive'],
  };
  const POPULAR = ['drive', 'onedrive', 'dropbox', 'box', 'pcloud', 'mega', 's3', 'b2', 'sftp', 'webdav',
    'protondrive', 'koofr', 'iclouddrive'];
  // Wrapper / utility backends: kept out of the main list.
  const ADVANCED = ['alias', 'union', 'combine', 'crypt', 'chunker', 'compress', 'hasher', 'cache', 'memory',
    'local', 'archive', 'doi'];
  const DEFAULT_NAMES = { drive: 'gdrive', onedrive: 'onedrive', dropbox: 'dropbox', box: 'box', pcloud: 'pcloud',
    mega: 'mega', s3: 's3', b2: 'b2', sftp: 'sftp', webdav: 'webdav', protondrive: 'proton', koofr: 'koofr',
    iclouddrive: 'icloud', 'google photos': 'gphotos', 'google cloud storage': 'gcs', azureblob: 'azure' };
  // OAuth sign-in is optional app credentials; hide these under "advanced" for non-technical users.
  const OAUTH_ADVANCED = ['client_id', 'client_secret'];

  const state = {
    providers: null,   // array from config/providers (non-hidden)
    byName: {},
    remotes: {},       // from config/dump
  };
  const callbacks = [];
  let modal = null, els = {};
  let flow = null;     // current add flow

  const label = (type) => (LABELS[type] && LABELS[type][0]) ||
    (state.byName[type] && shorten(state.byName[type].Description)) || type;
  const icon = (type) => {
    const i = LABELS[type] && LABELS[type][1];
    return 'bi-' + (i || 'cloud');
  };
  function shorten(s, n = 70) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function fire() { callbacks.forEach((cb) => { try { cb(); } catch (e) { console.error(e); } }); }

  // ---------- option helpers ----------
  // rclone's fs.MatchProvider
  function matchProvider(optProvider, current) {
    if (!optProvider) return true;
    let negate = false;
    if (optProvider[0] === '!') { negate = true; optProvider = optProvider.slice(1); }
    for (const p of optProvider.split(',')) if (p === current) return !negate;
    return negate;
  }
  const isHidden = (o) => (o.Hide & 2) !== 0;
  const isBool = (o) => o.Type === 'bool';
  function defaultStr(o) {
    if (o.DefaultStr != null && o.DefaultStr !== '') return String(o.DefaultStr);
    return o.Default == null || o.Default === '' ? '' : String(o.Default);
  }
  const FRIENDLY_ADV = (o, isOauth) => isOauth && OAUTH_ADVANCED.includes(o.Name);

  // ---------- modal scaffold ----------
  function injectStyle() {
    if (document.getElementById('rm-style')) return;
    const st = document.createElement('style');
    st.id = 'rm-style';
    st.textContent = `
      .rm-tile{display:flex;align-items:center;gap:.6rem;text-align:left;padding:.6rem .75rem;
        border:1px solid var(--bs-border-color);border-radius:var(--bs-border-radius);
        background:var(--bs-body-bg);color:var(--bs-body-color);width:100%}
      .rm-tile:hover,.rm-tile:focus-visible{background:var(--bs-tertiary-bg);border-color:var(--bs-primary)}
      .rm-tile .bi{font-size:1.4rem;color:var(--bs-primary)}
      .rm-tile small{display:block;color:var(--bs-secondary-color)}
      .rm-help{white-space:pre-wrap}
      .rm-help-toggle{padding:0;font-size:.8em}
      .rm-icon{font-size:1.5rem;color:var(--bs-primary)}
    `;
    document.head.appendChild(st);
  }

  function build() {
    injectStyle();
    const wrap = document.createElement('div');
    wrap.className = 'modal fade';
    wrap.tabIndex = -1;
    wrap.setAttribute('aria-labelledby', 'rm-title');
    wrap.innerHTML = `
      <div class="modal-dialog modal-lg modal-dialog-scrollable modal-fullscreen-sm-down">
        <div class="modal-content">
          <div class="modal-header">
            <button type="button" class="btn btn-sm btn-outline-secondary me-2 d-none" data-rm="back"><i class="bi bi-arrow-left"></i> Back</button>
            <h5 class="modal-title" id="rm-title">Cloud accounts</h5>
            <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
          </div>
          <div class="modal-body" data-rm="body"></div>
          <div class="modal-footer d-none" data-rm="footer"></div>
        </div>
      </div>`;
    document.body.appendChild(wrap);
    els = {
      root: wrap,
      title: wrap.querySelector('#rm-title'),
      back: wrap.querySelector('[data-rm=back]'),
      body: wrap.querySelector('[data-rm=body]'),
      footer: wrap.querySelector('[data-rm=footer]'),
    };
    modal = new bootstrap.Modal(wrap);
    els.back.addEventListener('click', () => { if (els.backAction) els.backAction(); });
    wrap.addEventListener('hidden.bs.modal', () => { cancelFlow(true); showList(); });
  }

  function setView(title, { back = null, footer = null } = {}) {
    els.title.textContent = title;
    els.back.classList.toggle('d-none', !back);
    els.backAction = back;
    els.footer.classList.toggle('d-none', !footer);
    els.footer.innerHTML = '';
    if (footer) els.footer.appendChild(footer);
    els.body.scrollTop = 0;
  }
  const alertHtml = (kind, msg) =>
    `<div class="alert alert-${kind} d-flex gap-2 mb-3" role="alert"><div class="text-break" style="white-space:pre-wrap">${esc(msg)}</div></div>`;

  async function loadProviders() {
    if (state.providers) return;
    const list = await api.providers();
    state.providers = list.filter((p) => !p.Hide);
    state.byName = {};
    state.providers.forEach((p) => { state.byName[p.Name] = p; });
  }

  // ---------- list view ----------
  async function showList() {
    cancelFlow(false);
    setView('Cloud accounts');
    els.body.innerHTML = `<div class="text-center text-body-secondary py-5"><div class="spinner-border spinner-border-sm me-2"></div>Loading…</div>`;
    try {
      const [, dump] = await Promise.all([loadProviders().catch(() => {}), api.dumpConfig()]);
      state.remotes = dump || {};
    } catch (e) {
      els.body.innerHTML = alertHtml('danger', e.message);
      return;
    }
    renderList();
  }

  function renderList() {
    const names = Object.keys(state.remotes).sort((a, b) => a.localeCompare(b));
    let html = `<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2">
      <p class="mb-0 text-body-secondary">Connect the cloud accounts you want to copy from or to.</p>
      <button class="btn btn-primary" data-act="add"><i class="bi bi-plus-lg"></i> Add cloud account</button></div>`;
    if (!names.length) {
      html += `<div class="text-center border rounded p-5 text-body-secondary">
        <i class="bi bi-cloud-plus display-4 d-block mb-2"></i>
        <p class="mb-1 fw-semibold">No cloud accounts yet</p>
        <p class="mb-0">Click "Add cloud account" to connect Google Drive, OneDrive, Dropbox and more.</p></div>`;
    } else {
      html += `<ul class="list-group">` + names.map((n) => {
        const t = state.remotes[n].type;
        return `<li class="list-group-item" data-remote="${esc(n)}">
          <div class="d-flex align-items-center gap-3 flex-wrap">
            <i class="bi ${icon(t)} rm-icon"></i>
            <div class="flex-grow-1" style="min-width:8rem">
              <div class="fw-semibold text-break">${esc(n)}</div>
              <div class="small text-body-secondary">${esc(label(t))} <span class="badge text-bg-light border">${esc(t)}</span></div>
            </div>
            <div class="btn-group btn-group-sm">
              <button class="btn btn-outline-secondary" data-act="test"><i class="bi bi-plug"></i> Test</button>
              <button class="btn btn-outline-danger" data-act="del"><i class="bi bi-trash3"></i> Delete</button>
            </div>
          </div>
          <div class="rm-status small mt-2 d-none"></div>
        </li>`;
      }).join('') + `</ul>`;
    }
    els.body.innerHTML = html;
    els.body.querySelector('[data-act=add]').addEventListener('click', startAdd);
    els.body.querySelectorAll('li[data-remote]').forEach((li) => {
      const name = li.dataset.remote;
      const status = li.querySelector('.rm-status');
      li.querySelector('[data-act=test]').addEventListener('click', (ev) => testRemote(name, status, ev.currentTarget));
      li.querySelector('[data-act=del]').addEventListener('click', () => confirmDelete(name, li, status));
    });
  }

  async function testRemote(name, statusEl, btn) {
    statusEl.classList.remove('d-none');
    statusEl.innerHTML = `<span class="spinner-border spinner-border-sm me-1"></span> Testing connection…`;
    btn.disabled = true;
    const fs = api.fsString(name, '');
    try {
      try {
        await api.about(fs);
      } catch (e) {
        // many backends do not support "about": fall back to listing the top level
        await api.listDirs(fs);
      }
      statusEl.innerHTML = `<span class="text-success"><i class="bi bi-check-circle-fill"></i> Connected - this account works.</span>`;
    } catch (e) {
      statusEl.innerHTML = `<span class="text-danger"><i class="bi bi-x-circle-fill"></i> Failed:</span> <span class="text-break">${esc(e.message)}</span>`;
    } finally { btn.disabled = false; }
  }

  function confirmDelete(name, li, statusEl) {
    statusEl.classList.remove('d-none');
    statusEl.innerHTML = `<div class="alert alert-warning py-2 mb-0 d-flex align-items-center flex-wrap gap-2">
      <span class="flex-grow-1">Remove <strong>${esc(name)}</strong> from rclone? Your files in the cloud are not touched.</span>
      <button class="btn btn-sm btn-danger" data-y>Remove</button>
      <button class="btn btn-sm btn-outline-secondary" data-n>Keep</button></div>`;
    statusEl.querySelector('[data-n]').addEventListener('click', () => { statusEl.classList.add('d-none'); statusEl.innerHTML = ''; });
    statusEl.querySelector('[data-y]').addEventListener('click', async (ev) => {
      ev.currentTarget.disabled = true;
      try {
        await api.deleteRemote(name);
        delete state.remotes[name];
        renderList();
        fire();
      } catch (e) {
        statusEl.innerHTML = alertHtml('danger', e.message);
      }
    });
  }

  // ---------- add flow: step A (pick provider) ----------
  async function startAdd() {
    setView('Add cloud account', { back: showList });
    els.body.innerHTML = `<div class="text-center text-body-secondary py-5"><div class="spinner-border spinner-border-sm me-2"></div>Loading providers…</div>`;
    try { await loadProviders(); } catch (e) { els.body.innerHTML = alertHtml('danger', e.message); return; }
    renderPicker('');
  }

  function tile(p) {
    const t = p.Name;
    const lbl = label(t);
    const sub = LABELS[t] ? '' : '';
    return `<div class="col-12 col-sm-6"><button type="button" class="rm-tile" data-type="${esc(t)}">
      <i class="bi ${icon(t)}"></i><span><span class="fw-semibold">${esc(lbl)}</span>${sub}<small>${esc(t)}</small></span></button></div>`;
  }

  function renderPicker(query) {
    let box = els.body.querySelector('.rm-picker');
    if (!box) {
      els.body.innerHTML = `<input type="search" class="form-control mb-3" placeholder="Search providers (e.g. Google, Dropbox, S3)…" aria-label="Search providers" data-rm="search">
        <div class="rm-picker"></div>`;
      els.body.querySelector('[data-rm=search]').addEventListener('input', (e) => renderPicker(e.target.value));
      box = els.body.querySelector('.rm-picker');
    }
    const q = query.trim().toLowerCase();
    const all = state.providers;
    const byLabel = (a, b) => label(a.Name).localeCompare(label(b.Name));
    let html = '';
    const grid = (arr) => `<div class="row g-2">${arr.map(tile).join('')}</div>`;
    if (q) {
      const m = all.filter((p) => (p.Name + ' ' + label(p.Name) + ' ' + p.Description).toLowerCase().includes(q)).sort(byLabel);
      html = m.length ? grid(m) : `<p class="text-body-secondary">No provider matches "${esc(query)}".</p>`;
    } else {
      const pop = POPULAR.map((n) => state.byName[n]).filter(Boolean);
      const adv = all.filter((p) => ADVANCED.includes(p.Name)).sort(byLabel);
      const rest = all.filter((p) => !POPULAR.includes(p.Name) && !ADVANCED.includes(p.Name)).sort(byLabel);
      html = `<h6 class="text-body-secondary text-uppercase small">Popular</h6>${grid(pop)}
        <h6 class="text-body-secondary text-uppercase small mt-4">All providers</h6>${grid(rest)}
        <h6 class="text-body-secondary text-uppercase small mt-4">Advanced (wrappers and utilities)</h6>${grid(adv)}`;
    }
    box.innerHTML = html;
    box.querySelectorAll('.rm-tile').forEach((b) => b.addEventListener('click', () => startConfigure(b.dataset.type)));
  }

  // ---------- step B: configure ----------
  function validateName(name) {
    if (!name) return 'Please enter a name.';
    if (/^[-\s]/.test(name)) return 'The name cannot start with a dash or a space.';
    if (/\s$/.test(name)) return 'The name cannot end with a space.';
    if (!/^[\p{L}\p{N}_.+@ -]+$/u.test(name)) return 'Use only letters, digits and _ - . + @ (and spaces).';
    if (Object.prototype.hasOwnProperty.call(state.remotes, name)) return 'You already have an account with this name.';
    return '';
  }
  function suggestName(type) {
    const base = DEFAULT_NAMES[type] || type.replace(/[^\p{L}\p{N}_.+@-]/gu, '');
    let n = base, i = 2;
    while (state.remotes[n]) n = base + (i++);
    return n;
  }

  function startConfigure(type) {
    const prov = state.byName[type];
    const options = prov.Options.filter((o) => !isHidden(o));
    const isOauth = prov.Options.some((o) => o.Name === 'token');
    flow = { type, prov, options, isOauth, values: {}, showAdv: false, created: null, abort: null };
    setView(`Connect ${label(type)}`, { back: startAdd });
    els.body.innerHTML = `
      <form novalidate data-rm="form">
        <div class="alert alert-info py-2 small" ${isOauth ? '' : 'hidden'}>
          <i class="bi bi-info-circle"></i> You will sign in to ${esc(label(type))} in your web browser. Nothing else to set up.</div>
        <div class="mb-3">
          <label class="form-label fw-semibold" for="rm-name">Name for this account</label>
          <input class="form-control" id="rm-name" value="${esc(suggestName(type))}" autocomplete="off" spellcheck="false">
          <div class="invalid-feedback" data-rm="name-err"></div>
          <div class="form-text">A short nickname you will see in the app.</div>
        </div>
        <div data-rm="fields"></div>
        <div class="form-check form-switch my-3 ${options.some((o) => isAdv(o)) ? '' : 'd-none'}">
          <input class="form-check-input" type="checkbox" role="switch" id="rm-adv">
          <label class="form-check-label" for="rm-adv">Show advanced options</label>
        </div>
        <div data-rm="err"></div>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" data-rm="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary"><i class="bi bi-check-lg"></i> ${isOauth ? 'Sign in and connect' : 'Connect'}</button>
        </div>
      </form>`;
    const form = els.body.querySelector('form');
    form.querySelector('[data-rm=cancel]').addEventListener('click', startAdd);
    form.querySelector('#rm-adv').addEventListener('change', (e) => { flow.showAdv = e.target.checked; renderFields(); });
    form.addEventListener('submit', (e) => { e.preventDefault(); submitConfigure(form); });
    renderFields();
    form.querySelector('#rm-name').select();
  }

  const isAdv = (o) => o.Advanced || FRIENDLY_ADV(o, flow && flow.isOauth);

  function currentProvider() {
    const v = flow.values.provider;
    if (v != null) return v;
    const o = flow.options.find((x) => x.Name === 'provider');
    return o ? defaultStr(o) : '';
  }
  function visibleOptions() {
    const cp = currentProvider();
    return flow.options.filter((o) => o.Name !== 'token' || flow.showAdv)
      .filter((o) => matchProvider(o.Provider, cp))
      .filter((o) => flow.showAdv || !isAdv(o) || (flow.values[o.Name] != null));
  }

  function renderFields() {
    const host = els.body.querySelector('[data-rm=fields]');
    const opts = visibleOptions();
    const cp = currentProvider();
    host.innerHTML = '';
    let advHeader = false;
    opts.forEach((o) => {
      if (isAdv(o) && !advHeader && flow.showAdv) {
        advHeader = true;
        const h = document.createElement('h6');
        h.className = 'text-body-secondary text-uppercase small mt-4';
        h.textContent = 'Advanced';
        host.appendChild(h);
      }
      host.appendChild(fieldEl(o, cp));
    });
    if (!opts.length) host.innerHTML = `<p class="text-body-secondary">Nothing else to set up here.</p>`;
  }

  function helpBlock(o, id) {
    const help = String(o.Help || '').trim();
    if (!help) return null;
    const lines = help.split('\n');
    const first = lines[0];
    const d = document.createElement('div');
    d.className = 'form-text';
    d.innerHTML = `<span class="text-break">${esc(first)}</span>`;
    if (lines.length > 1) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-link rm-help-toggle ms-1';
      btn.textContent = 'More';
      const more = document.createElement('div');
      more.className = 'rm-help mt-1 d-none text-break';
      more.textContent = lines.slice(1).join('\n').trim();
      btn.addEventListener('click', () => {
        const hid = more.classList.toggle('d-none');
        btn.textContent = hid ? 'More' : 'Less';
      });
      d.appendChild(btn); d.appendChild(more);
    }
    return d;
  }

  function fieldEl(o, cp) {
    const id = 'rm-f-' + o.Name.replace(/[^\w-]/g, '_');
    const def = defaultStr(o);
    const cur = flow.values[o.Name];
    const wrap = document.createElement('div');
    wrap.className = 'mb-3';
    wrap.dataset.opt = o.Name;
    const examples = (o.Examples || []).filter((x) => matchProvider(x.Provider, cp));
    const title = o.Name.replace(/_/g, ' ');
    const req = o.Required && !def;
    const lab = `<label class="form-label fw-semibold" for="${id}">${esc(title)}${req ? ' <span class="text-danger" title="Required">*</span>' : ''}</label>`;

    if (isBool(o)) {
      const checked = cur != null ? cur === 'true' : def === 'true';
      wrap.innerHTML = `<div class="form-check form-switch"><input class="form-check-input" type="checkbox" role="switch" id="${id}" ${checked ? 'checked' : ''}>
        <label class="form-check-label fw-semibold" for="${id}">${esc(title)}</label></div>`;
      wrap.querySelector('input').addEventListener('change', (e) => {
        const v = String(e.target.checked);
        if (v === (def || 'false')) delete flow.values[o.Name]; else flow.values[o.Name] = v;
        if (o.Name === 'provider') renderFields();
      });
    } else if (examples.length && (o.Exclusive || o.Name === 'provider')) {
      const sel = examples.map((x) => `<option value="${esc(x.Value)}" ${cur === x.Value ? 'selected' : ''}>${esc(x.Value)}${x.Help ? ' - ' + esc(shorten(String(x.Help).split('\n')[0], 80)) : ''}</option>`).join('');
      wrap.innerHTML = `${lab}<select class="form-select" id="${id}"><option value="" ${cur ? '' : 'selected'}>${req ? 'Choose…' : def ? 'Default (' + esc(def) + ')' : 'Default / not set'}</option>${sel}</select>`;
      wrap.querySelector('select').addEventListener('change', (e) => {
        if (e.target.value === '') delete flow.values[o.Name]; else flow.values[o.Name] = e.target.value;
        if (o.Name === 'provider') renderFields();
      });
    } else {
      const type = o.IsPassword ? 'password' : (o.Type === 'int' || o.Type === 'float64') ? 'number' : 'text';
      const dl = examples.length ? `<datalist id="${id}-dl">${examples.map((x) => `<option value="${esc(x.Value)}">${esc(shorten(String(x.Help || '').split('\n')[0], 80))}</option>`).join('')}</datalist>` : '';
      wrap.innerHTML = `${lab}<input class="form-control" id="${id}" type="${type}" ${type === 'number' ? 'step="any"' : ''} value="${esc(cur ?? '')}"
        placeholder="${esc(def)}" autocomplete="${o.IsPassword ? 'new-password' : 'off'}" spellcheck="false" ${examples.length ? `list="${id}-dl"` : ''}>${dl}`;
      wrap.querySelector('input').addEventListener('input', (e) => {
        if (e.target.value === '') delete flow.values[o.Name]; else flow.values[o.Name] = e.target.value;
        e.target.classList.remove('is-invalid');
      });
    }
    const h = helpBlock(o, id);
    if (h) wrap.appendChild(h);
    return wrap;
  }

  // ---------- create + question loop ----------
  function cancelFlow(cleanup) {
    if (!flow) return;
    const f = flow;
    flow = null;
    if (f.abort) { try { f.abort(); } catch { /* ignore */ } }
    if (cleanup && f.created) api.deleteRemote(f.created).catch(() => {});
  }

  function submitConfigure(form) {
    const nameEl = form.querySelector('#rm-name');
    const name = nameEl.value;
    const err = validateName(name);
    nameEl.classList.toggle('is-invalid', !!err);
    form.querySelector('[data-rm=name-err]').textContent = err;
    // required fields
    let bad = null;
    const vis = visibleOptions();
    vis.forEach((o) => {
      const inp = form.querySelector(`[data-opt="${CSS.escape(o.Name)}"] input, [data-opt="${CSS.escape(o.Name)}"] select`);
      const missing = o.Required && !defaultStr(o) && !isBool(o) && !flow.values[o.Name];
      if (inp) inp.classList.toggle('is-invalid', missing);
      if (missing && !bad) bad = inp;
    });
    if (err) { nameEl.focus(); return; }
    if (bad) { bad.focus(); form.querySelector('[data-rm=err]').innerHTML = alertHtml('warning', 'Please fill in the required fields (marked *).'); return; }
    const visNames = new Set(vis.map((o) => o.Name));
    const params = {};
    for (const [k, v] of Object.entries(flow.values)) if (visNames.has(k)) params[k] = v;
    runCreate(name, params);
  }

  const OPT = { nonInteractive: true, obscure: true };

  function showBusy(title, html) {
    setView(title);
    els.body.innerHTML = html;
  }

  async function runCreate(name, params) {
    const f = flow;
    f.name = name;
    showBusy(`Connecting ${label(f.type)}`, `<div class="text-center py-5"><div class="spinner-border mb-3"></div><p class="mb-0">Creating account…</p></div>`);
    f.created = name;
    await step(f, () => api.rcCancelable('config/create', { name, type: f.type, parameters: params, opt: OPT }));
  }

  // Runs one rc call, then interprets the config "state machine" response:
  //   { State, Option, Error, Result }  - State "" means finished; Option is the next question.
  async function step(f, makeCall, waitingForBrowser = false) {
    if (flow !== f) return;
    if (waitingForBrowser) showBrowserWait(f);
    const call = makeCall();
    f.abort = call.abort;
    let resp;
    try {
      resp = await call.promise;
    } catch (e) {
      if (flow !== f || e.aborted) return;
      return failFlow(f, e.message);
    }
    if (flow !== f) return;
    f.abort = null;
    if (resp.Error) return failFlow(f, resp.Error);
    if (!resp.State && !resp.Option) return finishFlow(f);
    const o = resp.Option;
    if (!o) return failFlow(f, 'rclone returned an unexpected response (state "' + resp.State + '").');
    // This app runs on the same computer as rclone, so always use the local browser sign-in.
    if (o.Name === 'config_is_local') {
      return step(f, () => answer(f, resp.State, 'true'), true);
    }
    showQuestion(f, resp.State, o);
  }

  const answer = (f, st, result) =>
    api.rcCancelable('config/update', { name: f.name, parameters: {}, opt: { ...OPT, continue: true, state: st, result: String(result) } });

  function showBrowserWait(f) {
    setView(`Sign in to ${label(f.type)}`);
    els.body.innerHTML = `
      <div class="text-center py-4">
        <div class="spinner-border text-primary mb-3" role="status"></div>
        <h5>A browser window has opened</h5>
        <p class="mb-1">Sign in to <strong>${esc(label(f.type))}</strong> and allow access, then come back here.</p>
        <p class="text-body-secondary small">This page will continue by itself when you are done.</p>
      </div>
      <div class="alert alert-secondary small">
        <i class="bi bi-question-circle"></i> <strong>No window appeared?</strong>
        rclone also prints a sign-in link (starting with <code>http://127.0.0.1:53682/auth</code>) in the
        window or log where this app was started - open that link in your browser.
        If you see "address already in use", another sign-in is still running: press Cancel and try again.
      </div>
      <div class="text-center"><button class="btn btn-outline-secondary" data-rm="cancel-auth">Cancel</button></div>`;
    els.body.querySelector('[data-rm=cancel-auth]').addEventListener('click', () => {
      cancelFlow(true);
      startAdd();
    });
  }

  function showQuestion(f, st, o) {
    setView(`Connect ${label(f.type)}`);
    const def = defaultStr(o);
    const ex = o.Examples || [];
    const id = 'rm-q';
    let input;
    if (isBool(o) || (ex.length && o.Exclusive)) {
      let items = ex.length ? ex : [{ Value: 'true', Help: 'Yes' }, { Value: 'false', Help: 'No' }];
      input = `<div data-rm="choices">` + items.map((x, i) => `<div class="form-check mb-1">
        <input class="form-check-input" type="radio" name="rm-choice" id="${id}${i}" value="${esc(x.Value)}" ${String(x.Value) === def || (!def && i === 0) ? 'checked' : ''}>
        <label class="form-check-label" for="${id}${i}">${esc(x.Help ? shorten(String(x.Help).split('\n')[0], 120) : x.Value)}${x.Help ? ` <span class="text-body-secondary small">(${esc(x.Value)})</span>` : ''}</label></div>`).join('') + `</div>`;
    } else {
      const dl = ex.length ? `<datalist id="${id}-dl">${ex.map((x) => `<option value="${esc(x.Value)}">${esc(shorten(String(x.Help || '').split('\n')[0], 80))}</option>`).join('')}</datalist>` : '';
      input = `<input class="form-control" id="${id}" type="${o.IsPassword ? 'password' : 'text'}" value="${esc(def)}" ${ex.length ? `list="${id}-dl"` : ''} autocomplete="off" spellcheck="false">${dl}`;
    }
    const help = String(o.Help || '').trim();
    els.body.innerHTML = `
      <form data-rm="q">
        <p class="text-body-secondary small mb-1">rclone needs one more answer</p>
        <p class="fw-semibold text-break" style="white-space:pre-wrap">${esc(help || o.Name)}</p>
        <div class="mb-3">${input}</div>
        <div class="d-flex justify-content-end gap-2">
          <button type="button" class="btn btn-outline-secondary" data-rm="cancel">Cancel</button>
          <button type="submit" class="btn btn-primary">Continue</button>
        </div>
      </form>`;
    const form = els.body.querySelector('form');
    form.querySelector('[data-rm=cancel]').addEventListener('click', () => { cancelFlow(true); startAdd(); });
    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const r = form.querySelector('input[name=rm-choice]:checked');
      const val = r ? r.value : form.querySelector('#' + id).value;
      showBusy(`Connecting ${label(f.type)}`, `<div class="text-center py-5"><div class="spinner-border mb-3"></div><p class="mb-0">Working…</p></div>`);
      step(f, () => answer(f, st, val));
    });
    const first = form.querySelector('input');
    if (first) first.focus();
  }

  async function failFlow(f, msg) {
    // remove the half-created remote so the list stays clean
    if (f.created) { await api.deleteRemote(f.created).catch(() => {}); f.created = null; }
    if (flow === f) flow = null;
    setView(`Could not connect ${label(f.type)}`);
    els.body.innerHTML = alertHtml('danger', msg) + `
      <div class="d-flex justify-content-end gap-2">
        <button class="btn btn-outline-secondary" data-rm="list">Back to my accounts</button>
        <button class="btn btn-primary" data-rm="retry">Try again</button></div>`;
    els.body.querySelector('[data-rm=list]').addEventListener('click', showList);
    els.body.querySelector('[data-rm=retry]').addEventListener('click', () => startConfigure(f.type));
  }

  async function finishFlow(f) {
    const name = f.name;
    f.created = null;
    flow = null;
    try { state.remotes = (await api.dumpConfig()) || {}; } catch { /* ignore */ }
    fire();
    setView('Connected');
    els.body.innerHTML = `<div class="text-center py-5">
      <i class="bi bi-check-circle-fill text-success display-3"></i>
      <h5 class="mt-3">${esc(name)} is connected</h5>
      <p class="text-body-secondary">${esc(label(f.type))} is ready to use.</p>
      <button class="btn btn-primary" data-rm="ok">Done</button></div>`;
    els.body.querySelector('[data-rm=ok]').addEventListener('click', showList);
  }

  // ---------- public API ----------
  window.Remotes = {
    open() {
      if (!modal) build();
      showList();
      modal.show();
    },
    onChange(cb) { if (typeof cb === 'function') callbacks.push(cb); },
  };
})();

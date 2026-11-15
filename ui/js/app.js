// rclone Easy Migration - wizard UI. Vanilla JS, no build step.
(function () {
  'use strict';
  const { fmt } = api;
  const esc = fmt.escape;
  const $ = (id) => document.getElementById(id);
  const LOCAL = '::local';
  const LS_JOB = 'rem.job';
  const LS_THEME = 'rem.theme';

  // ---------- small helpers ----------
  const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
  const lsSet = (k, v) => { try { v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v); } catch { /* ignore */ } };

  function toast(message, kind = 'danger') {
    const el = document.createElement('div');
    el.className = `toast align-items-center text-bg-${kind} border-0`;
    el.setAttribute('role', kind === 'danger' ? 'alert' : 'status');
    el.innerHTML = `<div class="d-flex"><div class="toast-body text-break">${esc(message)}</div>
      <button type="button" class="btn-close btn-close-white me-2 m-auto" data-bs-dismiss="toast" aria-label="Close"></button></div>`;
    $('toasts').appendChild(el);
    const t = new bootstrap.Toast(el, { delay: kind === 'danger' ? 8000 : 4000 });
    el.addEventListener('hidden.bs.toast', () => el.remove());
    t.show();
  }
  const showError = (e, prefix) => toast((prefix ? prefix + ': ' : '') + (e && e.message ? e.message : String(e)));

  // Promise-based confirm dialog. opts: {title, body (html), okText, okClass, check}
  function confirmDialog({ title, body, okText = 'OK', okClass = 'btn-primary', check = false }) {
    return new Promise((resolve) => {
      const modalEl = $('confirmModal');
      $('confirmTitle').textContent = title;
      $('confirmBody').innerHTML = body;
      const ok = $('confirmOk');
      ok.textContent = okText;
      ok.className = 'btn ' + okClass;
      const cw = $('confirmCheckWrap'), cb = $('confirmCheck');
      cw.classList.toggle('d-none', !check);
      cb.checked = false;
      ok.disabled = check;
      const onCheck = () => { ok.disabled = !cb.checked; };
      cb.addEventListener('change', onCheck);
      let result = false;
      const onOk = () => { result = true; modal.hide(); };
      ok.addEventListener('click', onOk);
      const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
      modalEl.addEventListener('hidden.bs.modal', function done() {
        modalEl.removeEventListener('hidden.bs.modal', done);
        cb.removeEventListener('change', onCheck);
        ok.removeEventListener('click', onOk);
        resolve(result);
      });
      modal.show();
    });
  }

  // ---------- theme ----------
  const mq = window.matchMedia ? matchMedia('(prefers-color-scheme: dark)') : null;
  function themePref() { return lsGet(LS_THEME) || 'auto'; }
  function applyTheme() {
    const pref = themePref();
    const dark = pref === 'dark' || (pref === 'auto' && mq && mq.matches);
    document.documentElement.setAttribute('data-bs-theme', dark ? 'dark' : 'light');
    $('themeIcon').className = 'bi ' + (pref === 'light' ? 'bi-sun' : pref === 'dark' ? 'bi-moon-stars' : 'bi-circle-half');
    document.querySelectorAll('[data-theme-choice]').forEach((b) =>
      b.classList.toggle('active', b.dataset.themeChoice === pref));
  }
  document.querySelectorAll('[data-theme-choice]').forEach((b) =>
    b.addEventListener('click', () => { lsSet(LS_THEME, b.dataset.themeChoice); applyTheme(); }));
  if (mq && mq.addEventListener) mq.addEventListener('change', applyTheme);
  applyTheme();

  // ---------- path / fs helpers ----------
  // Local paths are used verbatim as the fs; remote paths are "remote:path".
  function makeFs(remote, path) {
    const p = (path || '').trim();
    if (!remote) return p || '/';
    return api.fsString(remote, p);
  }
  const normPath = (p) => (p || '').replace(/\\/g, '/').replace(/\/+/g, '/').replace(/^\/+|\/+$/g, '');
  function splitLocal(path) {
    const p = (path || '').replace(/\\/g, '/');
    let root = '', rest = p;
    const m = /^([A-Za-z]:)\/?/.exec(p);
    if (m) { root = m[1] + '/'; rest = p.slice(m[0].length); } else if (p.startsWith('/')) { root = '/'; rest = p.replace(/^\/+/, ''); }
    return { root, segs: rest.split('/').filter(Boolean) };
  }
  function joinPath(remote, base, name) {
    if (!remote) {
      if (!base) return '/' + name;
      return base.replace(/[\\/]+$/, '') + '/' + name;
    }
    return (base ? base.replace(/\/+$/, '') + '/' : '') + name;
  }

  // ---------- remotes list (shared) ----------
  let remotes = []; // [{name, type}]
  async function loadRemotes() {
    try {
      const [names, cfg] = await Promise.all([api.listRemotes(), api.dumpConfig()]);
      remotes = names.map((n) => ({ name: n, type: (cfg[n] && cfg[n].type) || '' }));
    } catch (e) { showError(e, 'Could not load remotes'); remotes = []; }
  }
  async function refreshRemoteLists() {
    await loadRemotes();
    pickers.forEach((p) => p.fillRemotes());
    $('noRemotes').classList.toggle('d-none', remotes.length > 0);
  }

  // ---------- reusable folder picker ----------
  const pickers = [];
  function createPicker(rootId, prefix, { mustExist, allowCreate = false }) {
    const root = $(rootId);
    const id = (s) => prefix + s;
    root.innerHTML = `
      <div class="mb-3">
        <label for="${id('Remote')}" class="form-label fw-semibold">Account</label>
        <select class="form-select" id="${id('Remote')}"></select>
      </div>
      <div class="mb-2">
        <label for="${id('Path')}" class="form-label fw-semibold" id="${id('PathLabel')}">Folder</label>
        <div class="input-group">
          <button class="btn btn-outline-secondary" type="button" id="${id('Up')}" title="Go up one level" aria-label="Go up one level"><i class="bi bi-arrow-up"></i></button>
          <input class="form-control" id="${id('Path')}" autocomplete="off" spellcheck="false">
          <button class="btn btn-outline-primary" type="button" id="${id('Go')}">Go</button>
        </div>
        <div class="form-text" id="${id('Hint')}"></div>
      </div>
      <nav aria-label="Folder path"><ol class="breadcrumb mb-2 small" id="${id('Crumb')}"></ol></nav>
      <form class="input-group input-group-sm mb-2 d-none" id="${id('NewForm')}" novalidate>
        <span class="input-group-text"><i class="bi bi-folder-plus"></i></span>
        <input class="form-control" id="${id('NewName')}" placeholder="New folder name" aria-label="New folder name" autocomplete="off" spellcheck="false">
        <button class="btn btn-primary" type="submit" id="${id('NewOk')}">Create</button>
        <button class="btn btn-outline-secondary" type="button" id="${id('NewCancel')}">Cancel</button>
      </form>
      <div class="list-group mb-3 folder-list" id="${id('List')}" aria-live="polite"></div>
      <div class="border rounded p-2 mb-2 bg-body-tertiary">
        <div class="small text-body-secondary">Selected</div>
        <code class="fs-code fs-6" id="${id('Fs')}"></code>
      </div>
      <div class="d-flex flex-wrap align-items-center gap-2">
        ${allowCreate ? `<button class="btn btn-sm btn-outline-primary" type="button" id="${id('NewBtn')}"><i class="bi bi-folder-plus"></i> New folder</button>` : ''}
        <button class="btn btn-sm btn-outline-secondary" type="button" id="${id('SizeBtn')}"><i class="bi bi-calculator"></i> Calculate size</button>
        <button class="btn btn-sm btn-outline-secondary d-none" type="button" id="${id('SizeCancel')}">Cancel</button>
        <span class="small" id="${id('SizeOut')}"></span>
      </div>
      <div class="mt-2 d-none" id="${id('About')}"></div>`;

    const el = (s) => $(id(s));
    // remote starts as null so the first fillRemotes() prefers a configured cloud account over local disk.
    const st = { remote: null, path: '', listOk: false, token: 0, sizeJob: null };

    const api_ = {
      get remoteName() { return st.remote === LOCAL ? '' : st.remote; },
      get path() { return st.path.trim(); },
      get isLocal() { return st.remote === LOCAL; },
      get fs() { return makeFs(this.remoteName, st.path); },
      get valid() { return st.remote !== LOCAL || st.path.trim() !== ''; },
      get listOk() { return st.listOk; },
      get label() { return this.fs; },
      set(remoteName, path) {
        st.remote = remoteName ? remoteName : LOCAL;
        if (![...el('Remote').options].some((o) => o.value === st.remote)) st.remote = el('Remote').options[0].value;
        el('Remote').value = st.remote;
        st.path = path || '';
        return navigate(st.path);
      },
      fillRemotes() {
        const sel = el('Remote');
        const cur = st.remote;
        sel.innerHTML = remotes.map((r) =>
          `<option value="${esc(r.name)}">${esc(r.name)}${r.type ? ' (' + esc(r.type) + ')' : ''}</option>`).join('') +
          `<option value="${LOCAL}">Local disk (this computer)</option>`;
        const exists = [...sel.options].some((o) => o.value === cur);
        st.remote = exists ? cur : sel.options[0].value;
        // Prefer a configured remote over local disk the first time.
        if (!exists && remotes.length) st.remote = remotes[0].name;
        sel.value = st.remote;
        if (!exists) { st.path = ''; navigate(''); }
        else renderChrome();
      },
      onChange: null,
    };

    function fireChange() { if (api_.onChange) api_.onChange(); }

    function renderChrome() {
      const local = st.remote === LOCAL;
      el('Path').placeholder = local ? 'Type a folder, e.g. C:/Users/me/Documents or /home/me' : '(root of this account)';
      el('Hint').textContent = local ? 'Type an absolute path, or click folders below.' : 'Leave empty for the root, or type a path or click folders below.';
      el('Path').value = st.path;
      el('Fs').textContent = api_.valid ? api_.fs : '(choose a folder)';
      // breadcrumb
      const crumb = el('Crumb');
      crumb.innerHTML = '';
      const addCrumb = (label, path, last) => {
        const li = document.createElement('li');
        li.className = 'breadcrumb-item' + (last ? ' active' : '');
        if (last) { li.textContent = label; li.setAttribute('aria-current', 'page'); } else {
          const a = document.createElement('a');
          a.href = '#'; a.textContent = label;
          a.addEventListener('click', (ev) => { ev.preventDefault(); navigate(path); });
          li.appendChild(a);
        }
        crumb.appendChild(li);
      };
      if (local) {
        const { root, segs } = splitLocal(st.path);
        addCrumb(root || 'This computer', root, segs.length === 0);
        segs.forEach((s, i) => addCrumb(s, root + segs.slice(0, i + 1).join('/'), i === segs.length - 1));
      } else {
        const segs = normPath(st.path).split('/').filter(Boolean);
        addCrumb(st.remote + ':', '', segs.length === 0);
        segs.forEach((s, i) => addCrumb(s, segs.slice(0, i + 1).join('/'), i === segs.length - 1));
      }
      el('SizeOut').textContent = '';
      el('SizeOut').className = 'small';
    }

    async function navigate(path) {
      st.path = path || '';
      renderChrome();
      fireChange();
      const list = el('List');
      const token = ++st.token;
      loadAbout();
      list.innerHTML = '<div class="list-group-item text-body-secondary"><span class="spinner-border spinner-border-sm me-2" aria-hidden="true"></span>Loading folders…</div>';
      st.listOk = false;
      const local = st.remote === LOCAL;
      // For local with nothing typed we show the root of the current drive.
      const fs = local && !st.path.trim() ? '/' : api_.fs;
      try {
        const dirs = await api.listDirs(fs, '');
        if (token !== st.token) return;
        st.listOk = true;
        dirs.sort((a, b) => a.Name.localeCompare(b.Name, undefined, { numeric: true, sensitivity: 'base' }));
        if (!dirs.length) {
          list.innerHTML = '<div class="list-group-item text-body-secondary small"><i class="bi bi-folder2-open"></i> No subfolders here.</div>';
        } else {
          list.innerHTML = '';
          for (const d of dirs) {
            const b = document.createElement('button');
            b.type = 'button';
            b.className = 'list-group-item list-group-item-action';
            b.innerHTML = `<i class="bi bi-folder-fill text-warning"></i><span>${esc(d.Name)}</span><i class="bi bi-chevron-right ms-auto text-body-secondary"></i>`;
            b.title = d.Name;
            b.addEventListener('click', () => navigate(joinPath(api_.remoteName, local && !st.path.trim() ? '' : st.path, d.Name)));
            list.appendChild(b);
          }
        }
      } catch (e) {
        if (token !== st.token) return;
        const notFound = /not found|no such|cannot find|does not exist/i.test(e.message || '');
        const msg = notFound
          ? (mustExist ? 'This folder was not found.' : "This folder doesn't exist yet - it will be created.")
          : e.message;
        list.innerHTML = `<div class="list-group-item ${notFound && !mustExist ? 'text-body-secondary' : 'text-danger'} small"><i class="bi bi-info-circle"></i> ${esc(msg)}</div>`;
        st.listOk = notFound && !mustExist;
        if (!notFound) showError(e, 'Could not list folders');
      }
      fireChange();
    }

    async function loadAbout() {
      const box = el('About');
      box.classList.add('d-none');
      box.innerHTML = '';
      if (!api_.valid) return;
      const token = st.token;
      try {
        const a = await api.about(api_.fs);
        if (token !== st.token || a.total == null || a.used == null || !a.total) return;
        const pct = Math.min(100, Math.round((a.used / a.total) * 100));
        box.innerHTML = `<div class="small text-body-secondary mb-1">Storage: ${fmt.bytes(a.used)} used of ${fmt.bytes(a.total)}${a.free != null ? ' (' + fmt.bytes(a.free) + ' free)' : ''}</div>
          <div class="progress" style="height:.5rem" role="progressbar" aria-label="Storage used" aria-valuenow="${pct}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${pct}%"></div></div>`;
        box.classList.remove('d-none');
      } catch { /* many backends don't support about */ }
    }

    async function calcSize() {
      if (!api_.valid) return;
      const out = el('SizeOut');
      out.className = 'small text-body-secondary';
      out.innerHTML = '<span class="spinner-border spinner-border-sm me-1" aria-hidden="true"></span>Calculating… (this can take a while on big folders)';
      el('SizeBtn').disabled = true;
      el('SizeCancel').classList.remove('d-none');
      try {
        const { jobid } = await api.rc('operations/size', { fs: api_.fs, _async: true });
        st.sizeJob = jobid;
        for (;;) {
          await new Promise((r) => setTimeout(r, 700));
          if (st.sizeJob !== jobid) { out.textContent = 'Cancelled.'; break; }
          const j = await api.jobStatus(jobid);
          if (j.finished) {
            if (j.success) {
              out.className = 'small';
              out.textContent = `${(j.output.count ?? 0).toLocaleString()} files, ${fmt.bytes(j.output.bytes)}`;
            } else { out.className = 'small text-danger'; out.textContent = j.error || 'Failed'; }
            break;
          }
        }
      } catch (e) { out.textContent = ''; showError(e, 'Could not calculate size'); }
      st.sizeJob = null;
      el('SizeBtn').disabled = false;
      el('SizeCancel').classList.add('d-none');
    }

    el('Remote').addEventListener('change', () => {
      st.remote = el('Remote').value; st.path = ''; navigate('');
    });
    el('Go').addEventListener('click', () => navigate(el('Path').value));
    el('Path').addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); navigate(el('Path').value); } });
    el('Up').addEventListener('click', () => {
      if (st.remote === LOCAL) {
        const { root, segs } = splitLocal(st.path);
        navigate(segs.length ? root + segs.slice(0, -1).join('/') : root);
      } else {
        const segs = normPath(st.path).split('/').filter(Boolean);
        navigate(segs.slice(0, -1).join('/'));
      }
    });
    el('SizeBtn').addEventListener('click', calcSize);

    // ---- "New folder" (destination only) ----
    if (allowCreate) {
      const form = el('NewForm'), input = el('NewName');
      const hideForm = () => { form.classList.add('d-none'); input.value = ''; input.classList.remove('is-invalid'); };
      el('NewBtn').addEventListener('click', () => {
        if (!api_.valid && st.remote === LOCAL) { showError(new Error('Pick or type a folder on this computer first.'), 'New folder'); return; }
        form.classList.remove('d-none'); input.focus();
      });
      el('NewCancel').addEventListener('click', hideForm);
      input.addEventListener('keydown', (ev) => { if (ev.key === 'Escape') hideForm(); });
      input.addEventListener('input', () => input.classList.remove('is-invalid'));
      form.addEventListener('submit', async (ev) => {
        ev.preventDefault();
        const name = input.value.trim();
        if (!name || name === '.' || name === '..' || /[\\/:*?"<>|]/.test(name)) {
          input.classList.add('is-invalid');
          input.title = 'Enter a name without / \\ : * ? " < > |';
          toast('Folder names cannot contain / \\ : * ? " < > |', 'warning');
          return;
        }
        input.classList.remove('is-invalid');
        const btn = el('NewOk'); btn.disabled = true;
        const base = st.path;
        try {
          // Create <current folder>/<name>, then open it.
          await api.mkdir(api_.fs, name);
          hideForm();
          toast(`Folder "${name}" created.`, 'success');
          await navigate(joinPath(api_.remoteName, base, name));
        } catch (e) {
          showError(e, 'Could not create folder');
        } finally { btn.disabled = false; }
      });
    }
    el('SizeCancel').addEventListener('click', () => {
      const j = st.sizeJob; st.sizeJob = null;
      if (j != null) api.jobStop(j).catch(() => {});
    });

    pickers.push(api_);
    return api_;
  }

  // ---------- durable migration state ----------
  // One "current migration" is kept as JSON on disk under rclone's cache dir (config/paths.cache),
  // so it survives rcd restarts, port changes (different browser origin) and closed tabs.
  // localStorage is only a fallback/cache. Written with operations/uploadfile, read with core/command cat.
  const Store = {
    dir: null, warned: false,
    async init() {
      try { const p = await api.configPaths(); this.dir = String(p.cache || '').replace(/[\\]/g, '/').replace(/\/+$/, '') + '/rclone-easy-migration'; } catch { this.dir = null; }
    },
    async load() {
      let m = null;
      if (this.dir) { try { const t = await api.readText(this.dir + '/migration.json'); if (t) m = JSON.parse(t); } catch { /* none */ } }
      if (!m) { try { const t = lsGet('rem.migration'); if (t) m = JSON.parse(t); } catch { /* ignore */ } }
      return m;
    },
    async save(m) {
      m.updatedAt = Date.now();
      const text = JSON.stringify(m);
      lsSet('rem.migration', text);
      if (!this.dir) return;
      try { await api.uploadText(this.dir, 'migration.json', text); } catch (e) {
        if (!this.warned) { this.warned = true; showError(e, 'Progress could not be saved to disk'); }
      }
    },
    async clear() {
      lsSet('rem.migration', null);
      if (this.dir) { try { await api.deleteFile(this.dir, 'migration.json'); } catch { /* ignore */ } }
    },
  };
  let mig = null; // the current migration (persisted)
  const UNFINISHED = ['running', 'interrupted', 'stopped', 'failed', 'errors'];

  // ---------- wizard state ----------
  let srcPicker, dstPicker;
  let step = 1;
  let maxStep = 1;
  let job = null;          // active/last transfer job description
  let pollTimer = null;
  let polling = false;
  let jobBusy = false;     // true while a transfer is running

  function showStep(n) {
    step = n;
    maxStep = Math.max(maxStep, n);
    for (let i = 1; i <= 4; i++) $('pane' + i).hidden = i !== n;
    document.querySelectorAll('.step').forEach((b) => {
      const i = Number(b.dataset.step);
      b.classList.toggle('active', i === n);
      b.classList.toggle('done', i < n && !jobBusy && n !== 4);
      b.disabled = !(i < n && !jobBusy && n !== 4);
      if (i === n) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    if (n === 2) { $('srcReminder').innerHTML = `<i class="bi bi-box-arrow-up-right"></i> From: <code class="fs-code">${esc(srcPicker.fs)}</code>`; checkDestination(); }
    if (n === 3) { updateSummary(); computeRoute(); }
    window.scrollTo({ top: 0 });
  }
  document.querySelectorAll('.step').forEach((b) => b.addEventListener('click', () => showStep(Number(b.dataset.step))));
  document.querySelectorAll('[data-goto]').forEach((b) => b.addEventListener('click', () => showStep(Number(b.dataset.goto))));

  // relation between source and destination
  function relation() {
    const a = srcPicker, b = dstPicker;
    if (a.remoteName !== b.remoteName) return null;
    const pa = normPath(a.path), pb = normPath(b.path);
    if (pa === pb) return 'same';
    if (pa === '' || pb.startsWith(pa + '/')) return 'dstInSrc';
    if (pb === '' || pa.startsWith(pb + '/')) return 'srcInDst';
    return null;
  }
  function checkDestination() {
    const box = $('dstProblem');
    const r = dstPicker.valid ? relation() : null;
    let html = '';
    if (r === 'same') html = '<div class="alert alert-danger mb-0"><i class="bi bi-x-octagon-fill"></i> The destination is the same folder as the source. Choose a different destination.</div>';
    else if (r === 'dstInSrc') html = '<div class="alert alert-warning mb-0"><i class="bi bi-exclamation-triangle-fill"></i> The destination is <strong>inside</strong> the source folder on the same account. Files could be copied into themselves. Make sure this is what you want.</div>';
    else if (r === 'srcInDst') html = '<div class="alert alert-warning mb-0"><i class="bi bi-exclamation-triangle-fill"></i> The source is <strong>inside</strong> the destination folder on the same account. With Sync, source files could be affected. Make sure this is what you want.</div>';
    box.innerHTML = html;
    return r;
  }

  // ---------- step navigation ----------
  $('next1').addEventListener('click', () => {
    if (!srcPicker.valid) return toast('Please type or choose a folder on your local disk first.', 'warning');
    if (!srcPicker.listOk) return toast('The source folder could not be read. Check the path or account.', 'warning');
    showStep(2);
  });
  $('next2').addEventListener('click', () => {
    if (!dstPicker.valid) return toast('Please type or choose a destination folder on your local disk first.', 'warning');
    if (!dstPicker.listOk && dstPicker.path !== '') return toast('The destination could not be read. Check the path or account.', 'warning');
    if (checkDestination() === 'same') return toast('Source and destination must be different.', 'warning');
    showStep(3);
  });

  // ---------- options ----------
  const MODES = {
    copy: { name: 'Copy', verb: 'Copying', danger: false },
    sync: { name: 'Sync', verb: 'Syncing', danger: true },
    move: { name: 'Move', verb: 'Moving', danger: true },
  };
  const getMode = () => document.querySelector('input[name=mode]:checked').value;
  function readOptions() {
    const num = (id, d) => { const v = parseInt($(id).value, 10); return v > 0 ? v : d; };
    return {
      mode: getMode(),
      dryRun: $('optDryRun').checked,
      checksum: $('optChecksum').checked,
      ignoreExisting: $('optIgnoreExisting').checked,
      transfers: num('optTransfers', 4),
      checkers: num('optCheckers', 8),
      bw: $('optBw').value.trim(),
      across: !$('acrossWrap').classList.contains('d-none') && $('optAcross').checked,
      dstRun: runDstFs(),
      exclude: $('optExclude').value.split(/\r?\n/).map((s) => s.trim()).filter(Boolean),
    };
  }
  // Backends where server-side copy across two accounts is known to work (needs permissions on both).
  const ACROSS_DEFAULT_ON = ['drive', 's3', 'google cloud storage', 'azureblob', 'b2'];
  const typeOf = (name) => (remotes.find((r) => r.name === name) || {}).type || '';
  // Google Drive destination: stop cleanly at the 750 GB/day upload limit (backend option via connection string).
  function runDstFs() {
    const n = dstPicker.remoteName;
    if (n && typeOf(n) === 'drive') return `${n},stop_on_upload_limit=true:${dstPicker.path.replace(/^\/+/, '')}`;
    return dstPicker.fs;
  }
  let routeToken = 0;
  async function computeRoute() {
    const tok = ++routeToken;
    const msg = $('routeMsg');
    msg.innerHTML = '<span class="spinner-border spinner-border-sm mt-1" aria-hidden="true"></span> Checking how data will travel…';
    $('acrossWrap').classList.add('d-none');
    $('driveNote').classList.toggle('d-none', typeOf(dstPicker.remoteName) !== 'drive');
    const sr = srcPicker.remoteName, dr = dstPicker.remoteName;
    let sf = null, df = null;
    try { [sf, df] = await Promise.all([api.fsinfo(srcPicker.fs), api.fsinfo(dstPicker.fs)]); } catch { /* fall through to generic message */ }
    if (tok !== routeToken) return;
    const sLocal = sf ? !!sf.Features.IsLocal : !sr, dLocal = df ? !!df.Features.IsLocal : !dr;
    const mode = getMode();
    const feat = df && df.Features;
    const box = (icon, cls, html) => { msg.innerHTML = `<i class="bi ${icon} ${cls} fs-4"></i><div>${html}</div>`; };
    if (sr && sr === dr && feat && (mode === 'move' ? (feat.Move || feat.Copy) : feat.Copy)) {
      box('bi-lightning-charge-fill', 'text-success', '<strong>Direct server-side transfer</strong><div class="small text-body-secondary">Data doesn\'t pass through this computer, so it is fast and uses none of your bandwidth.</div>');
    } else if (sLocal && dLocal) {
      box('bi-hdd', 'text-secondary', '<strong>Copy between folders on this computer</strong><div class="small text-body-secondary">No internet needed.</div>');
    } else if (sr && dr && sr !== dr && typeOf(sr) && typeOf(sr) === typeOf(dr) && !['alias', 'local', 'crypt', 'union', 'combine', 'chunker', 'compress'].includes(typeOf(sr))) {
      const on = ACROSS_DEFAULT_ON.includes(typeOf(sr));
      box('bi-lightning-charge', 'text-primary', `<strong>Both accounts are "${esc(typeOf(sr))}" storage</strong><div class="small text-body-secondary">A direct server-side copy between accounts may be possible. Otherwise data streams through this computer.</div>`);
      $('acrossWrap').classList.remove('d-none');
      $('optAcross').checked = on;
    } else if (sLocal || dLocal) {
      box('bi-arrow-' + (dLocal ? 'down' : 'up') + '-circle', 'text-primary', `<strong>${dLocal ? 'Downloading to' : 'Uploading from'} this computer</strong><div class="small text-body-secondary">Your internet connection is used; files are not stored in between.</div>`);
    } else {
      box('bi-arrow-left-right', 'text-primary', '<strong>Data streams through this computer</strong><div class="small text-body-secondary">No local disk space is used, but your internet bandwidth is (download + upload).</div>');
    }
    updateSummary();
  }
  $('optAcross').addEventListener('input', () => updateSummary());

  function updateSummary() {
    const o = readOptions();
    const m = MODES[o.mode];
    $('summary').innerHTML = `<strong>${m.name}</strong> <code class="fs-code">${esc(srcPicker.fs)}</code> <i class="bi bi-arrow-right"></i> <code class="fs-code">${esc(dstPicker.fs)}</code>`;
    const bits = [];
    if (o.dryRun) bits.push('dry run (no changes)');
    if (o.checksum) bits.push('checksum compare');
    if (o.ignoreExisting) bits.push('skip existing');
    if (o.bw) bits.push('limit ' + o.bw);
    if (o.across) bits.push('direct server-side copy');
    if (o.exclude.length) bits.push(o.exclude.length + ' exclude rule' + (o.exclude.length > 1 ? 's' : ''));
    bits.push(`${o.transfers} transfers, ${o.checkers} checkers`);
    $('summaryExtra').textContent = bits.join(' · ');
    $('btnStart').className = 'btn btn-lg ' + (o.dryRun ? 'btn-primary' : o.mode === 'copy' ? 'btn-success' : o.mode === 'sync' ? 'btn-danger' : 'btn-warning');
    $('btnStart').innerHTML = o.dryRun ? '<i class="bi bi-play-fill"></i> Start dry run' : '<i class="bi bi-play-fill"></i> Start migration';
  }
  ['optDryRun', 'optChecksum', 'optIgnoreExisting', 'optTransfers', 'optCheckers', 'optBw', 'optExclude']
    .forEach((i) => $(i).addEventListener('input', updateSummary));
  document.querySelectorAll('input[name=mode]').forEach((r) => r.addEventListener('change', updateSummary));

  // Verified option keys (options/get, "main" block): Transfers, Checkers, CheckSum, DryRun, IgnoreExisting.
  // Filter key: ExcludeRule.
  function buildConfig(o) {
    // Retries/LowLevelRetries make long runs more tolerant of transient errors.
    const c = { Transfers: o.transfers, Checkers: o.checkers, CheckSum: o.checksum, DryRun: o.dryRun, IgnoreExisting: o.ignoreExisting, Retries: 5, LowLevelRetries: 20 };
    if (o.across) c.ServerSideAcrossConfigs = true;
    return c;
  }
  function buildFilter(o) { return o.exclude.length ? { ExcludeRule: o.exclude } : {}; }

  $('btnStart').addEventListener('click', async () => {
    const o = readOptions();
    if (relation() === 'same') return toast('Source and destination must be different.', 'warning');
    if (!o.dryRun && MODES[o.mode].danger) {
      const warn = o.mode === 'sync'
        ? `<p>This will make <code class="fs-code">${esc(dstPicker.fs)}</code> identical to <code class="fs-code">${esc(srcPicker.fs)}</code>.</p><p class="text-danger fw-semibold mb-0">Files on the destination that are not in the source will be DELETED.</p>`
        : `<p>Files will be copied to <code class="fs-code">${esc(dstPicker.fs)}</code> and then <strong>deleted from</strong> <code class="fs-code">${esc(srcPicker.fs)}</code>.</p>`;
      const ok = await confirmDialog({
        title: o.mode === 'sync' ? 'Sync will delete files' : 'Move will delete source files',
        body: warn + '<p class="small text-body-secondary mt-2 mb-0">Tip: run a dry run first to see what would happen.</p>',
        okText: 'Start ' + MODES[o.mode].name.toLowerCase(), okClass: o.mode === 'sync' ? 'btn-danger' : 'btn-warning', check: true,
      });
      if (!ok) return;
    }
    await startJob(o);
  });

  // ---------- job lifecycle ----------
  // def (optional): {srcFs, dstFs} to resume a saved migration instead of the picker selection.
  async function startJob(o, def) {
    $('btnStart').disabled = true;
    try {
      const srcFs = def ? def.srcFs : srcPicker.fs, dstFs = def ? def.dstFs : dstPicker.fs;
      const dstRun = def ? o.dstRun : runDstFs();
      const same = mig && mig.srcFs === srcFs && mig.dstFs === dstFs && mig.mode === o.mode;
      if (!o.dryRun && !same && mig && UNFINISHED.includes(mig.status)) {
        const ok = await confirmDialog({ title: 'Replace unfinished migration?',
          body: `<p>There is an unfinished migration:</p><p><code class="fs-code">${esc(mig.srcFs)}</code> to <code class="fs-code">${esc(mig.dstFs)}</code></p><p class="mb-0">Starting a different one forgets it (files already copied stay where they are).</p>`,
          okText: 'Start new one', okClass: 'btn-warning' });
        if (!ok) return;
      }
      if (o.bw) await api.setBwLimit(o.bw);
      const { jobid } = await api.startTransfer(o.mode, srcFs, dstRun, { config: buildConfig(o), filter: buildFilter(o) });
      let executeId = null;
      try { executeId = (await api.jobStatus(jobid)).executeId; } catch { /* ignore */ }
      job = { jobid, executeId, mode: o.mode, srcFs, dstFs, dryRun: o.dryRun, bw: !!o.bw, oneWay: o.mode !== 'sync', stopped: false, startedAt: Date.now(), run: null };
      if (o.dryRun) lsSet(LS_JOB, JSON.stringify(job));
      else {
        if (!same) mig = { id: Date.now().toString(36), createdAt: Date.now(), srcFs, dstFs, mode: o.mode, opts: o, runs: [] };
        mig.opts = o;
        job.run = { jobid, executeId, startedAt: Date.now(), endedAt: null, outcome: 'running', bytes: 0, files: 0, errors: 0 };
        mig.runs.push(job.run);
        mig.status = 'running';
        await Store.save(mig);
      }
      enterJobView();
    } catch (e) {
      if (o.bw) api.setBwLimit('off').catch(() => {});
      showError(e, 'Could not start');
    } finally { $('btnStart').disabled = false; }
  }

  function enterJobView() {
    jobBusy = true;
    $('verifyArea').innerHTML = '';
    $('resultArea').innerHTML = '';
    $('lastError').classList.add('d-none');
    $('activeList').innerHTML = '';
    $('activeCard').classList.remove('d-none');
    $('stDeletesWrap').classList.toggle('d-none', job.mode === 'copy');
    $('h4').textContent = (job.dryRun ? 'Dry run: ' : '') + MODES[job.mode].verb + '…';
    $('jobTitle').innerHTML = `<code class="fs-code">${esc(job.srcFs)}</code> <i class="bi bi-arrow-right"></i> <code class="fs-code">${esc(job.dstFs)}</code>`;
    setBadge('Running', 'primary');
    setBar(0, true, 'primary');
    ['btnVerify', 'btnRunReal', 'btnNew', 'btnResume'].forEach((b) => $(b).classList.add('d-none'));
    $('btnStop').classList.remove('d-none');
    $('btnStop').disabled = false;
    $('scanNote').classList.remove('d-none');
    showStep(4);
    startPolling();
  }

  function setBadge(text, kind) { const b = $('jobBadge'); b.textContent = text; b.className = 'badge text-bg-' + kind; }
  function setBar(pct, animated, kind, indeterminate) {
    const bar = $('pb');
    bar.style.width = (indeterminate ? 100 : pct) + '%';
    bar.className = 'progress-bar' + (animated ? ' progress-bar-striped progress-bar-animated' : '') + ' bg-' + kind;
    $('pbWrap').setAttribute('aria-valuenow', String(Math.round(pct)));
    $('pbPct').textContent = indeterminate ? '' : Math.round(pct) + '%';
  }

  function startPolling() {
    stopPolling();
    polling = true;
    const tick = async () => {
      if (!polling) return;
      let finished = false;
      try { finished = await pollOnce(); } catch (e) {
        if (e.status === 0) setBadge('Connection lost', 'warning'); // keep retrying
        else { showError(e); }
      }
      if (polling && !finished) pollTimer = setTimeout(tick, 1000);
    };
    tick();
  }
  function stopPolling() { polling = false; clearTimeout(pollTimer); }

  async function pollOnce() {
    const [j, s] = await Promise.all([api.jobStatus(job.jobid), api.stats(job.jobid)]);
    renderStats(s, j);
    if (job.run && !j.finished && Date.now() - (job.lastSave || 0) > 5000) {
      job.lastSave = Date.now();
      Object.assign(job.run, { bytes: s.bytes || 0, files: s.transfers || 0, errors: s.errors || 0, totalBytes: s.totalBytes || 0, totalFiles: s.totalTransfers || 0 });
      Store.save(mig);
    }
    if (j.finished) { stopPolling(); await onFinished(j, s); return true; }
    return false;
  }

  function renderStats(s, j) {
    const finished = j && j.finished;
    const total = s.totalBytes || 0, done = s.bytes || 0;
    const pct = total ? Math.min(100, (done / total) * 100) : 0;
    if (!finished) setBar(pct, true, 'primary', !total);
    $('pbLabel').textContent = `${fmt.bytes(done)} of ${fmt.bytes(total)}`;
    $('stBytes').textContent = fmt.bytes(done);
    $('stSpeed').textContent = finished ? '—' : fmt.speed(s.speed);
    $('stEta').textContent = finished ? '—' : (s.eta != null ? fmt.duration(s.eta) : '—');
    $('stElapsed').textContent = fmt.duration(finished && j.duration != null ? j.duration : s.elapsedTime);
    $('stFiles').textContent = `${(s.transfers || 0).toLocaleString()} / ${(s.totalTransfers || 0).toLocaleString()}`;
    $('stChecks').textContent = `${(s.checks || 0).toLocaleString()} / ${(s.totalChecks || 0).toLocaleString()}`;
    $('stErrors').textContent = (s.errors || 0).toLocaleString();
    $('stErrors').classList.toggle('text-danger', (s.errors || 0) > 0);
    $('stDeletes').textContent = ((s.deletes || 0) + (s.deletedDirs || 0)).toLocaleString();
    const le = $('lastError');
    if (s.lastError) { le.textContent = 'Last error: ' + s.lastError; le.classList.remove('d-none'); } else le.classList.add('d-none');
    const list = $('activeList');
    const tr = finished ? [] : (s.transferring || []);
    if (!tr.length) {
      list.innerHTML = `<li class="list-group-item small text-body-secondary">${finished ? 'Nothing running.' : 'Waiting for files…'}</li>`;
    } else {
      list.innerHTML = tr.map((t) => {
        const p = t.percentage || 0;
        return `<li class="list-group-item"><div class="d-flex justify-content-between gap-2 small">
          <span class="text-truncate" title="${esc(t.name)}">${esc(t.name)}</span>
          <span class="text-nowrap text-body-secondary">${p}% · ${fmt.speed(t.speed)}</span></div>
          <div class="progress mt-1" style="height:.4rem" role="progressbar" aria-label="${esc(t.name)}" aria-valuenow="${p}" aria-valuemin="0" aria-valuemax="100"><div class="progress-bar" style="width:${p}%"></div></div></li>`;
      }).join('');
    }
  }

  async function onFinished(j, s, historic) {
    jobBusy = false;
    if (job.bw) { api.setBwLimit('off').catch(() => {}); job.bw = false; }
    $('btnStop').classList.add('d-none');
    $('scanNote').classList.add('d-none');
    $('activeCard').classList.add('d-none');
    $('btnNew').classList.remove('d-none');
    const errors = s.errors || 0;
    let kind, title, icon;
    if (job.stopped) { kind = 'warning'; title = 'Stopped'; icon = 'bi-stop-circle-fill'; }
    else if (!j.success) { kind = 'danger'; title = 'Failed'; icon = 'bi-x-octagon-fill'; }
    else if (errors > 0) { kind = 'warning'; title = 'Finished with errors'; icon = 'bi-exclamation-triangle-fill'; }
    else { kind = 'success'; title = job.dryRun ? 'Dry run finished' : 'Migration complete'; icon = 'bi-check-circle-fill'; }
    setBadge(title, kind);
    if (job.run && !historic) {
      const outcome = job.stopped ? 'stopped' : !j.success ? 'failed' : errors > 0 ? 'errors' : 'completed';
      Object.assign(job.run, { endedAt: Date.now(), outcome, bytes: s.bytes || 0, files: s.transfers || 0, errors, totalBytes: s.totalBytes || 0, totalFiles: s.totalTransfers || 0, duration: j.duration, error: j.error || '' });
      mig.status = outcome;
      await Store.save(mig);
    }
    if (!job.dryRun) lsSet(LS_JOB, null); else lsSet(LS_JOB, JSON.stringify(job));
    const total = s.totalBytes || 0;
    setBar(job.stopped || !j.success ? (total ? (s.bytes / total) * 100 : 0) : 100, false, kind);
    $('h4').textContent = title;
    const dels = (s.deletes || 0);
    $('resultArea').innerHTML = `<div class="alert alert-${kind} mb-3" role="alert">
      <h2 class="h6 alert-heading"><i class="bi ${icon}"></i> ${esc(title)}</h2>
      <ul class="mb-0 ps-3">
        <li>${job.dryRun ? 'Would transfer' : 'Transferred'} ${(s.transfers || 0).toLocaleString()} file(s), ${fmt.bytes(s.bytes)}</li>
        ${job.mode !== 'copy' ? `<li>${job.dryRun ? 'Would delete' : 'Deleted'} ${dels.toLocaleString()} file(s)</li>` : ''}
        <li>Took ${fmt.duration(j.duration != null ? j.duration : s.elapsedTime)}; ${errors} error(s)</li>
        ${job.dryRun ? '<li><strong>Nothing was changed</strong> (dry run).</li>' : ''}
        ${j.error && !job.stopped ? `<li class="text-break">${esc(j.error)}</li>` : ''}
      </ul></div>`;
    const canVerify = !job.dryRun && job.mode !== 'move' && j.success && errors === 0;
    const canRetry = !job.dryRun && !historic && !(j.success && errors === 0);
    $('btnResume').classList.toggle('d-none', !canRetry);
    $('btnResumeLbl').textContent = job.stopped ? 'Resume' : 'Retry (resume)';
    if (canRetry) $('resultArea').insertAdjacentHTML('beforeend', '<p class="small text-body-secondary mb-3"><i class="bi bi-info-circle"></i> Retrying skips files that were already copied.</p>');
    $('btnVerify').classList.toggle('d-none', !canVerify);
    $('btnRunReal').classList.toggle('d-none', !job.dryRun);
    if (!job.dryRun && job.mode === 'move' && j.success) {
      $('verifyArea').innerHTML = '<div class="small text-body-secondary">Verification isn\'t offered after a Move because the source files were moved away.</div>';
    }
    showStep(4);
  }

  $('btnStop').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Stop migration?', body: 'Transfers in progress will be cancelled. Files already copied stay where they are.',
      okText: 'Stop', okClass: 'btn-danger',
    });
    if (!ok || !job) return;
    try { job.stopped = true; lsSet(LS_JOB, JSON.stringify(job)); await api.jobStop(job.jobid); $('btnStop').disabled = true; } catch (e) { showError(e, 'Could not stop'); }
  });

  $('btnNew').addEventListener('click', () => {
    stopPolling();
    job = null; jobBusy = false; lsSet(LS_JOB, null);
    maxStep = 1;
    showStep(1);
    renderResume();
  });

  $('btnRunReal').addEventListener('click', () => {
    $('optDryRun').checked = false;
    jobBusy = false;
    showStep(3);
    updateSummary();
    toast('Dry run turned off. Review the summary and start when ready.', 'info');
  });

  // ---------- verify (operations/check) ----------
  $('btnVerify').addEventListener('click', async () => {
    const area = $('verifyArea');
    $('btnVerify').disabled = true;
    area.innerHTML = '<div class="d-flex align-items-center gap-2 text-body-secondary"><span class="spinner-border spinner-border-sm" aria-hidden="true"></span> Verifying… this compares every file.</div>';
    try {
      // Copy: only source files must exist on the destination (oneWay). Sync: both sides must match.
      const { jobid } = await api.startCheck(job.srcFs, job.dstFs, { oneWay: job.oneWay });
      let j;
      for (;;) {
        await new Promise((r) => setTimeout(r, 1000));
        j = await api.jobStatus(jobid);
        if (j.finished) break;
      }
      const out = j.output || {};
      renderCheck(j, out);
    } catch (e) { area.innerHTML = ''; showError(e, 'Verify failed'); }
    $('btnVerify').disabled = false;
  });

  function renderCheck(j, out) {
    const differ = out.differ || [], mDst = out.missingOnDst || [], mSrc = out.missingOnSrc || [], errs = out.error || [];
    const bad = differ.length + mDst.length + errs.length + (job.oneWay ? 0 : mSrc.length);
    const ok = j.success && out.success && bad === 0;
    const section = (title, arr) => !arr.length ? '' : `<div class="mt-2"><div class="fw-semibold small">${esc(title)} (${arr.length.toLocaleString()})</div>
      <ul class="problem-list list-unstyled font-monospace mb-0 ps-2">${arr.slice(0, 20).map((p) => `<li class="text-break">${esc(p)}</li>`).join('')}${arr.length > 20 ? `<li class="text-body-secondary">… and ${(arr.length - 20).toLocaleString()} more</li>` : ''}</ul></div>`;
    $('verifyArea').innerHTML = `<div class="card border-${ok ? 'success' : 'danger'}"><div class="card-body">
      <h2 class="h6"><i class="bi ${ok ? 'bi-shield-check text-success' : 'bi-shield-exclamation text-danger'}"></i> ${ok ? 'Verified: source and destination match' : 'Verification found problems'}</h2>
      <div class="small text-body-secondary">${esc(out.status || j.error || '')}${out.hashType ? ' · compared by ' + esc(out.hashType) + ' hash' : ''}</div>
      ${section('Different content', differ)}${section('Missing on destination', mDst)}${job.oneWay ? '' : section('Missing on source', mSrc)}${section('Could not be compared', errs)}
      </div></div>`;
  }

  // ---------- navbar buttons ----------
  function openRemotes() {
    if (window.Remotes && typeof window.Remotes.open === 'function') window.Remotes.open();
    else alert('The remote manager is not available.\n\nTo add or edit cloud accounts, run "rclone config" in a terminal, then reload this page.');
  }
  $('btnRemotes').addEventListener('click', openRemotes);
  document.querySelectorAll('[data-action=open-remotes]').forEach((b) => b.addEventListener('click', openRemotes));

  $('btnQuit').addEventListener('click', async () => {
    const ok = await confirmDialog({
      title: 'Quit rclone Easy Migration?',
      body: jobBusy ? '<p class="text-danger fw-semibold">A migration is still running and will be stopped.</p>' : 'This stops rclone and closes the app.',
      okText: 'Quit', okClass: 'btn-danger',
    });
    if (!ok) return;
    try { await api.quit(); } catch { /* server may drop the connection while exiting */ }
    stopPolling();
    $('mainView').classList.add('d-none');
    $('byeView').classList.remove('d-none');
  });

  // ---------- init ----------
  async function init() {
    srcPicker = createPicker('srcPicker', 'src', { mustExist: true });
    dstPicker = createPicker('dstPicker', 'dst', { mustExist: false, allowCreate: true });
    dstPicker.onChange = () => { if (step === 2) checkDestination(); };
    api.version().then((v) => { $('versionBadge').textContent = 'rclone ' + v.version; }).catch(() => {});
    if (window.Remotes && typeof window.Remotes.onChange === 'function') window.Remotes.onChange(() => refreshRemoteLists());
    await refreshRemoteLists();
    showStep(1);

    await Store.init();
    mig = await Store.load();
    // Reattach to a job that is still running in this rclone process (same executeId), else mark interrupted.
    if (mig && mig.status === 'running') {
      const r = mig.runs[mig.runs.length - 1];
      let j = null;
      try { j = await api.jobStatus(r.jobid); } catch { /* not found */ }
      if (j && (!r.executeId || j.executeId === r.executeId)) {
        job = { jobid: r.jobid, executeId: r.executeId, mode: mig.mode, srcFs: mig.srcFs, dstFs: mig.dstFs, dryRun: false,
                bw: !!(mig.opts && mig.opts.bw), oneWay: mig.mode !== 'sync', stopped: false, startedAt: r.startedAt, run: r };
        enterJobView();
        return;
      }
      r.outcome = 'interrupted'; r.endedAt = r.endedAt || mig.updatedAt;
      mig.status = 'interrupted';
      await Store.save(mig);
    }
    const saved = lsGet(LS_JOB); // dry runs only
    if (saved) {
      try {
        job = JSON.parse(saved);
        const j = await api.jobStatus(job.jobid);
        if (job.executeId && j.executeId !== job.executeId) throw new Error('gone');
        enterJobView();
        return;
      } catch (e) { job = null; lsSet(LS_JOB, null); }
    }
    renderResume();
  }

  // ---------- landing: resume card ----------
  const STATUS = {
    running: ['Running', 'primary'], interrupted: ['Interrupted', 'warning'], stopped: ['Stopped', 'warning'],
    failed: ['Failed', 'danger'], errors: ['Finished with errors', 'warning'], completed: ['Completed', 'success'],
  };
  function renderResume() {
    const box = $('resumeCard');
    if (!mig || !mig.runs || !mig.runs.length) { box.classList.add('d-none'); return; }
    const [label, kind] = STATUS[mig.status] || ['Unknown', 'secondary'];
    const unfinished = UNFINISHED.includes(mig.status);
    const last = mig.runs[mig.runs.length - 1];
    const bytes = mig.runs.reduce((a, r) => a + (r.bytes || 0), 0);
    const files = mig.runs.reduce((a, r) => a + (r.files || 0), 0);
    const pct = last.totalBytes ? Math.min(100, Math.round(((last.bytes || 0) / last.totalBytes) * 100)) : null;
    const when = (t) => t ? new Date(t).toLocaleString() : '-';
    const lastErr = mig.status === 'errors' ? `${last.errors} error(s) in the last run. ` : '';
    box.innerHTML = `<div class="card border-${kind}"><div class="card-body">
      <div class="d-flex flex-wrap align-items-center gap-2 mb-1">
        <h2 class="h5 mb-0">${unfinished ? 'Unfinished migration' : 'Last migration'}</h2>
        <span class="badge text-bg-${kind}">${label}</span>
      </div>
      <p class="mb-2 text-break"><strong>${esc(MODES[mig.mode].name)}</strong> <code class="fs-code">${esc(mig.srcFs)}</code> <i class="bi bi-arrow-right"></i> <code class="fs-code">${esc(mig.dstFs)}</code></p>
      <div class="small text-body-secondary mb-2">${esc(lastErr)}${mig.runs.length} run(s) so far, ${files.toLocaleString()} file(s) and ${fmt.bytes(bytes)} copied${pct != null && unfinished ? `; last run reached ${pct}% of what it had found` : ''}.<br>
        Started ${esc(when(mig.createdAt))} &middot; last update ${esc(when(mig.updatedAt))}</div>
      ${unfinished ? '<p class="small mb-3"><i class="bi bi-shield-check"></i> Safe to stop anytime - already copied files are skipped when you resume.</p>' : ''}
      <div class="d-flex flex-wrap gap-2">
        ${unfinished ? `<button class="btn btn-success" type="button" id="rcResume"><i class="bi bi-arrow-clockwise"></i> ${mig.status === 'errors' || mig.status === 'failed' ? 'Retry' : 'Resume migration'}</button>` : ''}
        ${mig.status === 'completed' && mig.mode !== 'move' ? '<button class="btn btn-outline-primary" type="button" id="rcVerify"><i class="bi bi-shield-check"></i> Verify</button>' : ''}
        <button class="btn btn-outline-secondary" type="button" id="rcForget">${unfinished ? 'Discard' : 'Dismiss'}</button>
      </div></div></div>`;
    box.classList.remove('d-none');
    const r = $('rcResume');
    if (r) r.addEventListener('click', () => { r.disabled = true; startJob(Object.assign({}, mig.opts, { dryRun: false }), { srcFs: mig.srcFs, dstFs: mig.dstFs }).finally(() => { r.disabled = false; }); });
    const v = $('rcVerify');
    if (v) v.addEventListener('click', openHistoric);
    $('rcForget').addEventListener('click', async () => {
      if (unfinished && !(await confirmDialog({ title: 'Discard migration?', body: 'Forget this migration. Files already copied stay where they are.', okText: 'Discard', okClass: 'btn-danger' }))) return;
      await Store.clear(); mig = null; renderResume();
    });
  }
  $('btnResume').addEventListener('click', () => {
    startJob(Object.assign({}, mig.opts, { dryRun: false }), { srcFs: mig.srcFs, dstFs: mig.dstFs });
  });
  // Show the finished view for a completed saved migration (for Verify).
  function openHistoric() {
    const last = mig.runs[mig.runs.length - 1];
    job = { jobid: last.jobid, mode: mig.mode, srcFs: mig.srcFs, dstFs: mig.dstFs, dryRun: false, bw: false, oneWay: mig.mode !== 'sync', stopped: false, run: null };
    enterJobView(); stopPolling();
    onFinished({ success: true, duration: last.duration }, { errors: 0, transfers: last.files, bytes: last.bytes, totalBytes: last.totalBytes, deletes: 0 }, true);
  }
  // Desktop app: closing the window while a migration is running asks first.
  if (window.Desktop) {
    let asking = false;
    window.Desktop.onCloseRequested(async () => {
      if (asking) return;
      if (jobBusy) {
        asking = true;
        const ok = await confirmDialog({
          title: 'Close rclone Easy Migration?',
          body: '<p class="text-danger fw-semibold">A migration is running. Closing stops it - you can resume later.</p>',
          okText: 'Close and stop', okClass: 'btn-danger',
        });
        asking = false;
        if (!ok) return;
      }
      api.quit();
    });
  }

  // In the desktop app rclone may still be missing: show the setup screen first.
  (async () => {
    try {
      const info = await api.init();
      if (window.Desktop) window.Desktop.refreshAwake();
      if (info && info.state !== 'ready') await window.Desktop.setup(info);
    } catch (e) { showError(e, 'Could not start rclone'); return; }
    init();
  })();
})();

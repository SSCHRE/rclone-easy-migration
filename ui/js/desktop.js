// Desktop-app (Tauri) glue: setup screen when rclone is missing, window-close handling,
// external links in the system browser, keep-awake switch. Does nothing in a plain browser.
(function () {
  'use strict';
  const T = window.__TAURI__;
  if (!T || !T.core) return;
  const invoke = T.core.invoke;
  const esc = (s) => api.fmt.escape(s);
  const $ = (id) => document.getElementById(id);

  const Desktop = {};
  window.Desktop = Desktop;

  // ---- window close ----
  // Rust cancels the close and emits this event; app.js replaces the handler to confirm when busy.
  let closeHandler = () => invoke('quit_app');
  Desktop.onCloseRequested = (fn) => { closeHandler = fn; };
  T.event.listen('rem://close-requested', () => { Promise.resolve(closeHandler()).catch(() => invoke('quit_app')); });

  // ---- external links open in the system browser ----
  document.addEventListener('click', (e) => {
    const a = e.target.closest && e.target.closest('a[href]');
    if (!a) return;
    const href = a.getAttribute('href') || '';
    if (/^(https?:|mailto:)/i.test(href)) {
      e.preventDefault();
      invoke('plugin:opener|open_url', { url: href }).catch(() => {});
    }
  });

  // ---- navbar menu items ----
  document.querySelectorAll('.desktop-only').forEach((el) => el.classList.remove('d-none'));
  const awake = $('awakeItem');
  function paintAwake(on) {
    awake.querySelector('i').className = 'bi me-2 ' + (on ? 'bi-check2-square' : 'bi-square');
  }
  awake.addEventListener('click', async () => {
    const cur = awake.querySelector('i').classList.contains('bi-check2-square');
    try { paintAwake(await invoke('set_keep_awake', { enabled: !cur })); } catch { /* ignore */ }
  });
  $('logsItem').addEventListener('click', () => invoke('open_logs_folder').catch(() => {}));
  paintAwake(!!(api.info && api.info.keepAwake));
  Desktop.refreshAwake = () => paintAwake(!!(api.info && api.info.keepAwake));

  // ---- setup screen (rclone missing / failed to start) ----
  function fmtMB(n) { return (n / 1048576).toFixed(1) + ' MB'; }

  Desktop.setup = (info) => new Promise((resolve) => {
    const main = $('mainView');
    main.classList.add('d-none');
    const box = document.createElement('main');
    box.className = 'container py-5';
    box.style.maxWidth = '640px';
    document.body.insertBefore(box, main);

    const done = (newInfo) => {
      api.applyInfo(newInfo);
      box.remove();
      main.classList.remove('d-none');
      Desktop.refreshAwake();
      resolve();
    };
    let busy = false;

    function render(cur, msg) {
      const missing = cur.state === 'missing';
      box.innerHTML = `
        <div class="text-center mb-4"><i class="bi ${missing ? 'bi-cloud-download' : 'bi-exclamation-triangle'} display-3 ${missing ? 'text-primary' : 'text-danger'}"></i></div>
        <h1 class="h3 text-center">${missing ? 'rclone is needed' : 'rclone could not be started'}</h1>
        ${missing ? `<p class="text-body-secondary text-center">This app uses <strong>rclone</strong> to copy your files. It was not found on this computer (looked at your PATH and the usual install folders).</p>`
          : `<div class="alert alert-danger text-break" style="white-space:pre-wrap">${esc(cur.error)}</div>
             ${cur.logPath ? `<p class="small text-body-secondary text-break">Log file: <code>${esc(cur.logPath)}</code></p>` : ''}`}
        ${msg ? `<div class="alert alert-danger text-break">${esc(msg)}</div>` : ''}
        <div class="d-grid gap-2 my-4">
          <button class="btn btn-primary btn-lg" type="button" id="suDownload"><i class="bi bi-download"></i> Download rclone automatically</button>
          <button class="btn btn-outline-secondary" type="button" id="suChoose"><i class="bi bi-folder2-open"></i> Choose rclone file&hellip;</button>
        </div>
        <div class="progress d-none" id="suProgress" role="progressbar" style="height:1.4rem"><div class="progress-bar" id="suBar" style="width:0%"></div></div>
        <p class="small text-center text-body-secondary mt-2" id="suStatus"></p>
        <p class="small text-center">Or install it yourself from <a href="https://rclone.org/downloads/">rclone.org/downloads</a>, then restart this app.
          The automatic download is checked against rclone's published SHA256 checksum and stored only for this app.</p>
        <div class="text-center mt-4"><button class="btn btn-sm btn-outline-danger" type="button" id="suQuit"><i class="bi bi-power"></i> Quit</button>
          ${cur.state === 'error' ? ' <button class="btn btn-sm btn-outline-secondary" type="button" id="suLogs"><i class="bi bi-folder2-open"></i> Open log folder</button>' : ''}</div>`;
      const setBusy = (b) => { busy = b; box.querySelectorAll('button').forEach((x) => { if (x.id !== 'suQuit') x.disabled = b; }); };
      const fail = (e) => render(cur, String(e && e.message ? e.message : e));
      const finish = (r) => { if (r.state === 'ready') done(r); else render(r, r.state === 'missing' ? 'rclone was not found.' : ''); };

      $('suQuit').addEventListener('click', () => invoke('quit_app'));
      const logs = $('suLogs'); if (logs) logs.addEventListener('click', () => invoke('open_logs_folder'));
      $('suDownload').addEventListener('click', async () => {
        setBusy(true);
        $('suProgress').classList.remove('d-none');
        const un = await T.event.listen('rclone-download-progress', (ev) => {
          const p = ev.payload, bar = $('suBar'), st = $('suStatus');
          if (!bar) return;
          const label = { lookup: 'Looking up the latest version...', verify: 'Verifying checksum...', install: 'Installing...', done: 'Starting rclone...' }[p.stage];
          if (p.stage === 'download') {
            const pct = p.total ? Math.round((p.received / p.total) * 100) : 0;
            bar.style.width = (p.total ? pct : 100) + '%';
            bar.textContent = p.total ? pct + '%' : '';
            st.textContent = `Downloading... ${fmtMB(p.received)}${p.total ? ' of ' + fmtMB(p.total) : ''}`;
          } else { bar.style.width = '100%'; st.textContent = label || ''; }
        });
        try { finish(await invoke('download_rclone')); } catch (e) { fail(e); } finally { un(); }
      });
      $('suChoose').addEventListener('click', async () => {
        let sel;
        try { sel = await T.dialog.open({ title: 'Choose the rclone program', multiple: false, directory: false }); } catch (e) { return fail(e); }
        if (!sel) return;
        setBusy(true);
        try { finish(await invoke('set_rclone_path', { path: Array.isArray(sel) ? sel[0] : sel })); } catch (e) { fail(e); }
      });
    }
    render(info);
  });
})();

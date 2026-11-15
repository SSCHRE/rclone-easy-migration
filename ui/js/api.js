// Thin wrapper around the rclone remote-control (rc) API.
// The UI is served by `rclone rcd --rc-files ui`, so every rc call is same-origin.
// Basic-auth credentials are cached by the browser after the initial page load
// (the launcher opens http://user:pass@127.0.0.1:port/), so fetch() reuses them.
// Docs: https://rclone.org/rc/
(function () {
  'use strict';

  // Absolute base URL. The launcher opens http://user:pass@host/, and browsers refuse fetch()
  // with a relative URL on such a page ("Request cannot be constructed from a URL that includes
  // credentials"). location.origin never contains credentials; the browser still sends the cached
  // basic-auth header for this origin.
  // In the desktop app (Tauri) the UI is not served by rclone: api.init() asks the Rust side for the
  // rc URL + credentials and every request carries an explicit Authorization header.
  let BASE = location.origin;
  let AUTH = null;
  const TAURI = window.__TAURI__ && window.__TAURI__.core ? window.__TAURI__ : null;
  const authHeaders = (h = {}) => (AUTH ? Object.assign({ Authorization: AUTH }, h) : h);

  class RcError extends Error {
    constructor(message, status, body) {
      super(message);
      this.name = 'RcError';
      this.status = status;
      this.body = body;
    }
  }

  async function rc(method, params = {}) {
    let res;
    try {
      res = await fetch(BASE + '/' + method.replace(/^\//, ''), {
        method: 'POST',
        credentials: 'same-origin',
        headers: authHeaders({ 'Content-Type': 'application/json' }),
        body: JSON.stringify(params),
      });
    } catch (e) {
      throw new RcError('Cannot reach rclone. It may have stopped - restart the app.', 0, null);
    }
    let body = null;
    const text = await res.text();
    try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
    if (!res.ok) {
      throw new RcError((body && body.error) || `${method} failed (HTTP ${res.status})`, res.status, body);
    }
    return body;
  }

  // Build an rclone fs string from a remote name and a path.
  // remote: "gdrive" (no colon) or "" for local disk; path: "folder/sub".
  function fsString(remote, path = '') {
    const p = (path || '').replace(/^\/+/, '');
    if (!remote) return p || '/';
    return `${remote}:${p}`;
  }

  const api = {
    rc,
    RcError,
    fsString,

    version: () => rc('core/version'),
    quit: () => (TAURI ? TAURI.core.invoke('quit_app') : rc('core/quit')),

    // Desktop app: true when running inside Tauri.
    isDesktop: !!TAURI,
    // Desktop app: ask the Rust side for rclone's state. Returns the info object, or null in browser mode.
    // When info.state === 'ready' the rc URL and credentials are applied to all later calls.
    init: async () => {
      if (!TAURI) return null;
      return api.applyInfo(await TAURI.core.invoke('rclone_info'));
    },
    applyInfo: (info) => {
      if (info && info.state === 'ready') {
        BASE = String(info.url).replace(/\/+$/, '');
        AUTH = 'Basic ' + btoa(info.user + ':' + info.pass);
      }
      api.info = info;
      return info;
    },

    // --- config ---
    listRemotes: async () => (await rc('config/listremotes')).remotes || [],
    dumpConfig: () => rc('config/dump'),                  // { name: {type, ...}, ... }
    getRemote: (name) => rc('config/get', { name }),
    providers: async () => (await rc('config/providers')).providers || [],
    createRemote: (name, type, parameters = {}, opt = {}) =>
      rc('config/create', { name, type, parameters, opt }),
    updateRemote: (name, parameters = {}, opt = {}) =>
      rc('config/update', { name, parameters, opt }),
    deleteRemote: (name) => rc('config/delete', { name }),

    // --- browsing ---
    // Returns array of {Path, Name, Size, MimeType, ModTime, IsDir}
    listDirs: async (fs, remote = '') =>
      (await rc('operations/list', { fs, remote, opt: { dirsOnly: true } })).list || [],
    list: async (fs, remote = '', opt = {}) =>
      (await rc('operations/list', { fs, remote, opt })).list || [],
    about: (fs) => rc('operations/about', { fs }),        // {total, used, free, ...} (not all backends)
    size: (fs) => rc('operations/size', { fs }),          // {count, bytes} — can be slow on big trees
    mkdir: (fs, remote) => rc('operations/mkdir', { fs, remote }),

    // --- transfers (always async; returns {jobid}) ---
    // mode: 'copy' | 'sync' | 'move'
    // _config / _filter let us set per-job options: https://rclone.org/rc/#setting-config-flags-with-config
    startTransfer: (mode, srcFs, dstFs, { config = {}, filter = {}, createEmptySrcDirs = true } = {}) => {
      const params = { srcFs, dstFs, _async: true, _config: config, _filter: filter, createEmptySrcDirs };
      return rc(`sync/${mode}`, params);
    },
    // Verify source vs destination. Returns {jobid} when async.
    startCheck: (srcFs, dstFs, { oneWay = true, download = false, config = {} } = {}) =>
      rc('operations/check', { srcFs, dstFs, oneWay, download, _async: true, _config: config }),

    // --- jobs & stats ---
    jobStatus: (jobid) => rc('job/status', { jobid }),
    jobStop: (jobid) => rc('job/stop', { jobid }),
    jobList: () => rc('job/list'),
    // Stats for an async job live in group "job/<id>".
    stats: (jobid) => rc('core/stats', jobid != null ? { group: `job/${jobid}` } : {}),
    transferred: (jobid) => rc('core/transferred', jobid != null ? { group: `job/${jobid}` } : {}),
    resetStats: (jobid) => rc('core/stats-reset', jobid != null ? { group: `job/${jobid}` } : {}),
    fsinfo: (fs) => rc('operations/fsinfo', { fs }),     // {Name, Root, String, Features:{Copy, Move, IsLocal,...}, Hashes}
    configPaths: () => rc('config/paths'),               // {cache, config, temp}
    // Write a small text file into a local directory (created if missing) via multipart upload.
    uploadText: async (dir, name, text) => {
      const fd = new FormData();
      fd.append('file', new Blob([text], { type: 'application/json' }), name);
      const res = await fetch(BASE + '/operations/uploadfile?fs=' + encodeURIComponent(dir) + '&remote=', {
        method: 'POST', credentials: 'same-origin', headers: authHeaders(), body: fd });
      if (!res.ok) throw new RcError('Could not save state (HTTP ' + res.status + ')', res.status, null);
    },
    // Read a small local text file via core/command cat. Returns null if it does not exist.
    readText: async (path) => {
      const r = await rc('core/command', { command: 'cat', arg: [path] });
      return r.error ? null : r.result;
    },
    deleteFile: (fs, remote) => rc('operations/deletefile', { fs, remote }),
    setBwLimit: (rate) => rc('core/bwlimit', { rate }), // e.g. "10M" or "off"
  };

  // --- small shared helpers ---
  api.fmt = {
    bytes(n) {
      if (n == null || isNaN(n) || n < 0) return '—';
      const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB', 'PiB'];
      let i = 0; let v = Number(n);
      while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
      return `${v.toFixed(i === 0 ? 0 : v < 10 ? 2 : 1)} ${u[i]}`;
    },
    speed(bps) { return bps ? `${api.fmt.bytes(bps)}/s` : '—'; },
    duration(sec) {
      if (sec == null || isNaN(sec) || sec < 0) return '—';
      sec = Math.round(sec);
      const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
      return h ? `${h}h ${m}m` : m ? `${m}m ${s}s` : `${s}s`;
    },
    escape(s) {
      return String(s ?? '').replace(/[&<>"']/g, (c) =>
        ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    },
  };

  // Cancelable rc call (used for long blocking calls such as OAuth sign-in).
  // Returns { promise, abort }. Aborting makes rclone cancel the server-side call too.
  api.rcCancelable = (method, params = {}) => {
    const ctl = new AbortController();
    const promise = (async () => {
      let res;
      try {
        res = await fetch(BASE + '/' + method.replace(/^\//, ''), {
          method: 'POST', credentials: 'same-origin', signal: ctl.signal,
          headers: authHeaders({ 'Content-Type': 'application/json' }), body: JSON.stringify(params),
        });
      } catch (e) {
        if (e && e.name === 'AbortError') { const err = new RcError('Cancelled', 0, null); err.aborted = true; throw err; }
        throw new RcError('Cannot reach rclone. It may have stopped - restart the app.', 0, null);
      }
      const text = await res.text();
      let body; try { body = text ? JSON.parse(text) : {}; } catch { body = { error: text }; }
      if (!res.ok) throw new RcError((body && body.error) || `${method} failed (HTTP ${res.status})`, res.status, body);
      return body;
    })();
    return { promise, abort: () => ctl.abort() };
  };

  window.api = api;
})();

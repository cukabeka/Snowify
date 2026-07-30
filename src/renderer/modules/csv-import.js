/**
 * csv-import.js  (Spotify / TuneMyMusic CSV import)
 *
 * To avoid circular deps (library.js ↔ csv-import.js), the library helpers are
 * injected when the function is called.  See library.js for the call-site.
 */

import { escapeHtml, showToast } from './utils.js';
import { callbacks } from './callbacks.js';

const $ = (sel, ctx = document) => ctx.querySelector(sel);

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseSpotifyPlaylistUrl(url) {
  if (typeof url !== 'string') return null;
  const trimmed = url.trim();
  if (!trimmed) return null;
  const withoutHash = trimmed.replace(/#[^/]*$/, '');
  const match = withoutHash.match(/(?:https?:\/\/)?(?:open\.spotify\.com\/|spotify\.link\/)?playlist\/([a-zA-Z0-9]+)/i);
  if (!match) return null;
  return { id: match[1], url: withoutHash };
}

function collectTrackEntries(node, out, seen) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    node.forEach(item => collectTrackEntries(item, out, seen));
    return;
  }

  if (typeof node.uri === 'string' && node.uri.startsWith('spotify:track:')) {
    const title = normalizeText(node.name || node.title || '');
    const artists = Array.isArray(node.artists)
      ? node.artists.map(a => normalizeText(a?.name || a?.title || '')).filter(Boolean)
      : [];
    const artist = artists.length ? artists.join(', ') : normalizeText(node.artist || '');
    if (title && artist) {
      const key = `${title.toLowerCase()}::${artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ title, artist });
      }
    }
  }

  if (node.track && typeof node.track === 'object') {
    collectTrackEntries(node.track, out, seen);
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object' && value !== node.track) {
      collectTrackEntries(value, out, seen);
    }
  }
}

function extractTracksFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();
  const candidates = [];
  const stack = [];
  let start = -1;

  for (let i = 0; i < html.length; i++) {
    const ch = html[i];
    if ((ch === '{' || ch === '[') && stack.length === 0) {
      start = i;
      stack.push(ch);
      continue;
    }
    if (ch === '{' || ch === '[') {
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (!stack.length) continue;
      const top = stack.pop();
      if (top === '{' && ch === '}' || top === '[' && ch === ']') {
        if (stack.length === 0 && start >= 0) {
          const candidate = html.slice(start, i + 1);
          if (candidate.length > 24) candidates.push(candidate);
          start = -1;
        }
      } else {
        stack.push(top);
      }
    }
  }

  const parseCandidate = (candidate) => {
    try { return JSON.parse(candidate); } catch { return null; }
  };

  candidates.forEach(candidate => {
    const parsed = parseCandidate(candidate);
    if (!parsed) return;
    collectTrackEntries(parsed, out, seen);
  });

  return out;
}

async function loadSpotifyPlaylistTracks(url) {
  const parsed = parseSpotifyPlaylistUrl(url);
  if (!parsed) return null;
  const response = await fetch(`https://open.spotify.com/playlist/${parsed.id}`, {
    headers: {
      'Accept': 'text/html,application/xhtml+xml',
      'User-Agent': 'Mozilla/5.0'
    }
  });
  if (!response.ok) throw new Error('Playlist could not be loaded');
  const html = await response.text();
  const tracks = extractTracksFromHtml(html);
  if (!tracks.length) throw new Error('No tracks found');
  return { name: `Spotify Playlist (${parsed.id})`, tracks };
}

function resetModalUi(modal, stepSelect, stepProgress, errorEl, fileListEl, startBtn) {
  errorEl.classList.add('hidden');
  fileListEl.classList.add('hidden');
  fileListEl.innerHTML = '';
  stepSelect.classList.remove('hidden');
  stepProgress.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = I18n.t('spotify.import');
  modal.classList.remove('hidden');
}

async function runImportFlow(playlists, helpers) {
  const { createPlaylist, renderPlaylists, renderLibrary, modal, stepSelect, stepProgress, errorEl, startBtn, trackList, progressFill, progressText, progressCount, setModalTitle, setDoneButtonsVisible, cleanup, showImportSummary } = helpers;
  const pendingPlaylists = playlists || [];
  if (!pendingPlaylists.length) return;

  errorEl.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = I18n.t('spotify.importing');

  stepSelect.classList.add('hidden');
  stepProgress.classList.remove('hidden');

  let cancelled = false;
  let pendingPlaylistsRef = pendingPlaylists;
  const cancelState = { value: false };
  const updateCancelled = () => { cancelState.value = true; };

  const cleanupImport = () => {
    cancelState.value = true;
    modal.classList.add('hidden');
    startBtn.disabled = true;
    startBtn.textContent = I18n.t('spotify.import');
    stepSelect.classList.remove('hidden');
    stepProgress.classList.add('hidden');
    errorEl.classList.add('hidden');
  };

  const onCancel = () => {
    updateCancelled();
    cleanupImport();
  };

  const originalCancel = $('#spotify-cancel').onclick;
  $('#spotify-cancel').onclick = onCancel;

  let totalImported = 0;
  let totalPlaylists = 0;
  const allFailedTracks = [];

  for (let pi = 0; pi < pendingPlaylistsRef.length; pi++) {
    if (cancelState.value) break;
    const pl = pendingPlaylistsRef[pi];

    if (pendingPlaylistsRef.length > 1) {
      setModalTitle(I18n.t('spotify.importingProgress', { current: pi + 1, total: pendingPlaylistsRef.length, name: pl.name }));
    } else {
      setModalTitle(pl.name);
    }

    progressFill.style.width = '0%';
    progressCount.textContent = '';
    progressText.textContent = I18n.t('spotify.matching');
    trackList.innerHTML = '';

    const total = pl.tracks.length;
    const BATCH_SIZE = 3;

    trackList.innerHTML = pl.tracks.map((t, i) => `
      <div class="spotify-track-item pending" id="sp-track-${i}">
        <span class="spotify-track-status"><span class="dots">●●●</span></span>
        <span class="spotify-track-title">${escapeHtml(t.title)}</span>
        <span class="spotify-track-artist">${escapeHtml(t.artist)}</span>
      </div>
    `).join('');

    const matchedTracks = [];
    const failedTracks = [];
    let matched = 0;
    let failed = 0;

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (cancelState.value) break;

      const batch = pl.tracks.slice(i, Math.min(i + BATCH_SIZE, total));
      const promises = batch.map((t, bi) => {
        const idx = i + bi;
        return window.snowify.spotifyMatchTrack(t.title, t.artist)
          .catch(() => null)
          .then(result => ({ idx, result }));
      });

      const results = await Promise.all(promises);
      if (cancelState.value) break;

      for (const { idx, result } of results) {
        const t = pl.tracks[idx];
        const el = $(`#sp-track-${idx}`);
        if (result) {
          matchedTracks.push(result);
          matched++;
          if (el) {
            el.classList.remove('pending');
            el.classList.add('matched');
            el.querySelector('.spotify-track-status').innerHTML = '<svg class="check" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg>';
          }
        } else {
          failedTracks.push({ title: t.title, artist: t.artist });
          failed++;
          if (el) {
            el.classList.remove('pending');
            el.classList.add('unmatched');
            el.querySelector('.spotify-track-status').innerHTML = '<svg class="cross" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg>';
          }
        }
      }

      const done = Math.min(i + BATCH_SIZE, total);
      progressCount.textContent = `${done} / ${total}`;
      progressFill.style.width = `${(done / total) * 100}%`;
      progressText.textContent = pendingPlaylistsRef.length > 1
        ? I18n.t('spotify.matchingPlaylist', { current: pi + 1, total: pendingPlaylistsRef.length })
        : I18n.t('spotify.matching');

      const lastEl = $(`#sp-track-${Math.min(i + BATCH_SIZE, total) - 1}`);
      lastEl?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }

    if (cancelState.value) {
      if (matchedTracks.length) {
        const playlist = createPlaylist(pl.name);
        playlist.tracks = matchedTracks;
        callbacks.saveState();
        renderPlaylists();
        renderLibrary();
      }
      break;
    }

    if (matchedTracks.length) {
      const playlist = createPlaylist(pl.name);
      playlist.tracks = matchedTracks;
      callbacks.saveState();
      renderPlaylists();
      renderLibrary();
      totalImported += matched;
      totalPlaylists++;
    }

    allFailedTracks.push(...failedTracks);
    progressText.textContent = I18n.t('spotify.matchedOf', { matched, total }) +
      (failed ? ` (${I18n.t('spotify.notFound', { count: failed })})` : '');
  }

  if (cancelState.value) {
    showToast(I18n.t('toast.importCancelled'));
    return;
  }

  if (pendingPlaylistsRef.length > 1) {
    setModalTitle(I18n.t('spotify.importComplete'));
    progressText.textContent = I18n.t('toast.importedPlaylists', { playlistCount: totalPlaylists, trackCount: totalImported });
    progressFill.style.width = '100%';
    progressCount.textContent = '';
    showToast(I18n.t('toast.importedPlaylists', { playlistCount: totalPlaylists, trackCount: totalImported }));
  } else if (totalPlaylists) {
    showToast(I18n.t('toast.importedTracks', { count: totalImported }));
  } else {
    showToast(I18n.t('toast.noTracksMatched'));
  }

  if (allFailedTracks.length) {
    trackList.innerHTML = `<div class="spotify-failed-header">${I18n.t('spotify.failedToMatch', { count: allFailedTracks.length })}</div>` +
      allFailedTracks.map(t =>
        `<div class="spotify-track-item unmatched"><span class="spotify-track-status"><svg class="cross" width="16" height="16" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></span><span class="spotify-track-title">${escapeHtml(t.title)}</span><span class="spotify-track-artist">${escapeHtml(t.artist)}</span></div>`
      ).join('');
    trackList.scrollTop = 0;
  } else {
    trackList.innerHTML = '';
  }

  setDoneButtonsVisible(true);
  $('#spotify-done').onclick = () => {
    cleanup();
    resetModalUi(modal, stepSelect, stepProgress, errorEl, fileListEl, startBtn);
  };
}

/**
 * Open the Spotify / TuneMyMusic CSV import modal.
 *
 * @param {{ createPlaylist, renderPlaylists, renderLibrary }} helpers
 *   Functions from library.js, injected to break the circular dependency.
 */
export function openSpotifyImport({ createPlaylist, renderPlaylists, renderLibrary }) {
  const modal = $('#spotify-modal');
  const stepSelect = $('#spotify-step-url');
  const stepProgress = $('#spotify-step-progress');
  const errorEl = $('#spotify-error');
  const fileListEl = $('#spotify-file-list');
  const startBtn = $('#spotify-start');
  const playlistUrlInput = $('#spotify-playlist-url-input');
  const playlistImportBtn = $('#spotify-import-playlist-link');

  let cancelled = false;
  let pendingPlaylists = null;

  // Reset
  errorEl.classList.add('hidden');
  fileListEl.classList.add('hidden');
  fileListEl.innerHTML = '';
  stepSelect.classList.remove('hidden');
  stepProgress.classList.add('hidden');
  startBtn.disabled = true;
  startBtn.textContent = I18n.t('spotify.import');
  modal.classList.remove('hidden');

  function resetModal() {
    startBtn.disabled = true;
    startBtn.textContent = I18n.t('spotify.import');
    $('#spotify-modal-title').textContent = I18n.t('spotify.title');
    $('#spotify-done-buttons').style.display = 'none';
    pendingPlaylists = null;
  }

  function cleanup() {
    cancelled = true;
    modal.classList.add('hidden');
    resetModal();
    if (playlistUrlInput) playlistUrlInput.value = '';
  }

  $('#spotify-cancel').onclick = cleanup;
  modal.onclick = (e) => { if (e.target === modal) cleanup(); };

  // Open TuneMyMusic in system browser
  $('#spotify-exportify-link').onclick = (e) => {
    e.preventDefault();
    window.snowify.openExternal('https://www.tunemymusic.com/transfer');
  };

  // Pick CSV files via system dialog
  $('#spotify-pick-files').onclick = async () => {
    const playlists = await window.snowify.spotifyPickCsv();
    if (!playlists || !playlists.length) return;
    pendingPlaylists = playlists;
    fileListEl.innerHTML = playlists.map(p =>
      `<div class="spotify-file-item"><span class="spotify-file-name">${escapeHtml(p.name)}</span><span class="spotify-file-count">${p.tracks.length} tracks</span></div>`
    ).join('');
    fileListEl.classList.remove('hidden');
    startBtn.disabled = false;
    errorEl.classList.add('hidden');
  };

  playlistImportBtn.onclick = async () => {
    const value = playlistUrlInput.value.trim();
    if (!value) {
      errorEl.textContent = I18n.t('spotify.invalidPlaylistUrl');
      errorEl.classList.remove('hidden');
      return;
    }

    playlistImportBtn.disabled = true;
    playlistImportBtn.textContent = I18n.t('spotify.importing');
    errorEl.classList.add('hidden');

    try {
      const payload = await loadSpotifyPlaylistTracks(value);
      const trackList = $('#spotify-track-list');
      const progressFill = $('#spotify-progress-fill');
      const progressText = $('#spotify-progress-text');
      const progressCount = $('#spotify-progress-count');
      pendingPlaylists = [{ name: payload.name, tracks: payload.tracks }];
      await runImportFlow(pendingPlaylists, {
        createPlaylist,
        renderPlaylists,
        renderLibrary,
        modal,
        stepSelect,
        stepProgress,
        errorEl,
        startBtn,
        trackList,
        progressFill,
        progressText,
        progressCount,
        setModalTitle: (title) => { $('#spotify-modal-title').textContent = title; },
        setDoneButtonsVisible: (visible) => { $('#spotify-done-buttons').style.display = visible ? '' : 'none'; },
        cleanup,
      });
    } catch (err) {
      errorEl.textContent = err?.message || I18n.t('spotify.importError');
      errorEl.classList.remove('hidden');
    } finally {
      playlistImportBtn.disabled = false;
      playlistImportBtn.textContent = I18n.t('spotify.playlistLinkButton');
    }
  };

  startBtn.onclick = async () => {
    if (!pendingPlaylists || !pendingPlaylists.length) {
      errorEl.textContent = I18n.t('spotify.selectAtLeastOne');
      errorEl.classList.remove('hidden');
      return;
    }

    const trackList = $('#spotify-track-list');
    const progressFill = $('#spotify-progress-fill');
    const progressText = $('#spotify-progress-text');
    const progressCount = $('#spotify-progress-count');

    await runImportFlow(pendingPlaylists, {
      createPlaylist,
      renderPlaylists,
      renderLibrary,
      modal,
      stepSelect,
      stepProgress,
      errorEl,
      startBtn,
      trackList,
      progressFill,
      progressText,
      progressCount,
      setModalTitle: (title) => { $('#spotify-modal-title').textContent = title; },
      setDoneButtonsVisible: (visible) => { $('#spotify-done-buttons').style.display = visible ? '' : 'none'; },
      cleanup,
    });
  };
}

export async function importSpotifyPlaylistLink(url, helpers) {
  const payload = await loadSpotifyPlaylistTracks(url);
  if (!payload) throw new Error(I18n.t('spotify.invalidPlaylistUrl'));
  return payload;
}

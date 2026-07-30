/**
 * csv-import.js  (Spotify / TuneMyMusic CSV import)
 *
 * To avoid circular deps (library.js ↔ csv-import.js), the library helpers are
 * injected when the function is called.  See library.js for the call-site.
 */

import state from './state.js';
import { escapeHtml, showToast } from './utils.js';
import { callbacks } from './callbacks.js';

const $ = (sel, ctx = document) => ctx.querySelector(sel);

function normalizeText(value) {
  return String(value || '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeHtmlEntities(value) {
  return String(value || '')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function stripHtmlTags(value) {
  return decodeHtmlEntities(String(value || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function formatImportPlaylistName(playlistName, creatorName) {
  const importDate = new Intl.DateTimeFormat('de-DE', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());

  const safeName = normalizeText(playlistName) || 'Spotify Playlist';
  const safeCreator = normalizeText(creatorName) || 'Unknown';
  return `${safeName} | ${safeCreator} | ${importDate}`;
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

  const maybeTrack = node.track?.track ? node.track.track : node.track;
  if (maybeTrack && typeof maybeTrack === 'object') {
    collectTrackEntries(maybeTrack, out, seen);
  }

  const trackUri = typeof node.uri === 'string' ? node.uri : (typeof node.trackUri === 'string' ? node.trackUri : '');
  if (trackUri.startsWith('spotify:track:')) {
    const title = normalizeText(node.name || node.title || node.track?.name || '');
    const artists = Array.isArray(node.artists)
      ? node.artists.map(a => normalizeText(a?.name || a?.title || '')).filter(Boolean)
      : [];
    const artist = artists.length
      ? artists.join(', ')
      : normalizeText(node.artist || node.track?.artist || node.track?.artists?.[0]?.name || '');
    if (title && artist) {
      const key = `${title.toLowerCase()}::${artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ title, artist });
      }
    }
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object' && value !== node.track && value !== node.track?.track) {
      collectTrackEntries(value, out, seen);
    }
  }
}

function findPlaylistNameInObject(node, playlistId, seen = new Set()) {
  if (!node || typeof node !== 'object') return null;
  if (seen.has(node)) return null;
  seen.add(node);

  if (Array.isArray(node)) {
    for (const item of node) {
      const found = findPlaylistNameInObject(item, playlistId, seen);
      if (found) return found;
    }
    return null;
  }

  const uri = typeof node.uri === 'string' ? node.uri : '';
  const id = typeof node.id === 'string' ? node.id : '';
  const name = normalizeText(node.name || node.title || node.playlistName || '');

  const matchesPlaylist = uri.startsWith('spotify:playlist:') && uri.includes(playlistId)
    || uri.includes(playlistId)
    || id === playlistId;

  if (matchesPlaylist && name) {
    return name;
  }

  for (const value of Object.values(node)) {
    if (value && typeof value === 'object') {
      const found = findPlaylistNameInObject(value, playlistId, seen);
      if (found) return found;
    }
  }

  return null;
}

function extractPlaylistNameFromHtml(html, playlistId) {
  if (!html || typeof html !== 'string') return null;

  const creatorMatch = html.match(/<meta[^>]+name=["']music:creator["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  const creatorName = creatorMatch?.[1]
    ? creatorMatch[1].split('/').filter(Boolean).pop()?.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    : '';

  const nextDataMatch = html.match(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch) {
    try {
      const parsed = JSON.parse(nextDataMatch[1]);
      const found = findPlaylistNameInObject(parsed, playlistId);
      if (found) return formatImportPlaylistName(found, creatorName);
    } catch (_) {}
  }

  const ldJsonRegex = /<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let ldMatch;
  while ((ldMatch = ldJsonRegex.exec(html))) {
    try {
      const parsed = JSON.parse(ldMatch[1]);
      const items = Array.isArray(parsed) ? parsed : [parsed];
      for (const item of items) {
        const candidateUrl = typeof item?.url === 'string' ? item.url : '';
        const candidateId = typeof item?.['@id'] === 'string' ? item['@id'] : '';
        const name = normalizeText(item?.name || item?.['name']);
        if (name && (candidateUrl.includes(playlistId) || candidateId.includes(playlistId))) {
          return formatImportPlaylistName(name, creatorName);
        }
      }
    } catch (_) {}
  }

  const ogTitleMatch = html.match(/<meta[^>]+property=["']og:title["'][^>]+content=["']([^"']+)["'][^>]*>/i);
  if (ogTitleMatch) {
    const title = normalizeText(ogTitleMatch[1]);
    if (title) return formatImportPlaylistName(title, creatorName);
  }

  return null;
}

function extractTracksFromHtml(html) {
  if (!html || typeof html !== 'string') return [];
  const out = [];
  const seen = new Set();

  const trackRowRegex = /data-testid=["']track-row["']/gi;
  let match;
  const rowStarts = [];
  while ((match = trackRowRegex.exec(html))) {
    rowStarts.push(match.index);
  }

  for (let i = 0; i < rowStarts.length; i++) {
    const start = rowStarts[i];
    const end = i + 1 < rowStarts.length ? rowStarts[i + 1] : html.length;
    const rowHtml = html.slice(start, end);

    const titleBlockMatch = rowHtml.match(/<p[^>]*data-encore-id=["']listRowTitle["'][^>]*>([\s\S]*?)<\/p>/i);
    const titleCandidate = titleBlockMatch ? stripHtmlTags(titleBlockMatch[1]) : '';
    const title = titleCandidate && titleCandidate.toLowerCase() !== 'more' ? titleCandidate : '';

    const artistMatches = [...rowHtml.matchAll(/data-testid=["']internal-artist-link["'][^>]*>([\s\S]*?)<\/a>/gi)]
      .map(m => stripHtmlTags(m[1]))
      .filter(Boolean);
    const artist = artistMatches.join(', ');

    if (title && artist) {
      const key = `${title.toLowerCase()}::${artist.toLowerCase()}`;
      if (!seen.has(key)) {
        seen.add(key);
        out.push({ title, artist });
      }
    }
  }

  if (out.length) return out;

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
      if ((top === '{' && ch === '}') || (top === '[' && ch === ']')) {
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

  const targetUrl = `https://open.spotify.com/playlist/${parsed.id}`;
  let html = '';

  const isElectronRuntime = typeof window !== 'undefined' && !!window.process?.versions?.electron;
  const useElectronBridge = isElectronRuntime && typeof window !== 'undefined' && typeof window.snowify?.httpGet === 'function';

  if (useElectronBridge) {
    console.log('[spotify-import] using electron bridge');
    const response = await window.snowify.httpGet(targetUrl);
    html = typeof response?.body === 'string' ? response.body : '';
  } else {
    const proxyBase = (typeof window !== 'undefined' && (window.__SNOWIFY_PROXY_URL || window.SNOWIFY_PROXY_URL)) || 'http://127.0.0.1:8081';
    const proxyUrl = `${String(proxyBase).replace(/\/$/, '')}/${targetUrl}`;
    console.log('[spotify-import] using proxy', proxyUrl);
    const response = await fetch(proxyUrl, {
      headers: { Accept: 'text/html,application/xhtml+xml' },
      mode: 'cors'
    });
    if (!response.ok) throw new Error(`Playlist request failed: ${response.status}`);
    html = await response.text();
  }

  if (!html) throw new Error('Playlist could not be loaded');

  const tracks = extractTracksFromHtml(html);
  if (!tracks.length) throw new Error('No tracks found');

  const playlistName = extractPlaylistNameFromHtml(html, parsed.id);
  return { name: playlistName || `Spotify Playlist (${parsed.id})`, tracks };
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
  const { createPlaylist, renderPlaylists, renderLibrary, showPlaylistDetail, modal, stepSelect, stepProgress, errorEl, fileListEl, startBtn, trackList, progressFill, progressText, progressCount, setModalTitle, setDoneButtonsVisible, cleanup, showImportSummary } = helpers;
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
  let lastPlaylistId = null;
  const allFailedTracks = [];

  const _enrichThumbnails = async (tracks) => {
    const needsArt = tracks.filter(t => !t.thumbnail && (t.title || t.artist));
    if (!needsArt.length) return;
    const startTime = Date.now();
    progressText.textContent = I18n.t('spotify.fetchingCovers');
    for (let i = 0; i < needsArt.length; i++) {
      if (cancelState.value) return;
      const t = needsArt[i];
      try {
        const thumb = await window.snowify.getSearchThumbnail(t.title, t.artist);
        if (thumb && !t.thumbnail) {
          t.thumbnail = thumb;
          callbacks.saveState();
        }
      } catch (_) {}
      const elapsed = Date.now() - startTime;
      const avgPerItem = elapsed / (i + 1);
      const remaining = Math.round((needsArt.length - i - 1) * avgPerItem / 1000);
      progressCount.textContent = `${Math.min(i + 1, needsArt.length)} / ${needsArt.length}`;
      progressFill.style.width = `${((i + 1) / needsArt.length) * 100}%`;
      progressText.textContent = remaining > 0
        ? `${I18n.t('spotify.fetchingCovers')} (~${remaining}s ${I18n.t('common.remaining')})`
        : I18n.t('spotify.fetchingCovers');
      if (i % 5 === 4) await new Promise(r => setTimeout(r, 300));
    }
    progressText.textContent = I18n.t('spotify.coversLoaded');
    progressFill.style.width = '100%';
    progressCount.textContent = '';
    if (lastPlaylistId) {
      const pl = state.playlists.find(p => p.id === lastPlaylistId);
      if (pl) renderPlaylists();
    }
  };

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

    const isElectronRuntime = typeof window !== 'undefined' && !!window.process?.versions?.electron;
    const canUseNativeMatch = isElectronRuntime && typeof window.snowify?.spotifyMatchTrack === 'function';

    const makeFallbackTrack = (track) => ({
      id: 'import_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8),
      title: track.title,
      artist: track.artist,
      album: null,
      duration: null,
      durationMs: 0,
      thumbnail: '',
      url: null,
    });

    const matchTrack = async (track) => {
      if (canUseNativeMatch) {
        const result = await window.snowify.spotifyMatchTrack(track.title, track.artist).catch(() => null);
        if (result) return result;
      }
      return makeFallbackTrack(track);
    };

    for (let i = 0; i < total; i += BATCH_SIZE) {
      if (cancelState.value) break;

      const batch = pl.tracks.slice(i, Math.min(i + BATCH_SIZE, total));
      const promises = batch.map((t, bi) => {
        const idx = i + bi;
        return matchTrack(t).then(result => ({ idx, result }));
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
      lastPlaylistId = playlist.id;
      _enrichThumbnails(playlist.tracks);
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

  const SHOW_TRACKS_MAX = 30;
  const allMatchedTracks = [];
  for (const pl of pendingPlaylistsRef) {
    const playlist = state.playlists.find(p => p.id === lastPlaylistId);
    if (playlist) {
      allMatchedTracks.push(...playlist.tracks.slice(0, SHOW_TRACKS_MAX));
    }
  }
  const showTrackCount = Math.min(SHOW_TRACKS_MAX, allMatchedTracks.length);
  if (showTrackCount || allFailedTracks.length) {
    const rows = [];
    for (let i = 0; i < showTrackCount; i++) {
      const t = allMatchedTracks[i];
      rows.push(`<div class="spotify-track-item matched"><span class="spotify-track-status"><svg class="check" width="16" height="16" viewBox="0 0 16 16" fill="currentColor"><path d="M6.5 12.5l-4-4 1.4-1.4 2.6 2.6 5.6-5.6 1.4 1.4-7 7z"/></svg></span><span class="spotify-track-title">${escapeHtml(t.title)}</span><span class="spotify-track-artist">${escapeHtml(t.artist)}</span></div>`);
    }
    if (totalImported > SHOW_TRACKS_MAX) {
      rows.push(`<div class="spotify-track-item"><span class="spotify-track-status"></span><span class="spotify-track-title" style="opacity:0.6">${I18n.t('spotify.andMore', { count: totalImported - SHOW_TRACKS_MAX })}</span></div>`);
    }
    for (const t of allFailedTracks.slice(0, 10)) {
      rows.push(`<div class="spotify-track-item unmatched"><span class="spotify-track-status"><svg class="cross" width="16" height="16" viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/></svg></span><span class="spotify-track-title">${escapeHtml(t.title)}</span><span class="spotify-track-artist">${escapeHtml(t.artist)}</span></div>`);
    }
    if (allFailedTracks.length > 10) {
      rows.push(`<div class="spotify-track-item"><span class="spotify-track-status"></span><span class="spotify-track-title" style="opacity:0.6">${I18n.t('spotify.andMore', { count: allFailedTracks.length - 10 })}</span></div>`);
    }
    trackList.innerHTML = rows.join('');
    trackList.scrollTop = 0;
  } else {
    trackList.innerHTML = '';
  }

  $('#spotify-done').textContent = I18n.t('spotify.ok');
  setDoneButtonsVisible(true);
  $('#spotify-done').onclick = () => {
    cleanup();
    if (lastPlaylistId) {
      const pl = state.playlists.find(p => p.id === lastPlaylistId);
      if (pl) showPlaylistDetail(pl, false);
    }
  };
}

/**
 * Open the Spotify / TuneMyMusic CSV import modal.
 *
 * @param {{ createPlaylist, renderPlaylists, renderLibrary }} helpers
 *   Functions from library.js, injected to break the circular dependency.
 */
export function openSpotifyImport({ createPlaylist, renderPlaylists, renderLibrary, showPlaylistDetail }) {
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

  const cancelBtn = $('#spotify-cancel');
  if (cancelBtn) cancelBtn.onclick = cleanup;
  if (modal) modal.onclick = (e) => { if (e.target === modal) cleanup(); };

  // Open TuneMyMusic in system browser
  const exportifyLink = $('#spotify-exportify-link');
  if (exportifyLink) {
    exportifyLink.onclick = (e) => {
      e.preventDefault();
      window.snowify.openExternal?.('https://www.tunemymusic.com/transfer');
    };
  }

  // Pick CSV files via system dialog
  const pickFilesBtn = $('#spotify-pick-files');
  if (pickFilesBtn) {
    pickFilesBtn.onclick = async () => {
      const playlists = await window.snowify?.spotifyPickCsv?.();
      if (!playlists || !playlists.length) return;
      pendingPlaylists = playlists;
      fileListEl.innerHTML = playlists.map(p =>
        `<div class="spotify-file-item"><span class="spotify-file-name">${escapeHtml(p.name)}</span><span class="spotify-file-count">${p.tracks.length} tracks</span></div>`
      ).join('');
      fileListEl.classList.remove('hidden');
      startBtn.disabled = false;
      errorEl.classList.add('hidden');
    };
  }

  if (playlistImportBtn && playlistUrlInput) {
    playlistImportBtn.onclick = async () => {
      const value = playlistUrlInput.value.trim();
      if (!value) {
        errorEl.textContent = I18n.t('spotify.invalidPlaylistUrl');
        errorEl.classList.remove('hidden');
        return;
      }

      const trackList = $('#spotify-track-list');
      const progressFill = $('#spotify-progress-fill');
      const progressText = $('#spotify-progress-text');
      const progressCount = $('#spotify-progress-count');

      playlistImportBtn.disabled = true;
      playlistImportBtn.textContent = I18n.t('spotify.importing');
      errorEl.classList.add('hidden');
      stepSelect.classList.add('hidden');
      stepProgress.classList.remove('hidden');
      progressFill.style.width = '0%';
      progressCount.textContent = '';
      progressText.textContent = I18n.t('spotify.importing');
      trackList.innerHTML = '';

      try {
        const payload = await loadSpotifyPlaylistTracks(value);
        pendingPlaylists = [{ name: payload.name, tracks: payload.tracks }];
        await runImportFlow(pendingPlaylists, {
          createPlaylist,
          renderPlaylists,
          renderLibrary,
          showPlaylistDetail,
          modal,
          stepSelect,
          stepProgress,
          errorEl,
          fileListEl,
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
        progressText.textContent = err?.message || I18n.t('spotify.importError');
        progressFill.style.width = '0%';
        progressCount.textContent = '';
        errorEl.textContent = err?.message || I18n.t('spotify.importError');
        errorEl.classList.remove('hidden');
      } finally {
        playlistImportBtn.disabled = false;
        playlistImportBtn.textContent = I18n.t('spotify.playlistLinkButton');
      }
    };
  }

  if (startBtn) {
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
        showPlaylistDetail,
        modal,
        stepSelect,
        stepProgress,
        errorEl,
        fileListEl,
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
}

export async function importSpotifyPlaylistLink(url, helpers) {
  const payload = await loadSpotifyPlaylistTracks(url);
  if (!payload) throw new Error(I18n.t('spotify.invalidPlaylistUrl'));
  return payload;
}

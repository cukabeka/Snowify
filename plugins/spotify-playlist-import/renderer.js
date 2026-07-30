(function () {
  let button = null;
  let observer = null;

  function createButton() {
    if (button && button.isConnected) return button;
    const container = document.querySelector('.library-header-actions');
    if (!container) return null;

    button = document.createElement('button');
    button.className = 'btn-setting-action spotify-playlist-import-plugin-btn';
    button.type = 'button';
    button.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M9 18V5l12-2v13"></path>
        <circle cx="6" cy="18" r="3"></circle>
        <circle cx="18" cy="16" r="3"></circle>
      </svg>
      <span data-i18n="spotify.playlistLinkButton">Import Playlist</span>
    `;

    button.addEventListener('click', () => {
      if (window.SnowifySpotifyPlaylistImport?.openModal) {
        window.SnowifySpotifyPlaylistImport.openModal();
      }
    });

    container.appendChild(button);
    return button;
  }

  function ensureButton() {
    if (!document.getElementById('view-library')) return;
    createButton();
  }

  function start() {
    ensureButton();
    if (observer) return;
    observer = new MutationObserver(() => ensureButton());
    observer.observe(document.body, { childList: true, subtree: true });
    document.addEventListener('DOMContentLoaded', ensureButton, { once: true });
  }

  start();
})();

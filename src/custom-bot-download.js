// These routes are private and use a separately validated file resolver.
// Express/send defaults to dotfiles: 'ignore' for sendFile/download, so an
// owner's .env or .config/settings.json otherwise fails with a 404/500.
// NEVER apply dotfiles: 'allow' to public express.static middleware.
export function sendPrivateCustomBotDownload(res, file) {
  res.setHeader('Cache-Control', 'private, no-store, max-age=0');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  return res.download(file.absolute, file.rel.replace(/\//g, '__'), {
    dotfiles: 'allow',
    cacheControl: false,
    lastModified: false
  }, (error) => {
    if (!error) return;
    // Do not log absolute paths or sensitive file names (.env, tokens, ...).
    console.error('[custom-bot-file-download]', error.code || 'download-error');
    if (res.headersSent) return;
    const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
    const forbidden = error.code === 'EACCES' || error.code === 'EPERM';
    res.status(missing ? 404 : forbidden ? 403 : 500)
      .type('text/plain')
      .send('Datei konnte nicht heruntergeladen werden. Bitte Datei und Dateirechte prüfen.');
  });
}

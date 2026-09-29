// @ts-nocheck
// Controles de ventana del chat: animación en renderer, acción nativa en main.
for (const [id, action] of [
  ['window-minimize', 'minimize'],
  ['window-maximize', 'maximize'],
  ['close-btn', 'close'],
]) {
  const button = document.getElementById(id);
  button.addEventListener('click', () => {
    if (button.classList.contains('is-pressed')) return;
    button.classList.add('is-pressed');
    const delay = window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 150;
    setTimeout(() => {
      button.classList.remove('is-pressed');
      ipcRenderer.send(action === 'close' ? 'chat-close' : 'chat-window-control', action);
    }, delay);
  });
}
ipcRenderer.on('chat-window-maximized', (_event, maximized) => {
  const button = document.getElementById('window-maximize');
  const nextLabel = window.kaoruI18n.t(maximized ? 'restoreWindow' : 'maximizeWindow');
  button.setAttribute('aria-pressed', String(Boolean(maximized)));
  button.setAttribute('aria-label', nextLabel);
  button.title = window.kaoruI18n.t(maximized ? 'restore' : 'maximize');
});
document.addEventListener('kaoru-language-changed', () => {
  const button = document.getElementById('window-maximize');
  const maximized = button.getAttribute('aria-pressed') === 'true';
  button.setAttribute(
    'aria-label',
    window.kaoruI18n.t(maximized ? 'restoreWindow' : 'maximizeWindow')
  );
  button.title = window.kaoruI18n.t(maximized ? 'restore' : 'maximize');
});

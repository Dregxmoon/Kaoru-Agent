// @ts-nocheck
// Resumen contextual de la barra. Los paneles y sus listeners viven en los
// módulos existentes; aquí solo se consulta su estado al abrir el resumen.
const statusButton = document.getElementById('status-btn');
const statusPopover = document.getElementById('status-popover');

async function refreshHeaderStatus() {
  const [rules] = await Promise.allSettled([window.assistant.invoke('permissions-list')]);
  const permissions = document.getElementById('status-permissions');
  if (rules.status === 'fulfilled' && Array.isArray(rules.value)) {
    const custom = rules.value.filter((rule) => !String(rule.tool || '').startsWith('capability:'));
    permissions.textContent =
      custom.length === 1 ? '1 regla personalizada' : `${custom.length} reglas personalizadas`;
  } else {
    permissions.textContent = 'No disponible';
  }
}

function closeHeaderStatus() {
  statusPopover.hidden = true;
  statusButton.setAttribute('aria-expanded', 'false');
}

statusButton.addEventListener('click', () => {
  const opening = statusPopover.hidden;
  statusPopover.hidden = !opening;
  statusButton.setAttribute('aria-expanded', String(opening));
  if (opening) refreshHeaderStatus();
});

document.addEventListener('click', (event) => {
  if (
    !statusPopover.hidden &&
    !statusPopover.contains(event.target) &&
    event.target !== statusButton
  ) {
    closeHeaderStatus();
  }
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && !statusPopover.hidden) {
    closeHeaderStatus();
    statusButton.focus();
  }
});

for (const id of ['perms-btn', 'commands-btn', 'theme-toggle']) {
  document.getElementById(id).addEventListener('click', closeHeaderStatus);
}

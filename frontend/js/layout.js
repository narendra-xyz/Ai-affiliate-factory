// Renders the shared sidebar/topbar shell into any page that includes a
// <div id="app-shell"></div> wrapper, keeping nav markup in one place.
const NAV_ITEMS = [
  { href: '/index.html', label: 'Dashboard', icon: 'layout-dashboard' },
  { href: '/videos.html', label: 'Videos', icon: 'clapperboard' },
  { href: '/products.html', label: 'Products', icon: 'package' },
  { href: '/agents.html', label: 'Agents', icon: 'bot' },
  { href: '/finance.html', label: 'Finance', icon: 'wallet' },
  { href: '/command-center.html', label: 'Command Center', icon: 'terminal' },
  { href: '/settings.html', label: 'Settings', icon: 'settings' },
];

function renderShell(activePath, pageTitle, pageSubtitle) {
  const navHtml = NAV_ITEMS.map(
    (item) => `
    <a href="${item.href}" class="nav-item ${activePath === item.href ? 'active' : ''}">
      <i data-lucide="${item.icon}"></i>
      <span>${item.label}</span>
    </a>`
  ).join('');

  return `
    <div class="sidebar" id="sidebar">
      <div class="brand"><span class="dot"></span> AI Affiliate Factory</div>
      ${navHtml}
      <div style="margin-top:auto;padding-top:14px;border-top:1px solid var(--border);">
        <button class="nav-item" style="width:100%;background:none;border:none;cursor:pointer;" onclick="logout()">
          <i data-lucide="log-out"></i><span>Logout</span>
        </button>
      </div>
    </div>
    <div class="main">
      <div class="topbar">
        <div style="display:flex;align-items:center;gap:12px;">
          <button class="menu-toggle" onclick="document.getElementById('sidebar').classList.toggle('open')">
            <i data-lucide="menu"></i>
          </button>
          <div>
            <h1>${pageTitle}</h1>
            <p>${pageSubtitle || ''}</p>
          </div>
        </div>
      </div>
      <div id="page-content"></div>
    </div>
  `;
}

function mountShell(activePath, pageTitle, pageSubtitle) {
  requireAuthOrRedirect();
  document.getElementById('app-shell').innerHTML = renderShell(activePath, pageTitle, pageSubtitle);
  if (window.lucide) lucide.createIcons();
}

function logout() {
  clearToken();
  window.location.href = '/login.html';
}

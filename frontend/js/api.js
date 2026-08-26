// Thin API client used by every dashboard page. Reads the JWT stored in
// memory-backed sessionStorage (not localStorage, kept minimal) and
// redirects to login.html on 401.
const API_BASE = '/api';

function getToken() {
  return sessionStorage.getItem('aaf_token');
}

function setToken(token) {
  sessionStorage.setItem('aaf_token', token);
}

function clearToken() {
  sessionStorage.removeItem('aaf_token');
}

async function apiFetch(path, options = {}) {
  const token = getToken();
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });

  if (res.status === 401) {
    clearToken();
    window.location.href = '/login.html';
    return null;
  }

  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

function requireAuthOrRedirect() {
  if (!getToken()) window.location.href = '/login.html';
}

function formatIDR(value) {
  const n = Number(value || 0);
  return 'Rp' + n.toLocaleString('id-ID', { maximumFractionDigits: 0 });
}

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), 4000);
}

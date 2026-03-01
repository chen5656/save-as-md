// Save as MD — Popup Script

'use strict';

// ─── Helpers ──────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

function sendMsg(type, extra = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, ...extra }, resp => {
      if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
      else resolve(resp);
    });
  });
}

function timeAgo(isoString) {
  if (!isoString) return 'Never';
  const diff = Date.now() - new Date(isoString).getTime();
  const secs = Math.floor(diff / 1000);
  if (secs < 5)   return 'just now';
  if (secs < 60)  return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatRange(start, end) {
  const fmt = dt => new Date(dt).toLocaleString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
    hour: 'numeric', minute: '2-digit', hour12: true,
  });
  return `${fmt(start)} — ${fmt(end)}`;
}

// ─── Render ───────────────────────────────────────────────────────────────────
function showScreen(id) {
  ['setup-needed', 'permission-needed', 'main'].forEach(s => {
    const el = $(s);
    el.classList.toggle('hidden', s !== id);
  });
}

function renderState(state) {
  if (!state.setup_complete) {
    showScreen('setup-needed');
    return;
  }

  if (state.fs_permission_needed) {
    showScreen('permission-needed');
    return;
  }

  showScreen('main');

  // Bot name + status dot
  $('bot-name').textContent = state.bot_username ? `@${state.bot_username}` : 'Connected';
  const dot = $('status-dot');
  dot.className = 'status-dot';
  if (!state.is_polling_active) {
    dot.classList.add('grey');
  } else if (state.last_telegram_error || state.has_disconnect_warning) {
    dot.classList.add('red');
  } else if (state.last_successful_poll) {
    dot.classList.add('green');
  } else {
    dot.classList.add('grey');
  }

  // Last poll time (auto-refresh every 10s)
  $('last-poll').textContent = timeAgo(state.last_successful_poll);

  // Pending retries
  $('pending-count').textContent = (state.pending_retries || []).length;

  // Disconnect warning
  const banner = $('disconnect-banner');
  const unacked = (state.connection_warnings || []).find(w => !w.acknowledged);
  if (unacked) {
    banner.classList.remove('hidden');
    $('warning-text').textContent =
      `Offline ${unacked.duration}\n${formatRange(unacked.start, unacked.end)}\n` +
      `URLs sent during this window may not have been saved.`;

    $('dismiss-warning').onclick = async () => {
      await sendMsg('dismiss_warning', { warningId: unacked.id });
      await refresh();
    };
  } else {
    banner.classList.add('hidden');
  }

  // Telegram error
  const errBanner = $('error-banner');
  if (state.last_telegram_error) {
    errBanner.classList.remove('hidden');
    $('error-text').textContent = `Telegram error: ${state.last_telegram_error}`;
  } else {
    errBanner.classList.add('hidden');
  }

  // Toggle polling button
  const toggleBtn = $('toggle-polling');
  if (state.is_polling_active === false) {
    toggleBtn.textContent = '▶ Start';
    toggleBtn.className = 'btn btn-sm btn-start';
  } else {
    toggleBtn.textContent = '■ Stop';
    toggleBtn.className = 'btn btn-sm btn-stop';
  }

  // Active interval
  const interval = state.poll_interval || 300;
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.classList.toggle('active', parseInt(btn.dataset.seconds) === interval);
  });

  // Recent saves
  renderRecentSaves(state.recent_saves || []);

  // Connection history section
  const history = state.connection_warnings || [];
  const histSection = $('history-section');
  if (history.length > 0) {
    histSection.classList.remove('hidden');
    renderHistory(history);
  } else {
    histSection.classList.add('hidden');
  }
}

function renderRecentSaves(saves) {
  const list = $('recent-saves-list');
  if (!saves.length) {
    list.innerHTML = '<div class="empty-state">No saves yet</div>';
    return;
  }

  list.innerHTML = saves.slice(0, 5).map(s => `
    <div class="save-item">
      <div class="save-title" title="${esc(s.title || s.filename)}">${esc(s.title || s.filename)}</div>
      <div class="save-meta">
        <span>${esc(s.filename)}</span>
        <span>${timeAgo(s.saved_at)}</span>
      </div>
    </div>
  `).join('');
}

function renderHistory(warnings) {
  const list = $('history-list');
  list.innerHTML = warnings.slice(0, 5).map(w => `
    <div class="history-item">
      <div class="history-duration">Offline for ${esc(w.duration)}</div>
      <div>${esc(formatRange(w.start, w.end))}</div>
    </div>
  `).join('');
}

function esc(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Actions ──────────────────────────────────────────────────────────────────
async function refresh() {
  try {
    const state = await sendMsg('get_state');
    renderState(state);
  } catch (e) {
    console.error('Popup refresh error:', e);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await refresh();

  // Auto-refresh last-poll time every 10s
  setInterval(() => {
    const el = $('last-poll');
    // Re-render just the time
    refresh();
  }, 10_000);

  // Setup screen: open onboarding
  $('open-onboarding').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('onboarding.html') });
    window.close();
  });

  // Permission screen: open settings to re-grant folder access
  $('regrant-permission').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') + '#folder' });
    window.close();
  });

  // Settings link
  $('open-settings').addEventListener('click', e => {
    e.preventDefault();
    chrome.tabs.create({ url: chrome.runtime.getURL('settings.html') });
    window.close();
  });

  // Refresh now
  $('refresh-now').addEventListener('click', async () => {
    const btn = $('refresh-now');
    btn.disabled = true;
    btn.textContent = '↻ Polling…';
    try {
      await sendMsg('poll_now');
      await refresh();
    } finally {
      btn.disabled = false;
      btn.textContent = '↻ Refresh Now';
    }
  });

  // Stop / Start toggle
  $('toggle-polling').addEventListener('click', async () => {
    const { is_polling_active } = await sendMsg('get_state');
    if (is_polling_active === false) {
      await sendMsg('start_polling');
    } else {
      await sendMsg('stop_polling');
    }
    await refresh();
  });

  // Interval buttons
  document.querySelectorAll('.interval-btn').forEach(btn => {
    btn.addEventListener('click', async () => {
      const seconds = parseInt(btn.dataset.seconds);
      await sendMsg('set_interval', { intervalSeconds: seconds });
      await refresh();
    });
  });
});

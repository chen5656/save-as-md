// Markdown Vault — Onboarding Wizard

'use strict';

// ─── IndexedDB Helper (duplicated from background for popup context) ───────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('markdown-vault', 1);
    req.onupgradeneeded = e => e.target.result.createObjectStore('kv');
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

async function idbSet(key, value) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('kv', 'readwrite');
    tx.objectStore('kv').put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = e => reject(e.target.error);
  });
}

// ─── State ────────────────────────────────────────────────────────────────────
let verifiedBotUsername = null;
let chosenDirHandle = null;
let currentStep = 1;

// ─── Helpers ──────────────────────────────────────────────────────────────────
function $(id) { return document.getElementById(id); }

async function sendMsg(type, extra = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({ type, ...extra }, resp => {
          if (chrome.runtime.lastError) reject(new Error(chrome.runtime.lastError.message));
          else resolve(resp);
        });
      });
    } catch (e) {
      if (attempt === 0) { await new Promise(r => setTimeout(r, 300)); continue; }
      throw e;
    }
  }
}

function showStep(n) {
  [1, 2, 3].forEach(i => {
    $(`step-${i}`).classList.toggle('hidden', i !== n);
  });

  // Update step dots
  document.querySelectorAll('.step-dot').forEach(dot => {
    const s = parseInt(dot.dataset.step);
    dot.classList.toggle('active', s === n);
    dot.classList.toggle('done', s < n);
  });

  // Update progress bar
  const pct = n === 1 ? 33 : n === 2 ? 66 : 100;
  $('progress-fill').style.width = `${pct}%`;

  currentStep = n;
}

function setTokenStatus(msg, type = '') {
  const el = $('token-status');
  el.textContent = msg;
  el.className = `field-status ${type}`;
}

// ─── Step 1: Token Verification ───────────────────────────────────────────────
async function verifyToken() {
  const token = $('bot-token').value.trim();
  if (!token) {
    setTokenStatus('Please paste your bot token above.', 'error');
    return;
  }

  const btn = $('verify-btn');
  btn.disabled = true;
  btn.textContent = 'Verifying…';
  setTokenStatus('Checking token…');
  $('bot-token').classList.remove('error', 'success');

  try {
    const resp = await sendMsg('verify_token', { token });

    if (resp?.success) {
      verifiedBotUsername = resp.username;
      $('bot-token').classList.add('success');
      setTokenStatus(`✓ Connected as @${resp.username}`, 'success');
      $('bot-success').classList.remove('hidden');
      $('bot-username-display').textContent = `@${resp.username} is ready to receive URLs`;
      $('step1-next').disabled = false;
    } else {
      $('bot-token').classList.add('error');
      setTokenStatus(`❌ ${resp?.error || 'Invalid token. Please check and try again.'}`, 'error');
      $('step1-next').disabled = true;
    }
  } catch (e) {
    setTokenStatus(`❌ ${e.message}`, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = 'Verify';
  }
}

// ─── Step 2: Folder Selection ─────────────────────────────────────────────────
async function chooseFolder() {
  try {
    const dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });

    // Test write access
    try {
      const testFile = await dirHandle.getFileHandle('.markdown-vault-test', { create: true });
      const writable = await testFile.createWritable();
      await writable.write('test');
      await writable.close();
      await dirHandle.removeEntry('.markdown-vault-test').catch(() => { });
    } catch (writeErr) {
      alert(`Write permission test failed: ${writeErr.message}\nPlease choose a folder where you have write access.`);
      return;
    }

    chosenDirHandle = dirHandle;

    // Store handle in IndexedDB (must be done from non-service-worker context)
    await idbSet('save_dir_handle', dirHandle);

    $('folder-name').textContent = dirHandle.name;
    $('folder-status').classList.remove('hidden');
    $('step2-next').disabled = false;

  } catch (e) {
    if (e.name !== 'AbortError') {
      alert(`Could not open folder: ${e.message}`);
    }
  }
}

// ─── Step 3: Finish ───────────────────────────────────────────────────────────
async function finishSetup() {
  try {
    await sendMsg('save_settings', {
      settings: {
        setup_complete: true,
        bot_username: verifiedBotUsername,
      },
    });

    // Notify service worker that FS permission is now granted
    await sendMsg('fs_permission_granted');

    // Update done screen
    $('done-bot-name').textContent = `@${verifiedBotUsername}`;
    $('done-folder-name').textContent = chosenDirHandle?.name || 'Selected folder';
    $('done-bot-link').textContent = `@${verifiedBotUsername}`;

    showStep(3);
  } catch (e) {
    alert(`Setup error: ${e.message}`);
  }
}

// ─── Init ─────────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  showStep(1);

  // Step 1 controls
  $('verify-btn').addEventListener('click', verifyToken);
  $('bot-token').addEventListener('keydown', e => {
    if (e.key === 'Enter') verifyToken();
    // Reset verification if token changes
    if (e.key !== 'Enter') {
      $('step1-next').disabled = true;
      $('bot-success').classList.add('hidden');
      $('bot-token').classList.remove('error', 'success');
      setTokenStatus('');
      verifiedBotUsername = null;
    }
  });

  $('bot-token').addEventListener('input', () => {
    // Reset on manual input change
    $('step1-next').disabled = true;
    $('bot-success').classList.add('hidden');
    $('bot-token').classList.remove('error', 'success');
    setTokenStatus('');
    verifiedBotUsername = null;
  });

  $('step1-next').addEventListener('click', () => showStep(2));

  // Step 2 controls
  $('choose-folder-btn').addEventListener('click', chooseFolder);

  $('step2-back').addEventListener('click', () => showStep(1));

  $('step2-next').addEventListener('click', () => finishSetup());

  // Step 3 controls
  $('close-btn').addEventListener('click', () => window.close());
});

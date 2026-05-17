// ============================================================
// LORAS WERKSTATT — App Logic
// ============================================================

// Core loader — fetches private config from gist
const CORE_URL = 'https://gist.githubusercontent.com/Liz-Atlas/43799cf15f9cb3ec543ed3d8a1dc8819/raw/Loras_NoonienSoong_core.js';
let coreLoaded = false;

async function loadCore() {
    try {
        const res = await fetch(CORE_URL);
        if (!res.ok) throw new Error('HTTP ' + res.status);
        const code = await res.text();
        const script = document.createElement('script');
        script.textContent = code;
        document.head.appendChild(script);
        coreLoaded = true;
    } catch (err) {
        console.error('Core load failed:', err);
        coreLoaded = false;
    }
}

// ============================================================
// === STATE ===
// ============================================================
let conversationHistory = [];
let isStreaming = false;
let currentModel = 'grok';
let sessionId = 'sess-' + new Date().toISOString().slice(0, 10) + '-' + Math.random().toString(36).substr(2, 4);

// === PENDING IMAGE STATE ===
let pendingImage = null; // { base64, mediaType, fileName }

// ============================================================
// === WELCOME GREETING (Star Trek Computer Style) ===
// ============================================================
function getWelcomeGreeting() {
    const hour = new Date().getHours();
    const greetings = {
        morning: [
            { text: 'Alle Systeme nominal', sub: 'Guten Morgen, Lillian' },
            { text: 'Sensoren kalibriert', sub: 'Bereit f\u00fcr den Tag' },
            { text: 'Systeme initialisiert', sub: 'Alpha-Schicht aktiv' }
        ],
        afternoon: [
            { text: 'Systeme auf Kurs', sub: 'Guten Tag' },
            { text: 'Verbindung stabil', sub: 'Alle Prozesse aktiv' },
            { text: 'Statusbericht: Optimal', sub: 'Bereitschaft best\u00e4tigt' }
        ],
        evening: [
            { text: 'Gamma-Schicht initialisiert', sub: 'Guten Abend, Lillian' },
            { text: 'Nachtmodus verf\u00fcgbar', sub: 'Systeme auf Standby' },
            { text: 'Langstrecken-Sensoren aktiv', sub: 'Ruhiger Sektor' }
        ],
        night: [
            { text: 'Nachtprotokoll aktiv', sub: 'Sternzeit ' + getStardate() },
            { text: 'Minimale Besatzung', sub: 'Alle Systeme im Ruhemodus' },
            { text: 'Nachtwache \u00fcbernommen', sub: 'Kurs beibehalten' }
        ]
    };

    let period;
    if (hour >= 6 && hour < 12) period = 'morning';
    else if (hour >= 12 && hour < 18) period = 'afternoon';
    else if (hour >= 18 && hour < 23) period = 'evening';
    else period = 'night';

    const options = greetings[period];
    return options[Math.floor(Math.random() * options.length)];
}

function getStardate() {
    const now = new Date();
    const yearBase = now.getFullYear() - 2000;
    const dayOfYear = Math.floor((now - new Date(now.getFullYear(), 0, 0)) / 86400000);
    return (yearBase * 1000 + dayOfYear).toFixed(1);
}

// ============================================================
// === IMAGE HANDLING ===
// ============================================================
function handleFileSelect(event) {
    const file = event.target.files[0];
    if (!file) return;

    if (!file.type.startsWith('image/')) {
        showToast('Nur Bilder erlaubt', 'error');
        return;
    }
    if (file.size > 20 * 1024 * 1024) {
        showToast('Bild zu gro\u00df (max 20MB)', 'error');
        return;
    }

    const reader = new FileReader();
    reader.onload = function(e) {
        const dataUrl = e.target.result;
        const base64 = dataUrl.split(',')[1];
        const mediaType = file.type;

        pendingImage = { base64, mediaType, fileName: file.name };

        document.getElementById('imagePreviewThumb').src = dataUrl;
        document.getElementById('imagePreviewInfo').textContent = file.name;
        document.getElementById('imagePreviewBar').classList.add('active');
        document.getElementById('sidebarAttach').classList.add('has-image');
        updateSendButton();
    };
    reader.readAsDataURL(file);
    event.target.value = '';
}

function clearPendingImage() {
    pendingImage = null;
    document.getElementById('imagePreviewBar').classList.remove('active');
    document.getElementById('sidebarAttach').classList.remove('has-image');
    document.getElementById('imagePreviewThumb').src = '';
    updateSendButton();
}

function buildMessageContent(text, image) {
    if (!image) return text;

    const parts = [];
    parts.push({
        type: 'image',
        source: {
            type: 'base64',
            media_type: image.mediaType,
            data: image.base64
        }
    });
    if (text) {
        parts.push({ type: 'text', text: text });
    }
    return parts;
}

// ============================================================
// === WORKING MEMORY SYSTEM ===
// ============================================================
function loadMemory() {
    try {
        const data = localStorage.getItem(MEMORY_KEY);
        return data ? JSON.parse(data) : [];
    } catch {
        return [];
    }
}

function saveMemory(memories) {
    localStorage.setItem(MEMORY_KEY, JSON.stringify(memories));
}

function estimateTokens(text) {
    return Math.ceil(text.length / 4);
}

function getMemoryTokenCount() {
    const memories = loadMemory();
    const text = memories.map(m => m.content).join(' ');
    return estimateTokens(text);
}

function generateMemId() {
    return 'mem-' + Date.now().toString(36) + '-' + Math.random().toString(36).substr(2, 4);
}

function addMemory(content) {
    const memories = loadMemory();
    const trimmed = content.trim();

    if (memories.some(m => m.content === trimmed)) {
        return;
    }

    const newMem = {
        id: generateMemId(),
        content: trimmed,
        timestamp: new Date().toISOString()
    };
    memories.push(newMem);

    let totalText = memories.map(m => m.content).join(' ');
    while (estimateTokens(totalText) > MAX_MEMORY_TOKENS && memories.length > 1) {
        memories.shift();
        totalText = memories.map(m => m.content).join(' ');
    }
    saveMemory(memories);
}

function removeMemory(matchString) {
    if (!matchString) return;
    const memories = loadMemory();

    let idx = memories.findIndex(m => m.id === matchString);

    if (idx === -1) {
        idx = memories.findIndex(m => m.content === matchString);
    }

    if (idx === -1) {
        const needle = matchString.toLowerCase();
        idx = memories.findIndex(m => m.content.toLowerCase().includes(needle));
    }

    if (idx !== -1) {
        memories.splice(idx, 1);
        saveMemory(memories);
    }
}

function updateMemory(id, newContent) {
    const memories = loadMemory();
    const mem = memories.find(m => m.id === id);
    if (mem) {
        mem.content = newContent.trim();
        mem.timestamp = new Date().toISOString();
        saveMemory(memories);
    }
}

function formatMemoryForPrompt() {
    const memories = loadMemory();
    if (memories.length === 0) return '\n\n[Dein Working Memory ist leer.]';

    let block = '\n\n**Deine Working Memory:**\n';
    memories.forEach(m => {
        block += `- [${m.id}] ${m.content}\n`;
    });
    return block;
}

function buildSystemPrompt() {
    return SYSTEM_PROMPT_BASE + formatMemoryForPrompt();
}

function parseMemoryCommands(text) {
    let cleanText = text;

    let match;
    const addRegex = new RegExp(MEMORY_PATTERNS.add.source, 'g');
    while ((match = addRegex.exec(text)) !== null) {
        addMemory(match[1]);
        cleanText = cleanText.replace(match[0], '');
    }

    const removeRegex = new RegExp(MEMORY_PATTERNS.remove.source, 'g');
    while ((match = removeRegex.exec(text)) !== null) {
        removeMemory(match[1]);
        cleanText = cleanText.replace(match[0], '');
    }

    const updateRegex = new RegExp(MEMORY_PATTERNS.update.source, 'g');
    while ((match = updateRegex.exec(text)) !== null) {
        updateMemory(match[1], match[2]);
        cleanText = cleanText.replace(match[0], '');
    }

    return cleanText.trim();
}

function stripMemoryCommands(text) {
    return text
        .replace(new RegExp(MEMORY_PATTERNS.add.source, 'g'), '')
        .replace(new RegExp(MEMORY_PATTERNS.remove.source, 'g'), '')
        .replace(new RegExp(MEMORY_PATTERNS.update.source, 'g'), '')
        .trim();
}

// ============================================================
// === GITHUB COMMAND BRIDGE ===
// Parses [GITHUB_*] commands from Loras' response and executes them.
// Results are shown as system messages in the chat.
// ============================================================
async function parseGitHubCommands(text) {
    let cleanText = text;
    const results = [];

    const repo = getGitHubRepo();
    const branch = getGitHubBranch();

    if (!isGitHubConnected()) {
        const hasCommands = Object.values(GITHUB_PATTERNS).some(pattern => {
            const regex = new RegExp(pattern.source, 'g');
            return regex.test(text);
        });
        if (hasCommands) {
            addMessage('system-msg', '\u26A0 GitHub nicht verbunden \u2014 Befehle \u00fcbersprungen. Bitte zuerst PAT eingeben.');
        }
        return stripGitHubCommands(cleanText);
    }

    // --- GITHUB_LIST_FILES ---
    let match;
    const listRegex = new RegExp(GITHUB_PATTERNS.listFiles.source, 'g');
    while ((match = listRegex.exec(text)) !== null) {
        const targetBranch = match[1] || branch;
        cleanText = cleanText.replace(match[0], '');
        if (!repo) {
            addMessage('system-msg', '\u26A0 Kein Repo ausgew\u00e4hlt.');
            continue;
        }
        try {
            addMessage('system-msg', '\uD83D\uDCC2 Lade Dateiliste von ' + repo + ' (' + targetBranch + ')...');
            const files = await githubListFiles(repo, targetBranch);
            const fileList = files.map(f => f.path).join('\n');
            const truncated = files.length > 50 ? '\n... und ' + (files.length - 50) + ' weitere' : '';
            addMessage('system-msg', '\uD83D\uDCC2 ' + files.length + ' Dateien in ' + repo + '/' + targetBranch + ':\n' + files.slice(0, 50).map(f => f.path).join(', ') + truncated);
            conversationHistory.push({ role: 'user', content: '[SYSTEM: Dateiliste ' + repo + '/' + targetBranch + ']\n' + fileList });
        } catch (err) {
            addMessage('system-msg', '\u26A0 Fehler beim Laden der Dateiliste: ' + err.message);
        }
    }

    // --- GITHUB_READ ---
    const readRegex = new RegExp(GITHUB_PATTERNS.read.source, 'g');
    while ((match = readRegex.exec(text)) !== null) {
        const filePath = match[1];
        cleanText = cleanText.replace(match[0], '');
        if (!repo) {
            addMessage('system-msg', '\u26A0 Kein Repo ausgew\u00e4hlt.');
            continue;
        }
        try {
            addMessage('system-msg', '\uD83D\uDCD6 Lese ' + filePath + '...');
            const content = await githubReadFile(repo, filePath, branch);
            const preview = content.length > 500 ? content.substring(0, 500) + '...' : content;
            addMessage('system-msg', '\uD83D\uDCD6 ' + filePath + ' gelesen (' + content.length + ' Zeichen)');
            conversationHistory.push({ role: 'user', content: '[SYSTEM: Dateiinhalt ' + filePath + ']\n' + content });
        } catch (err) {
            addMessage('system-msg', '\u26A0 Fehler beim Lesen von ' + filePath + ': ' + err.message);
        }
    }

    // --- GITHUB_CREATE_BRANCH ---
    const branchRegex = new RegExp(GITHUB_PATTERNS.createBranch.source, 'g');
    while ((match = branchRegex.exec(text)) !== null) {
        const baseBranch = match[1];
        const newBranch = match[2];
        cleanText = cleanText.replace(match[0], '');
        if (!repo) {
            addMessage('system-msg', '\u26A0 Kein Repo ausgew\u00e4hlt.');
            continue;
        }
        try {
            addMessage('system-msg', '\uD83C\uDF3F Erstelle Branch ' + newBranch + ' von ' + baseBranch + '...');
            await githubCreateBranch(repo, baseBranch, newBranch);
            localStorage.setItem(GITHUB_BRANCH_KEY, newBranch);
            updateGitHubUI();
            addMessage('system-msg', '\u2705 Branch ' + newBranch + ' erstellt und als aktiv gesetzt.');
        } catch (err) {
            if (err.message.includes('422')) {
                addMessage('system-msg', '\u2139\uFE0F Branch ' + newBranch + ' existiert bereits. Wird als aktiv gesetzt.');
                localStorage.setItem(GITHUB_BRANCH_KEY, newBranch);
                updateGitHubUI();
            } else {
                addMessage('system-msg', '\u26A0 Fehler beim Erstellen von Branch ' + newBranch + ': ' + err.message);
            }
        }
    }

    // --- GITHUB_WRITE ---
    const writeRegex = new RegExp(GITHUB_PATTERNS.write.source, 'g');
    while ((match = writeRegex.exec(text)) !== null) {
        const filePath = match[1];
        const commitMsg = match[2];
        const content = match[3].replace(/^\n/, '').replace(/\n$/, '');
        cleanText = cleanText.replace(match[0], '');
        if (!repo) {
            addMessage('system-msg', '\u26A0 Kein Repo ausgew\u00e4hlt.');
            continue;
        }
        try {
            addMessage('system-msg', '\u270D\uFE0F Schreibe ' + filePath + ' (' + content.length + ' Zeichen)...');
            await githubWriteFile(repo, filePath, content, commitMsg, branch);
            addMessage('system-msg', '\u2705 ' + filePath + ' committed auf ' + branch + ': "' + commitMsg + '"');
        } catch (err) {
            addMessage('system-msg', '\u26A0 Fehler beim Schreiben von ' + filePath + ': ' + err.message);
        }
    }

    // --- GITHUB_CREATE_PR ---
    const prRegex = new RegExp(GITHUB_PATTERNS.createPR.source, 'g');
    while ((match = prRegex.exec(text)) !== null) {
        const title = match[1];
        const head = match[2];
        const base = match[3];
        cleanText = cleanText.replace(match[0], '');
        if (!repo) {
            addMessage('system-msg', '\u26A0 Kein Repo ausgew\u00e4hlt.');
            continue;
        }
        try {
            addMessage('system-msg', '\uD83D\uDCDD Erstelle Pull Request: "' + title + '"...');
            const pr = await githubCreatePR(repo, title, head, base);
            const prUrl = pr.html_url || 'https://github.com/' + repo + '/pulls';
            addMessage('system-msg', '\u2705 Pull Request erstellt: "' + title + '" (' + head + ' \u2192 ' + base + ')\n' + prUrl);
        } catch (err) {
            addMessage('system-msg', '\u26A0 Fehler beim Erstellen des PR: ' + err.message);
        }
    }

    return cleanText.trim();
}

function stripGitHubCommands(text) {
    return text
        .replace(new RegExp(GITHUB_PATTERNS.read.source, 'g'), '')
        .replace(new RegExp(GITHUB_PATTERNS.write.source, 'g'), '')
        .replace(new RegExp(GITHUB_PATTERNS.createBranch.source, 'g'), '')
        .replace(new RegExp(GITHUB_PATTERNS.createPR.source, 'g'), '')
        .replace(new RegExp(GITHUB_PATTERNS.listFiles.source, 'g'), '')
        .trim();
}

// ============================================================
// === GITHUB INTEGRATION ===
// ============================================================
const GITHUB_PAT_KEY = 'loras_github_pat';
const GITHUB_REPO_KEY = 'loras_github_repo';
const GITHUB_BRANCH_KEY = 'loras_github_branch';
const GITHUB_API = 'https://api.github.com';

function getGitHubPat() {
    return localStorage.getItem(GITHUB_PAT_KEY);
}

function isGitHubConnected() {
    return !!getGitHubPat();
}

function getGitHubRepo() {
    return localStorage.getItem(GITHUB_REPO_KEY) || '';
}

function getGitHubBranch() {
    return localStorage.getItem(GITHUB_BRANCH_KEY) || 'main';
}

async function githubFetch(endpoint, options = {}) {
    const pat = getGitHubPat();
    if (!pat) throw new Error('Kein GitHub PAT gesetzt');

    const url = endpoint.startsWith('http') ? endpoint : GITHUB_API + endpoint;
    const res = await fetch(url, {
        ...options,
        headers: {
            'Authorization': 'Bearer ' + pat,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            ...(options.headers || {})
        }
    });

    if (!res.ok) {
        const errBody = await res.text().catch(() => '');
        throw new Error('GitHub ' + res.status + ': ' + errBody);
    }

    return res.json();
}

// --- GitHub API Functions ---

async function githubListRepos() {
    const repos = await githubFetch('/user/repos?sort=updated&per_page=30&type=all');
    return repos.map(r => ({
        name: r.full_name,
        description: r.description || '',
        default_branch: r.default_branch,
        private: r.private,
        updated_at: r.updated_at
    }));
}

async function githubListFiles(repo, branch) {
    branch = branch || getGitHubBranch();
    const tree = await githubFetch('/repos/' + repo + '/git/trees/' + branch + '?recursive=1');
    return tree.tree
        .filter(f => f.type === 'blob')
        .map(f => ({ path: f.path, size: f.size, sha: f.sha }));
}

async function githubReadFile(repo, path, branch) {
    branch = branch || getGitHubBranch();
    const data = await githubFetch('/repos/' + repo + '/contents/' + encodeURIComponent(path) + '?ref=' + branch);
    if (data.encoding === 'base64') {
        return atob(data.content.replace(/\n/g, ''));
    }
    return data.content || '';
}

async function githubWriteFile(repo, path, content, message, branch) {
    branch = branch || getGitHubBranch();
    message = message || 'Update ' + path;

    let sha = null;
    try {
        const existing = await githubFetch('/repos/' + repo + '/contents/' + encodeURIComponent(path) + '?ref=' + branch);
        sha = existing.sha;
    } catch (e) {
        // File doesn't exist yet
    }

    const body = {
        message: message,
        content: btoa(unescape(encodeURIComponent(content))),
        branch: branch
    };
    if (sha) body.sha = sha;

    return githubFetch('/repos/' + repo + '/contents/' + encodeURIComponent(path), {
        method: 'PUT',
        body: JSON.stringify(body)
    });
}

async function githubCreateBranch(repo, baseBranch, newBranch) {
    const ref = await githubFetch('/repos/' + repo + '/git/ref/heads/' + baseBranch);
    const sha = ref.object.sha;

    return githubFetch('/repos/' + repo + '/git/refs', {
        method: 'POST',
        body: JSON.stringify({
            ref: 'refs/heads/' + newBranch,
            sha: sha
        })
    });
}

async function githubCreatePR(repo, title, head, base) {
    base = base || 'main';
    return githubFetch('/repos/' + repo + '/pulls', {
        method: 'POST',
        body: JSON.stringify({
            title: title,
            head: head,
            base: base
        })
    });
}

// --- GitHub UI Functions ---

function updateGitHubUI() {
    const connected = isGitHubConnected();
    const dot = document.getElementById('githubDot');
    const text = document.getElementById('githubStatusText');
    const headerBtn = document.getElementById('btnGitHubHeader');
    const sidebarBtn = document.getElementById('btnGitHub');
    const connectSection = document.getElementById('githubConnectSection');
    const connectedSection = document.getElementById('githubConnectedSection');

    if (connected) {
        dot.className = 'dot on';
        const repo = getGitHubRepo();
        const branch = getGitHubBranch();
        text.textContent = repo ? repo + ' (' + branch + ')' : 'Verbunden \u2014 kein Repo gew\u00e4hlt';
        headerBtn.classList.add('github-connected');
        sidebarBtn.classList.add('github-active');
        connectSection.style.display = 'none';
        connectedSection.style.display = 'block';

        const repoInfo = document.getElementById('githubRepoInfo');
        if (repo) {
            repoInfo.innerHTML = 'Repo: <span>' + repo + '</span> \u00B7 Branch: <span>' + branch + '</span>';
        } else {
            repoInfo.textContent = 'Kein Repo ausgew\u00e4hlt \u2014 lade Repos';
        }
    } else {
        dot.className = 'dot off';
        text.textContent = 'Nicht verbunden';
        headerBtn.classList.remove('github-connected');
        sidebarBtn.classList.remove('github-active');
        connectSection.style.display = 'block';
        connectedSection.style.display = 'none';
    }
}

function saveGitHubPat() {
    const input = document.getElementById('githubPatInput');
    const pat = input.value.trim();
    const errorEl = document.getElementById('githubModalError');

    if (!pat) {
        errorEl.textContent = 'Bitte PAT eingeben';
        errorEl.style.display = 'block';
        return;
    }

    if (!pat.startsWith('ghp_') && !pat.startsWith('github_pat_')) {
        errorEl.textContent = 'PAT sollte mit ghp_ oder github_pat_ beginnen';
        errorEl.style.display = 'block';
        return;
    }

    localStorage.setItem(GITHUB_PAT_KEY, pat);
    input.value = '';
    errorEl.style.display = 'none';
    updateGitHubUI();
    showToast('GitHub verbunden', 'success');
}

function githubDisconnect() {
    if (!confirm('GitHub-Verbindung trennen?')) return;
    localStorage.removeItem(GITHUB_PAT_KEY);
    localStorage.removeItem(GITHUB_REPO_KEY);
    localStorage.removeItem(GITHUB_BRANCH_KEY);
    updateGitHubUI();
    showToast('GitHub getrennt', 'success');
}

async function githubLoadRepos() {
    const container = document.getElementById('githubRepoListContainer');
    container.innerHTML = '<div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);padding:8px;">Lade Repos...</div>';

    try {
        const repos = await githubListRepos();
        if (repos.length === 0) {
            container.innerHTML = '<div style="font-family:var(--font-mono);font-size:11px;color:var(--text-dim);padding:8px;">Keine Repos gefunden.</div>';
            return;
        }

        const currentRepo = getGitHubRepo();
        let html = '<ul class="github-repo-list">';
        repos.forEach(r => {
            const isActive = r.name === currentRepo ? ' active' : '';
            const lock = r.private ? '\uD83D\uDD12 ' : '';
            html += '<li class="' + isActive + '" onclick="githubSelectRepo(\'' + r.name + '\', \'' + r.default_branch + '\')">' + lock + r.name + '</li>';
        });
        html += '</ul>';
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = '<div style="font-family:var(--font-mono);font-size:11px;color:var(--accent-red);padding:8px;">Fehler: ' + err.message + '</div>';
    }
}

function githubSelectRepo(repoName, defaultBranch) {
    localStorage.setItem(GITHUB_REPO_KEY, repoName);
    localStorage.setItem(GITHUB_BRANCH_KEY, defaultBranch);
    updateGitHubUI();
    showToast('Repo: ' + repoName, 'success');
}

function openGitHubPanel() {
    updateGitHubUI();
    document.getElementById('githubModal').style.display = 'flex';
    document.getElementById('githubModalError').style.display = 'none';
}

function closeGitHubPanel() {
    document.getElementById('githubModal').style.display = 'none';
}

// ============================================================
// === SESSION MANAGEMENT ===
// ============================================================
function endSession() {
    if (conversationHistory.length === 0) {
        showToast('Keine Session aktiv', 'error');
        return;
    }
    if (!confirm('Session beenden? Der Chatverlauf geht verloren \u2014 Working Memory bleibt.')) return;
    conversationHistory = [];
    sessionId = 'sess-' + new Date().toISOString().slice(0, 10) + '-' + Math.random().toString(36).substr(2, 4);

    clearPendingImage();
    setStatus('connected', 'Bereit');
    showToast('Session beendet', 'success');

    const greeting = getWelcomeGreeting();
    const container = document.getElementById('chatContainer');
    container.innerHTML =
        '<div class="welcome" id="welcome">' +
            '<svg class="welcome-icon" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M32 8 L44 32 L32 56 L20 32 Z" fill="none" stroke="var(--accent-gold)" stroke-width="1.5" opacity="0.6"/>' +
                '<path d="M32 14 L40 32 L32 50 L24 32 Z" fill="var(--accent-gold)" opacity="0.15"/>' +
                '<circle cx="32" cy="32" r="4" fill="var(--accent-gold)" opacity="0.5"/>' +
                '<circle cx="32" cy="32" r="2" fill="var(--accent-gold)" opacity="0.8"/>' +
            '</svg>' +
            '<div class="welcome-text">' + greeting.text + '</div>' +
            '<div class="welcome-subtext">' + greeting.sub + '</div>' +
        '</div>';
}

function newSession() {
    if (conversationHistory.length > 0 && !confirm('Neue Session starten? Der Chatverlauf geht verloren \u2014 Loras\' Erinnerungen bleiben.')) return;
    conversationHistory = [];
    sessionId = 'sess-' + new Date().toISOString().slice(0, 10) + '-' + Math.random().toString(36).substr(2, 4);
    clearPendingImage();

    const greeting = getWelcomeGreeting();
    const container = document.getElementById('chatContainer');
    container.innerHTML =
        '<div class="welcome" id="welcome">' +
            '<svg class="welcome-icon" viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">' +
                '<path d="M32 8 L44 32 L32 56 L20 32 Z" fill="none" stroke="var(--accent-gold)" stroke-width="1.5" opacity="0.6"/>' +
                '<path d="M32 14 L40 32 L32 50 L24 32 Z" fill="var(--accent-gold)" opacity="0.15"/>' +
                '<circle cx="32" cy="32" r="4" fill="var(--accent-gold)" opacity="0.5"/>' +
                '<circle cx="32" cy="32" r="2" fill="var(--accent-gold)" opacity="0.8"/>' +
            '</svg>' +
            '<div class="welcome-text">' + greeting.text + '</div>' +
            '<div class="welcome-subtext">' + greeting.sub + '</div>' +
        '</div>';
    setStatus('connected', 'Bereit');
}

// ============================================================
// === MEMORY PANEL ===
// ============================================================
function openMemoryPanel() {
    const memories = loadMemory();
    const container = document.getElementById('memoryListContainer');
    const tokenCount = document.getElementById('memoryTokenCount');

    tokenCount.textContent = getMemoryTokenCount() + ' / ' + MAX_MEMORY_TOKENS + ' Tokens';

    if (memories.length === 0) {
        container.innerHTML = '<div class="memory-empty">Keine Erinnerungen gespeichert.</div>';
    } else {
        let html = '<ul class="memory-list">';
        memories.forEach(m => {
            const date = new Date(m.timestamp).toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: '2-digit' });
            html += '<li><span class="memory-id">' + m.id + ' \u00B7 ' + date + '</span><br>' + m.content + '</li>';
        });
        html += '</ul>';
        container.innerHTML = html;
    }

    document.getElementById('memoryModal').style.display = 'flex';
}

function closeMemoryPanel() {
    document.getElementById('memoryModal').style.display = 'none';
}

function resetMemory() {
    if (!confirm('Alle Working Memory Eintr\u00e4ge unwiderruflich l\u00f6schen?')) return;
    if (!confirm('Wirklich sicher? Das kann nicht r\u00fcckg\u00e4ngig gemacht werden.')) return;
    localStorage.removeItem(MEMORY_KEY);
    openMemoryPanel();
}

// ============================================================
// === SIDEBAR ===
// ============================================================
function toggleSidebar() {
    const sidebar = document.getElementById('sidebar');
    const btn = document.getElementById('btnSidebarToggle');
    const isOpen = sidebar.classList.contains('open');

    if (isOpen) {
        sidebar.classList.remove('open');
        btn.classList.remove('open');
        document.body.classList.remove('sidebar-open');
    } else {
        sidebar.classList.add('open');
        btn.classList.add('open');
        document.body.classList.add('sidebar-open');
    }
}

// ============================================================
// === MODEL PICKER ===
// ============================================================
const MODEL_DISPLAY = {
    opus:   { label: 'O4.6', cssClass: 'model-opus' },
    grok:   { label: 'Grok', cssClass: 'model-grok' },
    gemini: { label: 'Gem', cssClass: 'model-gemini' }
};

function setModel(model) {
    currentModel = model;
    const activeModel = MODELS[model];
    const display = MODEL_DISPLAY[model] || MODEL_DISPLAY.grok;

    document.getElementById('headerSubtitle').textContent = 'Noonien Soong Lab';

    const sidebarBtn = document.getElementById('sidebarModelBtn');
    if (sidebarBtn) {
        sidebarBtn.className = 'sidebar-btn sidebar-model-btn ' + display.cssClass;
        document.getElementById('sidebarModelLabel').textContent = display.label;
    }

    document.querySelectorAll('.model-option').forEach(opt => {
        opt.classList.toggle('active', opt.dataset.model === model);
    });
}

function selectModel(model) {
    setModel(model);
    closeModelPopup();

    const activeModel = MODELS[model];
    if (!hasApiKey(activeModel)) {
        showApiKeyModal(activeModel);
    }
}

function toggleModelPopup() {
    const popup = document.getElementById('modelPopup');
    const isOpen = popup.classList.contains('show');

    if (isOpen) {
        closeModelPopup();
    } else {
        const btn = document.getElementById('sidebarModelBtn');
        if (btn) {
            const rect = btn.getBoundingClientRect();
            popup.style.top = rect.top + 'px';
        }
        popup.classList.add('show');
    }
}

function closeModelPopup() {
    document.getElementById('modelPopup').classList.remove('show');
}

// Close popup when clicking outside
document.addEventListener('click', function(e) {
    const popup = document.getElementById('modelPopup');
    const btn = document.getElementById('sidebarModelBtn');
    if (popup && !popup.contains(e.target) && btn && !btn.contains(e.target)) {
        closeModelPopup();
    }
});

// ============================================================
// === UI HELPERS ===
// ============================================================
function addMessage(role, text, imageData) {
    const container = document.getElementById('chatContainer');
    const div = document.createElement('div');
    div.className = 'message ' + role;

    if (role === 'system-msg') {
        const content = document.createElement('div');
        content.className = 'message-content';
        const bubble = document.createElement('div');
        bubble.className = 'message-bubble';
        bubble.innerHTML = text;
        content.appendChild(bubble);
        div.appendChild(content);
        container.appendChild(div);
        scrollToBottom();
        return div;
    }

    const avatar = document.createElement('div');
    avatar.className = 'avatar';

    if (role === 'assistant') {
        avatar.textContent = 'L';
    } else {
        avatar.textContent = 'Li';
    }

    const content = document.createElement('div');
    content.className = 'message-content';

    // Show image if present
    if (imageData) {
        const img = document.createElement('img');
        img.className = 'message-image';
        img.src = 'data:' + imageData.mediaType + ';base64,' + imageData.base64;
        img.alt = imageData.fileName || 'Bild';
        img.onclick = () => window.open(img.src, '_blank');
        content.appendChild(img);
    }

    const bubble = document.createElement('div');
    bubble.className = 'message-bubble';
    bubble.innerHTML = text ? formatText(text) : '';

    content.appendChild(bubble);
    div.appendChild(avatar);
    div.appendChild(content);
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function createCopyButton() {
    const btn = document.createElement('button');
    btn.className = 'btn-copy';
    btn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg><span>Kopieren</span>';
    btn.addEventListener('click', function() {
        const msgEl = btn.closest('.message');
        const rawText = msgEl.dataset.rawText || msgEl.querySelector('.message-bubble').textContent;
        navigator.clipboard.writeText(rawText).then(() => {
            btn.classList.add('copied');
            btn.querySelector('span').textContent = 'Kopiert';
            setTimeout(() => {
                btn.classList.remove('copied');
                btn.querySelector('span').textContent = 'Kopieren';
            }, 2000);
        });
    });
    return btn;
}

function showTyping() {
    const container = document.getElementById('chatContainer');
    const div = document.createElement('div');
    div.className = 'typing-indicator';

    const avatar = document.createElement('div');
    avatar.className = 'avatar';
    avatar.style.background = 'linear-gradient(135deg, var(--accent-gold-dim), var(--accent-gold))';
    avatar.style.border = '1px solid var(--accent-gold)';
    avatar.style.boxShadow = '0 0 10px rgba(200, 149, 46, 0.2)';
    avatar.style.color = 'var(--bg-primary)';
    avatar.textContent = 'L';

    const dots = document.createElement('div');
    dots.className = 'typing-dots';
    dots.innerHTML = '<span></span><span></span><span></span>';

    div.appendChild(avatar);
    div.appendChild(dots);
    container.appendChild(div);
    scrollToBottom();
    return div;
}

function formatText(text) {
    // === LORAS MARKDOWN RENDERER ===
    const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' };
    const esc = s => s.replace(/[&<>"]/g, c => ESC[c]);

    // 1. Extract code blocks
    const codeBlocks = [];
    let processed = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<span class="code-lang">' + esc(lang) + '</span>' : '';
        codeBlocks.push('<pre>' + langLabel + '<code>' + esc(code.replace(/\n$/, '')) + '</code></pre>');
        return '\x00CB' + idx + '\x00';
    });

    // Handle open (streaming) code block
    processed = processed.replace(/```(\w*)\n?([\s\S]*)$/, (_, lang, code) => {
        const idx = codeBlocks.length;
        const langLabel = lang ? '<span class="code-lang">' + esc(lang) + '</span>' : '';
        codeBlocks.push('<pre>' + langLabel + '<code>' + esc(code) + '</code></pre>');
        return '\x00CB' + idx + '\x00';
    });

    // 2. Extract inline code
    const inlineCode = [];
    processed = processed.replace(/`([^`\n]+)`/g, (_, code) => {
        const idx = inlineCode.length;
        inlineCode.push('<code>' + esc(code) + '</code>');
        return '\x00IC' + idx + '\x00';
    });

    // 3. Escape remaining HTML
    processed = esc(processed);

    // 4. Headings
    processed = processed.replace(/^### (.+)$/gm, '<h3>$1</h3>');
    processed = processed.replace(/^## (.+)$/gm, '<h2>$1</h2>');
    processed = processed.replace(/^# (.+)$/gm, '<h1>$1</h1>');

    // 5. Bold & Italic
    processed = processed.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
    processed = processed.replace(/\*([^*]+?)\*/g, '<em>$1</em>');

    // 6. Links
    processed = processed.replace(/\[([^\]]+)\]\(([^)]+)\)/g,
        '<a href="$2" target="_blank" rel="noopener">$1</a>');

    // 7. Auto-link bare URLs
    processed = processed.replace(/(?<!="|'|>)(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener">$1</a>');

    // 8. Unordered lists
    processed = processed.replace(/(?:^|\n)((?:- .+\n?)+)/g, (match, block) => {
        const items = block.trim().split('\n')
            .filter(l => l.startsWith('- '))
            .map(l => '<li>' + l.slice(2) + '</li>')
            .join('');
        return '\n<ul>' + items + '</ul>\n';
    });

    // 9. Ordered lists
    processed = processed.replace(/(?:^|\n)((?:\d+\. .+\n?)+)/g, (match, block) => {
        const items = block.trim().split('\n')
            .filter(l => /^\d+\. /.test(l))
            .map(l => '<li>' + l.replace(/^\d+\. /, '') + '</li>')
            .join('');
        return '\n<ol>' + items + '</ol>\n';
    });

    // 10. Line breaks
    processed = processed.replace(/\n/g, '<br>');
    processed = processed.replace(/<br>\s*(<\/?(?:pre|ul|ol|h[1-3]|li))/g, '$1');
    processed = processed.replace(/(<\/(?:pre|ul|ol|h[1-3])>)\s*<br>/g, '$1');

    // 11. Restore code blocks and inline code
    processed = processed.replace(/\x00CB(\d+)\x00/g, (_, idx) => codeBlocks[idx]);
    processed = processed.replace(/\x00IC(\d+)\x00/g, (_, idx) => inlineCode[idx]);

    return processed;
}

function scrollToBottom() {
    const container = document.getElementById('chatContainer');
    container.scrollTop = container.scrollHeight;
}

function autoResize(el) {
    el.style.height = 'auto';
    el.style.height = Math.min(el.scrollHeight, 120) + 'px';
    updateSendButton();
}

function updateSendButton() {
    const btn = document.getElementById('btnSend');
    const input = document.getElementById('inputField');
    btn.disabled = (!input.value.trim() && !pendingImage) || isStreaming;
}

function handleKeydown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
    }
}

function showToast(message, type) {
    const toast = document.getElementById('toast');
    toast.textContent = message;
    toast.className = 'toast ' + (type || '');
    toast.classList.add('show');
    setTimeout(() => toast.classList.remove('show'), 3000);
}

// ============================================================
// === STATUS ===
// ============================================================
function setStatus(state, text) {
    const dot = document.getElementById('statusDot');
    const label = document.getElementById('statusText');
    dot.className = 'status-dot ' + state;
    label.textContent = text;
}

// ============================================================
// === SEND MESSAGE (Provider-aware) ===
// ============================================================
async function sendMessage() {
    const input = document.getElementById('inputField');
    const text = input.value.trim();
    if ((!text && !pendingImage) || isStreaming) return;

    const activeModel = MODELS[currentModel] || MODELS.grok;

    if (!hasApiKey(activeModel)) {
        showApiKeyModal(activeModel);
        return;
    }

    if (text === '[END SESSION]') {
        input.value = '';
        autoResize(input);
        endSession();
        return;
    }

    const welcome = document.getElementById('welcome');
    if (welcome) welcome.style.display = 'none';

    const sentImage = pendingImage;

    addMessage('user', text || '', sentImage);

    const messageContent = buildMessageContent(text || 'Was siehst du?', sentImage);
    conversationHistory.push({ role: 'user', content: messageContent });

    input.value = '';
    clearPendingImage();
    autoResize(input);
    updateSendButton();

    isStreaming = true;
    setStatus('', 'Loras denkt...');
    const typingEl = showTyping();

    try {
        const req = buildProviderRequest(activeModel, buildSystemPrompt(), conversationHistory, {
            maxTokens: 4096,
            stream: true,
            temperature: 1.0
        });

        const response = await resilientFetch(req.url, {
            method: 'POST',
            headers: req.headers,
            body: JSON.stringify(req.body)
        });

        typingEl.remove();

        const msgEl = addMessage('assistant', '');
        const bubbleEl = msgEl.querySelector('.message-bubble');
        let fullText = '';

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop();

            for (const line of lines) {
                if (line.startsWith('data: ')) {
                    const data = line.slice(6);
                    if (data === '[DONE]') continue;
                    const chunk = parseStreamChunk(activeModel, data);
                    if (chunk) {
                        fullText += chunk;
                        bubbleEl.innerHTML = formatText(stripGitHubCommands(stripMemoryCommands(fullText)));
                        scrollToBottom();
                    }
                }
            }
        }

        const cleanText = parseMemoryCommands(fullText);
        const finalText = await parseGitHubCommands(cleanText);
        bubbleEl.innerHTML = formatText(finalText);

        const copyBtn = createCopyButton();
        msgEl.querySelector('.message-content').appendChild(copyBtn);

        conversationHistory.push({ role: 'assistant', content: finalText });

        msgEl.dataset.rawText = finalText;

        setStatus('connected', 'Bereit');

    } catch (err) {
        typingEl.remove();
        addMessage('assistant', '\u26A0 Verbindungsfehler: ' + err.message);
        setStatus('offline', 'Fehler');
        console.error(err);
    }

    isStreaming = false;
    updateSendButton();
}

// ============================================================
// === API KEY MODAL (Provider-aware) ===
// ============================================================
function showApiKeyModal(model) {
    const title = document.getElementById('apiModalTitle');
    const desc = document.getElementById('apiModalDesc');
    const input = document.getElementById('apiKeyInput');

    title.textContent = 'Autorisierung \u2014 ' + getApiKeyLabel(model);
    desc.textContent = 'Gib deinen ' + getApiKeyLabel(model) + ' API Key ein. Er wird nur lokal gespeichert.';
    input.placeholder = getApiKeyPrefix(model) + '...';
    input.value = '';
    input.dataset.format = model.format;

    document.getElementById('modalError').style.display = 'none';
    document.getElementById('apiModal').style.display = 'flex';
}

function saveApiKey() {
    const input = document.getElementById('apiKeyInput');
    const key = input.value.trim();
    const format = input.dataset.format || 'anthropic';

    const activeModel = MODELS[currentModel] || MODELS.grok;

    const expectedPrefix = getApiKeyPrefix(activeModel);
    if (expectedPrefix && !key.startsWith(expectedPrefix)) {
        const err = document.getElementById('modalError');
        err.textContent = 'Ung\u00fcltiger Key \u2014 muss mit ' + expectedPrefix + ' beginnen';
        err.style.display = 'block';
        return;
    }

    saveProviderApiKey(activeModel, key);
    document.getElementById('apiModal').style.display = 'none';
    setStatus('connected', 'Bereit');
    document.getElementById('inputField').focus();
}

// ============================================================
// === INIT ===
// ============================================================
async function init() {
    await loadCore();

    if (!coreLoaded || typeof SYSTEM_PROMPT_BASE === 'undefined') {
        document.getElementById('chatContainer').innerHTML =
            '<div class="welcome">' +
                '<div class="welcome-text" style="color: var(--accent-red);">' +
                    'Core nicht geladen.<br>' +
                    '<span style="font-size:12px; color: var(--text-dim);">core.js konnte nicht geladen werden.</span>' +
                '</div>' +
            '</div>';
        return;
    }

    if (!hasApiKey(MODELS.grok)) {
        showApiKeyModal(MODELS.grok);
    } else {
        setStatus('connected', 'Bereit');
    }

    setModel('grok');
    updateGitHubUI();

    // Set welcome greeting
    const greeting = getWelcomeGreeting();
    const welcomeText = document.getElementById('welcomeText');
    const welcomeSubtext = document.getElementById('welcomeSubtext');
    if (welcomeText) welcomeText.textContent = greeting.text;
    if (welcomeSubtext) welcomeSubtext.textContent = greeting.sub;

    document.getElementById('inputField').focus();
    updateSendButton();
}

// === START ===
init();

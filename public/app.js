const app = {
  activeView:      'dashboard',
  inputMode:       'upload',    // 'upload' | 'record' | 'url'
  selectedFile:    null,
  history:         [],
  currentTranscript: '',
  chatHistory:     [],
  settings: {
    defaultStyle: 'paragraph',
    nvidiaKey:    '',
    hasFaceImage: false,
  },
  recorder: {
    mediaRecorder: null,
    audioChunks: [],
    timerInterval: null,
    startTime: null
  },

  init() {
    this.setupNavigation();
    this.setupFileDrop();
    this.loadData();
    this.updateDashboard();
    this.renderHistory();

    // Check if there is an active navigation request from url hash
    const hash = window.location.hash.replace('#', '');
    if (hash && document.getElementById(`view-${hash}`)) {
      this.navigate(hash);
    }
  },

  setupNavigation() {
    const items = document.querySelectorAll('.nav-item');
    items.forEach(item => {
      item.addEventListener('click', (e) => {
        const view = e.currentTarget.dataset.view;
        if(view) this.navigate(view);
      });
    });
  },

  navigate(viewId, reset = false) {
    // If reset is requested (e.g. from New Note), clear current transcribe state
    if (viewId === 'transcribe' && reset) {
      this.resetTranscribe();
    }

    // Update nav active state
    document.querySelectorAll('.nav-item').forEach(el => el.classList.remove('active'));
    document.querySelector(`.nav-item[data-view="${viewId}"]`)?.classList.add('active');

    // Update view visibility
    document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
    document.getElementById(`view-${viewId}`)?.classList.add('active');

    // Update title
    const titles = {
      'dashboard': 'Dashboard',
      'transcribe': 'Transcribe & Summarize',
      'history': 'All Recordings',
      'settings': 'Preferences'
    };
    document.getElementById('page-title').innerText = titles[viewId] || 'VoiceNote';

    this.activeView = viewId;
    window.location.hash = viewId;
  },

  setupFileDrop() {
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');

    const handleFiles = (files) => {
      if (files.length > 0) {
        this.selectedFile = files[0];
        document.getElementById('file-chosen-name').innerText = this.selectedFile.name;
        document.getElementById('file-chosen-banner').style.display = 'flex';
        dropZone.style.display = 'none';
      }
    };

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', () => {
      dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('dragover');
      handleFiles(e.dataTransfer.files);
    });

    fileInput.addEventListener('change', (e) => {
      handleFiles(e.target.files);
    });
  },

  switchInputMode(mode) {
    this.inputMode = mode;
    ['upload', 'record', 'url'].forEach(m => {
      document.getElementById(`tab-${m}`)?.classList.toggle('active', m === mode);
      document.getElementById(`${m}-section`).style.display = m === mode ? '' : 'none';
    });
    // Reset file/url state when switching
    this.selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-chosen-banner').style.display = 'none';
    document.getElementById('recording-status').style.display = 'none';
    if (mode === 'url') document.getElementById('url-input').focus();
  },

  handleGenerate() {
    if (this.inputMode === 'url') this.processUrl();
    else this.processAudio();
  },

  async processUrl() {
    const url = (document.getElementById('url-input').value || '').trim();
    if (!url) { this.showNotif('Please paste a URL first', true); return; }

    const style = document.getElementById('summary-style').value;
    this.setLoading(true, 'Downloading & transcribing via yt-dlp…');

    try {
      const response = await fetch('/api/process-url', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ url, style }),
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Server error processing URL.');

      this.displayResults(data);
      this.saveToHistory(data, url);
      this.showNotif('URL processed successfully!');
    } catch (err) {
      console.error(err);
      this.showNotif(err.message, true);
    } finally {
      this.setLoading(false);
    }
  },

  clearFile() {
    this.selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-chosen-banner').style.display = 'none';
    document.getElementById('results-container').classList.remove('visible');
    // Restore correct section visibility based on current mode
    ['upload', 'record', 'url'].forEach(m => {
      document.getElementById(`${m}-section`).style.display = m === this.inputMode ? '' : 'none';
    });
  },

  resetTranscribe() {
    this.clearFile();
    this.stopSpeaking();
    document.getElementById('res-transcript').innerText = '';
    document.getElementById('res-summary').innerText = '';
    document.getElementById('res-keypoints').innerHTML = '';
    const solutionEl = document.getElementById('res-solution');
    if (solutionEl) solutionEl.innerText = '';
    const solutionCard = document.getElementById('solution-card');
    if (solutionCard) solutionCard.style.display = 'none';
    document.getElementById('avatar-card').style.display = 'none';
    document.getElementById('nvidia-avatar-video').style.display = 'none';
    const vid = document.getElementById('avatar-video');
    if (vid) { vid.pause(); vid.src = ''; }
    document.getElementById('chat-card').style.display = 'none';
    this.currentTranscript = '';
    this.chatHistory       = [];
  },

  async startRecording() {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      this.recorder.mediaRecorder = new MediaRecorder(stream);
      this.recorder.audioChunks = [];

      this.recorder.mediaRecorder.ondataavailable = (event) => {
        this.recorder.audioChunks.push(event.data);
      };

      this.recorder.mediaRecorder.onstop = () => {
        const audioBlob = new Blob(this.recorder.audioChunks, { type: 'audio/webm' });
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.selectedFile = new File([audioBlob], `recording-${timestamp}.webm`, { type: 'audio/webm' });
        
        document.getElementById('file-chosen-name').innerText = this.selectedFile.name;
        document.getElementById('file-chosen-banner').style.display = 'flex';
        document.getElementById('recording-status').style.display = 'none';
        document.getElementById('btn-record').style.display = 'none';
        
        // Stop all tracks to release microphone
        stream.getTracks().forEach(track => track.stop());
      };

      this.recorder.mediaRecorder.start();
      
      // UI Updates
      document.getElementById('drop-zone').style.display = 'none';
      document.getElementById('btn-record').style.display = 'none';
      document.getElementById('recording-status').style.display = 'flex';
      
      this.startTimer();
      this.showNotif('Recording started...');
    } catch (err) {
      console.error('Microphone error:', err);
      this.showNotif('Could not access microphone.', true);
    }
  },

  stopRecording() {
    if (this.recorder.mediaRecorder && this.recorder.mediaRecorder.state !== 'inactive') {
      this.recorder.mediaRecorder.stop();
      this.stopTimer();
      this.showNotif('Recording saved!');
    }
  },

  startTimer() {
    this.recorder.startTime = Date.now();
    const timerElement = document.getElementById('recording-timer');
    
    this.recorder.timerInterval = setInterval(() => {
      const elapsed = Date.now() - this.recorder.startTime;
      const seconds = Math.floor(elapsed / 1000);
      const mm = Math.floor(seconds / 60).toString().padStart(2, '0');
      const ss = (seconds % 60).toString().padStart(2, '0');
      timerElement.innerText = `${mm}:${ss}`;
    }, 1000);
  },

  stopTimer() {
    if (this.recorder.timerInterval) {
      clearInterval(this.recorder.timerInterval);
      this.recorder.timerInterval = null;
    }
    document.getElementById('recording-timer').innerText = '00:00';
  },

  async processAudio() {
    if (!this.selectedFile) {
      this.showNotif('Please select an audio file first', true);
      return;
    }

    const style = document.getElementById('summary-style').value;
    const formData = new FormData();
    formData.append('file', this.selectedFile);
    formData.append('style', style);

    this.setLoading(true, 'Transcribing & Summarizing AI models running...');

    try {
      // Assuming server runs on the same port, or fallback to relative URL
      const response = await fetch('/api/process', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Server error processing audio.');
      }

      this.displayResults(data);
      this.saveToHistory(data, this.selectedFile.name);
      this.showNotif('Audio processed successfully!');
      
    } catch (err) {
      console.error(err);
      this.showNotif(err.message, true);
    } finally {
      this.setLoading(false);
    }
  },

  displayResults(data) {
    document.getElementById('res-transcript').innerText = data.transcript;
    document.getElementById('res-lang').innerText = (data.language || 'EN').toUpperCase();
    document.getElementById('res-summary').innerText = data.summary;

    const kpList = document.getElementById('res-keypoints');
    kpList.innerHTML = '';
    (data.keyPoints || []).forEach(pt => {
      const li = document.createElement('li');
      li.innerText = pt;
      kpList.appendChild(li);
    });

    const solutionCard = document.getElementById('solution-card');
    if (data.solution && solutionCard) {
      document.getElementById('res-solution').innerText = data.solution;
      solutionCard.style.display = 'block';
    } else if (solutionCard) {
      solutionCard.style.display = 'none';
    }

    // Show avatar card
    document.getElementById('avatar-card').style.display = 'block';
    document.getElementById('nvidia-avatar-video').style.display = 'none';

    // Reset and show chat card
    this.currentTranscript = data.transcript || '';
    this.chatHistory       = [];
    this.resetChatUI();
    document.getElementById('chat-card').style.display = 'block';

    document.getElementById('results-container').classList.add('visible');
    setTimeout(() => {
      document.querySelector('.view-container').scrollTo(0, document.body.scrollHeight);
    }, 100);
  },

  saveToHistory(data, filename) {
    const item = {
      id: Date.now().toString(),
      date: new Date().toISOString(),
      filename: filename,
      wordCount: data.wordCount,
      duration: data.duration,
      summaryPreview: data.summary.substring(0, 80) + '...',
      fullData: data
    };

    this.history.unshift(item);
    this.saveData();
    this.updateDashboard();
    this.renderHistory();
  },

  viewHistoryItem(id) {
    const item = this.history.find(i => i.id === id);
    if (!item) return;

    this.navigate('transcribe');
    this.clearFile();
    document.getElementById('drop-zone').style.display = 'none';
    
    const banner = document.getElementById('file-chosen-banner');
    banner.style.display = 'flex';
    document.getElementById('file-chosen-name').innerText = `[Archived] ${item.filename}`;
    
    this.displayResults(item.fullData);
  },

  renderHistory() {
    const dashList = document.getElementById('dashboard-recent-list');
    const fullList = document.getElementById('full-history-list');

    if (this.history.length === 0) {
      const empty = '<p style="color: var(--text-muted); padding: 1rem;">No history found.</p>';
      dashList.innerHTML = empty;
      fullList.innerHTML = empty;
      return;
    }

    const createHTML = (item) => `
      <div class="history-item">
        <div class="history-info">
          <div class="history-icon"><i class="fa-solid fa-microphone-lines"></i></div>
          <div class="history-details">
            <h4>${item.filename}</h4>
            <p>${new Date(item.date).toLocaleString()} • ${item.wordCount || 0} words</p>
          </div>
        </div>
        <div class="history-actions">
          <button class="btn btn-secondary" onclick="app.viewHistoryItem('${item.id}')">View</button>
        </div>
      </div>
    `;

    dashList.innerHTML = this.history.slice(0, 3).map(createHTML).join('');
    fullList.innerHTML = this.history.map(createHTML).join('');
  },

  clearHistory() {
    if(confirm('Are you sure you want to delete all recording history?')) {
      this.history = [];
      this.saveData();
      this.updateDashboard();
      this.renderHistory();
      this.showNotif('History cleared');
    }
  },

  updateDashboard() {
    document.getElementById('dash-total').innerText = this.history.length;
    
    const words = this.history.reduce((sum, item) => sum + (item.wordCount || 0), 0);
    document.getElementById('dash-words').innerText = words.toLocaleString();
  },

  saveSettings() {
    this.settings.defaultStyle = document.getElementById('setting-style').value;
    this.settings.nvidiaKey    = document.getElementById('setting-nvidia-key').value.trim();
    this.saveData();
    document.getElementById('summary-style').value = this.settings.defaultStyle;
    this.showNotif('Preferences saved successfully!');
  },

  loadData() {
    try {
      const storedHistory = localStorage.getItem('vn_history');
      if (storedHistory) this.history = JSON.parse(storedHistory);

      const storedSettings = localStorage.getItem('vn_settings');
      if (storedSettings) {
        this.settings = { ...this.settings, ...JSON.parse(storedSettings) };
        document.getElementById('setting-style').value    = this.settings.defaultStyle;
        document.getElementById('summary-style').value    = this.settings.defaultStyle;
        document.getElementById('setting-nvidia-key').value = this.settings.nvidiaKey || '';
        if (this.settings.hasFaceImage) {
          document.getElementById('face-upload-status').innerText = 'Face photo already uploaded.';
        }
      }
    } catch(e) { console.error('Error loading data', e); }
  },

  saveData() {
    localStorage.setItem('vn_history', JSON.stringify(this.history));
    localStorage.setItem('vn_settings', JSON.stringify(this.settings));
  },

  setLoading(active, text) {
    const overlay = document.getElementById('loading-overlay');
    if (active) {
      if (text) document.getElementById('loading-text').innerText = text;
      overlay.classList.add('active');
    } else {
      overlay.classList.remove('active');
    }
  },

  // ── Chat with Note ──────────────────────────────────────────────────────────

  resetChatUI() {
    document.getElementById('chat-messages').innerHTML = `
      <div class="chat-bubble ai">
        <div class="chat-avatar-icon"><i class="fa-solid fa-robot"></i></div>
        <div class="chat-bubble-text">I've read your note. Ask me anything about it!</div>
      </div>`;
    document.getElementById('chat-input').value = '';
  },

  appendChatBubble(role, text) {
    const box = document.getElementById('chat-messages');
    const el  = document.createElement('div');
    el.className = `chat-bubble ${role === 'user' ? 'user' : 'ai'}`;
    el.innerHTML = role === 'user'
      ? `<div class="chat-bubble-text">${this._escapeHtml(text)}</div>`
      : `<div class="chat-avatar-icon"><i class="fa-solid fa-robot"></i></div>
         <div class="chat-bubble-text">${this._escapeHtml(text)}</div>`;
    box.appendChild(el);
    box.scrollTop = box.scrollHeight;
    return el;
  },

  _escapeHtml(str) {
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
              .replace(/\n/g,'<br>');
  },

  async sendChat() {
    const input   = document.getElementById('chat-input');
    const message = input.value.trim();
    if (!message) return;

    input.value = '';
    this.appendChatBubble('user', message);

    // Thinking bubble
    const thinking = this.appendChatBubble('ai', '…');
    thinking.querySelector('.chat-bubble-text').classList.add('thinking');

    const sendBtn = document.getElementById('btn-chat-send');
    sendBtn.disabled = true;

    try {
      const response = await fetch('/api/chat', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message,
          transcript: this.currentTranscript,
          history:    this.chatHistory,
        }),
      });

      const data = await response.json();
      if (!response.ok) throw new Error(data.error || 'Chat failed');

      // Replace thinking bubble with real reply
      thinking.querySelector('.chat-bubble-text').classList.remove('thinking');
      thinking.querySelector('.chat-bubble-text').innerHTML = this._escapeHtml(data.reply);

      // Keep history for context (cap at 20 turns to avoid prompt bloat)
      this.chatHistory.push({ role: 'user',      content: message     });
      this.chatHistory.push({ role: 'assistant', content: data.reply  });
      if (this.chatHistory.length > 20) this.chatHistory = this.chatHistory.slice(-20);

    } catch (err) {
      thinking.querySelector('.chat-bubble-text').classList.remove('thinking');
      thinking.querySelector('.chat-bubble-text').innerHTML =
        `<span style="color:var(--danger);">${this._escapeHtml(err.message)}</span>`;
    } finally {
      sendBtn.disabled = false;
      input.focus();
    }
  },

  // ── Avatar Explainer ────────────────────────────────────────────────────────

  speakSummary() {
    const summary = document.getElementById('res-summary').innerText;
    if (!summary) return;

    if (!('speechSynthesis' in window)) {
      this.showNotif('Browser TTS is not supported in this browser', true);
      return;
    }

    window.speechSynthesis.cancel();

    const utterance  = new SpeechSynthesisUtterance(summary);
    utterance.rate   = 0.92;
    utterance.pitch  = 1.0;
    utterance.volume = 1.0;

    const mouth  = document.getElementById('avatar-mouth');
    const avatar = document.getElementById('css-avatar');

    utterance.onstart = () => {
      document.getElementById('btn-speak').style.display      = 'none';
      document.getElementById('btn-stop-speak').style.display = 'inline-flex';
      mouth?.classList.add('talking');
      avatar?.classList.add('speaking');
    };

    const onDone = () => {
      document.getElementById('btn-speak').style.display      = 'inline-flex';
      document.getElementById('btn-stop-speak').style.display = 'none';
      mouth?.classList.remove('talking');
      avatar?.classList.remove('speaking');
    };

    utterance.onend   = onDone;
    utterance.onerror = onDone;

    window.speechSynthesis.speak(utterance);
  },

  stopSpeaking() {
    if ('speechSynthesis' in window) window.speechSynthesis.cancel();
    document.getElementById('btn-speak')?.style &&
      (document.getElementById('btn-speak').style.display = 'inline-flex');
    document.getElementById('btn-stop-speak')?.style &&
      (document.getElementById('btn-stop-speak').style.display = 'none');
    document.getElementById('avatar-mouth')?.classList.remove('talking');
    document.getElementById('css-avatar')?.classList.remove('speaking');
  },

  async generateAvatar() {
    const summary   = document.getElementById('res-summary').innerText;
    const nvidiaKey = this.settings.nvidiaKey;

    if (!nvidiaKey) {
      this.showNotif('Add your NVIDIA API key in Settings first', true);
      this.navigate('settings');
      return;
    }
    if (!this.settings.hasFaceImage) {
      this.showNotif('Upload a face photo in Settings first', true);
      this.navigate('settings');
      return;
    }

    const btn = document.getElementById('btn-nvidia-avatar');
    btn.disabled   = true;
    btn.innerHTML  = '<i class="fa-solid fa-spinner fa-spin"></i> Generating…';

    this.setLoading(true, 'Generating NVIDIA Avatar Video…');

    try {
      const response = await fetch('/api/avatar', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', 'x-nvidia-key': nvidiaKey },
        body:    JSON.stringify({ text: summary }),
      });

      if (!response.ok) {
        const err = await response.json();
        throw new Error(err.error || 'Avatar generation failed');
      }

      const videoBlob = await response.blob();
      const videoURL  = URL.createObjectURL(videoBlob);

      const videoEl = document.getElementById('avatar-video');
      videoEl.src   = videoURL;
      document.getElementById('nvidia-avatar-video').style.display = 'block';
      videoEl.play();

      this.showNotif('Avatar video generated!');
    } catch (err) {
      this.showNotif(err.message, true);
    } finally {
      this.setLoading(false);
      btn.disabled  = false;
      btn.innerHTML = '<i class="fa-solid fa-film"></i> Generate Avatar Video';
    }
  },

  async uploadFaceImage() {
    const fileInput = document.getElementById('face-upload-input');
    if (!fileInput.files.length) return;

    const formData = new FormData();
    formData.append('image', fileInput.files[0]);

    this.setLoading(true, 'Uploading face photo…');

    try {
      const res  = await fetch('/api/avatar/face', { method: 'POST', body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      // Show preview
      const reader   = new FileReader();
      reader.onload  = (e) => {
        const preview = document.getElementById('face-preview');
        preview.src   = e.target.result;
        preview.style.display = 'block';
      };
      reader.readAsDataURL(fileInput.files[0]);

      document.getElementById('face-upload-status').innerText = 'Face photo uploaded successfully.';
      this.settings.hasFaceImage = true;
      this.saveData();
      this.showNotif('Face photo uploaded!');
    } catch (err) {
      this.showNotif(err.message, true);
    } finally {
      this.setLoading(false);
    }
  },

  showNotif(msg, isError = false) {
    const notif = document.getElementById('notification');
    document.getElementById('notif-text').innerText = msg;
    
    notif.className = 'notification' + (isError ? ' error' : '');
    notif.querySelector('i').className = isError ? 'fa-solid fa-circle-exclamation' : 'fa-solid fa-circle-check';
    
    // Force reflow
    void notif.offsetWidth;
    
    notif.classList.add('show');
    
    setTimeout(() => {
      notif.classList.remove('show');
    }, 4000);
  }
};

// Initialize App
document.addEventListener('DOMContentLoaded', () => app.init());

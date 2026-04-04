const app = {
  activeView: 'dashboard',
  selectedFile: null,
  history: [],
  settings: {
    defaultStyle: 'paragraph'
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

  clearFile() {
    this.selectedFile = null;
    document.getElementById('file-input').value = '';
    document.getElementById('file-chosen-banner').style.display = 'none';
    document.getElementById('drop-zone').style.display = 'block';
    document.getElementById('results-container').classList.remove('visible');
    document.getElementById('btn-record').style.display = 'flex';
  },

  resetTranscribe() {
    this.clearFile();
    document.getElementById('res-transcript').innerText = '';
    document.getElementById('res-summary').innerText = '';
    document.getElementById('res-keypoints').innerHTML = '';
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

    document.getElementById('results-container').classList.add('visible');
    // Scroll down to results
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
        document.getElementById('setting-style').value = this.settings.defaultStyle;
        document.getElementById('summary-style').value = this.settings.defaultStyle;
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

(() => {
    const registerWorker = async () => {
      if (!('serviceWorker' in navigator)) return;
      try {
        await navigator.serviceWorker.register('/sw.js', { scope: '/' });
      } catch (error) {
        console.error('PWA service worker registration failed:', error);
      }
    };
  
    const addStatus = () => {
      const status = document.createElement('div');
      status.className = 'pwa-status';
      status.setAttribute('role', 'status');
      status.setAttribute('aria-live', 'polite');
      status.hidden = true;
      document.body.append(status);
  
      const update = () => {
        status.textContent = navigator.onLine
          ? 'Back online. Reconnect the console if live data has paused.'
          : 'You are offline. Live sessions and messages are unavailable.';
        status.classList.toggle('pwa-status--offline', !navigator.onLine);
        status.hidden = navigator.onLine;
      };
  
      window.addEventListener('online', update);
      window.addEventListener('offline', update);
      update();
    };
  
    const addInstallControl = () => {
      let installPrompt;
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'pwa-install';
      button.textContent = 'Install app';
      button.setAttribute('aria-label', 'Install WhatsApp Bot Admin Console');
      button.hidden = true;
      document.body.append(button);
  
      window.addEventListener('beforeinstallprompt', (event) => {
        event.preventDefault();
        installPrompt = event;
        button.hidden = false;
      });
  
      button.addEventListener('click', async () => {
        if (!installPrompt) return;
        await installPrompt.prompt();
        await installPrompt.userChoice;
        installPrompt = undefined;
        button.hidden = true;
      });
  
      window.addEventListener('appinstalled', () => {
        installPrompt = undefined;
        button.hidden = true;
      });
    };
  
    const start = () => {
      addStatus();
      addInstallControl();
      void registerWorker();
    };
  
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }
  })();
  
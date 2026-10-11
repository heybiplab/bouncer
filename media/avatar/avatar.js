// Avatar webview script: applies state messages from the extension to the scene.
(() => {
  const vscode = acquireVsCodeApi();
  const sign = document.getElementById('sign');
  const caption = document.getElementById('caption');

  const captions = {
    idle: () => "All clear. Nobody's waiting at the door.",
    watching: (count) => (count > 0 ? `Claude is editing… ${count} at the door so far.` : 'Claude is editing… Bouncer is watching.'),
    done: () => 'Review them below.',
  };

  const render = ({ status, count }) => {
    const state = captions[status] ? status : 'idle';
    document.body.dataset.state = state;
    sign.textContent = `${count} waiting at the door`;
    caption.textContent = captions[state](count);
  };

  window.addEventListener('message', (event) => {
    if (event.data?.type === 'state') {
      render(event.data);
    }
  });

  vscode.postMessage({ type: 'ready' });
})();

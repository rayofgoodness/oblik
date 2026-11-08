// Міст між інтерфейсом (src/app.js) і Rust.
// Створює window.api з тими самими методами, що й preload.js в Electron,
// тому app.js працює однаково в обох версіях. Виконується до скриптів сторінки.
(() => {
  const invoke = (cmd, args) => window.__TAURI_INTERNALS__.invoke(cmd, args);
  let pending = Promise.resolve();

  window.api = {
    load: async () => {
      const text = await invoke('load');
      return text ? JSON.parse(text) : null;
    },
    save: (json) => (pending = invoke('save', { json })),
    // У Tauri синхронного виклику немає: запускаємо збереження,
    // а закриття вікна чекає на нього (див. __oblikFlushAndQuit)
    saveSync: (json) => { pending = invoke('save', { json }); return true; },
    openDataFolder: () => invoke('open_data_folder'),
    exportFile: (name, content, kind) => invoke('export_file', { name, content, kind }),
    print: async () => window.print(),
  };

  // Викликається з Rust при закритті вікна: дописати незбережене і вийти
  window.__oblikFlushAndQuit = async () => {
    try {
      window.dispatchEvent(new Event('pagehide'));
      await pending;
    } catch (e) {
      console.error(e);
    }
    invoke('quit');
  };
})();

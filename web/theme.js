(() => {
  const root = document.documentElement;
  const key = 'historian2grafana.theme';
  const preferred = matchMedia('(prefers-color-scheme: dark)');
  let choice;
  try { choice = localStorage.getItem(key); } catch { /* браузер запретил хранение */ }

  function apply() {
    const dark = choice === 'dark' || (choice !== 'light' && preferred.matches);
    root.dataset.theme = dark ? 'dark' : 'light';
    document.getElementById('theme-toggle')?.setAttribute('aria-pressed', String(dark));
    document.dispatchEvent(new Event('theme-change'));
  }

  apply();
  preferred.addEventListener('change', apply);
  window.addEventListener('storage', (event) => {
    if (event.key !== key) return;
    choice = event.newValue;
    apply();
  });
  document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('theme-toggle')?.addEventListener('click', () => {
      choice = root.dataset.theme === 'dark' ? 'light' : 'dark';
      try { localStorage.setItem(key, choice); } catch { /* браузер запретил хранение */ }
      apply();
    });
    apply();
  });
})();

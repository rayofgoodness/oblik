# Облік магазину

Облік товару і каси для невеликого магазину. Працює без інтернету.

- **Журнал**: дата, найменування, надходження, каса (термінал + готівка), готівка, списання, коментар. Підсумки за день і місяць, залишок на кінець місяця.
- **Залишки товару**: кількість (г або шт) × ціна (за кг або за шт) = сума, загальна сума товару.

## iPhone (PWA)

1. Відкрити https://rayofgoodness.github.io/oblik/ у **Safari**.
2. «Поділитися» → «На екран „Додому“».
3. Далі застосунок відкривається з іконки і працює без інтернету.

Дані зберігаються лише на цьому телефоні. Регулярно натискайте «Зберегти копію» і зберігайте файл у «Файли» / iCloud. Видалення застосунку з екрана стирає дані.

## Windows

Інсталер: `npm run dist:win` → `dist/Oblik-Setup-<версія>.exe`. Дані: `%APPDATA%\Oblik\data.json`, щоденні копії в `backups/`.

Перенести дані між ПК і телефоном: «Зберегти копію» на одному пристрої → «Відновити» на іншому (замінює всі дані).

На ПК вхід за паролем не потрібен — він є лише в PWA (телефон / сайт).

### Дві версії для Windows

| | Electron (`main.js`) | Rust / Tauri (`src-tauri/`) |
|---|---|---|
| Інсталер | ~120 МБ | ~5 МБ |
| Рушій | вбудований Chromium | WebView2 з Windows 10/11 |
| Дані | `%APPDATA%\Oblik` | та сама папка |

Обидві показують той самий інтерфейс із `src/` і читають ті самі дані, тож можна перейти з однієї на іншу. **Не запускайте обидві одночасно** — вони писатимуть в один файл.

## Розробка

```bash
npm install
npm start            # Electron-версія для ПК
npm run dist:win     # Electron: інсталер + zip для Windows
npm run rust:dev     # Rust-версія на цьому комп'ютері
npm run deploy:web   # PWA на Cloudflare
```

Rust-інсталер для Windows з macOS (одноразово: `rustup target add x86_64-pc-windows-msvc`, `cargo install --locked cargo-xwin`, `brew install nsis llvm lld`):

```bash
npm run rust:build:win
# → src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis/Oblik-Rust_<версія>_x64-setup.exe
# → src-tauri/target/x86_64-pc-windows-msvc/release/oblik.exe (без встановлення)
```

Скрипт сам додає LLVM у PATH і ставить `LC_ALL=en_US.UTF-8`: без локалі `makensis` з Homebrew падає з `std::bad_alloc`.

Код інтерфейсу спільний: `src/`. При зміні файлів у `src/` збільшити `VERSION` у `src/sw.js`, щоб телефони отримали оновлення.

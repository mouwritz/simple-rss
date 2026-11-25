# Simple RSS

A small desktop RSS reader for Windows, macOS and Linux, built with Electron.

- **Feed list:** title and a short summary per post, newest first, with an unread dot.
- **Auto refresh:** every 1, 5 (default), 15, 30 or 60 minutes, or off. You can also refresh by hand (`Ctrl/⌘+R`).
- **Reader:** click a row to read the full post, with the header image shown when the feed has one. Links open in your normal browser.
- **Channels menu:** add, rename and delete channels. You can paste a feed URL or a website address, and the app finds the website's feed.
- **Favorites:** new posts in a starred channel send a desktop notification. Clicking the notification opens that post.
- **Colors:** give a channel a color and its posts get a colored line on the left.
- Reads RSS 2.0, RSS 1.0 (RDF) and Atom. Light and dark mode follow your system.
- Keyboard: `↑`/`↓` (or `k`/`j`) to move through posts.

## Run it

You need [Node.js](https://nodejs.org) 20 or newer.

```bash
npm install
npm start
```

## Build installers

```bash
npm run dist:win     # Windows: NSIS installer (x64 + arm64) and a portable .exe
npm run dist:mac     # macOS: universal .dmg and .zip
npm run dist:linux   # Linux: AppImage and .deb (x64 + arm64)
```

Output goes to `dist/`. Build each platform on that platform. macOS builds must run on a Mac. The `.github/workflows/build.yml` workflow does all three for you: push a tag like `v1.0.0`, or start it by hand from the Actions tab, and download the installers from the run's artifacts.

The installers are **unsigned**. Windows SmartScreen and macOS Gatekeeper will warn the first time. On a Mac, right-click the app and choose *Open*. To sign the builds, add code-signing certificates as described in the [electron-builder docs](https://www.electron.build/code-signing).

## How it is put together

```
src/main.js            Electron main process: window, feed downloads, saving, notifications
src/preload.js         The small, safe bridge (window.api) between the page and the main process
src/renderer/
  index.html           Layout
  styles.css           Styling (light and dark)
  feed.js              RSS/Atom parser, feed discovery, HTML sanitizer
  app.js               UI, refresh loop, channels menu, notifications
build/icon.png         App icon (electron-builder makes the .ico/.icns from it)
```

- Feeds are downloaded in the main process, so there are no CORS limits. Character sets other than UTF-8 are handled.
- Channels, posts (up to 300 per channel), read state and settings are saved to `store.json` in the app's user-data folder.
- Post HTML is cleaned with an allowlist before it is shown: no scripts, iframes, forms, event handlers or tracking pixels. A strict Content-Security-Policy blocks scripts as a second layer, and the page runs sandboxed with no Node access.
- Notifications fire only for posts that arrive after a channel's first load, so adding a channel doesn't flood you. More than 3 new posts at once are grouped into one notification.

## Notes

- Auto refresh and notifications run while the app is open. On Windows and Linux, closing the window quits the app. On macOS the app keeps running in the Dock.
- On Windows, notifications show the app's name properly only when you run the installed app, not during `npm start`.

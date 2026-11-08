# Discord → Telegram migration notes

- Replaced discord.js event handling and embeds with Telegraf commands/messages.
- Added user-scoped Telegram subscriptions, so many users can subscribe to the same Instagram username without duplicate scraping.
- Added a shared polling worker and per-username deduplication.
- Kept the Puppeteer Instagram checker in `instagram.js`; its UNKNOWN result is not treated as a ban.
- Added Telegram-native `/start`, `/watch`, `/unbanwatch`, `/check`, `/status`, `/watchlist`, `/unwatch`, `/pause`, `/resume`, `/followers`, `/history`, `/stats`, `/dmon`, `/dmoff`, owner maintenance and premium commands.
- Discord server/channel features are intentionally omitted because Telegram has no equivalent guild/channel model. See README for exact limitations.
- This package has not been live-tested against Telegram, MongoDB, or Instagram credentials in this environment.

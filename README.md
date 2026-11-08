# IG-MONI Telegram Bot

Telegram-native edition of IG-MONI. Uses Telegraf, MongoDB, Puppeteer and Chromium. Each user owns their subscriptions; a profile is checked once per worker cycle and alerts are sent to all subscribers, avoiding duplicate Instagram checks for shared profiles.

## Commands
- `/start`, `/help`
- `/watch username` or `/banwatch username`
- `/unbanwatch username`
- `/check username`, `/status username`
- `/watchlist`, `/unwatch username`
- `/pause username`, `/resume username`
- `/followers username threshold`
- `/history username`, `/stats`, `/ping`, `/uptime`, `/botinfo`, `/price`
- `/dmon`, `/dmoff`
- Owner: `/mon`, `/moff`, `/givepremium userId [days]`

## Deploy
1. Create a bot with `@BotFather` and copy its token.
2. Set `TELEGRAM_BOT_TOKEN`, `MONGODB_URI`, and `OWNER_IDS` in your host's environment settings.
3. Deploy using the included Dockerfile (recommended; it installs Chromium).
4. Open the bot in Telegram and send `/start`.

Do not commit `.env` or share the bot token. If exposed, revoke it with BotFather.

## Capacity notes
The application supports a target of up to 2,000 registered Telegram users, but registered users are not equivalent to 2,000 concurrently monitored unique Instagram profiles. The current worker is deliberately conservative (one Instagram check at a time, deduplicated by username, 15-minute default cycle) to reduce Instagram rate limits and Chromium pressure. Actual profile throughput depends on Instagram response latency and account restrictions. A high-volume production deployment should split the worker into a durable queue and add Redis/BullMQ, distributed locks, and operational metrics before increasing concurrency.

## Important limitations
Instagram public-page scraping is unofficial and can return UNKNOWN during login walls, challenges, rate limits, or layout changes. UNKNOWN is not treated as a ban. The current checker supports public-profile metadata; verified-badge detection and the old Discord-specific server/channel management, role pings, invite, guild access, and server administration commands are not portable to Telegram and are not included in this first Telegram port. User subscriptions, ban/recovery alerts, follower threshold alerts, history, pause/resume, and owner maintenance/premium controls are included.

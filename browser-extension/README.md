# Hourglass Connector (browser extension)

This tiny extension tells the Hourglass desktop app which website your active
tab is on, so the app can auto-switch timers:

- **YouTube** or **Instagram** → your Entertainment timer
- **Quran.com** → your Quran / Prayer timer
- An **excluded YouTube channel** (e.g. a physics channel you learn from) →
  optionally a different timer, or none — it won't count as Entertainment.

It talks only to `http://127.0.0.1:45871` on your own machine. It sends the
current site and, for YouTube, the channel name — nothing else, nowhere else.

## Install (Chrome or Edge)

1. Open `chrome://extensions` (or `edge://extensions`).
2. Turn on **Developer mode** (top-right).
3. Click **Load unpacked** and choose this `browser-extension` folder.
4. Open the Hourglass app → the **Website Auto-Switch** status turns green.

Make sure Hourglass is running; the extension connects to it automatically.

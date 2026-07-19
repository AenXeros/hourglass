# ⏳ Hourglass

A focus tracker built around switchable "hourglass" timers. Instead of counting
down one clock, you keep several — one per task — and only ever one runs at a
time. Switching between them (by click or global keybind) tells you how much
time you *actually* spent on each thing.

## The idea

1. Tell it what time you **wake up** and **sleep** — it shows how many hours your
   day holds and how much you've allocated.
2. Create an **hourglass** for each task (name + how long you want to spend).
3. **Start** one to run its timer. Starting another automatically pauses the
   first, so time only ever counts toward the task you're actually doing.
4. Get up for lunch? Hit the lunch hourglass's keybind and it switches instantly
   — even if Hourglass isn't the focused window.

## Persistence & the 5 AM reset

- Your wake/sleep times and your hourglasses **persist forever** until you change
  them yourself.
- Only the **elapsed time** on each hourglass resets — automatically, every day
  at **5:00 AM**. The app checks this continuously, so it resets even if it was
  running through 5 AM.

Data lives at `%APPDATA%\hourglass\hourglass-data.json`.

## Mini mode

Click the **⧉** button (top-left) to collapse the app into a small, always-on-top
box in the top-right corner of your screen. It shows the running task and its
time left, and nothing else. Drag it to move it; click **⤢** to reopen the full
window.

## Keybinds

Each hourglass can have a **global** shortcut that toggles it on/off from
anywhere. Click the keybind field, then press the combo you want.

- Pressing an hourglass's keybind starts it (and pauses whatever was running).
- Pressing the same keybind again pauses everything.
- **Tip:** prefer a modifier combo like `Ctrl+Shift+1`. A bare `Shift+1` also
  works, but because shortcuts are global it would swallow that combo in every
  app (e.g. you couldn't type `!`).

## Running

```bash
npm install
npm start
```

## Building a Windows installer

```bash
npm run dist
```

Produces an installer under `dist/`.

/**
 * Dev tool: replay the latest transcript and screenshot the dashboard at key
 * moments (night table, day chat, vote reveal, endgame). Server must be running.
 *
 *   npx tsx scripts/screenshot-replay.ts [--spoilers] [--speed N]
 */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:3000";
const OUT = "/tmp/wolves-shots";

const spoilers = process.argv.includes("--spoilers");
const speedIdx = process.argv.indexOf("--speed");
const speed = speedIdx > -1 ? Number(process.argv[speedIdx + 1]) : 3;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--window-size=1920,1080",
      // keep client-side animation timers accurate in headless capture
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });

  // Crank the speed via the UI control, then optionally open the GM panel.
  await page.evaluate((s) => {
    const ws = new WebSocket(`ws://${location.host}/ws`);
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: "hello", channel: "spectator" }));
      ws.send(JSON.stringify({ type: "set_speed", speed: s }));
      ws.close();
    };
  }, speed);
  if (spoilers) {
    await page.evaluate(() => {
      const boxes = Array.from(document.querySelectorAll<HTMLInputElement>(".toggle input"));
      boxes.forEach((b) => !b.checked && b.click());
    });
  }

  // Kick off the replay of the most recent transcript.
  const files: { files: string[] } = await fetch(`${BASE}/api/transcripts`).then((r) => r.json());
  if (!files.files.length) throw new Error("no transcripts to replay");
  await fetch(`${BASE}/api/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: files.files[0] }),
  });
  console.log(`replaying ${files.files[0]} at ${speed}x, spoilers=${spoilers}`);

  // Snap on phase transitions and night-action animations.
  const wanted = new Set(["night", "peek", "swap", "day", "vote-countdown", "votes", "reveal"]);
  const seen = new Set<string>();
  const deadline = Date.now() + 240_000;
  while (seen.size < wanted.size && Date.now() < deadline) {
    const marker: string = await page.evaluate(() => {
      if (document.querySelector(".overlay.endgame")) return "reveal";
      if (document.querySelector(".countdown")) return "vote-countdown";
      if (document.querySelector(".vote-layout")) return "votes";
      if (document.querySelector(".pcard.swapped")) return "swap";
      if (document.querySelector(".pcard.peeked")) return "peek";
      if (document.querySelector(".overlay.night")) return "night";
      if (document.querySelector(".table-strip")) return "day";
      return "";
    });
    if (marker && wanted.has(marker) && !seen.has(marker)) {
      // settle so animations/messages are mid-flight (none for night actions)
      const settle = marker === "votes" ? 3500 : marker === "peek" || marker === "swap" ? 250 : 2500;
      await new Promise((r) => setTimeout(r, settle));
      await page.screenshot({ path: `${OUT}/${String(seen.size + 1).padStart(2, "0")}-${marker}.png` });
      seen.add(marker);
      console.log("captured", marker);
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  if (seen.size < wanted.size) {
    console.log("missed:", [...wanted].filter((w) => !seen.has(w)).join(", "));
  }

  await browser.close();
  console.log("done →", OUT);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

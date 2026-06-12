/** Dev probe: log the vote-sequence DOM state over time during a replay. */
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:3000";

async function main() {
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: [
      "--window-size=1920,1080",
      "--disable-background-timer-throttling",
      "--disable-renderer-backgrounding",
      "--disable-backgrounding-occluded-windows",
    ],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();
  await page.goto(BASE, { waitUntil: "networkidle0" });

  const files: { files: string[] } = await fetch(`${BASE}/api/transcripts`).then((r) => r.json());
  const res = await fetch(`${BASE}/api/replay`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ file: files.files[0] }),
  });
  console.log("replay start:", res.status, files.files[0]);

  const t0 = Date.now();
  let sawVotes = false;
  while (Date.now() - t0 < 200_000) {
    const s = await page.evaluate(() => ({
      banner: document.querySelector(".phase-text")?.textContent ?? "",
      countdown: !!document.querySelector(".countdown"),
      rows: document.querySelectorAll(".vote-card").length,
      verdict: !!document.querySelector(".deaths.stamp"),
      endgame: !!document.querySelector(".overlay.endgame"),
    }));
    if (s.countdown || s.rows > 0 || s.endgame) sawVotes = true;
    if (sawVotes) {
      console.log(
        `t=${((Date.now() - t0) / 1000).toFixed(1)}s banner=${JSON.stringify(s.banner)} countdown=${s.countdown} rows=${s.rows} verdict=${s.verdict} endgame=${s.endgame}`,
      );
      if (s.endgame) break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  await browser.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

/** Dev tool: screenshot specific routes (no game needed). Server must be running. */
import fs from "node:fs";
import puppeteer from "puppeteer-core";

const CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const BASE = "http://localhost:3000";
const OUT = "/tmp/wolves-shots";

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await puppeteer.launch({
    executablePath: CHROME,
    headless: true,
    args: ["--window-size=1920,1080"],
    defaultViewport: { width: 1920, height: 1080 },
  });
  const page = await browser.newPage();

  // Seed a localStorage persona library so the page shows the library populated.
  await page.goto(BASE, { waitUntil: "networkidle0" });
  await page.evaluate(() => {
    localStorage.setItem(
      "aiwolves:personas",
      JSON.stringify([
        { id: "p_demo1", name: "Barista Bea", avatar: "☕", color: "#7dd3fc", body: "calm barista", updatedAt: Date.now() },
        { id: "p_demo2", name: "Sir Reginald", avatar: "🎩", color: "#fbbf24", body: "pompous detective", updatedAt: Date.now() - 1000 },
      ]),
    );
  });

  await page.goto(`${BASE}/#/bring`, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 600));
  await page.screenshot({ path: `${OUT}/bring-player.png` });
  console.log("captured bring-player");

  await page.goto(BASE, { waitUntil: "networkidle0" });
  await new Promise((r) => setTimeout(r, 800));
  await page.screenshot({ path: `${OUT}/dashboard-submissions.png` });
  console.log("captured dashboard-submissions");

  await browser.close();
  console.log("done →", OUT);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

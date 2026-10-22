// Visual check: builds the Three.js preview, opens it in headless Chromium,
// lets the bot play, flags console errors and performance budget overruns,
// and saves screenshots for Claude (or a person) to review against the bible.
//   npm run qa:visual [-- --project <name> --turns 200 --out qa-output]
import { mkdirSync } from "node:fs";
import { parseArgs } from "node:util";
import { chromium } from "playwright-core";
import { preview, build } from "vite";

const { values } = parseArgs({
  options: {
    project: { type: "string", default: "dungeon-crawler" },
    turns: { type: "string", default: "150" },
    out: { type: "string", default: "qa-output" },
    "no-build": { type: "boolean", default: false },
  },
});
const project = values.project!.replace(/^projects\//, "");
const BUDGET = { drawCalls: 400, triangles: 300_000 };

if (!values["no-build"]) await build({ logLevel: "warn" });
const server = await preview({ preview: { port: 4317, strictPort: true }, logLevel: "warn" });
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH ?? "/opt/pw-browsers/chromium-1194/chrome-linux/chrome",
  args: ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const problems: string[] = [];
try {
  mkdirSync(values.out!, { recursive: true });
  for (const [name, viewport] of [
    ["desktop", { width: 1280, height: 800 }],
    ["phone", { width: 390, height: 844 }],
  ] as const) {
    const page = await browser.newPage({ viewport });
    page.on("pageerror", (e) => problems.push(`${name}: page error: ${e.message}`));
    page.on("console", (m) => m.type() === "error" && problems.push(`${name}: console error: ${m.text()}`));
    await page.goto(`http://localhost:4317/?project=${project}&seed=visual-1`);
    await page.waitForFunction(() => "__qa" in window);
    await page.waitForTimeout(800);
    await page.screenshot({ path: `${values.out}/${project}-${name}-start.png` });
    const result = await page.evaluate(async (turns) => {
      const qa = (window as any).__qa;
      for (let i = 0; i < turns && qa.game.state.status === "playing"; i++) {
        qa.botStep();
        await new Promise((r) => setTimeout(r, 8));
      }
      await new Promise((r) => setTimeout(r, 600));
      return { ...qa.stats(), floor: qa.game.state.floor, status: qa.game.state.status, turn: qa.game.state.turn };
    }, Number(values.turns));
    await page.screenshot({ path: `${values.out}/${project}-${name}-after.png` });
    console.log(`${name}: turn ${result.turn}, floor ${result.floor}, ${result.status}, ${result.calls} draw calls, ${result.triangles} tris`);
    if (result.calls > BUDGET.drawCalls) problems.push(`${name}: ${result.calls} draw calls > budget ${BUDGET.drawCalls}`);
    if (result.triangles > BUDGET.triangles) problems.push(`${name}: ${result.triangles} triangles > budget ${BUDGET.triangles}`);
    await page.close();
  }
} finally {
  await browser.close();
  server.httpServer.close();
}
problems.forEach((p) => console.log(`FAIL ${p}`));
console.log(problems.length ? "VISUAL CHECK FAILED" : `VISUAL CHECK PASSED (screenshots in ${values.out}/)`);
process.exit(problems.length ? 1 : 0);

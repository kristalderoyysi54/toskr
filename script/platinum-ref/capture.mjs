// 抓 Tauri 前端在 Platinum 下的参照截图与计算样式。由 capture.sh 注入 ROOT / OUT / ONLY 后交给 `ego-browser nodejs` 执行。
const fs = await import("node:fs/promises");
const seed = await fs.readFile(ROOT + "/script/platinum-ref/seed.js", "utf8");
const dump = await fs.readFile(ROOT + "/script/platinum-ref/dump.js", "utf8");
const jobs = JSON.parse(await fs.readFile(ROOT + "/script/platinum-ref/jobs.json", "utf8")).filter((j) => !ONLY || ONLY.split(",").includes(j.name));
await fs.mkdir(OUT, { recursive: true });
const task = await taskSpace("toskr platinum reference");
const page = task.page("p1");
const rclick = async (x, y) => {
  await page.cdp("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "right", clickCount: 1 });
  await page.cdp("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "right", clickCount: 1 });
};
for (const j of jobs) {
  try {
    // 视口每次都要重设；配色方案只有写进 localStorage 再重载才会挂 data-theme
    await page.cdp("Emulation.setDeviceMetricsOverride", { width: j.w || 380, height: j.h || 760, deviceScaleFactor: 1, mobile: false });
    await page.goto("http://localhost:1420/" + (j.query || ""));
    await page.evaluate(() => localStorage.setItem("toskr.colorScheme", JSON.stringify({ scheme: "platinum", highlight: "lavender", scrollbar: "classic" })));
    await page.reload();
    await page.waitForFunction(() => !!window.notesStore && !!window.uiStore && !!window.targetStore && !!window.dataOperationStore, undefined, { timeout: 20000 });
    await page.evaluate(seed);
    await page.waitForTimeout(700);
    await page.mouse.move((j.w || 380) - 1, 2);
    for (const s of j.steps || []) {
      if (s.eval) await page.evaluate(s.eval);
      if (s.click) await page.mouse.click(s.click[0], s.click[1]);
      if (s.clickSel) await page.click(s.clickSel);
      if (s.rclick) await rclick(s.rclick[0], s.rclick[1]);
      if (s.hover) await page.mouse.move(s.hover[0], s.hover[1]);
      await page.waitForTimeout(s.wait || 350);
    }
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${OUT}/ref-${j.name}-light.png` });
    await fs.writeFile(`${OUT}/dump-${j.name}.txt`, await page.evaluate(dump));
    console.log("ok", j.name);
  } catch (e) {
    console.log("FAIL", j.name, String(e).slice(0, 240));
  }
}
await task.finish({ keep: [] });

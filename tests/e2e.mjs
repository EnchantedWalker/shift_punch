// End-to-end check against the Firebase emulators. From the repo root:
//   python3 -m http.server 5055 &   (serves the app)
//   npx firebase emulators:exec --only auth,firestore --project demo-shiftpunch "node tests/e2e.mjs"
// Set FBCDN to a folder holding firebase-app.js, firebase-auth.js and firebase-firestore.js (10.12.2)
// to run without reaching www.gstatic.com. Screenshots go to SHOTS (default: ./shots).
import { chromium } from "playwright";
import { readFileSync, mkdirSync } from "node:fs";

const APP = "http://localhost:5055/index.html?emu";
const SHOTS = process.env.SHOTS || "shots";
mkdirSync(SHOTS, { recursive: true });
const CONFIG = `export const firebaseConfig = { apiKey: "demo-key", authDomain: "localhost", projectId: "demo-shiftpunch", appId: "demo" };`;

const browser = await chromium.launch();
const errors = [];
async function person(label) {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await ctx.route("**/firebase-config.js", (r) => r.fulfill({ contentType: "text/javascript", body: CONFIG }));
  if (process.env.FBCDN) await ctx.route("https://www.gstatic.com/firebasejs/10.12.2/*", (r) => {
    const f = r.request().url().split("/").pop();
    r.fulfill({ contentType: "text/javascript", body: readFileSync(`${process.env.FBCDN}/${f}`, "utf8") });
  });
  await ctx.route("https://fonts.googleapis.com/**", (r) => r.fulfill({ contentType: "text/css", body: "" }));
  const page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(`${label}: ${e.message}`));
  page.on("console", (m) => { if (m.type() === "error" && !/PERMISSION_DENIED|Failed to load resource/.test(m.text())) errors.push(`${label} console: ${m.text()}`); });
  await page.goto(APP);
  return page;
}
const step = (s) => console.log("  - " + s);
async function signUp(page, name, email) {
  await page.click("#auth-switch");
  await page.fill("#a-name", name);
  await page.fill("#a-email", email);
  await page.fill("#a-pass", "secret123");
  await page.click("#auth-submit");
  await page.waitForSelector("#view-app:not([hidden])");
}
const tab = (page, v) => page.click(`.tab[data-v="${v}"]`);
async function verifyEmail(email) {
  const r = await fetch("http://127.0.0.1:9099/emulator/v1/projects/demo-shiftpunch/oobCodes").then((x) => x.json());
  const code = r.oobCodes.filter((c) => c.email === email && c.requestType === "VERIFY_EMAIL").pop();
  await fetch(code.oobLink);
}

// Leader
const boss = await person("leader");
await boss.screenshot({ path: `${SHOTS}/01-sign-in.png` });
await signUp(boss, "Iman", "boss@example.com");
step("leader signed up");
await boss.click('.punch[data-t="in"]');
await boss.waitForSelector('.punch[data-t="mealStart"]');
step("leader clocked in");
await boss.screenshot({ path: `${SHOTS}/02-clock.png` });
await tab(boss, "group");
await boss.fill("#new-group-name", "Front desk");
await boss.click('[data-form="new-group"] button');
await boss.waitForSelector("#add-email");
step("leader started a group");
await boss.fill("#add-email", "Ann@Example.com");
await boss.fill("#add-rate", "17");
await boss.click('[data-form="add-member"] button');
await boss.waitForSelector("text=Hasn't joined yet");
step("leader invited ann@example.com at $17/hr");

// Member
const ann = await person("member");
await signUp(ann, "Ann Lee", "ann@example.com");
await tab(ann, "group");
await ann.waitForSelector('[data-act="accept"]');
const disabled = await ann.isDisabled('[data-act="accept"]');
step(`member sees invite; Join disabled before email confirmed: ${disabled}`);
await ann.screenshot({ path: `${SHOTS}/03-invite.png`, fullPage: true });
await verifyEmail("ann@example.com");
await ann.click('[data-act="verified"]');
await ann.waitForSelector('[data-act="accept"]:not([disabled])');
await ann.click('[data-act="accept"]');
await ann.waitForSelector("text=Groups you're in");
await ann.waitForSelector('[data-act="leave"]');
step("member confirmed email and joined");

// Member adds a past day: 9:00-5:30 with a 30 min meal = 8.00 h
await tab(ann, "sheet");
await ann.click('[data-seg] [data-p="all"]');
await ann.click("#add-day");
const d = new Date(); d.setDate(d.getDate() - 1);
const k = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
await ann.fill("#ed-date", k);
await ann.fill("#ed-h-0", "09:00");
await ann.selectOption("#ed-t-1", "mealStart"); await ann.fill("#ed-h-1", "12:00");
await ann.click("#ed-add"); await ann.fill("#ed-h-2", "12:30");
await ann.click("#ed-add"); await ann.fill("#ed-h-3", "17:30");
await ann.click("#ed-save");
await ann.waitForSelector("tr.day");
const annHours = await ann.textContent("#my-totals .total b");
step(`member added a day; member sees ${annHours} hours`);
await ann.screenshot({ path: `${SHOTS}/04-member-timesheet.png`, fullPage: true });

// Leader sees the member
await boss.click('[data-seg] [data-p="all"]');
await boss.waitForSelector('tr[data-mid] td.pay');
const row = (await boss.textContent("tr[data-mid]")).replace(/\s+/g, " ").trim();
step(`leader's group row: ${row}`);
await boss.screenshot({ path: `${SHOTS}/05-leader-group.png`, fullPage: true });
await boss.click("tr[data-mid]");
await boss.waitForSelector("#m-rate");
await boss.screenshot({ path: `${SHOTS}/06-leader-member.png`, fullPage: true });
const memberTotals = (await boss.textContent("#view-group .totals")).replace(/\s+/g, " ").trim();
step(`leader's view of member: ${memberTotals}`);

// Member leaves -> leader loses access
await tab(ann, "group");
await ann.click('[data-act="leave"]'); await ann.click('[data-act="leave"]');
await boss.waitForSelector('text=All groups').catch(() => {});
await boss.waitForTimeout(1500);
const after = await boss.locator("tr[data-mid]").count();
step(`after member leaves, leader's group shows ${after} member rows`);

console.log(errors.length ? "\nERRORS:\n" + errors.join("\n") : "\nno page errors");
await browser.close();
const ok = disabled && annHours === "8.00" && /8\.00/.test(row) && /\$136\.00/.test(row) && after === 0 && !errors.length;
console.log(ok ? "E2E PASSED" : "E2E FAILED");
process.exit(ok ? 0 : 1);

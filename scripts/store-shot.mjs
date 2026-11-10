// Store screenshot (docs/screenshot.png, 1600x900 @2x) in TREK-like fill mode, basemap loaded.
// `trek-plugin shot` collapses the frame for a full-height tab, so use this instead:
//   npm run dev   (in another terminal)   then   npm run shot
import { createRequire } from 'node:module';
const require = createRequire(new URL('../package.json', import.meta.url));
const { chromium } = require('playwright');
const b = await chromium.launch();
const p = await b.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
await p.goto('http://localhost:4317/preview?chrome=0&theme=light');
// Fill-mode like TREK: the frame takes the whole viewport.
await p.addStyleTag({ content: 'html,body{margin:0!important;height:100%!important;overflow:hidden!important} .stage,.wrap{all:unset} iframe{position:fixed!important;inset:0!important;width:100vw!important;height:100vh!important;border:0!important;border-radius:0!important;box-shadow:none!important}' });
const f = p.frameLocator('iframe');
await f.locator('#generate:not([disabled])').waitFor();
await f.locator('svg.map image').waitFor({ timeout: 20000 });
await p.waitForTimeout(700);
await p.screenshot({ path: process.argv[2] || 'docs/screenshot.png' });
await b.close();

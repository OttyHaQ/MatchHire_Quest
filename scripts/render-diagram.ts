// Renders docs/diagrams/flow-map.mmd to docs/diagrams/flow-map.png.
// Usage: npx tsx scripts/render-diagram.ts
// Needs a Playwright Chromium (npx playwright install chromium) and internet access
// (Mermaid is loaded from a CDN).
import { readFileSync } from 'node:fs';
import { chromium } from '@playwright/test';

const src = 'docs/diagrams/flow-map.mmd';
const out = 'docs/diagrams/flow-map.png';

(async () => {
  const chart = readFileSync(src, 'utf8').replace(/</g, '&lt;');
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 }, deviceScaleFactor: 2 });
  await page.setContent(`<html><head><style>pre { margin: 0 } #wrap svg { max-width: none !important; display: block }</style></head>
    <body style="margin:0;background:#fff">
    <div id="wrap" style="display:inline-block;padding:16px;background:#fff"><pre class="mermaid">${chart}</pre></div>
    <script src="https://cdn.jsdelivr.net/npm/mermaid@11.4.1/dist/mermaid.min.js"></script>
    <script>mermaid.initialize({ startOnLoad: false, theme: 'default' });
      mermaid.run().then(() => (document.body.dataset.done = 'ok'), (e) => (document.body.dataset.done = 'error: ' + e.message));</script>
  </body></html>`);
  await page.waitForSelector('body[data-done]', { timeout: 30_000 });
  const status = await page.getAttribute('body', 'data-done');
  if (status !== 'ok') throw new Error(`Mermaid failed to render: ${status}`);
  await page.locator('#wrap').screenshot({ path: out });
  await browser.close();
  console.log(`wrote ${out}`);
})();

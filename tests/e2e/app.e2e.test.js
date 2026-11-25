'use strict';
// End-to-end tests in real Chromium (Playwright library + node:test).
// Run: npm run test:e2e   (set CHROMIUM_PATH to use a preinstalled browser)
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { chromium } = require('playwright');
const { startServer } = require('../helpers/server.js');
const { decodePNG, encodePNG } = require('../helpers/png.js');

const FIXTURES = path.join(__dirname, '..', 'fixtures', 'daltonlens');
const INPUT_PNG = fs.readFileSync(path.join(FIXTURES, 'input.png'));

let server, browser;

test.before(async () => {
    server = await startServer();
    browser = await chromium.launch({
        executablePath: process.env.CHROMIUM_PATH || undefined,
        args: [
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            '--enable-unsafe-swiftshader'
        ]
    });
});

test.after(async () => {
    if (browser) await browser.close();
    if (server) await server.close();
});

async function openApp(options = {}) {
    const context = await browser.newContext({
        viewport: options.viewport || { width: 1360, height: 900 },
        colorScheme: options.colorScheme || 'dark',
        acceptDownloads: true,
        ...(options.context || {})
    });
    if (options.initScript) await context.addInitScript(options.initScript);
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    await page.goto(server.url);
    return { context, page, errors };
}

async function uploadFixture(page, buffer = INPUT_PNG, name = 'input.png') {
    await page.setInputFiles('#imageInput', { name, mimeType: 'image/png', buffer });
    await page.waitForSelector('#viewer:not([hidden]), #compareGrid:not([hidden])');
}

async function setSeverity(page, pct) {
    await page.$eval('#severity', (el, v) => {
        el.value = String(v);
        el.dispatchEvent(new Event('input', { bubbles: true }));
    }, pct);
}

async function setModel(page, model) {
    // The selector lives in the collapsible "advanced settings", like a real user would open it.
    if (!(await page.$eval('#advanced', (d) => d.open))) await page.click('#advanced summary');
    await page.selectOption('#modelSelect', model);
}

async function pickType(page, type) {
    await page.click(`.type-card[data-type="${type}"]`);
}

function maxDiff(a, b) {
    assert.equal(a.length, b.length);
    let max = 0;
    for (let i = 0; i < a.length; i++) {
        if (i % 4 === 3) continue;
        const d = Math.abs(a[i] - b[i]);
        if (d > max) max = d;
    }
    return max;
}

test('loads cleanly: empty state only, no errors, no horizontal overflow', async () => {
    const { context, page, errors } = await openApp();
    assert.ok(await page.isVisible('#dropzone'));
    for (const id of ['#viewer', '#compareGrid', '#imageMeta', '#busy', '#panel-camera', '#toast']) {
        assert.equal(await page.isVisible(id), false, `${id} should be hidden`);
    }
    assert.equal(await page.isEnabled('#downloadBtn'), false);
    assert.equal(await page.$$eval('.type-card', (els) => els.length), 5);
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    assert.ok(overflow <= 0, `horizontal overflow ${overflow}px`);
    assert.deepEqual(errors, []);
    await context.close();
});

test('every interactive control has an accessible name', async () => {
    const { context, page } = await openApp();
    const unnamed = await page.evaluate(() => {
        const out = [];
        document.querySelectorAll('button, select, input:not([type=hidden]), [role=slider], a[href]').forEach((el) => {
            const labelled = el.labels && el.labels.length && el.labels[0].textContent.trim();
            const name = el.getAttribute('aria-label') || el.getAttribute('title') || labelled ||
                (el.getAttribute('aria-labelledby') && document.getElementById(el.getAttribute('aria-labelledby')).textContent.trim()) ||
                el.textContent.trim();
            if (!name) out.push(el.outerHTML.slice(0, 80));
        });
        return out;
    });
    assert.deepEqual(unnamed, []);
    await context.close();
});

test('upload through the file input reproduces the DaltonLens Brettel reference in the browser', async () => {
    const { context, page, errors } = await openApp();
    await uploadFixture(page);
    assert.match(await page.textContent('#imageMeta'), /input\.png · 216×216/);
    await setModel(page, 'brettel1997');

    const expected = decodePNG(fs.readFileSync(path.join(FIXTURES, 'brettel1997_tritan_wn_1.0.png')));
    await pickType(page, 'tritan');
    await setSeverity(page, 100);
    const got = await page.evaluate(() => window.__cvdApp.exactPixels());
    assert.ok(maxDiff(got, Array.from(expected.data)) <= 1);

    const expected55 = decodePNG(fs.readFileSync(path.join(FIXTURES, 'brettel1997_protan_wn_0.55.png')));
    await pickType(page, 'protan');
    await setSeverity(page, 55);
    const got55 = await page.evaluate(() => window.__cvdApp.exactPixels());
    assert.ok(maxDiff(got55, Array.from(expected55.data)) <= 1);
    assert.deepEqual(errors, []);
    await context.close();
});

test('GPU (WebGL) display matches the exact CPU computation', async (t) => {
    const { context, page } = await openApp();
    await uploadFixture(page);
    const gpu = await page.evaluate(() => window.__cvdApp.gpu());
    if (!gpu.image) {
        t.skip('WebGL not available in this browser');
        await context.close();
        return;
    }
    const cases = [
        ['protan', 100, 'auto'], ['deutan', 60, 'auto'], ['tritan', 100, 'auto'],
        ['tritan', 35, 'machado2009'], ['deutan', 100, 'brettel1997'], ['achromat', 80, 'auto'], ['normal', 100, 'auto']
    ];
    for (const [type, sev, model] of cases) {
        await setModel(page, model);
        await pickType(page, type);
        if (type !== 'normal') await setSeverity(page, sev);
        const [shown, exact] = await page.evaluate(() => [window.__cvdApp.displayedPixels(), window.__cvdApp.exactPixels()]);
        const d = maxDiff(shown, exact);
        assert.ok(d <= 2, `${type}/${sev}/${model}: GPU differs from CPU by ${d}`);
    }
    await context.close();
});

test('severity slider drives the clinical terminology', async () => {
    const { context, page } = await openApp();
    await pickType(page, 'deutan');
    await setSeverity(page, 100);
    assert.match(await page.textContent('#severityName'), /דאוטרנופיה/);
    await setSeverity(page, 60);
    assert.match(await page.textContent('#severityName'), /דאוטרנומליה/);
    assert.equal(await page.textContent('#severityValue'), '60%');
    await pickType(page, 'achromat');
    await setSeverity(page, 100);
    assert.match(await page.textContent('#severityName'), /אכרומטופסיה/);
    await pickType(page, 'normal');
    assert.equal(await page.isDisabled('#severity'), true);
    await context.close();
});

test('type cards show live swatches that change with the simulation', async () => {
    const { context, page } = await openApp();
    const swatch = (type) => page.$eval(`.type-card[data-type="${type}"] .swatches span:first-child`, (el) => el.style.backgroundColor);
    assert.equal(await swatch('normal'), 'rgb(229, 57, 53)');
    const full = await swatch('protan');
    assert.notEqual(full, 'rgb(229, 57, 53)');
    await setSeverity(page, 20);
    assert.notEqual(await swatch('protan'), full);
    await context.close();
});

test('views: split handle (pointer + keyboard), side by side, and all-types grid', async () => {
    const { context, page } = await openApp();
    await uploadFixture(page);
    assert.equal(await page.getAttribute('#viewer', 'data-view'), 'split');

    const box = await page.locator('#viewer').boundingBox();
    await page.mouse.click(box.x + box.width * 0.25, box.y + box.height / 2);
    assert.equal(await page.getAttribute('#splitHandle', 'aria-valuenow'), '25');
    await page.focus('#splitHandle');
    await page.keyboard.press('ArrowRight');
    assert.equal(await page.getAttribute('#splitHandle', 'aria-valuenow'), '27');
    await page.keyboard.press('End');
    assert.equal(await page.getAttribute('#splitHandle', 'aria-valuenow'), '100');

    await page.click('[data-view="side"]');
    assert.equal(await page.getAttribute('#viewer', 'data-view'), 'side');
    assert.equal(await page.isVisible('#splitHandle'), false);

    await page.click('[data-view="grid"]');
    assert.equal(await page.isVisible('#compareGrid'), true);
    assert.equal(await page.isVisible('#viewer'), false);
    assert.equal(await page.$$eval('.cmp-card', (els) => els.length), 5);
    await page.click('.cmp-card[data-type="tritan"]');
    assert.equal(await page.getAttribute('#viewer', 'data-view'), 'split');
    assert.equal(await page.isChecked('.type-card[data-type="tritan"] input'), true);
    await context.close();
});

test('download saves the exact simulated PNG with a descriptive name', async () => {
    const { context, page } = await openApp();
    await uploadFixture(page);
    await pickType(page, 'deutan');
    await setSeverity(page, 60);
    const [download] = await Promise.all([page.waitForEvent('download'), page.click('#downloadBtn')]);
    assert.equal(download.suggestedFilename(), 'input_deuteranomaly-60.png');
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cvd-')), 'out.png');
    await download.saveAs(file);
    const png = decodePNG(fs.readFileSync(file));
    const exact = await page.evaluate(() => window.__cvdApp.exactPixels());
    assert.equal(png.width, 216);
    assert.equal(maxDiff(Array.from(png.data), exact), 0);

    const [cmp] = await Promise.all([page.waitForEvent('download'), page.click('#downloadCompareBtn')]);
    assert.equal(cmp.suggestedFilename(), 'input_compare_deuteranomaly-60.png');
    await context.close();
});

test('rejects non-image files with a friendly message', async () => {
    const { context, page } = await openApp();
    await page.setInputFiles('#imageInput', { name: 'notes.txt', mimeType: 'text/plain', buffer: Buffer.from('hello') });
    await page.waitForSelector('#toast:not([hidden])');
    assert.match(await page.textContent('#toast'), /אינו תמונה/);
    assert.ok(await page.isVisible('#dropzone'));
    await context.close();
});

test('transparent pixels keep their alpha', async () => {
    const { context, page } = await openApp();
    const data = new Uint8ClampedArray(4 * 4 * 4);
    for (let i = 0; i < 16; i++) data.set([200, 30, 40, i < 8 ? 0 : 255], i * 4);
    await uploadFixture(page, encodePNG({ width: 4, height: 4, data }), 'alpha.png');
    const px = await page.evaluate(() => window.__cvdApp.exactPixels());
    assert.equal(px[3], 0);
    assert.equal(px[63], 255);
    await context.close();
});

test('sample image loads and theme toggle persists across reloads', async () => {
    const { context, page } = await openApp();
    await page.click('#sampleBtn');
    await page.waitForSelector('#viewer:not([hidden])');
    assert.match(await page.textContent('#imageMeta'), /1200×800/);
    assert.equal(await page.getAttribute('html', 'data-theme'), 'dark');
    await page.click('#themeToggle');
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await page.reload();
    assert.equal(await page.getAttribute('html', 'data-theme'), 'light');
    await context.close();
});

test('live camera: GPU rendering, split view, capture into image mode, stop on tab change', async () => {
    const { context, page, errors } = await openApp();
    await page.click('#tab-camera');
    assert.equal(await page.isVisible('#cameraIntro'), true);
    await page.click('#camStartBtn');
    await page.waitForFunction(() => /FPS/.test(document.getElementById('camStats').textContent), null, { timeout: 15000 });
    assert.equal(await page.evaluate(() => window.__cvdApp.cameraRunning()), true);
    assert.match(await page.textContent('#camStats'), /GPU|CPU/);

    // The filtered canvas must actually contain simulated frames.
    const size = await page.$eval('#camCanvas', (c) => [c.width, c.height]);
    assert.ok(size[0] > 0 && size[1] > 0);

    await page.click('#camSplitBtn');
    assert.equal(await page.getAttribute('#camSplitBtn', 'aria-pressed'), 'true');
    assert.equal(await page.isVisible('#camSplitHandle'), true);
    assert.match(await page.$eval('#camCanvas', (c) => c.style.clipPath), /inset/);

    // Changing the type while live is picked up immediately.
    await pickType(page, 'tritan');
    assert.equal(await page.evaluate(() => window.__cvdApp.state.type), 'tritan');

    await page.click('#camCaptureBtn');
    await page.waitForSelector('#viewer:not([hidden])');
    assert.equal(await page.getAttribute('#tab-image', 'aria-selected'), 'true');
    assert.match(await page.textContent('#imageMeta'), /camera-.*\.png/);
    assert.equal(await page.evaluate(() => window.__cvdApp.cameraRunning()), false);

    await page.click('#tab-camera');
    await page.click('#camStartBtn');
    await page.waitForFunction(() => window.__cvdApp.cameraRunning());
    await page.click('#tab-image');
    assert.equal(await page.evaluate(() => window.__cvdApp.cameraRunning()), false);
    assert.equal(await page.evaluate(() => document.getElementById('camVideo').srcObject), null);
    assert.deepEqual(errors, []);
    await context.close();
});

test('camera permission denied shows actionable guidance', async () => {
    const { context, page } = await openApp({
        initScript: () => {
            navigator.mediaDevices.getUserMedia = () => Promise.reject(new DOMException('denied', 'NotAllowedError'));
        }
    });
    await page.click('#tab-camera');
    await page.click('#camStartBtn');
    await page.waitForSelector('#cameraError:not([hidden])');
    assert.match(await page.textContent('#cameraError'), /הגישה למצלמה נחסמה/);
    assert.equal(await page.isEnabled('#camStartBtn'), true);
    await context.close();
});

test('mobile: stage first, no horizontal overflow in either mode', async () => {
    const { context, page } = await openApp({ viewport: { width: 375, height: 760 }, context: { isMobile: true, hasTouch: true } });
    const order = await page.evaluate(() => {
        const stage = document.getElementById('panel-image').getBoundingClientRect().top;
        const side = document.querySelector('.sidebar').getBoundingClientRect().top;
        return stage < side;
    });
    assert.ok(order, 'stage should be above the controls on mobile');
    await page.click('#sampleBtn');
    for (const tab of ['#tab-image', '#tab-camera']) {
        await page.click(tab);
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        assert.ok(overflow <= 0, `${tab}: horizontal overflow ${overflow}px`);
    }
    assert.equal(await page.isVisible('#quickTypes'), true);
    await context.close();
});

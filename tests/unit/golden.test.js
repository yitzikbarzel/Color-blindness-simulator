'use strict';
// Compares our Brettel 1997 output with the reference images shipped by
// libDaltonLens (public domain, https://github.com/DaltonLens/libDaltonLens,
// tests/images). libDaltonLens itself is validated against DaltonLens-Python.
// Same acceptance criterion as libDaltonLens' own test: at most 1 unit per channel.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const CVD = require('../../assets/js/cvd.js');
const { decodePNG } = require('../helpers/png.js');

const DIR = path.join(__dirname, '..', 'fixtures', 'daltonlens');
const load = (name) => decodePNG(fs.readFileSync(path.join(DIR, name)));

const input = load('input.png');

for (const type of ['protan', 'deutan', 'tritan']) {
    for (const severity of ['1.0', '0.55']) {
        test(`Brettel 1997 ${type} @ ${severity} matches DaltonLens reference image`, () => {
            const expected = load(`brettel1997_${type}_wn_${severity}.png`);
            assert.equal(expected.width, input.width);
            assert.equal(expected.height, input.height);

            const img = { data: new Uint8ClampedArray(input.data) };
            CVD.simulateImageData(img, type, Number(severity), 'brettel1997');

            let maxDiff = 0, bad = 0;
            for (let i = 0; i < img.data.length; i++) {
                if (i % 4 === 3) continue;
                const d = Math.abs(img.data[i] - expected.data[i]);
                if (d > maxDiff) maxDiff = d;
                if (d > 1) bad++;
            }
            assert.equal(bad, 0, `${bad} channels differ by more than 1 (max ${maxDiff})`);
        });
    }
}

test('auto model uses exactly the Brettel reference for tritanopia', () => {
    const expected = load('brettel1997_tritan_wn_1.0.png');
    const img = { data: new Uint8ClampedArray(input.data) };
    CVD.simulateImageData(img, 'tritan', 1, 'auto');
    for (let i = 0; i < img.data.length; i++) {
        if (i % 4 !== 3) assert.ok(Math.abs(img.data[i] - expected.data[i]) <= 1);
    }
});

test('Machado 2009 dichromacy stays close to the Brettel reference (independent models agree)', () => {
    // Different models, so not identical — but they must agree closely on average.
    for (const type of ['protan', 'deutan']) {
        const expected = load(`brettel1997_${type}_wn_1.0.png`);
        const img = { data: new Uint8ClampedArray(input.data) };
        CVD.simulateImageData(img, type, 1, 'machado2009');
        let sum = 0, n = 0;
        for (let i = 0; i < img.data.length; i++) {
            if (i % 4 === 3) continue;
            sum += Math.abs(img.data[i] - expected.data[i]);
            n++;
        }
        assert.ok(sum / n < 8, `${type} mean abs diff ${(sum / n).toFixed(2)}`);
    }
});

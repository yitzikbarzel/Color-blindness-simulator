'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const CVD = require('../../assets/js/cvd.js');

const DEFICIENT = ['protan', 'deutan', 'tritan'];
const ALL_TYPES = ['normal', 'protan', 'deutan', 'tritan', 'achromat'];
const MODELS = ['auto', 'machado2009', 'brettel1997'];

// Deterministic PRNG so failures are reproducible.
function rng(seed) {
    return () => {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        return seed / 4294967296;
    };
}

function randomColors(count, seed = 42) {
    const r = rng(seed);
    return Array.from({ length: count }, () => [r() * 256 | 0, r() * 256 | 0, r() * 256 | 0]);
}

const det = (m) => m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
const mul = (m, v) => [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2],
    m[3] * v[0] + m[4] * v[1] + m[5] * v[2],
    m[6] * v[0] + m[7] * v[1] + m[8] * v[2]
];
const rowSums = (m) => [m[0] + m[1] + m[2], m[3] + m[4] + m[5], m[6] + m[7] + m[8]];

// Independent float64 reference implementation (no lookup tables).
function referenceSimulate(rgb, type, severity, model) {
    const t = CVD.getTransform(type, severity, model);
    const lin = rgb.map((c) => CVD.srgbToLinearExact(c / 255));
    const d = lin[0] * t.n[0] + lin[1] * t.n[1] + lin[2] * t.n[2];
    return mul(d >= 0 ? t.m1 : t.m2, lin).map((v) => Math.round(CVD.linearToSrgbExact(v) * 255));
}

test.describe('sRGB transfer functions', () => {
    test('decode matches the exact IEC 61966-2-1 formula for every byte', () => {
        for (let i = 0; i < 256; i++) {
            const c = i / 255;
            const exact = c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
            assert.equal(CVD.srgbToLinear(i), exact);
        }
        assert.ok(Math.abs(CVD.srgbToLinear(128) - 0.2158605) < 1e-6);
    });

    test('decode -> encode round-trips all 256 values exactly', () => {
        for (let i = 0; i < 256; i++) assert.equal(CVD.encode(CVD.srgbToLinear(i)), i, `value ${i}`);
    });

    test('16-bit encode table agrees with the exact formula', () => {
        const r = rng(7);
        let mismatches = 0;
        const N = 200000;
        for (let i = 0; i < N; i++) {
            const v = r();
            const exact = Math.round(CVD.linearToSrgbExact(v) * 255);
            const got = CVD.encode(v);
            assert.ok(Math.abs(got - exact) <= 1, `v=${v}`);
            if (got !== exact) mismatches++;
        }
        assert.ok(mismatches / N < 0.002, `mismatch rate ${mismatches / N}`);
    });

    test('encode clamps out-of-gamut and NaN values', () => {
        assert.equal(CVD.encode(-0.5), 0);
        assert.equal(CVD.encode(1.7), 255);
        assert.equal(CVD.encode(NaN), 0);
    });
});

test.describe('model data integrity', () => {
    test('Machado 2009 tables: 11 steps, identity at 0, white preserved in every matrix', () => {
        for (const type of DEFICIENT) {
            const table = CVD.MACHADO_2009[type];
            assert.equal(table.length, 11);
            table[0].forEach((v, k) => assert.equal(v, [1, 0, 0, 0, 1, 0, 0, 0, 1][k]));
            table.forEach((m, step) => {
                assert.equal(m.length, 9);
                rowSums(m).forEach((s) => assert.ok(Math.abs(s - 1) < 2e-5, `${type} ${step * 10}% row sum ${s}`));
            });
        }
    });

    test('Machado 2009 interpolation matches the colorspacious reference test vectors', () => {
        const d50 = [0.547494, 0.607765, -0.155259, 0.181692, 0.781742, 0.036566, -0.010410, 0.027275, 0.983136];
        const d60 = [0.498864, 0.674741, -0.173604, 0.205199, 0.754872, 0.039929, -0.011131, 0.030969, 0.980162];
        CVD.machadoMatrix('deutan', 0.5).forEach((v, k) => assert.ok(Math.abs(v - d50[k]) < 1e-12));
        const m = CVD.machadoMatrix('deutan', 0.531);
        m.forEach((v, k) => assert.ok(Math.abs(v - (0.31 * d60[k] + 0.69 * d50[k])) < 1e-9));
        assert.ok(Math.abs(CVD.machadoMatrix('protan', 1)[0] - 0.152286) < 1e-12);
        assert.equal(CVD.machadoMatrix('protan', 0)[0], 1);
    });

    test('Machado protan/deutan dichromacy matrices are rank-2 (a true 2-D dichromat gamut)', () => {
        for (const type of ['protan', 'deutan']) {
            assert.ok(Math.abs(det(CVD.MACHADO_2009[type][10])) < 1e-5, type);
        }
        // ...but Machado's tritan matrix is not, which is why "auto" uses Brettel for tritan.
        assert.ok(Math.abs(det(CVD.MACHADO_2009.tritan[10])) > 0.1);
        assert.equal(CVD.resolveModel('tritan', 'auto'), 'brettel1997');
    });

    test('Brettel 1997 parameters: white preserved, separation plane contains the neutral axis', () => {
        for (const type of DEFICIENT) {
            const p = CVD.BRETTEL_1997[type];
            for (const m of [p.m1, p.m2]) {
                rowSums(m).forEach((s) => assert.ok(Math.abs(s - 1) < 2e-3, `${type} row sum ${s}`));
                assert.ok(Math.abs(det(m)) < 1e-4, `${type} projection must be rank-2`);
            }
            assert.ok(Math.abs(p.n[0] + p.n[1] + p.n[2]) < 1e-9, `${type} n·white`);
        }
    });

    test('Brettel 1997 is a projection: simulating twice equals simulating once', () => {
        const r = rng(3);
        for (const type of DEFICIENT) {
            const p = CVD.BRETTEL_1997[type];
            const f = (v) => mul(v[0] * p.n[0] + v[1] * p.n[1] + v[2] * p.n[2] >= 0 ? p.m1 : p.m2, v);
            for (let i = 0; i < 5000; i++) {
                const x = [r(), r(), r()];
                const y = f(x), z = f(y);
                y.forEach((v, k) => assert.ok(Math.abs(v - z[k]) < 1e-4, type));
            }
        }
    });
});

test.describe('model selection', () => {
    test('auto picks Machado for protan/deutan and Brettel for tritan', () => {
        assert.equal(CVD.resolveModel('protan', 'auto'), 'machado2009');
        assert.equal(CVD.resolveModel('deutan'), 'machado2009');
        assert.equal(CVD.resolveModel('tritan', 'auto'), 'brettel1997');
        assert.equal(CVD.resolveModel('achromat', 'brettel1997'), 'luminance');
        assert.equal(CVD.resolveModel('normal', 'machado2009'), 'identity');
        assert.equal(CVD.resolveModel('tritan', 'machado2009'), 'machado2009');
    });

    test('unknown type or model is rejected', () => {
        assert.throws(() => CVD.getTransform('protanopia', 1));
        assert.throws(() => CVD.getTransform('protan', 1, 'vischeck'));
    });

    test('severity is clamped to [0, 1]', () => {
        assert.equal(CVD.getTransform('protan', 2).severity, 1);
        assert.equal(CVD.getTransform('protan', -1).severity, 0);
        assert.equal(CVD.getTransform('protan', NaN).severity, 0);
        assert.equal(CVD.getTransform('protan', '0.5').severity, 0.5);
    });
});

test.describe('simulation behaviour', () => {
    const colors = randomColors(4000);

    test('matches an independent float64 reference implementation', () => {
        for (const type of ALL_TYPES) {
            for (const model of MODELS) {
                for (const s of [0.1, 0.37, 0.55, 0.9, 1]) {
                    let mismatches = 0;
                    for (const c of colors) {
                        const got = CVD.simulateColor(c, type, s, model);
                        const ref = referenceSimulate(c, type, s, model);
                        for (let k = 0; k < 3; k++) {
                            const diff = Math.abs(got[k] - ref[k]);
                            assert.ok(diff <= 1, `${type}/${model}/${s} ${c} -> ${got} vs ${ref}`);
                            if (diff) mismatches++;
                        }
                    }
                    assert.ok(mismatches / (colors.length * 3) < 0.005);
                }
            }
        }
    });

    test('severity 0 and "normal" are exact no-ops', () => {
        for (const c of colors.slice(0, 500)) {
            for (const type of ALL_TYPES) {
                for (const model of MODELS) assert.deepEqual(CVD.simulateColor(c, type, 0, model), c);
            }
            assert.deepEqual(CVD.simulateColor(c, 'normal', 1), c);
        }
    });

    test('neutral greys stay neutral for every type, model and severity', () => {
        for (const type of ALL_TYPES) {
            for (const model of MODELS) {
                for (const s of [0.05, 0.3, 0.64, 1]) {
                    for (let g = 0; g < 256; g += 5) {
                        CVD.simulateColor([g, g, g], type, s, model)
                            .forEach((v) => assert.ok(Math.abs(v - g) <= 1, `${type}/${model}/${s} grey ${g} -> ${v}`));
                    }
                }
            }
        }
    });

    test('full monochromacy produces relative-luminance greys', () => {
        for (const c of colors.slice(0, 500)) {
            const [r, g, b] = CVD.simulateColor(c, 'achromat', 1);
            assert.equal(r, g);
            assert.equal(g, b);
            const y = CVD.LUMA[0] * CVD.srgbToLinear(c[0]) + CVD.LUMA[1] * CVD.srgbToLinear(c[1]) + CVD.LUMA[2] * CVD.srgbToLinear(c[2]);
            assert.ok(Math.abs(r - Math.round(CVD.linearToSrgbExact(y) * 255)) <= 1);
        }
    });

    test('changing severity in 1% steps never jumps (perceptual continuity, CIELAB ΔE)', () => {
        // Measured perceptually: 8-bit sRGB codes are very non-uniform near black,
        // so a code-value threshold would be meaningless.
        const toLab = (rgb) => {
            const [r, g, b] = rgb.map((c) => CVD.srgbToLinearExact(c / 255));
            const X = (0.4124 * r + 0.3576 * g + 0.1805 * b) / 0.95047;
            const Y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
            const Z = (0.0193 * r + 0.1192 * g + 0.9505 * b) / 1.08883;
            const f = (t) => (t > 216 / 24389 ? Math.cbrt(t) : (24389 / 27 * t + 16) / 116);
            return [116 * f(Y) - 16, 500 * (f(X) - f(Y)), 200 * (f(Y) - f(Z))];
        };
        const dE = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
        const sample = colors.slice(0, 300).concat([[255, 0, 0], [0, 255, 0], [0, 0, 255], [255, 255, 0]]);
        for (const type of ['protan', 'deutan', 'tritan', 'achromat']) {
            for (const model of MODELS) {
                let prev = sample.map((c) => toLab(CVD.simulateColor(c, type, 0, model)));
                for (let p = 1; p <= 100; p++) {
                    const cur = sample.map((c) => toLab(CVD.simulateColor(c, type, p / 100, model)));
                    cur.forEach((lab, i) => {
                        const d = dE(lab, prev[i]);
                        assert.ok(d < 4, `${type}/${model} jump of ΔE ${d.toFixed(2)} at ${p}% for ${sample[i]}`);
                    });
                    prev = cur;
                }
            }
        }
    });

    test('red/green confusion: dichromats lose the red-green distinction', () => {
        // Hue difference between pure red and pure green measured as |R-G| contrast
        // of the two simulated colours relative to the original.
        for (const type of ['protan', 'deutan']) {
            for (const model of ['machado2009', 'brettel1997']) {
                const red = CVD.simulateColor([255, 0, 0], type, 1, model);
                const green = CVD.simulateColor([0, 200, 0], type, 1, model);
                const opponent = (c) => c[0] - c[1]; // red-green opponent signal
                assert.ok(Math.abs(opponent(red)) < 40, `${type}/${model} red ${red}`);
                assert.ok(Math.abs(opponent(green)) < 60, `${type}/${model} green ${green}`);
            }
        }
        // Tritanopes keep red/green apart but confuse blue/yellow axis.
        const red = CVD.simulateColor([255, 0, 0], 'tritan', 1);
        assert.ok(red[0] - red[1] > 200);
    });

    test('alpha channel is never modified', () => {
        const px = new Uint8ClampedArray([200, 40, 90, 17, 10, 250, 30, 0, 255, 255, 255, 128]);
        CVD.applyTransform(px, CVD.getTransform('deutan', 0.8));
        assert.equal(px[3], 17);
        assert.equal(px[7], 0);
        assert.equal(px[11], 128);
    });

    test('simulateImageData works in place on ImageData-like objects', () => {
        const img = { width: 2, height: 1, data: new Uint8ClampedArray([255, 0, 0, 255, 0, 0, 255, 255]) };
        const out = CVD.simulateImageData(img, 'achromat', 1);
        assert.equal(out, img);
        assert.equal(img.data[0], img.data[1]);
    });
});

test.describe('helpers', () => {
    test('fitWithin keeps aspect ratio and only scales down', () => {
        assert.deepEqual(CVD.fitWithin(800, 600, 1e6), { width: 800, height: 600, scaled: false });
        const r = CVD.fitWithin(8000, 6000, 16777216);
        assert.ok(r.scaled);
        assert.ok(r.width * r.height <= 16777216);
        assert.ok(Math.abs(r.width / r.height - 8000 / 6000) < 0.001);
    });

    test('toColumnMajor transposes for WebGL', () => {
        assert.deepEqual(CVD.toColumnMajor([1, 2, 3, 4, 5, 6, 7, 8, 9]), [1, 4, 7, 2, 5, 8, 3, 6, 9]);
    });
});

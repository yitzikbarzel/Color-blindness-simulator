/*!
 * cvd.js — physiologically-based color vision deficiency (CVD) simulation.
 *
 * Pure, dependency-free and DOM-free so the exact same code runs in the
 * browser (images, swatches, camera fallback) and in Node (unit tests).
 *
 * Pipeline for every pixel:
 *   8-bit sRGB --(exact sRGB EOTF)--> linear RGB --(3x3 model matrix)--> linear RGB
 *   --(exact inverse EOTF, clamped)--> 8-bit sRGB.   Alpha is never touched.
 *
 * Models
 *  - Machado, Oliveira & Fernandes (2009), doi:10.1109/TVCG.2009.113.
 *    Models anomalous trichromacy as a shift of the cone's spectral sensitivity,
 *    so partial severities are physiologically meaningful (not a plain blend).
 *    Matrices are the authors' published table (0.1 steps), interpolated linearly
 *    between steps exactly like the colorspacious reference implementation.
 *  - Brettel, Viénot & Mollon (1997), doi:10.1364/JOSAA.14.002647.
 *    Two half-plane projection in LMS space; the most accurate dichromacy model,
 *    and the only one that handles tritanopia well. Parameters are the
 *    precomputed values from libDaltonLens (public domain), severity is a
 *    linear-light blend exactly like libDaltonLens.
 *  - Monochromacy (achromatopsia): relative luminance (Rec. 709 / sRGB Y).
 *
 * Every model is expressed as a "transform" {m1, m2, n}: a pixel uses m1 when
 * dot(rgbLinear, n) >= 0 and m2 otherwise (single-matrix models use m1 = m2 and
 * n = 0). The WebGL renderer consumes the very same transform.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CVD = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var IDENTITY = [1, 0, 0, 0, 1, 0, 0, 0, 1];
    var ZERO3 = [0, 0, 0];

    // Rec. 709 / sRGB relative luminance coefficients (linear light).
    var LUMA = [0.2126, 0.7152, 0.0722];

    // libDaltonLens precomputed Brettel 1997 parameters (sRGB + Smith & Pokorny
    // 1975 LMS, RGB white as neutral). Row-major, applied to linear RGB.
    var BRETTEL_1997 = {
        protan: {
            m1: [0.14980, 1.19548, -0.34528, 0.10764, 0.84864, 0.04372, 0.00384, -0.00540, 1.00156],
            m2: [0.14570, 1.16172, -0.30742, 0.10816, 0.85291, 0.03892, 0.00386, -0.00524, 1.00139],
            n: [0.00048, 0.00393, -0.00441]
        },
        deutan: {
            m1: [0.36477, 0.86381, -0.22858, 0.26294, 0.64245, 0.09462, -0.02006, 0.02728, 0.99278],
            m2: [0.37298, 0.88166, -0.25464, 0.25954, 0.63506, 0.10540, -0.01980, 0.02784, 0.99196],
            n: [-0.00281, -0.00611, 0.00892]
        },
        tritan: {
            m1: [1.01277, 0.13548, -0.14826, -0.01243, 0.86812, 0.14431, 0.07589, 0.80500, 0.11911],
            m2: [0.93678, 0.18979, -0.12657, 0.06154, 0.81526, 0.12320, -0.37562, 1.12767, 0.24796],
            n: [0.03901, -0.02788, -0.01113]
        }
    };

    // Machado, Oliveira & Fernandes (2009), severities 0.0, 0.1 ... 1.0.
    // Generated verbatim from colorspacious/cvd.py (MACHADO_ET_AL_MATRICES).
    var MACHADO_2009 = {
        protan: [
            [1.000000, 0.000000, 0.000000, 0.000000, 1.000000, 0.000000, 0.000000, 0.000000, 1.000000],  // 0%
            [0.856167, 0.182038, -0.038205, 0.029342, 0.955115, 0.015544, -0.002880, -0.001563, 1.004443],  // 10%
            [0.734766, 0.334872, -0.069637, 0.051840, 0.919198, 0.028963, -0.004928, -0.004209, 1.009137],  // 20%
            [0.630323, 0.465641, -0.095964, 0.069181, 0.890046, 0.040773, -0.006308, -0.007724, 1.014032],  // 30%
            [0.539009, 0.579343, -0.118352, 0.082546, 0.866121, 0.051332, -0.007136, -0.011959, 1.019095],  // 40%
            [0.458064, 0.679578, -0.137642, 0.092785, 0.846313, 0.060902, -0.007494, -0.016807, 1.024301],  // 50%
            [0.385450, 0.769005, -0.154455, 0.100526, 0.829802, 0.069673, -0.007442, -0.022190, 1.029632],  // 60%
            [0.319627, 0.849633, -0.169261, 0.106241, 0.815969, 0.077790, -0.007025, -0.028051, 1.035076],  // 70%
            [0.259411, 0.923008, -0.182420, 0.110296, 0.804340, 0.085364, -0.006276, -0.034346, 1.040622],  // 80%
            [0.203876, 0.990338, -0.194214, 0.112975, 0.794542, 0.092483, -0.005222, -0.041043, 1.046265],  // 90%
            [0.152286, 1.052583, -0.204868, 0.114503, 0.786281, 0.099216, -0.003882, -0.048116, 1.051998],  // 100%
        ],
        deutan: [
            [1.000000, 0.000000, 0.000000, 0.000000, 1.000000, 0.000000, 0.000000, 0.000000, 1.000000],  // 0%
            [0.866435, 0.177704, -0.044139, 0.049567, 0.939063, 0.011370, -0.003453, 0.007233, 0.996220],  // 10%
            [0.760729, 0.319078, -0.079807, 0.090568, 0.889315, 0.020117, -0.006027, 0.013325, 0.992702],  // 20%
            [0.675425, 0.433850, -0.109275, 0.125303, 0.847755, 0.026942, -0.007950, 0.018572, 0.989378],  // 30%
            [0.605511, 0.528560, -0.134071, 0.155318, 0.812366, 0.032316, -0.009376, 0.023176, 0.986200],  // 40%
            [0.547494, 0.607765, -0.155259, 0.181692, 0.781742, 0.036566, -0.010410, 0.027275, 0.983136],  // 50%
            [0.498864, 0.674741, -0.173604, 0.205199, 0.754872, 0.039929, -0.011131, 0.030969, 0.980162],  // 60%
            [0.457771, 0.731899, -0.189670, 0.226409, 0.731012, 0.042579, -0.011595, 0.034333, 0.977261],  // 70%
            [0.422823, 0.781057, -0.203881, 0.245752, 0.709602, 0.044646, -0.011843, 0.037423, 0.974421],  // 80%
            [0.392952, 0.823610, -0.216562, 0.263559, 0.690210, 0.046232, -0.011910, 0.040281, 0.971630],  // 90%
            [0.367322, 0.860646, -0.227968, 0.280085, 0.672501, 0.047413, -0.011820, 0.042940, 0.968881],  // 100%
        ],
        tritan: [
            [1.000000, 0.000000, 0.000000, 0.000000, 1.000000, 0.000000, 0.000000, 0.000000, 1.000000],  // 0%
            [0.926670, 0.092514, -0.019184, 0.021191, 0.964503, 0.014306, 0.008437, 0.054813, 0.936750],  // 10%
            [0.895720, 0.133330, -0.029050, 0.029997, 0.945400, 0.024603, 0.013027, 0.104707, 0.882266],  // 20%
            [0.905871, 0.127791, -0.033662, 0.026856, 0.941251, 0.031893, 0.013410, 0.148296, 0.838294],  // 30%
            [0.948035, 0.089490, -0.037526, 0.014364, 0.946792, 0.038844, 0.010853, 0.193991, 0.795156],  // 40%
            [1.017277, 0.027029, -0.044306, -0.006113, 0.958479, 0.047634, 0.006379, 0.248708, 0.744913],  // 50%
            [1.104996, -0.046633, -0.058363, -0.032137, 0.971635, 0.060503, 0.001336, 0.317922, 0.680742],  // 60%
            [1.193214, -0.109812, -0.083402, -0.058496, 0.979410, 0.079086, -0.002346, 0.403492, 0.598854],  // 70%
            [1.257728, -0.139648, -0.118081, -0.078003, 0.975409, 0.102594, -0.003316, 0.501214, 0.502102],  // 80%
            [1.278864, -0.125333, -0.153531, -0.084748, 0.957674, 0.127074, -0.000989, 0.601151, 0.399838],  // 90%
            [1.255528, -0.076749, -0.178779, -0.078411, 0.930809, 0.147602, 0.004733, 0.691367, 0.303900],  // 100%
        ],
    };

    var TYPES = ['normal', 'protan', 'deutan', 'tritan', 'achromat'];
    var MODELS = ['auto', 'machado2009', 'brettel1997'];

    // ------------------------------------------------------------------
    // sRGB transfer functions
    // ------------------------------------------------------------------

    function srgbToLinearExact(c01) {
        return c01 <= 0.04045 ? c01 / 12.92 : Math.pow((c01 + 0.055) / 1.055, 2.4);
    }

    function linearToSrgbExact(v) {
        if (v <= 0) return 0;
        if (v >= 1) return 1;
        return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
    }

    // Decode: exact for all 256 inputs.
    var SRGB_TO_LINEAR = new Float64Array(256);
    for (var i = 0; i < 256; i++) SRGB_TO_LINEAR[i] = srgbToLinearExact(i / 255);

    // Encode: 16-bit lookup. Worst-case error vs. the exact formula is ~0.03 of
    // one 8-bit code value (steepest part of the curve, near black).
    var ENCODE_STEPS = 65535;
    var LINEAR_TO_SRGB = new Uint8Array(ENCODE_STEPS + 1);
    for (var j = 0; j <= ENCODE_STEPS; j++) {
        LINEAR_TO_SRGB[j] = Math.round(linearToSrgbExact(j / ENCODE_STEPS) * 255);
    }

    function encode(v) {
        if (!(v > 0)) return 0; // also maps NaN to 0
        if (v >= 1) return 255;
        return LINEAR_TO_SRGB[(v * ENCODE_STEPS + 0.5) | 0];
    }

    // ------------------------------------------------------------------
    // Matrix helpers (row-major 3x3)
    // ------------------------------------------------------------------

    function lerpMatrix(a, b, t) {
        var out = new Array(9);
        for (var k = 0; k < 9; k++) out[k] = a[k] + (b[k] - a[k]) * t;
        return out;
    }

    function clampSeverity(s) {
        s = Number(s);
        if (!(s > 0)) return 0;
        return s >= 1 ? 1 : s;
    }

    function machadoMatrix(type, severity) {
        var table = MACHADO_2009[type];
        var x = clampSeverity(severity) * 10;
        var lo = Math.floor(x);
        if (lo >= 10) return table[10].slice();
        return lerpMatrix(table[lo], table[lo + 1], x - lo);
    }

    // ------------------------------------------------------------------
    // Public API
    // ------------------------------------------------------------------

    /** Which concrete model is used for a (type, model preference) pair. */
    function resolveModel(type, model) {
        if (type === 'normal') return 'identity';
        if (type === 'achromat') return 'luminance';
        if (TYPES.indexOf(type) < 0) throw new Error('Unknown CVD type: ' + type);
        if (model === 'machado2009' || model === 'brettel1997') return model;
        if (model && model !== 'auto') throw new Error('Unknown CVD model: ' + model);
        // auto: Machado for protan/deutan (models anomalous trichromacy, the most
        // common case), Brettel for tritan (Machado's tritan is the weakest part
        // of that model; Brettel is the reference for tritanopia).
        return type === 'tritan' ? 'brettel1997' : 'machado2009';
    }

    /**
     * Build the per-pixel transform for a deficiency.
     * @param {string} type   normal | protan | deutan | tritan | achromat
     * @param {number} severity 0..1 (0 = normal vision, 1 = dichromacy/monochromacy)
     * @param {string} [model] auto | machado2009 | brettel1997
     */
    function getTransform(type, severity, model) {
        var resolved = resolveModel(type, model);
        var s = clampSeverity(severity);
        if (resolved === 'identity' || s === 0) {
            return { m1: IDENTITY.slice(), m2: IDENTITY.slice(), n: ZERO3.slice(), identity: true, model: resolved, severity: s };
        }
        if (resolved === 'machado2009') {
            var m = machadoMatrix(type, s);
            return { m1: m, m2: m.slice(), n: ZERO3.slice(), identity: false, model: resolved, severity: s };
        }
        if (resolved === 'brettel1997') {
            var p = BRETTEL_1997[type];
            return {
                m1: lerpMatrix(IDENTITY, p.m1, s),
                m2: lerpMatrix(IDENTITY, p.m2, s),
                n: p.n.slice(),
                identity: false,
                model: resolved,
                severity: s
            };
        }
        // luminance (monochromacy)
        var full = LUMA.concat(LUMA, LUMA);
        var lm = lerpMatrix(IDENTITY, full, s);
        return { m1: lm, m2: lm.slice(), n: ZERO3.slice(), identity: false, model: resolved, severity: s };
    }

    /** Apply a transform in place to RGBA bytes (Uint8ClampedArray / Uint8Array). */
    function applyTransform(data, t) {
        if (t.identity) return data;
        var a0 = t.m1[0], a1 = t.m1[1], a2 = t.m1[2], a3 = t.m1[3], a4 = t.m1[4],
            a5 = t.m1[5], a6 = t.m1[6], a7 = t.m1[7], a8 = t.m1[8];
        var b0 = t.m2[0], b1 = t.m2[1], b2 = t.m2[2], b3 = t.m2[3], b4 = t.m2[4],
            b5 = t.m2[5], b6 = t.m2[6], b7 = t.m2[7], b8 = t.m2[8];
        var n0 = t.n[0], n1 = t.n[1], n2 = t.n[2];
        var lin = SRGB_TO_LINEAR;
        for (var p = 0, len = data.length; p < len; p += 4) {
            var r = lin[data[p]], g = lin[data[p + 1]], b = lin[data[p + 2]];
            if (r * n0 + g * n1 + b * n2 >= 0) {
                data[p] = encode(a0 * r + a1 * g + a2 * b);
                data[p + 1] = encode(a3 * r + a4 * g + a5 * b);
                data[p + 2] = encode(a6 * r + a7 * g + a8 * b);
            } else {
                data[p] = encode(b0 * r + b1 * g + b2 * b);
                data[p + 1] = encode(b3 * r + b4 * g + b5 * b);
                data[p + 2] = encode(b6 * r + b7 * g + b8 * b);
            }
        }
        return data;
    }

    /** Simulate in place on an ImageData-like object ({data}). */
    function simulateImageData(imageData, type, severity, model) {
        applyTransform(imageData.data, getTransform(type, severity, model));
        return imageData;
    }

    /** Simulate one 8-bit sRGB color. Returns [r, g, b]. */
    function simulateColor(rgb, type, severity, model) {
        var px = new Uint8ClampedArray([rgb[0], rgb[1], rgb[2], 255]);
        applyTransform(px, getTransform(type, severity, model));
        return [px[0], px[1], px[2]];
    }

    /** Largest size with the same aspect ratio that fits in maxPixels. */
    function fitWithin(width, height, maxPixels) {
        var px = width * height;
        if (!(px > maxPixels)) return { width: width, height: height, scaled: false };
        var k = Math.sqrt(maxPixels / px);
        return {
            width: Math.max(1, Math.floor(width * k)),
            height: Math.max(1, Math.floor(height * k)),
            scaled: true
        };
    }

    /** Row-major 3x3 -> column-major (what WebGL's uniformMatrix3fv expects). */
    function toColumnMajor(m) {
        return [m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]];
    }

    return {
        version: '2.0.0',
        TYPES: TYPES.slice(),
        MODELS: MODELS.slice(),
        LUMA: LUMA.slice(),
        BRETTEL_1997: BRETTEL_1997,
        MACHADO_2009: MACHADO_2009,
        resolveModel: resolveModel,
        getTransform: getTransform,
        applyTransform: applyTransform,
        simulateImageData: simulateImageData,
        simulateColor: simulateColor,
        machadoMatrix: machadoMatrix,
        fitWithin: fitWithin,
        toColumnMajor: toColumnMajor,
        srgbToLinear: function (byte) { return SRGB_TO_LINEAR[byte]; },
        srgbToLinearExact: srgbToLinearExact,
        linearToSrgbExact: linearToSrgbExact,
        encode: encode
    };
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { decodePNG, encodePNG } = require('../helpers/png.js');

test('PNG test helper round-trips RGBA pixels', () => {
    const width = 7, height = 5;
    const data = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < data.length; i++) data[i] = (i * 37) & 0xff;
    const decoded = decodePNG(encodePNG({ width, height, data }));
    assert.equal(decoded.width, width);
    assert.equal(decoded.height, height);
    assert.deepEqual(Array.from(decoded.data), Array.from(data));
});

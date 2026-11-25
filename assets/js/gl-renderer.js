/*!
 * gl-renderer.js — real-time CVD simulation on the GPU (WebGL 1).
 *
 * Runs the same per-pixel math as cvd.js (exact sRGB transfer functions,
 * half-plane selection, 3x3 linear-light transform) in a fragment shader, so a
 * live camera feed can be simulated at full frame rate. It consumes the very
 * transform object produced by CVD.getTransform(), which keeps CPU and GPU
 * results in lock-step (verified by the end-to-end parity test).
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.CVDGL = factory();
    }
})(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var VERTEX_SHADER = [
        'attribute vec2 a_pos;',
        'varying vec2 v_uv;',
        'void main() {',
        '    v_uv = a_pos * 0.5 + 0.5;',
        '    gl_Position = vec4(a_pos, 0.0, 1.0);',
        '}'
    ].join('\n');

    var FRAGMENT_SHADER = [
        '#ifdef GL_FRAGMENT_PRECISION_HIGH',
        'precision highp float;',
        '#else',
        'precision mediump float;',
        '#endif',
        'uniform sampler2D u_tex;',
        'uniform mat3 u_m1;',
        'uniform mat3 u_m2;',
        'uniform vec3 u_n;',
        'varying vec2 v_uv;',
        'vec3 toLinear(vec3 c) {',
        '    return mix(pow((c + 0.055) / 1.055, vec3(2.4)), c / 12.92, step(c, vec3(0.04045)));',
        '}',
        'vec3 toSrgb(vec3 l) {',
        '    l = clamp(l, 0.0, 1.0);',
        '    return mix(1.055 * pow(l, vec3(1.0 / 2.4)) - 0.055, l * 12.92, step(l, vec3(0.0031308)));',
        '}',
        'void main() {',
        '    vec4 c = texture2D(u_tex, v_uv);',
        '    vec3 lin = toLinear(c.rgb);',
        '    vec3 o = dot(lin, u_n) >= 0.0 ? u_m1 * lin : u_m2 * lin;',
        '    gl_FragColor = vec4(toSrgb(o), c.a);',
        '}'
    ].join('\n');

    function compile(gl, type, source) {
        var shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);
        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            var log = gl.getShaderInfoLog(shader);
            gl.deleteShader(shader);
            throw new Error('Shader compile failed: ' + log);
        }
        return shader;
    }

    function columnMajor(m) {
        return new Float32Array([m[0], m[3], m[6], m[1], m[4], m[7], m[2], m[5], m[8]]);
    }

    /**
     * Create a renderer bound to a canvas. Returns null when WebGL is not
     * available, so callers can fall back to the CPU path.
     */
    function create(canvas) {
        // alpha + non-premultiplied output so transparent images composite like the original.
        var options = { alpha: true, antialias: false, depth: false, stencil: false, premultipliedAlpha: false, preserveDrawingBuffer: false };
        var gl;
        try {
            gl = canvas.getContext('webgl', options) || canvas.getContext('experimental-webgl', options);
        } catch (e) {
            gl = null;
        }
        if (!gl) return null;

        var program;
        try {
            program = gl.createProgram();
            gl.attachShader(program, compile(gl, gl.VERTEX_SHADER, VERTEX_SHADER));
            gl.attachShader(program, compile(gl, gl.FRAGMENT_SHADER, FRAGMENT_SHADER));
            gl.linkProgram(program);
            if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
        } catch (e) {
            if (typeof console !== 'undefined') console.warn('WebGL unavailable, using CPU fallback:', e.message);
            return null;
        }
        gl.useProgram(program);

        var buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
        gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
        var aPos = gl.getAttribLocation(program, 'a_pos');
        gl.enableVertexAttribArray(aPos);
        gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 0, 0);

        var texture = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, texture);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, true);
        gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
        gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
        gl.uniform1i(gl.getUniformLocation(program, 'u_tex'), 0);

        var uM1 = gl.getUniformLocation(program, 'u_m1');
        var uM2 = gl.getUniformLocation(program, 'u_m2');
        var uN = gl.getUniformLocation(program, 'u_n');
        var maxTexture = gl.getParameter(gl.MAX_TEXTURE_SIZE);
        var lastTransform = null;
        var lost = false;

        canvas.addEventListener('webglcontextlost', function (e) {
            e.preventDefault();
            lost = true;
        });

        return {
            maxTextureSize: maxTexture,
            isLost: function () { return lost || gl.isContextLost(); },

            /** Draw `source` (video, image, canvas, ImageBitmap) through `transform`. */
            render: function (source, transform, width, height) {
                if (lost) return false;
                if (canvas.width !== width) canvas.width = width;
                if (canvas.height !== height) canvas.height = height;
                gl.viewport(0, 0, width, height);
                if (transform !== lastTransform) {
                    gl.uniformMatrix3fv(uM1, false, columnMajor(transform.m1));
                    gl.uniformMatrix3fv(uM2, false, columnMajor(transform.m2));
                    gl.uniform3f(uN, transform.n[0], transform.n[1], transform.n[2]);
                    lastTransform = transform;
                }
                gl.bindTexture(gl.TEXTURE_2D, texture);
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
                gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
                return true;
            },

            /** Read back the last frame as top-down RGBA (call right after render). */
            readPixels: function () {
                var w = canvas.width, h = canvas.height;
                var bottomUp = new Uint8Array(w * h * 4);
                gl.readPixels(0, 0, w, h, gl.RGBA, gl.UNSIGNED_BYTE, bottomUp);
                var out = new Uint8ClampedArray(w * h * 4);
                var row = w * 4;
                for (var y = 0; y < h; y++) {
                    out.set(bottomUp.subarray((h - 1 - y) * row, (h - y) * row), y * row);
                }
                return out;
            }
        };
    }

    return { create: create, FRAGMENT_SHADER: FRAGMENT_SHADER };
});

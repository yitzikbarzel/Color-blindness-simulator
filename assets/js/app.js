/*!
 * app.js — UI for the color blindness simulator.
 * Depends on CVD (cvd.js) and CVDGL (gl-renderer.js).
 */
(function () {
    'use strict';

    var CVD = window.CVD;
    var CVDGL = window.CVDGL;

    // ------------------------------------------------------------------
    // Constants & content
    // ------------------------------------------------------------------

    var STORAGE = { theme: 'cbSimTheme', model: 'cbSimModel', view: 'cbSimView' };
    var MAX_PIXELS = 4096 * 4096;          // keeps memory sane (iOS canvas limit is 16.7 MP)
    var CPU_BUSY_THRESHOLD = 1200000;      // show a spinner above ~1.2 MP on the CPU path
    var CAMERA_CPU_PIXELS = 640 * 480;     // CPU fallback resolution for live video
    var THUMB_SIDE = 480;

    var TYPE_ORDER = ['normal', 'protan', 'deutan', 'tritan', 'achromat'];

    var TYPE_INFO = {
        normal: {
            title: 'ראייה תקינה', short: 'תקין', sub: 'שלושה סוגי קונוסים תקינים', stat: ''
        },
        protan: {
            title: 'פרוטן', short: 'פרוטן', sub: 'רגישות מופחתת לאדום (קונוס L)', stat: 'כ-2% מהגברים',
            full: 'פרוטנופיה', partial: 'פרוטנומליה',
            fullDetail: 'דיכרומטיות: קונוס L חסר', partialDetail: 'טריכרומטיות חריגה: קונוס L מוסט',
            slugFull: 'protanopia', slugPartial: 'protanomaly'
        },
        deutan: {
            title: 'דאוטרן', short: 'דאוטרן', sub: 'רגישות מופחתת לירוק (קונוס M)', stat: 'כ-6% מהגברים',
            full: 'דאוטרנופיה', partial: 'דאוטרנומליה',
            fullDetail: 'דיכרומטיות: קונוס M חסר', partialDetail: 'טריכרומטיות חריגה: קונוס M מוסט · הסוג הנפוץ ביותר',
            slugFull: 'deuteranopia', slugPartial: 'deuteranomaly'
        },
        tritan: {
            title: 'טריטן', short: 'טריטן', sub: 'רגישות מופחתת לכחול (קונוס S)', stat: 'נדיר מאוד',
            full: 'טריטנופיה', partial: 'טריטנומליה',
            fullDetail: 'דיכרומטיות: קונוס S חסר', partialDetail: 'טריכרומטיות חריגה: קונוס S מוסט',
            slugFull: 'tritanopia', slugPartial: 'tritanomaly'
        },
        achromat: {
            title: 'מונוכרומטיות', short: 'מונוכרום', sub: 'ראייה ללא צבעים', stat: 'כ-1 ל-30,000',
            full: 'אכרומטופסיה', partial: 'אכרומטומליה',
            fullDetail: 'מונוכרומטיות: ראייה בגווני אפור', partialDetail: 'צבעוניות מופחתת (קירוב)',
            slugFull: 'achromatopsia', slugPartial: 'achromatomaly'
        }
    };

    var MODEL_HINTS = {
        auto: 'Machado 2009 לפרוטן ולדאוטרן (מדמה גם צורות חלקיות באופן פיזיולוגי), ו-Brettel 1997 לטריטן — המודל המדויק ביותר עבורו.',
        machado2009: 'מודל הסטת הרגישות של הקונוסים, כפי שבכלי הפיתוח של Chrome ו-Firefox. בטריטן הוא פחות מדויק.',
        brettel1997: 'הקרנה דו-מישורית במרחב LMS — המדויק ביותר לדיכרומטיות. צורות חלקיות מחושבות כמיזוג ליניארי באור ליניארי.'
    };

    // Reference palette shown on every type card (Material-ish primaries).
    var PALETTE = [
        [229, 57, 53], [251, 140, 0], [253, 216, 53], [67, 160, 71],
        [0, 172, 193], [30, 136, 229], [142, 36, 170], [216, 27, 96]
    ];

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function $(id) { return document.getElementById(id); }

    var store = {
        get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
        set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) { /* ignore */ } }
    };

    function rgbCss(c) { return 'rgb(' + c[0] + ',' + c[1] + ',' + c[2] + ')'; }

    function describe(type, severity) {
        var info = TYPE_INFO[type];
        var pct = Math.round(severity * 100);
        if (type === 'normal' || pct === 0) {
            return { name: 'ראייה תקינה', detail: 'טריכרומטית — ללא סימולציה', label: 'ראייה תקינה', slug: 'normal' };
        }
        if (pct >= 100) {
            return { name: info.full, detail: info.fullDetail, label: info.full, slug: info.slugFull };
        }
        return {
            name: info.partial,
            detail: info.partialDetail + ' · ' + pct + '%',
            label: info.partial + ' ' + pct + '%',
            slug: info.slugPartial + '-' + pct
        };
    }

    var toastTimer = null;
    function toast(message, ms) {
        var el = $('toast');
        el.textContent = message;
        el.hidden = false;
        clearTimeout(toastTimer);
        toastTimer = setTimeout(function () { el.hidden = true; }, ms || 3200);
    }

    function saveBlob(blob, filename) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
    }

    function canvasToBlob(canvas) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (b) { b ? resolve(b) : reject(new Error('toBlob failed')); }, 'image/png');
        });
    }

    function makeCanvas(w, h) {
        var c = document.createElement('canvas');
        c.width = w;
        c.height = h;
        return c;
    }

    function baseName(name) {
        return (name || 'image').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) || 'image';
    }

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    var storedModel = store.get(STORAGE.model);
    var storedView = store.get(STORAGE.view);

    var state = {
        mode: 'image',
        type: 'deutan',
        severity: 1,
        model: CVD.MODELS.indexOf(storedModel) >= 0 ? storedModel : 'auto',
        view: ['split', 'side', 'grid'].indexOf(storedView) >= 0 ? storedView : 'split',
        split: 0.5,
        camSplit: 0.5
    };
    var transform = CVD.getTransform(state.type, state.severity, state.model);

    function refreshTransform() {
        transform = CVD.getTransform(state.type, state.severity, state.model);
    }

    // ------------------------------------------------------------------
    // Theme
    // ------------------------------------------------------------------

    function setTheme(theme) {
        document.documentElement.setAttribute('data-theme', theme);
        store.set(STORAGE.theme, theme);
        $('themeToggle').setAttribute('aria-label', theme === 'dark' ? 'מעבר למצב בהיר' : 'מעבר למצב כהה');
        $('themeToggle').title = $('themeToggle').getAttribute('aria-label');
    }

    // ------------------------------------------------------------------
    // Controls: type cards, quick chips, severity, model
    // ------------------------------------------------------------------

    var typeCards = {};
    var quickChips = {};

    function buildTypeControls() {
        var list = $('typeList');
        var quick = $('quickTypes');
        TYPE_ORDER.forEach(function (key) {
            var info = TYPE_INFO[key];

            var card = document.createElement('label');
            card.className = 'type-card';
            card.dataset.type = key;

            var input = document.createElement('input');
            input.type = 'radio';
            input.name = 'cvdType';
            input.value = key;
            input.addEventListener('change', function () { if (input.checked) setType(key); });

            var dot = document.createElement('span');
            dot.className = 'type-dot';

            var title = document.createElement('span');
            title.className = 'type-title';
            title.textContent = info.title;
            if (info.stat) {
                var stat = document.createElement('span');
                stat.className = 'type-stat';
                stat.textContent = info.stat;
                title.appendChild(stat);
            }

            var sub = document.createElement('span');
            sub.className = 'type-sub';
            sub.textContent = info.sub;

            var sw = document.createElement('span');
            sw.className = 'swatches';
            sw.setAttribute('aria-hidden', 'true');
            PALETTE.forEach(function () { sw.appendChild(document.createElement('span')); });

            card.append(input, dot, title, sub, sw);
            list.appendChild(card);
            typeCards[key] = { card: card, input: input, swatches: sw };

            var chip = document.createElement('button');
            chip.type = 'button';
            chip.className = 'quick-chip';
            chip.setAttribute('role', 'radio');
            chip.textContent = info.short;
            chip.addEventListener('click', function () { setType(key); });
            quick.appendChild(chip);
            quickChips[key] = chip;
        });
    }

    function updateSwatches() {
        TYPE_ORDER.forEach(function (key) {
            var spans = typeCards[key].swatches.children;
            PALETTE.forEach(function (c, i) {
                var out = key === 'normal' ? c : CVD.simulateColor(c, key, state.severity, state.model);
                spans[i].style.backgroundColor = rgbCss(out);
            });
        });
    }

    function updateControls() {
        TYPE_ORDER.forEach(function (key) {
            var on = key === state.type;
            typeCards[key].input.checked = on;
            typeCards[key].card.classList.toggle('is-selected', on);
            quickChips[key].setAttribute('aria-checked', String(on));
            quickChips[key].tabIndex = on ? 0 : -1;
        });

        var slider = $('severity');
        var pct = Math.round(state.severity * 100);
        slider.value = pct;
        slider.disabled = state.type === 'normal';
        slider.style.setProperty('--fill', pct + '%');
        slider.setAttribute('aria-valuetext', pct + '%');
        $('severityValue').textContent = state.type === 'normal' ? '—' : pct + '%';

        var d = describe(state.type, state.severity);
        var clinical = $('severityName');
        clinical.textContent = '';
        var strong = document.createElement('strong');
        strong.textContent = state.type === 'normal' ? 'ראייה תקינה' : d.name;
        var span = document.createElement('span');
        span.textContent = state.type === 'normal' ? ' · בחרו סוג כדי לראות סימולציה' : ' · ' + d.detail;
        clinical.append(strong, span);

        $('filteredLabel').textContent = d.label;
        $('camFilteredLabel').textContent = d.label;
        $('modelSelect').value = state.model;
        $('modelHint').textContent = MODEL_HINTS[state.model];
    }

    function onSettingsChanged() {
        refreshTransform();
        updateControls();
        updateSwatches();
        scheduleImageRender();
    }

    function setType(type) {
        if (state.type === type) return;
        state.type = type;
        onSettingsChanged();
    }

    // ------------------------------------------------------------------
    // Image mode
    // ------------------------------------------------------------------

    var image = null; // { canvas, pixels, width, height, name, thumb }
    var filteredCanvas = $('filteredCanvas');
    var filteredGL = CVDGL.create(filteredCanvas);
    var filtered2d = filteredGL ? null : filteredCanvas.getContext('2d');
    var maxSide = filteredGL ? Math.min(filteredGL.maxTextureSize || 4096, 8192) : 8192;

    var renderQueued = false;
    function scheduleImageRender() {
        if (!image || renderQueued) return;
        renderQueued = true;
        requestAnimationFrame(function () {
            renderQueued = false;
            renderImage();
        });
    }

    var cpuJob = 0;
    function renderImage() {
        if (!image) return;
        if (state.view === 'grid') {
            renderGrid();
            return;
        }
        if (filteredGL && !filteredGL.isLost()) {
            filteredGL.render(image.canvas, transform, image.width, image.height);
            return;
        }
        if (!filtered2d) {
            // GL context was lost: swap in a fresh 2D canvas.
            var fresh = filteredCanvas.cloneNode(false);
            filteredCanvas.replaceWith(fresh);
            filteredCanvas = fresh;
            filteredGL = null;
            filtered2d = filteredCanvas.getContext('2d');
        }
        var job = ++cpuJob;
        var big = image.width * image.height > CPU_BUSY_THRESHOLD;
        var run = function () {
            if (job !== cpuJob || !image) return;
            filteredCanvas.width = image.width;
            filteredCanvas.height = image.height;
            var out = new ImageData(new Uint8ClampedArray(image.pixels.data), image.width, image.height);
            CVD.applyTransform(out.data, transform);
            filtered2d.putImageData(out, 0, 0);
            $('busy').hidden = true;
        };
        if (big) {
            $('busy').hidden = false;
            setTimeout(run, 16);
        } else {
            run();
        }
    }

    /** Exact CPU render at full working resolution (used for downloads and tests). */
    function renderExact() {
        var out = new ImageData(new Uint8ClampedArray(image.pixels.data), image.width, image.height);
        CVD.applyTransform(out.data, transform);
        var c = makeCanvas(image.width, image.height);
        c.getContext('2d').putImageData(out, 0, 0);
        return c;
    }

    function decodeImage(blob) {
        if (typeof createImageBitmap === 'function') {
            return createImageBitmap(blob, { imageOrientation: 'from-image' }).catch(function () {
                return decodeWithImg(blob);
            });
        }
        return decodeWithImg(blob);
    }

    function decodeWithImg(blob) {
        return new Promise(function (resolve, reject) {
            var url = URL.createObjectURL(blob);
            var img = new Image();
            img.onload = function () { URL.revokeObjectURL(url); resolve(img); };
            img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('decode failed')); };
            img.src = url;
        });
    }

    function loadFile(file) {
        if (!file) return Promise.resolve();
        if (!file.type || file.type.indexOf('image/') !== 0) {
            toast('הקובץ שנבחר אינו תמונה. נסו JPG, PNG, WebP או GIF.');
            return Promise.resolve();
        }
        return decodeImage(file).then(function (source) {
            setImage(source, file.name || 'image');
        }, function () {
            toast('לא ניתן לפתוח את התמונה. ייתכן שהפורמט (למשל HEIC) אינו נתמך בדפדפן זה.');
        });
    }

    function setImage(source, name) {
        var sw = source.naturalWidth || source.width;
        var sh = source.naturalHeight || source.height;
        if (!sw || !sh) {
            toast('לא ניתן לקרוא את מידות התמונה.');
            return;
        }
        var fit = CVD.fitWithin(sw, sh, MAX_PIXELS);
        var k = Math.min(1, maxSide / Math.max(fit.width, fit.height));
        var w = Math.max(1, Math.floor(fit.width * k));
        var h = Math.max(1, Math.floor(fit.height * k));

        var canvas = makeCanvas(w, h);
        var ctx = canvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(source, 0, 0, w, h);
        if (typeof source.close === 'function') source.close();

        image = {
            canvas: canvas,
            pixels: ctx.getImageData(0, 0, w, h),
            width: w,
            height: h,
            name: name,
            thumb: null
        };

        var orig = $('originalCanvas');
        orig.width = w;
        orig.height = h;
        orig.getContext('2d').drawImage(canvas, 0, 0);

        $('panel-image').style.setProperty('--ar', (w / h).toFixed(5));
        var meta = name + ' · ' + sw + '×' + sh;
        if (w !== sw || h !== sh) meta += ' · מעובדת ב-' + w + '×' + h;
        $('imageMeta').textContent = meta;
        $('imageMeta').hidden = false;
        $('dropzone').hidden = true;
        $('downloadBtn').disabled = false;
        $('downloadCompareBtn').disabled = false;
        applyView();
        renderImage();
    }

    function applyView() {
        Array.prototype.forEach.call(document.querySelectorAll('#viewSwitch .seg-btn'), function (b) {
            b.setAttribute('aria-pressed', String(b.dataset.view === state.view));
        });
        if (!image) return;
        var grid = state.view === 'grid';
        $('viewer').hidden = grid;
        $('compareGrid').hidden = !grid;
        if (!grid) $('viewer').dataset.view = state.view;
    }

    function setView(view) {
        state.view = view;
        store.set(STORAGE.view, view);
        applyView();
        renderImage();
    }

    function thumbPixels() {
        if (image.thumb) return image.thumb;
        var k = Math.min(1, THUMB_SIDE / Math.max(image.width, image.height));
        var w = Math.max(1, Math.round(image.width * k));
        var h = Math.max(1, Math.round(image.height * k));
        var c = makeCanvas(w, h);
        var ctx = c.getContext('2d', { willReadFrequently: true });
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(image.canvas, 0, 0, w, h);
        image.thumb = ctx.getImageData(0, 0, w, h);
        return image.thumb;
    }

    function renderGrid() {
        var grid = $('compareGrid');
        var base = thumbPixels();
        grid.textContent = '';
        TYPE_ORDER.forEach(function (key) {
            var card = document.createElement('button');
            card.type = 'button';
            card.className = 'cmp-card';
            card.dataset.type = key;
            card.setAttribute('aria-pressed', String(key === state.type));
            var severity = key === 'normal' ? 0 : state.severity;
            var d = describe(key, severity);

            var title = document.createElement('span');
            title.className = 'cmp-title';
            title.textContent = key === 'normal' ? 'מקור' : d.name;
            var stat = document.createElement('span');
            stat.textContent = key === 'normal' ? 'ראייה תקינה' : TYPE_INFO[key].stat;
            title.appendChild(stat);

            var c = makeCanvas(base.width, base.height);
            var data = new ImageData(new Uint8ClampedArray(base.data), base.width, base.height);
            if (key !== 'normal') CVD.applyTransform(data.data, CVD.getTransform(key, severity, state.model));
            c.getContext('2d').putImageData(data, 0, 0);
            c.setAttribute('role', 'img');
            c.setAttribute('aria-label', d.name);

            card.append(c, title);
            card.addEventListener('click', function () {
                state.type = key;
                if (key !== 'normal' && state.severity === 0) state.severity = 1;
                onSettingsChanged();
                setView('split');
            });
            grid.appendChild(card);
        });
    }

    function downloadSimulated() {
        if (!image) return;
        var btn = $('downloadBtn');
        btn.disabled = true;
        $('busy').hidden = false;
        setTimeout(function () {
            var c = renderExact();
            canvasToBlob(c).then(function (blob) {
                saveBlob(blob, baseName(image.name) + '_' + describe(state.type, state.severity).slug + '.png');
                toast('התמונה המסומלצת נשמרה');
            }).catch(function () {
                toast('השמירה נכשלה, נסו שוב.');
            }).then(function () {
                btn.disabled = false;
                $('busy').hidden = true;
            });
        }, 16);
    }

    function downloadComparison() {
        if (!image) return;
        var sim = renderExact();
        var w = image.width, h = image.height;
        var pad = Math.round(Math.max(16, w * 0.02));
        var bar = Math.round(Math.max(44, w * 0.05));
        var c = makeCanvas(w * 2 + pad * 3, h + bar + pad * 2);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#0b1020';
        ctx.fillRect(0, 0, c.width, c.height);
        ctx.drawImage(image.canvas, pad, bar + pad);
        ctx.drawImage(sim, w + pad * 2, bar + pad);
        ctx.fillStyle = '#e8edf7';
        ctx.font = '600 ' + Math.round(bar * 0.45) + 'px Heebo, Arial, sans-serif';
        ctx.textBaseline = 'middle';
        ctx.textAlign = 'center';
        ctx.direction = 'rtl';
        ctx.fillText('מקור', pad + w / 2, bar / 2 + pad / 2);
        ctx.fillText(describe(state.type, state.severity).label, w + pad * 2 + w / 2, bar / 2 + pad / 2);
        canvasToBlob(c).then(function (blob) {
            saveBlob(blob, baseName(image.name) + '_compare_' + describe(state.type, state.severity).slug + '.png');
            toast('תמונת ההשוואה נשמרה');
        });
    }

    // Procedurally generated demo: a dot plate with hidden digits drawn from a
    // red/green confusion palette, plus a reference palette and spectrum.
    function makeSampleImage() {
        var W = 1200, H = 800;
        var c = makeCanvas(W, H);
        var ctx = c.getContext('2d');
        ctx.fillStyle = '#f5f2ea';
        ctx.fillRect(0, 0, W, H);

        var seed = 20240611;
        var rand = function () { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };

        var cx = 400, cy = 400, R = 340;
        var mask = makeCanvas(W, H);
        var mctx = mask.getContext('2d');
        mctx.fillStyle = '#000';
        mctx.font = '800 420px Arial, sans-serif';
        mctx.textAlign = 'center';
        mctx.textBaseline = 'middle';
        mctx.fillText('74', cx, cy + 20);
        var m = mctx.getImageData(0, 0, W, H).data;

        var figure = ['#d6603c', '#e07a3a', '#cc5a40', '#e38c47', '#d36f3d'];
        var ground = ['#8ca659', '#9caf5c', '#819d57', '#a5b563', '#94a45b'];
        var cell = 32, cols = Math.ceil(W / cell), buckets = {};
        for (var attempt = 0; attempt < 16000; attempt++) {
            var r = 5 + rand() * 11;
            var a = rand() * Math.PI * 2, dist = Math.sqrt(rand()) * (R - r);
            var x = cx + Math.cos(a) * dist, y = cy + Math.sin(a) * dist;
            var gx = Math.floor(x / cell), gy = Math.floor(y / cell), ok = true;
            for (var dx = -1; dx <= 1 && ok; dx++) {
                for (var dy = -1; dy <= 1 && ok; dy++) {
                    var list = buckets[(gy + dy) * cols + gx + dx];
                    if (!list) continue;
                    for (var q = 0; q < list.length; q++) {
                        var o = list[q];
                        if (Math.hypot(o[0] - x, o[1] - y) < o[2] + r + 1.5) { ok = false; break; }
                    }
                }
            }
            if (!ok) continue;
            (buckets[gy * cols + gx] = buckets[gy * cols + gx] || []).push([x, y, r]);
            var inside = m[((Math.round(y) * W) + Math.round(x)) * 4 + 3] > 128;
            var pal = inside ? figure : ground;
            ctx.fillStyle = pal[Math.floor(rand() * pal.length)];
            ctx.beginPath();
            ctx.arc(x, y, r, 0, Math.PI * 2);
            ctx.fill();
        }

        var swatches = [['אדום', '#e53935'], ['כתום', '#fb8c00'], ['צהוב', '#fdd835'], ['ירוק', '#43a047'], ['תכלת', '#00acc1'], ['כחול', '#1e88e5'], ['סגול', '#8e24aa']];
        ctx.direction = 'rtl';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        ctx.fillStyle = '#1f2937';
        ctx.font = '700 34px Heebo, Arial, sans-serif';
        ctx.fillText('פלטת ייחוס', 1150, 88);
        swatches.forEach(function (s, i) {
            var y = 140 + i * 68;
            ctx.fillStyle = s[1];
            if (ctx.roundRect) {
                ctx.beginPath();
                ctx.roundRect(820, y, 200, 50, 12);
                ctx.fill();
            } else {
                ctx.fillRect(820, y, 200, 50);
            }
            ctx.fillStyle = '#1f2937';
            ctx.font = '500 26px Heebo, Arial, sans-serif';
            ctx.fillText(s[0], 1150, y + 25);
        });
        var grad = ctx.createLinearGradient(820, 0, 1150, 0);
        for (var hdeg = 0; hdeg <= 360; hdeg += 30) grad.addColorStop(hdeg / 360, 'hsl(' + hdeg + ',90%,52%)');
        ctx.fillStyle = grad;
        ctx.fillRect(820, 650, 330, 56);
        return c;
    }

    // ------------------------------------------------------------------
    // Split comparison (shared by image + camera)
    // ------------------------------------------------------------------

    function attachSplit(container, handle, isActive, get, set) {
        var dragging = false;
        function fromPointer(clientX) {
            var r = container.getBoundingClientRect();
            set(Math.min(1, Math.max(0, (clientX - r.left) / r.width)));
        }
        container.addEventListener('pointerdown', function (e) {
            if (!isActive() || e.button !== 0) return;
            dragging = true;
            handle.classList.add('is-dragging');
            try { container.setPointerCapture(e.pointerId); } catch (err) { /* ignore */ }
            fromPointer(e.clientX);
        });
        container.addEventListener('pointermove', function (e) {
            if (dragging) fromPointer(e.clientX);
        });
        function end() {
            dragging = false;
            handle.classList.remove('is-dragging');
        }
        container.addEventListener('pointerup', end);
        container.addEventListener('pointercancel', end);
        handle.addEventListener('keydown', function (e) {
            var step = e.shiftKey ? 0.1 : 0.02;
            var v = get();
            if (e.key === 'ArrowLeft') v -= step;
            else if (e.key === 'ArrowRight') v += step;
            else if (e.key === 'Home') v = 0;
            else if (e.key === 'End') v = 1;
            else return;
            e.preventDefault();
            set(Math.min(1, Math.max(0, v)));
        });
    }

    function setHandleAria(handle, p) {
        var pct = Math.round(p * 100);
        handle.setAttribute('aria-valuenow', String(pct));
        handle.setAttribute('aria-valuetext', pct + '%');
    }

    function setImageSplit(p) {
        state.split = p;
        $('viewer').style.setProperty('--split', (p * 100).toFixed(2) + '%');
        setHandleAria($('splitHandle'), p);
    }

    // ------------------------------------------------------------------
    // Live camera
    // ------------------------------------------------------------------

    var cam = {
        stream: null,
        facing: 'environment',
        mirrored: false,
        running: false,
        gen: 0,
        gl: null,
        ctx2d: null,
        split: false,
        width: 0,
        height: 0,
        frames: 0,
        fpsSince: 0,
        resumeOnVisible: false
    };
    var video = $('camVideo');

    var CAMERA_ERRORS = {
        NotAllowedError: 'הגישה למצלמה נחסמה. אפשרו גישה למצלמה בהגדרות הדפדפן ונסו שוב.',
        SecurityError: 'הגישה למצלמה נחסמה. אפשרו גישה למצלמה בהגדרות הדפדפן ונסו שוב.',
        NotFoundError: 'לא נמצאה מצלמה במכשיר זה.',
        OverconstrainedError: 'לא נמצאה מצלמה מתאימה במכשיר זה.',
        NotReadableError: 'המצלמה תפוסה על ידי אפליקציה אחרת. סגרו אותה ונסו שוב.',
        AbortError: 'הפעלת המצלמה בוטלה. נסו שוב.'
    };

    function showCameraError(message) {
        var el = $('cameraError');
        el.textContent = message;
        el.hidden = !message;
    }

    function camCanvas() { return $('camCanvas'); }

    function ensureCameraRenderer() {
        if (cam.gl || cam.ctx2d) return;
        cam.gl = CVDGL.create(camCanvas());
        if (!cam.gl) cam.ctx2d = camCanvas().getContext('2d', { willReadFrequently: true });
    }

    function fallbackCameraToCpu() {
        var old = camCanvas();
        var fresh = old.cloneNode(false);
        fresh.style.clipPath = old.style.clipPath;
        old.replaceWith(fresh);
        cam.gl = null;
        cam.ctx2d = fresh.getContext('2d', { willReadFrequently: true });
    }

    function startCamera() {
        showCameraError('');
        if (!window.isSecureContext) {
            showCameraError('המצלמה זמינה רק בחיבור מאובטח (HTTPS). פתחו את האתר בכתובת https.');
            return Promise.resolve(false);
        }
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            showCameraError('הדפדפן הזה אינו תומך בגישה למצלמה.');
            return Promise.resolve(false);
        }
        var startBtn = $('camStartBtn');
        startBtn.disabled = true;
        var constraints = {
            audio: false,
            video: { facingMode: { ideal: cam.facing }, width: { ideal: 1280 }, height: { ideal: 720 } }
        };
        return navigator.mediaDevices.getUserMedia(constraints).then(function (stream) {
            startBtn.disabled = false;
            if (state.mode !== 'camera') {
                stream.getTracks().forEach(function (t) { t.stop(); });
                return false;
            }
            stopStream();
            cam.stream = stream;
            var track = stream.getVideoTracks()[0];
            var settings = track && track.getSettings ? track.getSettings() : {};
            cam.mirrored = settings.facingMode ? settings.facingMode === 'user' : cam.facing === 'user';
            $('mediaFlip').classList.toggle('is-mirrored', cam.mirrored);

            video.srcObject = stream;
            var play = video.play();
            if (play && play.catch) play.catch(function () { /* autoplay is muted+inline, safe to ignore */ });

            ensureCameraRenderer();
            $('cameraIntro').hidden = true;
            $('cameraViewer').hidden = false;
            $('camCaptureBtn').disabled = false;
            $('camSplitBtn').disabled = false;
            $('camStopBtn').hidden = false;
            $('camStats').hidden = false;
            $('camFullscreenBtn').hidden = !document.fullscreenEnabled;
            applyCamSplit();

            if (navigator.mediaDevices.enumerateDevices) {
                navigator.mediaDevices.enumerateDevices().then(function (devices) {
                    var n = devices.filter(function (d) { return d.kind === 'videoinput'; }).length;
                    $('camSwitchBtn').hidden = n < 2;
                }).catch(function () { /* ignore */ });
            }

            cam.running = true;
            cam.frames = 0;
            cam.fpsSince = performance.now();
            var gen = ++cam.gen;
            requestCamFrame(gen);
            return true;
        }, function (err) {
            startBtn.disabled = false;
            showCameraError(CAMERA_ERRORS[err && err.name] || 'לא ניתן להפעיל את המצלמה (' + ((err && err.name) || 'שגיאה') + ').');
            return false;
        });
    }

    function requestCamFrame(gen) {
        if (typeof video.requestVideoFrameCallback === 'function') {
            video.requestVideoFrameCallback(function () { camFrame(gen); });
        } else {
            requestAnimationFrame(function () { camFrame(gen); });
        }
    }

    function camFrame(gen) {
        if (!cam.running || gen !== cam.gen) return;
        var w = video.videoWidth, h = video.videoHeight;
        if (w && h) {
            if (w !== cam.width || h !== cam.height) {
                cam.width = w;
                cam.height = h;
                $('cameraViewer').style.setProperty('--ar', (w / h).toFixed(5));
            }
            if (cam.gl && cam.gl.isLost()) fallbackCameraToCpu();
            if (cam.gl) {
                cam.gl.render(video, transform, w, h);
            } else {
                var fit = CVD.fitWithin(w, h, CAMERA_CPU_PIXELS);
                var c = camCanvas();
                if (c.width !== fit.width) c.width = fit.width;
                if (c.height !== fit.height) c.height = fit.height;
                cam.ctx2d.drawImage(video, 0, 0, fit.width, fit.height);
                var frame = cam.ctx2d.getImageData(0, 0, fit.width, fit.height);
                CVD.applyTransform(frame.data, transform);
                cam.ctx2d.putImageData(frame, 0, 0);
            }
            cam.frames++;
            var now = performance.now();
            if (now - cam.fpsSince >= 500) {
                var fps = Math.round(cam.frames * 1000 / (now - cam.fpsSince));
                $('camStats').textContent = fps + ' FPS · ' + (cam.gl ? 'GPU' : 'CPU') + ' · ' + w + '×' + h;
                cam.frames = 0;
                cam.fpsSince = now;
            }
        }
        requestCamFrame(gen);
    }

    function stopStream() {
        if (cam.stream) {
            cam.stream.getTracks().forEach(function (t) { t.stop(); });
            cam.stream = null;
        }
        video.srcObject = null;
    }

    function stopCamera() {
        cam.running = false;
        cam.gen++;
        stopStream();
        if (document.fullscreenElement && document.exitFullscreen) document.exitFullscreen().catch(function () {});
        $('cameraViewer').hidden = true;
        $('cameraIntro').hidden = false;
        $('camCaptureBtn').disabled = true;
        $('camSplitBtn').disabled = true;
        $('camStopBtn').hidden = true;
        $('camSwitchBtn').hidden = true;
        $('camStats').hidden = true;
        $('camFullscreenBtn').hidden = true;
    }

    function applyCamSplit() {
        var viewer = $('cameraViewer');
        viewer.classList.toggle('is-split', cam.split);
        $('camSplitBtn').setAttribute('aria-pressed', String(cam.split));
        var pct = (state.camSplit * 100).toFixed(2) + '%';
        viewer.style.setProperty('--split', pct);
        var clip = 'none';
        if (cam.split) clip = cam.mirrored ? 'inset(0 ' + pct + ' 0 0)' : 'inset(0 0 0 ' + pct + ')';
        camCanvas().style.clipPath = clip;
        setHandleAria($('camSplitHandle'), state.camSplit);
    }

    function captureFrame() {
        var w = video.videoWidth, h = video.videoHeight;
        if (!w || !h) return Promise.resolve();
        var c = makeCanvas(w, h);
        c.getContext('2d').drawImage(video, 0, 0, w, h);
        return canvasToBlob(c).then(function (blob) {
            var stamp = new Date().toISOString().slice(0, 19).replace(/[T:]/g, '-');
            var file = new File([blob], 'camera-' + stamp + '.png', { type: 'image/png' });
            setMode('image');
            return loadFile(file).then(function () {
                toast('הפריים נשמר — אפשר להשוות, לבחון את כל הסוגים ולהוריד');
            });
        });
    }

    // ------------------------------------------------------------------
    // Mode tabs
    // ------------------------------------------------------------------

    function setMode(mode) {
        if (state.mode === mode) return;
        state.mode = mode;
        ['image', 'camera'].forEach(function (m) {
            var tab = $('tab-' + m);
            var on = m === mode;
            tab.setAttribute('aria-selected', String(on));
            tab.tabIndex = on ? 0 : -1;
            $('panel-' + m).hidden = !on;
        });
        if (mode === 'image') {
            if (cam.running) stopCamera();
            scheduleImageRender();
        }
    }

    // ------------------------------------------------------------------
    // Wiring
    // ------------------------------------------------------------------

    function init() {
        buildTypeControls();
        setTheme(document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark');
        $('themeToggle').addEventListener('click', function () {
            setTheme(document.documentElement.getAttribute('data-theme') === 'dark' ? 'light' : 'dark');
        });

        $('severity').addEventListener('input', function (e) {
            state.severity = Number(e.target.value) / 100;
            onSettingsChanged();
        });
        $('modelSelect').addEventListener('change', function (e) {
            state.model = e.target.value;
            store.set(STORAGE.model, state.model);
            onSettingsChanged();
        });

        // Quick chips: arrow-key navigation like a radio group.
        $('quickTypes').addEventListener('keydown', function (e) {
            var i = TYPE_ORDER.indexOf(state.type);
            if (e.key === 'ArrowLeft') i = (i + 1) % TYPE_ORDER.length;
            else if (e.key === 'ArrowRight') i = (i - 1 + TYPE_ORDER.length) % TYPE_ORDER.length;
            else return;
            e.preventDefault();
            setType(TYPE_ORDER[i]);
            quickChips[state.type].focus();
        });

        // Mode tabs (RTL: ArrowLeft moves to the next tab).
        ['image', 'camera'].forEach(function (m) {
            $('tab-' + m).addEventListener('click', function () { setMode(m); });
        });
        document.querySelector('.mode-switch').addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            e.preventDefault();
            var next = state.mode === 'image' ? 'camera' : 'image';
            setMode(next);
            $('tab-' + next).focus();
        });

        // Image input: picker, dropzone, drag & drop, paste, sample.
        $('imageInput').addEventListener('change', function (e) {
            loadFile(e.target.files && e.target.files[0]);
            e.target.value = '';
        });
        var dz = $('dropzone');
        dz.addEventListener('click', function (e) {
            if (e.target.closest('#sampleBtn')) return;
            $('imageInput').click();
        });
        dz.addEventListener('keydown', function (e) {
            if (e.target !== dz) return;
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                $('imageInput').click();
            }
        });
        $('sampleBtn').addEventListener('click', function () {
            setImage(makeSampleImage(), 'sample-plate.png');
        });

        var dragDepth = 0;
        window.addEventListener('dragenter', function (e) {
            if (!e.dataTransfer || Array.prototype.indexOf.call(e.dataTransfer.types, 'Files') < 0) return;
            dragDepth++;
            dz.classList.add('is-dragover');
        });
        window.addEventListener('dragleave', function () {
            dragDepth = Math.max(0, dragDepth - 1);
            if (!dragDepth) dz.classList.remove('is-dragover');
        });
        window.addEventListener('dragover', function (e) { e.preventDefault(); });
        window.addEventListener('drop', function (e) {
            e.preventDefault();
            dragDepth = 0;
            dz.classList.remove('is-dragover');
            var file = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
            if (file) {
                setMode('image');
                loadFile(file);
            }
        });
        window.addEventListener('paste', function (e) {
            var items = e.clipboardData && e.clipboardData.items;
            if (!items) return;
            for (var i = 0; i < items.length; i++) {
                if (items[i].type && items[i].type.indexOf('image/') === 0) {
                    setMode('image');
                    loadFile(items[i].getAsFile());
                    return;
                }
            }
        });

        Array.prototype.forEach.call(document.querySelectorAll('#viewSwitch .seg-btn'), function (b) {
            b.addEventListener('click', function () { setView(b.dataset.view); });
        });
        $('downloadBtn').addEventListener('click', downloadSimulated);
        $('downloadCompareBtn').addEventListener('click', downloadComparison);

        attachSplit($('viewer'), $('splitHandle'),
            function () { return state.view === 'split'; },
            function () { return state.split; },
            setImageSplit);
        setImageSplit(state.split);

        // Camera
        $('camStartBtn').addEventListener('click', startCamera);
        $('camStopBtn').addEventListener('click', stopCamera);
        $('camCaptureBtn').addEventListener('click', captureFrame);
        $('camSwitchBtn').addEventListener('click', function () {
            cam.facing = cam.facing === 'environment' ? 'user' : 'environment';
            startCamera();
        });
        $('camSplitBtn').addEventListener('click', function () {
            cam.split = !cam.split;
            applyCamSplit();
        });
        $('camFullscreenBtn').addEventListener('click', function () {
            var panel = $('panel-camera');
            if (document.fullscreenElement) document.exitFullscreen();
            else if (panel.requestFullscreen) panel.requestFullscreen().catch(function () {});
        });
        attachSplit($('cameraViewer'), $('camSplitHandle'),
            function () { return cam.split; },
            function () { return state.camSplit; },
            function (p) { state.camSplit = p; applyCamSplit(); });

        document.addEventListener('visibilitychange', function () {
            if (document.hidden && cam.running) {
                cam.resumeOnVisible = true;
                stopCamera();
            } else if (!document.hidden && cam.resumeOnVisible && state.mode === 'camera') {
                cam.resumeOnVisible = false;
                startCamera();
            }
        });
        window.addEventListener('pagehide', stopStream);

        applyView();
        onSettingsChanged();
    }

    init();

    // Small, read-only surface for automated end-to-end tests.
    window.__cvdApp = {
        state: state,
        transform: function () { return transform; },
        gpu: function () { return { image: !!filteredGL, camera: !!cam.gl }; },
        cameraRunning: function () { return cam.running; },
        /** Exact pixels of the simulated image at working resolution. */
        exactPixels: function () {
            if (!image) return null;
            var c = renderExact();
            return Array.from(c.getContext('2d').getImageData(0, 0, c.width, c.height).data);
        },
        /** Pixels currently shown in the filtered canvas (GPU or CPU path). */
        displayedPixels: function () {
            if (!image) return null;
            if (filteredGL) {
                filteredGL.render(image.canvas, transform, image.width, image.height);
                return Array.from(filteredGL.readPixels());
            }
            return Array.from(filtered2d.getImageData(0, 0, image.width, image.height).data);
        },
        originalPixels: function () { return image ? Array.from(image.pixels.data) : null; }
    };
})();

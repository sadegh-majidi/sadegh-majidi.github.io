/* Native chart renderer for the LeakyLMs page.
 *
 * Why this exists: the figures were previously exported from the paper as SVG and
 * scaled to fit. Those figures are drawn for a ~3.3in journal column, so their type
 * is large relative to their canvas — scaling them to the page made the labels
 * enormous on wide screens and unreadable on narrow ones. Nothing about them
 * adapted to the viewport except uniform scaling.
 *
 * Here the SVG is built at the container's real pixel size and re-built on resize.
 * Type is fixed in px, so a label is the same size at 380px wide as at 1200px;
 * only the plot geometry adapts. Tick density drops on narrow screens.
 *
 * Data comes from assets/charts-data.js, generated from assets/data/*.csv.
 * Values are the measurements, converted s -> ms. No smoothing, no resampling.
 */
(function (global) {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';

  var FONT = '"IBM Plex Mono", ui-monospace, monospace';
  var TICK_PX = 11;      /* tick labels */
  var NAME_PX = 11.5;    /* axis names  */
  var MARK_PX = 11;      /* marker label */

  /* The paper's palette is tuned for white paper. On the dark theme those hues sit
     too close to the background, so they are lifted toward white. Hue is preserved,
     so a series keeps the colour it has in the paper. */
  function isDark() {
    var t = document.documentElement.getAttribute('data-theme');
    if (t) return t === 'dark';
    return global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches;
  }
  function adj(hex) {
    if (!isDark()) return hex;
    var m = /^#([0-9a-fA-F]{6})$/.exec(hex);
    if (!m) return hex;
    var n = parseInt(m[1], 16), r = n >> 16, g = (n >> 8) & 255, b = n & 255;
    /* Lift each colour only as far as it needs to be readable on the dark card. A flat
       lift washed every hue toward white, which collapsed the two blues in the eight-series
       plot into near-duplicates. Colours already light enough are left exactly as they are,
       so hue separation survives. */
    var lum = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255, MIN = 0.5;
    if (lum >= MIN) return hex;
    var t = (MIN - lum) / (1 - lum);
    var f = function (c) { return Math.round(c + (255 - c) * t); };
    return 'rgb(' + f(r) + ',' + f(g) + ',' + f(b) + ')';
  }

  function mk(tag, attrs, text) {
    var e = document.createElementNS(NS, tag);
    for (var k in attrs) if (attrs[k] !== undefined && attrs[k] !== null) e.setAttribute(k, attrs[k]);
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }

  function niceTicks(lo, hi, target) {
    var span = hi - lo;
    if (!(span > 0)) return [lo];
    var step = Math.pow(10, Math.floor(Math.log10(span / target)));
    var err = span / target / step;
    if (err >= 7.5) step *= 10; else if (err >= 3.5) step *= 5; else if (err >= 1.5) step *= 2;
    var out = [], v = Math.ceil(lo / step) * step;
    for (; v <= hi + step * 1e-6; v += step) out.push(+v.toPrecision(12));
    return out;
  }

  function fmtX(v) {
    var a = Math.abs(v);
    if (a >= 1e6) return trim(v / 1e6) + 'M';
    if (a >= 1e3) return trim(v / 1e3) + 'K';
    return trim(v);
  }
  function trim(n) { return String(+n.toFixed(2)); }
  function fmtY(v) {
    var a = Math.abs(v);
    if (v === 0) return '0';
    if (a >= 10) return String(Math.round(v));
    if (a >= 1) return v.toFixed(1);
    return v.toFixed(2);
  }
  function fmtInt(v) { return Math.round(v).toLocaleString('en-US'); }

  /* Monotone cubic (Fritsch-Carlson) path through the points.
     The paper's own figures draw these two plots as densely-sampled smooth curves with
     markers at the sampled positions, because the underlying runtime model is a smooth
     function of sequence length. Straight segments between 13 samples misrepresent that.
     Monotone interpolation is used rather than a least-squares quadratic: it passes
     exactly through every measured point (a quadratic fit left residuals up to 3.7%,
     which would visibly lift the markers off the curve) and it cannot overshoot, so it
     never introduces a bump or dip the measurements do not contain. */
  function smoothPath(pts, X, Y) {
    var p = pts.slice().sort(function (a, b) { return a[0] - b[0]; });
    var n = p.length, i;
    if (n < 3) return null;
    var xs = p.map(function (q) { return q[0]; }), ys = p.map(function (q) { return q[1]; });
    var h = [], d = [];
    for (i = 0; i < n - 1; i++) { h[i] = xs[i + 1] - xs[i]; d[i] = h[i] ? (ys[i + 1] - ys[i]) / h[i] : 0; }
    var m = new Array(n);
    m[0] = d[0]; m[n - 1] = d[n - 2];
    for (i = 1; i < n - 1; i++) m[i] = (d[i - 1] * d[i] <= 0) ? 0 : (d[i - 1] + d[i]) / 2;
    for (i = 0; i < n - 1; i++) {          /* monotonicity limiter */
      if (d[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
      var a = m[i] / d[i], b = m[i + 1] / d[i], q = a * a + b * b;
      if (q > 9) { var t = 3 / Math.sqrt(q); m[i] = t * a * d[i]; m[i + 1] = t * b * d[i]; }
    }
    var out = 'M ' + X(xs[0]) + ' ' + Y(ys[0]);
    for (i = 0; i < n - 1; i++) {
      out += ' C ' + X(xs[i] + h[i] / 3) + ' ' + Y(ys[i] + m[i] * h[i] / 3) +
             ' '   + X(xs[i + 1] - h[i] / 3) + ' ' + Y(ys[i + 1] - m[i + 1] * h[i] / 3) +
             ' '   + X(xs[i + 1]) + ' ' + Y(ys[i + 1]);
    }
    return out;
  }

  /* Least-squares quadratic, evaluated densely.
     The paper draws these two figures as smooth fitted curves with markers at the sampled
     positions, and the markers deliberately sit slightly off the curve — that gap is how
     well the runtime model matches the measurements. A quadratic is the right family: the
     model is a polynomial in sequence length, with attention quadratic in T.
     x is normalised to [0,1] before fitting, otherwise the x^4 sums lose precision. */
  function quadFit(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var xs = pts.map(function (p) { return p[0]; });
    var lo = Math.min.apply(null, xs), hi = Math.max.apply(null, xs);
    if (hi === lo) return null;
    var u = xs.map(function (x) { return (x - lo) / (hi - lo); });
    var ys = pts.map(function (p) { return p[1]; });
    var S = [0, 0, 0, 0, 0], T = [0, 0, 0], i, k;
    for (i = 0; i < n; i++) {
      var p1 = 1;
      for (k = 0; k < 5; k++) { S[k] += p1; p1 *= u[i]; }
      T[0] += ys[i]; T[1] += ys[i] * u[i]; T[2] += ys[i] * u[i] * u[i];
    }
    /* solve [S4 S3 S2; S3 S2 S1; S2 S1 S0] [a b c]^T = [T2 T1 T0]^T */
    var A = [[S[4], S[3], S[2]], [S[3], S[2], S[1]], [S[2], S[1], S[0]]], b = [T[2], T[1], T[0]];
    for (i = 0; i < 3; i++) {
      var piv = i;
      for (k = i + 1; k < 3; k++) if (Math.abs(A[k][i]) > Math.abs(A[piv][i])) piv = k;
      var tA = A[i]; A[i] = A[piv]; A[piv] = tA;
      var tb = b[i]; b[i] = b[piv]; b[piv] = tb;
      if (!A[i][i]) return null;
      for (k = 0; k < 3; k++) {
        if (k === i) continue;
        var f = A[k][i] / A[i][i];
        for (var c = i; c < 3; c++) A[k][c] -= f * A[i][c];
        b[k] -= f * b[i];
      }
    }
    var co = [b[0] / A[0][0], b[1] / A[1][1], b[2] / A[2][2]];
    return function (x) {
      var t = (x - lo) / (hi - lo);
      return co[0] * t * t + co[1] * t + co[2];
    };
  }
  /* The curve spans the chart's x-domain, not just the series' own range, so a series
     whose measurements stop early still runs to the edge like the rest — as the paper's
     figure does. Beyond the last measurement this is an extrapolation of the fit; the
     markers stop where the data stops, which is what shows the reader where that is.
     The y-domain is set from the measurements alone, so an extrapolated curve that climbs
     past the top is clipped rather than rescaling every other series. */
  function fitPath(pts, X, Y, N, lo, hi) {
    var f = quadFit(pts);
    if (!f) return null;
    var xs = pts.map(function (p) { return p[0]; });
    if (lo === undefined) lo = Math.min.apply(null, xs);
    if (hi === undefined) hi = Math.max.apply(null, xs);
    var out = [];
    for (var i = 0; i <= N; i++) {
      var x = lo + (hi - lo) * i / N;
      out.push(X(x) + ',' + Y(f(x)));
    }
    return out.join(' ');
  }

  /* Rough px width of a monospace string at a given size. Used to reserve the
     left gutter, so long y labels never collide with the axis name. */
  function textW(s, px) { return s.length * px * 0.6; }

  function render(host, spec, opts) {
    opts = opts || {};
    var W = Math.max(240, Math.round(host.clientWidth || host.getBoundingClientRect().width));
    if (!W || W < 40) return null;

    var narrow = W < 460;
    var H = Math.round(Math.max(180, Math.min(opts.maxHeight || 300, W * (narrow ? 0.72 : 0.52))));

    var vis = spec.series.filter(function (s) { return !s.off; });

    /* domains */
    var xs = [], ys = [];
    vis.forEach(function (s) { s.pts.forEach(function (p) { xs.push(p[0]); ys.push(p[1]); }); });
    if (!xs.length) return null;
    var x0 = opts.xMin !== undefined ? opts.xMin : Math.min.apply(null, xs);
    var x1 = opts.xMax !== undefined ? opts.xMax : Math.max.apply(null, xs);
    if (x1 === x0) x1 = x0 + 1;
    var yMax = Math.max.apply(null, ys) * 1.08;
    var y0 = 0, y1 = yMax;

    var yTicks = niceTicks(y0, y1, narrow ? 4 : 5);
    var xTicks = niceTicks(x0, x1, W < 380 ? 3 : W < 560 ? 4 : 6);

    var maxYLab = yTicks.reduce(function (m, t) { return Math.max(m, textW(fmtY(t), TICK_PX)); }, 0);
    var padL = Math.round(maxYLab + (spec.y ? NAME_PX + 10 : 0) + 12);
    var padR = 10, padT = 12;
    var padB = Math.round(TICK_PX + (spec.x ? NAME_PX + 10 : 0) + 16);

    var X = function (v) { return padL + (v - x0) / (x1 - x0) * (W - padL - padR); };
    var Y = function (v) { return H - padB - (v - y0) / (y1 - y0) * (H - padT - padB); };

    var svg = mk('svg', {
      width: W, height: H, viewBox: '0 0 ' + W + ' ' + H,
      role: 'img', 'aria-label': spec.alt || host.getAttribute('data-alt') || ''
    });
    svg.style.display = 'block';

    /* grid + y labels */
    yTicks.forEach(function (t) {
      svg.appendChild(mk('line', { x1: padL, x2: W - padR, y1: Y(t), y2: Y(t), 'class': 'ch-grid' }));
      svg.appendChild(mk('text', {
        x: padL - 7, y: Y(t) + TICK_PX * 0.35, 'text-anchor': 'end',
        'class': 'ch-lbl', 'font-size': TICK_PX, 'font-family': FONT
      }, fmtY(t)));
    });
    /* x grid + labels */
    xTicks.forEach(function (t) {
      if (t < x0 || t > x1) return;
      svg.appendChild(mk('line', { x1: X(t), x2: X(t), y1: padT, y2: H - padB, 'class': 'ch-grid' }));
      svg.appendChild(mk('text', {
        x: X(t), y: H - padB + TICK_PX + 5, 'text-anchor': 'middle',
        'class': 'ch-lbl', 'font-size': TICK_PX, 'font-family': FONT
      }, fmtX(t)));
    });

    /* axes */
    svg.appendChild(mk('line', { x1: padL, x2: W - padR, y1: H - padB, y2: H - padB, 'class': 'ch-ax' }));
    svg.appendChild(mk('line', { x1: padL, x2: padL, y1: padT, y2: H - padB, 'class': 'ch-ax' }));
    if (spec.x) svg.appendChild(mk('text', {
      x: padL + (W - padL - padR) / 2, y: H - 3, 'text-anchor': 'middle',
      'class': 'ch-name', 'font-size': NAME_PX, 'font-family': FONT
    }, spec.x));
    if (spec.y) {
      var yn = mk('text', {
        x: -(padT + (H - padB - padT) / 2), y: NAME_PX + 1, transform: 'rotate(-90)',
        'text-anchor': 'middle', 'class': 'ch-name', 'font-size': NAME_PX, 'font-family': FONT
      }, spec.y);
      svg.appendChild(yn);
    }

    /* vertical marker (the break) */
    if (spec.mark && spec.mark.x >= x0 && spec.mark.x <= x1) {
      var mx = X(spec.mark.x);
      svg.appendChild(mk('line', { x1: mx, x2: mx, y1: padT, y2: H - padB, 'class': 'ch-mark' }));
      if (spec.mark.label && !opts.hideMarkLabel) {
        var toRight = mx < W - textW(spec.mark.label, MARK_PX) - 24;
        svg.appendChild(mk('text', {
          x: mx + (toRight ? 5 : -5), y: padT + MARK_PX,
          'text-anchor': toRight ? 'start' : 'end',
          'class': 'ch-marklbl', 'font-size': MARK_PX, 'font-family': FONT
        }, spec.mark.label));
      }
    }

    /* series */
    var clip = 'chclip' + Math.random().toString(36).slice(2, 8);
    var cp = mk('clipPath', { id: clip });
    cp.appendChild(mk('rect', { x: padL, y: padT, width: Math.max(0, W - padL - padR), height: Math.max(0, H - padT - padB) }));
    svg.appendChild(cp);
    var g = mk('g', { 'clip-path': 'url(#' + clip + ')' });

    vis.forEach(function (s) {
      var pts = s.pts.filter(function (p) { return p[0] >= x0 && p[0] <= x1; });
      if (!pts.length) return;
      var line = { fill: 'none', stroke: adj(s.color), 'stroke-width': s.dash ? 1.4 : 1.7,
                   'stroke-linejoin': 'round', 'stroke-linecap': 'round',
                   'stroke-dasharray': s.dash ? '5 3' : null };
      var mode = s.curve || spec.curve;
      var sm = null, fp = null;
      if (mode === 'fit') fp = fitPath(pts, X, Y, 96, x0, x1);
      else if (mode === 'smooth') sm = smoothPath(pts, X, Y);
      if (fp) {
        line.points = fp;
        g.appendChild(mk('polyline', line));
      } else if (sm) {
        line.d = sm;
        g.appendChild(mk('path', line));
      } else {
        line.points = pts.map(function (p) { return X(p[0]) + ',' + Y(p[1]); }).join(' ');
        g.appendChild(mk('polyline', line));
      }
      /* markers sit at the real sampled positions, as in the paper's figures */
      if (pts.length <= 26 && (!s.dash || sm || fp)) {
        pts.forEach(function (p) {
          g.appendChild(mk('circle', { cx: X(p[0]), cy: Y(p[1]), r: narrow ? 1.9 : 2.3, fill: adj(s.color) }));
        });
      }
    });

    /* optional cursor, used by the interactive figure */
    if (opts.cursor != null) {
      var cx = X(opts.cursor);
      g.appendChild(mk('line', { x1: cx, x2: cx, y1: padT, y2: H - padB, 'class': 'ch-cur' }));
      vis.forEach(function (s) {
        var hit = null;
        s.pts.forEach(function (p) { if (p[0] === opts.cursor) hit = p; });
        if (hit) g.appendChild(mk('circle', { cx: X(hit[0]), cy: Y(hit[1]), r: 4.5, fill: 'none', 'class': 'ch-hit' }));
      });
    }
    svg.appendChild(g);
    return svg;
  }

  function legend(spec) {
    var wrap = document.createElement('div');
    wrap.className = 'ch-leg';
    spec.series.forEach(function (s) {
      if (s.hide || s.off) return;
      var i = document.createElement('span');
      i.innerHTML = '<i class="ch-sw' + (s.dash ? ' dash' : '') + '" style="--c:' + adj(s.color) + '"></i>';
      i.appendChild(document.createTextNode(s.name));
      wrap.appendChild(i);
    });
    if (spec.note) {
      var n = document.createElement('span');
      n.className = 'ch-note';
      n.textContent = spec.note;
      wrap.appendChild(n);
    }
    return wrap;
  }

  function draw(host, spec, opts) {
    var svg = render(host, spec, opts);
    if (!svg) return;
    host.innerHTML = '';
    host.appendChild(svg);
    if (spec.series.some(function (s) { return !s.hide && !s.off; })) host.appendChild(legend(spec));
  }

  /* Auto-mount every [data-chart], and redraw on container resize so the type
     never scales — only the geometry does. */
  function mountAll() {
    if (!global.CHART_DATA) return;
    var nodes = document.querySelectorAll('[data-chart]');
    Array.prototype.forEach.call(nodes, function (host) {
      var spec = global.CHART_DATA[host.getAttribute('data-chart')];
      if (!spec) return;
      spec.alt = host.getAttribute('data-alt') || '';
      if (host.getAttribute('data-note')) spec.note = host.getAttribute('data-note');
      var pending = null;
      var redraw = function () { draw(host, spec, {}); };
      redraw();
      global.LeakyCharts.onTheme(redraw);
      if ('ResizeObserver' in global) {
        var last = host.clientWidth;
        new ResizeObserver(function () {
          if (Math.abs(host.clientWidth - last) < 2) return;
          last = host.clientWidth;
          clearTimeout(pending);
          pending = setTimeout(redraw, 60);
        }).observe(host);
      } else {
        global.addEventListener('resize', function () { clearTimeout(pending); pending = setTimeout(redraw, 120); });
      }
    });
  }

  /* Redraw on theme change so the colour lift is reapplied. */
  var themeHooks = [];
  global.LeakyCharts = {
    render: render, draw: draw, legend: legend, fmtInt: fmtInt, isDark: isDark,
    onTheme: function (fn) { themeHooks.push(fn); }
  };
  if (global.matchMedia) {
    var mq = global.matchMedia('(prefers-color-scheme: dark)');
    var fire = function () { themeHooks.forEach(function (f) { f(); }); };
    if (mq.addEventListener) mq.addEventListener('change', fire); else if (mq.addListener) mq.addListener(fire);
    new MutationObserver(fire).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mountAll);
  else mountAll();
})(window);

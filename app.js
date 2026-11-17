/*
 * AVAS 工具 — 实时合成引擎 / 合规扫描 / 多普勒驶过 / UI
 * 依赖 dsp.js（全局 AVAS）
 */
(function () {
  'use strict';
  var D = AVAS;
  var $ = function (id) { return document.getElementById(id); };
  var clamp = D.clamp;

  /* ================= 状态与持久化 ================= */

  var STORE_KEY = 'avas-tool-v1';

  var state = {
    mode: 'forward',
    speed: 0,
    speedMax: 30,
    interp: 'smooth',
    harmonicCount: 8,
    template: 'smooth',
    vibratoDepth: 0.003,          // 基频分数偏移
    vibratoRate: 4.5,
    startRampMs: 150,             // 起步渐入，消除突兀感
    calibrationDb: 100,           // 0 dBFS 对应的 dB SPL（仅影响试听与表显，不影响合格判定）
    refDistance: 1.0,             // 曲线声压级的参考测量距离 m
    curves: D.defaultCurves(),
    overallLimits: D.defaultOverallLimits(),
    thresholds: D.makeBands().reduce(function (m, b) {
      if (b.thresh !== null) m[b.fc] = b.thresh;
      return m;
    }, {}),
    scan: { step: 1, results: null, running: false },
    drive: { speedKmh: 20, lateral: 7.5, startDist: 20, duration: 0, playing: false, t: 0 }
  };

  function saveState() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify({
        curves: state.curves, overallLimits: state.overallLimits,
        thresholds: state.thresholds, interp: state.interp,
        harmonicCount: state.harmonicCount, template: state.template,
        vibratoDepth: state.vibratoDepth, vibratoRate: state.vibratoRate,
        startRampMs: state.startRampMs, calibrationDb: state.calibrationDb,
        refDistance: state.refDistance, scanStep: state.scan.step
      }));
    } catch (e) { /* 隐私模式等场景静默 */ }
  }

  function loadState() {
    try {
      var raw = localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var s = JSON.parse(raw);
      if (s.curves) state.curves = s.curves;
      if (s.overallLimits) state.overallLimits = s.overallLimits;
      if (s.thresholds) state.thresholds = s.thresholds;
      if (s.interp) state.interp = s.interp;
      if (s.harmonicCount) state.harmonicCount = s.harmonicCount;
      if (s.template) state.template = s.template;
      if (typeof s.vibratoDepth === 'number') state.vibratoDepth = s.vibratoDepth;
      if (typeof s.vibratoRate === 'number') state.vibratoRate = s.vibratoRate;
      if (typeof s.startRampMs === 'number') state.startRampMs = s.startRampMs;
      if (typeof s.calibrationDb === 'number') state.calibrationDb = s.calibrationDb;
      if (typeof s.refDistance === 'number') state.refDistance = s.refDistance;
      if (typeof s.scanStep === 'number') state.scan.step = s.scanStep;
    } catch (e) { /* 损坏存档忽略 */ }
  }

  function curveAt(kind, speed) {
    var set = state.curves[state.mode][kind];
    return D.interpCurve(set, clamp(speed, 0, state.speedMax), state.interp);
  }

  /* ================= 离线渲染（用于合规分析，确定性、可复现） ================= */

  function renderOffline(f0, weights, seconds, fs) {
    var n = Math.floor(seconds * fs);
    var buf = new Float64Array(n);
    var phases = new Float64Array(weights.length);
    var lfoPhase = 0;
    for (var i = 0; i < n; i++) {
      var t = i / fs;
      var vib = 1 + state.vibratoDepth * Math.sin(2 * Math.PI * state.vibratoRate * t + lfoPhase);
      var s = 0;
      for (var h = 1; h <= weights.length; h++) {
        phases[h - 1] += 2 * Math.PI * f0 * h * vib / fs;
        s += weights[h - 1] * Math.sin(phases[h - 1] + (h - 1) * 0.7);
      }
      buf[i] = s;
    }
    return buf;
  }

  var BANDS = D.makeBands();

  /* ================= 实时合成引擎 ================= */

  function LiveEngine() {
    this.ctx = null;
    this.voice = null;
    this.playing = false;
    this.lastModeSig = null;
    this.timer = null;
  }

  LiveEngine.prototype._buildVoice = function () {
    var ctx = this.ctx;
    var voice = { oscs: [], gains: [], lfo: null, lfoGain: null, master: ctx.createGain() };
    voice.master.gain.value = 0;
    voice.lfo = ctx.createOscillator();
    voice.lfo.type = 'sine';
    voice.lfo.frequency.value = state.vibratoRate;
    voice.lfoGain = ctx.createGain();
    // detune 单位为音分；分数偏移 delta -> cents = 1200*log2(1+delta)
    voice.lfoGain.gain.value = 1200 * Math.log2(1 + state.vibratoDepth);
    voice.lfo.connect(voice.lfoGain);
    for (var h = 1; h <= state.harmonicCount; h++) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      var g = ctx.createGain();
      g.gain.value = 0;
      voice.lfoGain.connect(osc.detune);
      osc.connect(g); g.connect(voice.master);
      osc.start();
      voice.oscs.push(osc); voice.gains.push(g);
    }
    voice.lfo.start();
    voice.master.connect(this.tap);
    this.voice = voice;
  };

  LiveEngine.prototype.ensure = function () {
    if (this.ctx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.tap = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.tap.connect(this.analyser);
    this.tap.connect(this.ctx.destination);
    this._buildVoice();
    var self = this;
    this.timer = setInterval(function () { self._tick(); }, 40);
  };

  LiveEngine.prototype._tick = function () {
    if (!this.voice) return;
    var ctx = this.ctx;
    var now = ctx.currentTime;
    var tau = 0.05;

    var sig = state.mode + '|' + state.harmonicCount;
    if (this.lastModeSig !== sig) {
      // 模式或谐波结构变化：重建声部，旧声部淡出后回收，新声部继承播放状态与渐入
      var old = this.voice;
      this._buildVoice();
      var fresh = this.voice;
      old.master.gain.cancelScheduledValues(now);
      old.master.gain.setTargetAtTime(0, now, 0.02);
      setTimeout(function () {
        old.oscs.forEach(function (o) { try { o.stop(); } catch (e) {} });
        try { old.lfo.stop(); } catch (e) {}
        old.master.disconnect();
      }, 200);
      if (this.playing) {
        fresh.master.gain.cancelScheduledValues(now);
        fresh.master.gain.setValueAtTime(0.0001, now);
        fresh.master.gain.exponentialRampToValueAtTime(
          Math.max(0.0002, this._targetGain()), now + 0.08);
      }
      this.lastModeSig = sig;
    }

    var f0 = curveAt('pitch', state.speed);
    var bright = curveAt('timbre', state.speed);
    var targetSpl = curveAt('level', state.speed);
    var weights = D.harmonicProfile(state.template, state.harmonicCount, bright);
    var voiceNow = this.voice;

    for (var h = 1; h <= voiceNow.oscs.length; h++) {
      voiceNow.oscs[h - 1].frequency.setTargetAtTime(f0 * h, now, tau);
      voiceNow.gains[h - 1].gain.setTargetAtTime(weights[h - 1], now, tau);
    }
    voiceNow.lfo.frequency.setTargetAtTime(state.vibratoRate, now, tau);
    voiceNow.lfoGain.gain.setTargetAtTime(1200 * Math.log2(1 + state.vibratoDepth), now, tau);

    if (this.playing && this.voice === voiceNow) {
      voiceNow.master.gain.setTargetAtTime(this._targetGain(targetSpl), now, tau);
    }
  };

  LiveEngine.prototype._targetGain = function (targetSpl) {
    if (typeof targetSpl !== 'number') targetSpl = curveAt('level', state.speed);
    var dbfs = targetSpl - state.calibrationDb;
    return Math.max(0, D.dbToAmp(dbfs));
  };

  LiveEngine.prototype.start = function () {
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    this.playing = true;
    var now = this.ctx.currentTime;
    var g = this.voice.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(0.0001, now);
    // 起步渐入：按表格配置的斜坡时间，避免起步突兀
    g.exponentialRampToValueAtTime(Math.max(0.0002, this._targetGain()),
      now + state.startRampMs / 1000);
  };

  LiveEngine.prototype.stop = function () {
    if (!this.ctx || !this.voice) { this.playing = false; return; }
    this.playing = false;
    var now = this.ctx.currentTime;
    var g = this.voice.master.gain;
    g.cancelScheduledValues(now);
    g.setValueAtTime(Math.max(0.0001, g.value), now);
    g.exponentialRampToValueAtTime(0.0001, now + 0.12);
  };
  LiveEngine.prototype.snapshot = function () {
    if (!this.ctx) return null;
    var n = this.analyser.fftSize;
    var buf = new Float32Array(n);
    this.analyser.getFloatTimeDomainData(buf);
    return D.analyzeSignal(Array.prototype.slice.call(buf), this.ctx.sampleRate, n, BANDS);
  };

  /* ================= 多普勒驶过引擎 ================= */

  function DriveByEngine() {
    this.ctx = null;
    this.playing = false;
    this.raf = null;
    this.startTime = 0;
    this.offset = 0;
  }

  DriveByEngine.prototype.ensure = function () {
    if (this.ctx) return;
    var Ctx = window.AudioContext || window.webkitAudioContext;
    this.ctx = new Ctx();
    this.tap = this.ctx.createGain();
    this.delay = this.ctx.createDelay(0.5);
    this.delay.delayTime.value = 0;
    this.distGain = this.ctx.createGain();
    this.distGain.gain.value = 0;
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 8192;
    this.tap.connect(this.delay);
    this.delay.connect(this.distGain);
    this.distGain.connect(this.analyser);
    this.distGain.connect(this.ctx.destination);
    this._buildVoice();
  };

  DriveByEngine.prototype._buildVoice = function () {
    var ctx = this.ctx;
    var v = { oscs: [], gains: [], lfo: null, lfoGain: null, master: ctx.createGain() };
    v.master.gain.value = 0;
    v.lfo = ctx.createOscillator();
    v.lfo.type = 'sine';
    v.lfo.frequency.value = state.vibratoRate;
    v.lfoGain = ctx.createGain();
    v.lfoGain.gain.value = 1200 * Math.log2(1 + state.vibratoDepth);
    v.lfo.connect(v.lfoGain);
    for (var h = 1; h <= state.harmonicCount; h++) {
      var osc = ctx.createOscillator();
      osc.type = 'sine';
      var g = ctx.createGain();
      g.gain.value = 0;
      v.lfoGain.connect(osc.detune);
      osc.connect(g); g.connect(v.master);
      osc.start();
      v.oscs.push(osc); v.gains.push(g);
    }
    v.lfo.start();
    v.master.connect(this.tap);
    this.voice = v;
  };

  DriveByEngine.prototype._opts = function () {
    var speedMs = D.kmhToMs(state.drive.speedKmh);
    var dur = state.drive.duration || (2 * state.drive.startDist / speedMs);
    return {
      speedMs: speedMs,
      lateral: state.drive.lateral,
      closestAt: dur / 2
    };
  };

  DriveByEngine.prototype.play = function () {
    this.ensure();
    if (this.ctx.state === 'suspended') this.ctx.resume();
    var self = this;
    var speedMs = D.kmhToMs(state.drive.speedKmh);
    state.drive.duration = 2 * state.drive.startDist / speedMs;
    this.startTime = this.ctx.currentTime + 0.05;
    this.offset = state.drive.t || 0;
    this.playing = true;

    var now = this.ctx.currentTime;
    var splAt0 = curveAt('level', 0);
    var baseAmp = D.dbToAmp(splAt0 - state.calibrationDb);
    this._sig = state.mode + '|' + state.harmonicCount;
    this.voice.master.gain.cancelScheduledValues(now);
    this.voice.master.gain.setValueAtTime(0.0001, now);
    this.voice.master.gain.exponentialRampToValueAtTime(Math.max(0.0002, baseAmp), now + 0.1);
    this._loop();
  };

  DriveByEngine.prototype._loop = function () {
    if (!this.playing) return;
    var self = this;
    var opts = this._opts();
    var tObs = this.offset + (this.ctx.currentTime - this.startTime);
    state.drive.t = tObs;
    if (tObs >= state.drive.duration) { this.stop(true); onDriveEnded(); return; }

    // 档位/谐波结构变化时重建声部（旧声部淡出后回收）
    var sig = state.mode + '|' + state.harmonicCount;
    if (this._sig !== sig) {
      var old = this.voice;
      this._buildVoice();
      this._sig = sig;
      if (old) {
        old.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.02);
        setTimeout(function () {
          old.oscs.forEach(function (o) { try { o.stop(); } catch (e) {} });
          try { old.lfo.stop(); } catch (e) {}
          old.master.disconnect();
        }, 200);
      }
      var splNow = D.interpCurve(state.curves[state.mode].level,
        Math.abs(state.drive.speedKmh), state.interp);
      this.voice.master.gain.setTargetAtTime(
        D.dbToAmp(splNow - state.calibrationDb), this.ctx.currentTime, 0.03);
    }

    var tau = D.emissionTime(tObs, opts);
    var tauClamped = clamp(tau, 0, state.drive.duration);
    var st = D.driveState(tauClamped, opts);
    // 倒车的曲线差异完全由 state.mode 的曲线集体现，车速取绝对值查表
    var spd = Math.abs(state.drive.speedKmh);
    var f0 = D.interpCurve(state.curves[state.mode].pitch, spd, state.interp);
    var bright = D.interpCurve(state.curves[state.mode].timbre, spd, state.interp);
    var targetSpl = D.interpCurve(state.curves[state.mode].level, spd, state.interp);
    var weights = D.harmonicProfile(state.template, state.harmonicCount, bright);

    var now = this.ctx.currentTime;
    for (var h = 1; h <= this.voice.oscs.length; h++) {
      this.voice.oscs[h - 1].frequency.setTargetAtTime(f0 * h, now, 0.03);
      this.voice.gains[h - 1].gain.setTargetAtTime(weights[h - 1], now, 0.03);
    }
    // 多普勒：延迟线的延迟量 = 传播延迟 τ 内的变化率 -> 重采样比；
    // 直接以瞬时传播延迟驱动 delayTime，其斜率即多普勒频移（1/(1+dR/dt·1/c)）
    var propDelay = st.R / D.C_SOUND;
    this.delay.delayTime.linearRampToValueAtTime(propDelay, now + 0.04);
    var distDb = D.distanceGainDb(st.R, state.refDistance);
    var amp = D.dbToAmp(targetSpl - state.calibrationDb + distDb);
    this.distGain.gain.setTargetAtTime(Math.max(0, amp), now, 0.03);

    onDriveFrame(tObs, st, propDelay);
    this.raf = requestAnimationFrame(function () { self._loop(); });
  };

  DriveByEngine.prototype.pause = function () {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    if (this.ctx) this.distGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  };

  DriveByEngine.prototype.stop = function (finished) {
    this.playing = false;
    if (this.raf) cancelAnimationFrame(this.raf);
    state.drive.t = finished ? 0 : state.drive.t;
    if (this.ctx) this.distGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.05);
  };

  DriveByEngine.prototype.snapshot = function () {
    if (!this.ctx) return null;
    var n = this.analyser.fftSize;
    var buf = new Float32Array(n);
    this.analyser.getFloatTimeDomainData(buf);
    return D.analyzeSignal(Array.prototype.slice.call(buf), this.ctx.sampleRate, n, BANDS);
  };

  var live = new LiveEngine();
  var drive = new DriveByEngine();

  /* ================= 合规扫描 ================= */

  function yieldTick() { return new Promise(function (r) { setTimeout(r, 0); }); }

  async function runComplianceScan(onProgress) {
    state.scan.running = true;
    var results = [];
    var speeds = [];
    for (var v = 0; v <= state.speedMax + 1e-9; v += state.scan.step) speeds.push(+v.toFixed(2));
    var fs = 48000, seconds = 0.5;
    var sampleRate = fs;

    for (var i = 0; i < speeds.length; i++) {
      var spd = speeds[i];
      var f0 = D.interpCurve(state.curves[state.mode].pitch, spd, state.interp);
      var bright = D.interpCurve(state.curves[state.mode].timbre, spd, state.interp);
      var targetSpl = D.interpCurve(state.curves[state.mode].level, spd, state.interp);
      var weights = D.harmonicProfile(state.template, state.harmonicCount, bright);
      var samples = renderOffline(f0, weights, seconds, fs);
      var ana = D.analyzeSignal(samples, sampleRate, 8192, BANDS);

      // 母线归一化：unity 渲染的 RMS 映射到目标 SPL，再求各频段 SPL
      var normDb = targetSpl - (20 * Math.log10(ana.rms || 1e-10));
      var bandSpl = ana.bands.map(function (b) {
        return { fc: b.fc, spl: b.dbfs + normDb, thresh: state.thresholds[b.fc] != null ? state.thresholds[b.fc] : null };
      });
      var overallA = ana.overallA + normDb;
      var overallLin = ana.overallLin + normDb;
      var overallLimit = D.interpCurve(state.overallLimits, spd, state.interp);

      var passing = [], failing = [];
      bandSpl.forEach(function (b) {
        if (b.thresh === null) return;
        if (b.spl >= b.thresh) passing.push(b.fc);
        else failing.push({ fc: b.fc, spl: b.spl, thresh: b.thresh, gap: b.thresh - b.spl });
      });
      var overallPass = overallLin <= overallLimit + 0.001;
      var pass = passing.length >= 2 && overallPass;

      results.push({
        speed: spd, f0: f0, targetSpl: targetSpl,
        bandSpl: bandSpl, overallA: overallA, overallLin: overallLin,
        overallLimit: overallLimit,
        passBands: passing, failBands: failing,
        overallPass: overallPass, pass: pass
      });
      onProgress && onProgress((i + 1) / speeds.length, results);
      await yieldTick();
    }
    state.scan.results = results;
    state.scan.running = false;
    saveState();
    return results;
  }

  /* ================= 曲线编辑器 ================= */

  function CurveEditor(canvas, kind, opts) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.kind = kind;
    this.opts = opts; // { yMin, yMax, unit, color, formatter, getPoints, onCommit }
    this.dragIdx = -1;
    var self = this;
    canvas.addEventListener('pointerdown', function (e) { self._down(e); });
    canvas.addEventListener('pointermove', function (e) { self._move(e); });
    window.addEventListener('pointerup', function () {
      if (self.dragIdx >= 0) { self.dragIdx = -1; saveState(); (self.opts.onCommit || scheduleScan)(); }
    });
    canvas.addEventListener('dblclick', function (e) { self._dbl(e); });
  }

  CurveEditor.prototype._xy = function () {
    var r = this.canvas.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    if (this.canvas.width !== Math.round(r.width * dpr)) {
      this.canvas.width = Math.round(r.width * dpr);
      this.canvas.height = Math.round(r.height * dpr);
    }
    this.w = r.width; this.h = r.height; this.dpr = dpr;
    this.padL = 46; this.padR = 14; this.padT = 12; this.padB = 24;
  };

  CurveEditor.prototype._toPx = function (p) {
    var x = this.padL + (p.x / state.speedMax) * (this.w - this.padL - this.padR);
    var y = this.padT + (1 - (p.y - this.opts.yMin) / (this.opts.yMax - this.opts.yMin)) *
      (this.h - this.padT - this.padB);
    return [x, y];
  };

  CurveEditor.prototype._fromPx = function (px, py) {
    var x = clamp((px - this.padL) / (this.w - this.padL - this.padR) * state.speedMax, 0, state.speedMax);
    var y = clamp(this.opts.yMin + (1 - (py - this.padT) / (this.h - this.padT - this.padB)) *
      (this.opts.yMax - this.opts.yMin), this.opts.yMin, this.opts.yMax);
    return { x: +x.toFixed(1), y: +y.toFixed(this.opts.yDigits || 2) };
  };

  CurveEditor.prototype._points = function () {
    return this.opts.getPoints ? this.opts.getPoints() : state.curves[state.mode][this.kind];
  };

  CurveEditor.prototype._hit = function (px, py) {
    var pts = this._points();
    for (var i = 0; i < pts.length; i++) {
      var q = this._toPx(pts[i]);
      if (Math.hypot(q[0] - px, q[1] - py) < 9) return i;
    }
    return -1;
  };

  CurveEditor.prototype._down = function (e) {
    this._xy();
    var r = this.canvas.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    var idx = this._hit(px, py);
    if (idx >= 0) { this.dragIdx = idx; this.canvas.setPointerCapture(e.pointerId); return; }
    // 空白处：新增点（保持 x 升序）
    var p = this._fromPx(px, py);
    var pts = this._points();
    var insertAt = 0;
    while (insertAt < pts.length && pts[insertAt].x < p.x) insertAt++;
    pts.splice(insertAt, 0, p);
    this.dragIdx = insertAt;
    this.canvas.setPointerCapture(e.pointerId);
    this.draw();
  };

  CurveEditor.prototype._move = function (e) {
    this._xy();
    var r = this.canvas.getBoundingClientRect();
    var px = e.clientX - r.left, py = e.clientY - r.top;
    if (this.dragIdx < 0) {
      this.canvas.style.cursor = this._hit(px, py) >= 0 ? 'grab' : 'crosshair';
      return;
    }
    var p = this._fromPx(px, py);
    var pts = this._points();
    // 端点不允许越过相邻点
    if (this.dragIdx > 0) p.x = Math.max(p.x, pts[this.dragIdx - 1].x + 0.3);
    if (this.dragIdx < pts.length - 1) p.x = Math.min(p.x, pts[this.dragIdx + 1].x - 0.3);
    pts[this.dragIdx] = p;
    this.draw();
    updateReadouts();
    scheduleScan();
  };

  CurveEditor.prototype._dbl = function (e) {
    this._xy();
    var r = this.canvas.getBoundingClientRect();
    var idx = this._hit(e.clientX - r.left, e.clientY - r.top);
    var pts = this._points();
    if (idx > 0 && idx < pts.length - 1) { // 端点保护
      pts.splice(idx, 1);
      this.draw();
      saveState(); scheduleScan();
    }
  };

  CurveEditor.prototype.draw = function (scanResults) {
    this._xy();
    var c = this.ctx, dpr = this.dpr;
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    c.clearRect(0, 0, this.w, this.h);
    c.font = '11px system-ui, sans-serif';

    // 网格 + 坐标
    c.strokeStyle = 'rgba(128,128,128,.18)'; c.fillStyle = '#8893a5';
    c.lineWidth = 1;
    for (var gx = 0; gx <= state.speedMax; gx += 5) {
      var qx = this._toPx({ x: gx, y: 0 })[0];
      c.beginPath(); c.moveTo(qx, this.padT); c.lineTo(qx, this.h - this.padB); c.stroke();
      c.textAlign = 'center';
      c.fillText(gx, qx, this.h - this.padB + 15);
    }
    var steps = 4;
    for (var gi = 0; gi <= steps; gi++) {
      var yv = this.opts.yMin + (this.opts.yMax - this.opts.yMin) * gi / steps;
      var qy = this._toPx({ x: 0, y: yv })[1];
      c.beginPath(); c.moveTo(this.padL, qy); c.lineTo(this.w - this.padR, qy); c.stroke();
      c.textAlign = 'right';
      c.fillText(this.opts.formatter(yv), this.padL - 6, qy + 4);
    }
    c.textAlign = 'center';
    c.fillStyle = '#6b7484';
    c.fillText('车速 km/h', (this.padL + this.w - this.padR) / 2, this.h - 2);

    // 扫描结果：不合格点红叉（仅响度曲线显示）
    if (scanResults && this.kind === 'level') {
      scanResults.forEach(function (r2) {
        if (!r2.pass) {
          var q = this._toPx({ x: r2.speed, y: clamp(r2.overallLin, this.opts.yMin, this.opts.yMax) });
          c.strokeStyle = '#e5484d'; c.lineWidth = 2;
          c.beginPath();
          c.moveTo(q[0] - 5, q[1] - 5); c.lineTo(q[0] + 5, q[1] + 5);
          c.moveTo(q[0] + 5, q[1] - 5); c.lineTo(q[0] - 5, q[1] + 5);
          c.stroke();
        }
      }, this);
    }

    // 曲线（密集采样插值）
    var pts = this._points();
    c.strokeStyle = this.opts.color; c.lineWidth = 2; c.beginPath();
    for (var sx = 0; sx <= state.speedMax; sx += 0.25) {
      var y2 = D.interpCurve(pts, sx, state.interp);
      var q2 = this._toPx({ x: sx, y: clamp(y2, this.opts.yMin, this.opts.yMax) });
      if (sx === 0) c.moveTo(q2[0], q2[1]); else c.lineTo(q2[0], q2[1]);
    }
    c.stroke();

    // 当前车速竖线
    if (!this.opts.getPoints) {
      var cx = this._toPx({ x: state.speed, y: 0 })[0];
      c.strokeStyle = 'rgba(94,176,255,.55)'; c.setLineDash([4, 4]);
      c.beginPath(); c.moveTo(cx, this.padT); c.lineTo(cx, this.h - this.padB); c.stroke();
      c.setLineDash([]);
    }

    // 控制点
    pts.forEach(function (p, i) {
      var q3 = this._toPx(p);
      c.beginPath(); c.arc(q3[0], q3[1], 5.5, 0, Math.PI * 2);
      c.fillStyle = i === this.dragIdx ? '#fff' : this.opts.color;
      c.fill();
      c.strokeStyle = '#0f1420'; c.lineWidth = 1.5; c.stroke();
      if (i === this.dragIdx || pts.length <= 6) {
        c.fillStyle = '#c6cdd9'; c.textAlign = 'left';
        c.fillText(this.opts.formatter(p.y), q3[0] + 8, q3[1] - 7);
      }
    }, this);
  };

  /* ================= 频段表 ================= */

  function renderBandTable(scanForSpeed) {
    var host = $('bandRows');
    var result = null;
    if (scanForSpeed && state.scan.results) {
      var best = null;
      state.scan.results.forEach(function (r) {
        if (best === null || Math.abs(r.speed - scanForSpeed) < Math.abs(best.speed - scanForSpeed)) best = r;
      });
      result = best;
    }
    var html = '';
    BANDS.forEach(function (b) {
      var thresh = state.thresholds[b.fc];
      var spl = result ? result.bandSpl.filter(function (x) { return x.fc === b.fc; })[0].spl : null;
      var pass = spl !== null && thresh != null && spl >= thresh;
      html += '<tr class="' + (thresh != null && spl !== null ? (pass ? 'pass' : 'fail') : '') + '">' +
        '<td>' + b.fc + '</td>' +
        '<td><input type="number" class="threshInput" data-fc="' + b.fc + '" value="' +
        (thresh != null ? thresh : '') + '" placeholder="—" min="0" max="120" step="0.5"></td>' +
        '<td>' + (spl !== null ? spl.toFixed(1) : '—') + '</td>' +
        '<td>' + (thresh != null && spl !== null ? (pass ? '✓ 过线' : '✗ 差 ' + (thresh - spl).toFixed(1) + ' dB') : '—') + '</td>' +
        '</tr>';
    });
    host.innerHTML = html;
    host.querySelectorAll('.threshInput').forEach(function (inp) {
      inp.addEventListener('change', function () {
        var fc = +inp.dataset.fc;
        var val = inp.value === '' ? null : +inp.value;
        if (val === null) delete state.thresholds[fc]; else state.thresholds[fc] = val;
        saveState(); scheduleScan();
      });
    });
  }

  /* ================= 扫描结果汇总 ================= */

  function renderScanSummary() {
    var res = state.scan.results;
    var host = $('scanSummary');
    if (!res) { host.innerHTML = '<p class="muted">修改曲线后自动扫描，或点击「立即扫描」。</p>'; return; }
    var fails = res.filter(function (r) { return !r.pass; });
    var html = '<div class="scanHead ' + (fails.length ? 'bad' : 'good') + '">' +
      (fails.length ? '⚠ ' + fails.length + ' 个车速点不合格' : '✓ 全部 ' + res.length + ' 个车速点合格（至少 2 频段过线且总级未超限）') +
      '</div>';
    if (fails.length) {
      html += '<table class="failTable"><thead><tr><th>车速 km/h</th><th>过线频段数</th><th>问题频段（差值 dB）</th><th>总级/上限</th></tr></thead><tbody>';
      fails.forEach(function (r) {
        var bandTxt = r.failBands.map(function (f) {
          return f.fc + 'Hz 差' + f.gap.toFixed(1);
        }).join('；') || '—';
        var ovr = !r.overallPass ? ' <b>总级超限 ' + (r.overallLin - r.overallLimit).toFixed(1) + ' dB</b>' : '';
        html += '<tr><td>' + r.speed + '</td><td>' + r.passBands.length + '</td><td>' + bandTxt + '</td>' +
          '<td>' + r.overallLin.toFixed(1) + ' / ' + r.overallLimit.toFixed(1) + ovr + '</td></tr>';
      });
      html += '</tbody></table>';
    }
    host.innerHTML = html;
  }

  /* ================= 扫描调度（防抖，改点后半秒内出结果） ================= */

  var scanTimer = null;
  function scheduleScan() {
    if (scanTimer) clearTimeout(scanTimer);
    scanTimer = setTimeout(runScanUI, 450);
  }

  async function runScanUI() {
    if (state.scan.running) return;
    $('scanProgress').style.display = 'block';
    var bar = $('scanBar');
    var res = await runComplianceScan(function (p, partial) {
      bar.style.width = (p * 100).toFixed(0) + '%';
      if (p >= 1) {
        setTimeout(function () { $('scanProgress').style.display = 'none'; bar.style.width = '0%'; }, 250);
      }
    });
    renderScanSummary();
    renderBandTable(state.speed);
    redrawEditors();
  }

  /* ================= 实时表显 ================= */

  function updateReadouts() {
    $('speedVal').textContent = state.speed.toFixed(1);
    var p = curveAt('pitch', state.speed);
    var l = curveAt('level', state.speed);
    $('pitchVal').textContent = p.toFixed(1) + ' Hz';
    $('levelVal').textContent = l.toFixed(1) + ' dB';
    $('timbreVal').textContent = curveAt('timbre', state.speed).toFixed(2);
    $('speedSlider').value = state.speed;
    var roP = $('roPitch'), roL = $('roLevel');
    if (roP) roP.textContent = p.toFixed(1) + ' Hz';
    if (roL) roL.textContent = l.toFixed(1) + ' dB';
  }

  var editors = {};
  function redrawEditors() {
    editors.pitch.draw();
    editors.level.draw(state.scan.results);
    editors.timbre.draw();
    if (editors.limits) editors.limits.draw();
  }

  function meterLoop() {
    if (live.playing && live.ctx) {
      var snap = live.snapshot();
      if (snap) {
        var splLin = snap.overallLin + state.calibrationDb;
        var splA = snap.overallA + state.calibrationDb;
        $('meterLin').textContent = splLin.toFixed(1);
        $('meterA').textContent = splA.toFixed(1);
        var passNow = null;
        if (state.scan.results) {
          var cur = null;
          state.scan.results.forEach(function (r) {
            if (cur === null || Math.abs(r.speed - state.speed) < Math.abs(cur.speed - state.speed)) cur = r;
          });
          passNow = cur;
        }
        var badge = $('liveBadge');
        if (passNow) {
          badge.style.display = 'inline-block';
          badge.textContent = passNow.pass ? '当前车速：合格' : '当前车速：不合格';
          badge.className = 'badge ' + (passNow.pass ? 'ok' : 'no');
        }
        renderBandTable(state.speed);
      }
    }
    requestAnimationFrame(meterLoop);
  }

  /* ================= 驶过可视化 ================= */

  function drawDriveScene(tObs, st) {
    var cv = $('driveCanvas'), c = cv.getContext('2d');
    var r = cv.getBoundingClientRect();
    var dpr = window.devicePixelRatio || 1;
    if (cv.width !== Math.round(r.width * dpr)) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    c.setTransform(dpr, 0, 0, dpr, 0, 0);
    var W = r.width, H = r.height;
    c.clearRect(0, 0, W, H);

    var margin = 40, roadY = H * 0.62;
    // 道路
    c.strokeStyle = 'rgba(148,163,184,.5)'; c.lineWidth = 2;
    c.beginPath(); c.moveTo(margin, roadY); c.lineTo(W - margin, roadY); c.stroke();
    c.setLineDash([10, 10]); c.strokeStyle = 'rgba(148,163,184,.25)';
    c.beginPath(); c.moveTo(margin, roadY + 26); c.lineTo(W - margin, roadY + 26); c.stroke();
    c.setLineDash([]);

    // 观察者（麦克风）
    var obsX = W / 2, obsY = roadY + 26;
    c.fillStyle = '#5eb0ff';
    c.beginPath(); c.arc(obsX, obsY, 6, 0, Math.PI * 2); c.fill();
    c.fillStyle = '#8893a5'; c.font = '11px system-ui'; c.textAlign = 'center';
    c.fillText('麦克风（侧向 ' + state.drive.lateral + ' m）', obsX, obsY + 22);

    // 车辆位置：把 startDist 映射到 margin
    var span = state.drive.startDist;
    var carX = obsX + (st.x / span) * (W / 2 - margin);
    var carY = roadY;
    c.fillStyle = state.mode === 'reverse' ? '#f5a524' : '#7c5cff';
    c.fillRect(carX - 12, carY - 9, 24, 14);
    c.fillStyle = '#0f1420';
    c.beginPath(); c.arc(carX - 7, carY + 7, 3, 0, Math.PI * 2); c.arc(carX + 7, carY + 7, 3, 0, Math.PI * 2); c.fill();

    // 连线 + 距离标注
    c.strokeStyle = 'rgba(94,176,255,.4)';
    c.beginPath(); c.moveTo(carX, carY); c.lineTo(obsX, obsY); c.stroke();
    c.fillStyle = '#c6cdd9'; c.textAlign = 'left';
    c.fillText('R = ' + st.R.toFixed(1) + ' m', (carX + obsX) / 2 + 6, (carY + obsY) / 2);

    // 实时参数
    c.textAlign = 'left'; c.fillStyle = '#8893a5';
    var info = 't=' + tObs.toFixed(2) + 's  多普勒比 ' + st.ratio.toFixed(4) +
      '（' + (st.ratio > 1 ? '接近' : st.ratio < 1 ? '远离' : '最近点') + '）';
    c.fillText(info, margin, 18);
  }

  function onDriveFrame(tObs, st, propDelay) {
    drawDriveScene(tObs, st);
    $('driveTime').textContent = tObs.toFixed(2);
    $('driveRatio').textContent = st.ratio.toFixed(4);
    $('driveDist').textContent = st.R.toFixed(1);
    var snap = drive.snapshot();
    if (snap) $('driveSpl').textContent = (snap.overallLin + state.calibrationDb).toFixed(1);
    var dur = state.drive.duration || 1;
    $('driveScrub').value = (tObs / dur) * 100;
  }

  function onDriveEnded() {
    state.drive.playing = false;
    $('drivePlay').textContent = '▶ 播放驶过';
    $('driveTime').textContent = '0.00';
    $('driveScrub').value = 0;
  }

  /* ================= 导入 / 导出 ================= */

  function exportJSON() {
    var blob = new Blob([JSON.stringify({
      version: 1, exportedAt: new Date().toISOString(), state: {
        curves: state.curves, overallLimits: state.overallLimits, thresholds: state.thresholds,
        interp: state.interp, harmonicCount: state.harmonicCount, template: state.template,
        vibratoDepth: state.vibratoDepth, vibratoRate: state.vibratoRate, startRampMs: state.startRampMs,
        calibrationDb: state.calibrationDb, refDistance: state.refDistance
      }
    }, null, 2)], { type: 'application/json' });
    downloadBlob(blob, 'avas-project.json');
  }

  function importJSON(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result).state || JSON.parse(reader.result);
        if (data.curves) state.curves = data.curves;
        if (data.overallLimits) state.overallLimits = data.overallLimits;
        if (data.thresholds) state.thresholds = data.thresholds;
        Object.keys(data).forEach(function (k) {
          if (k in state && typeof data[k] !== 'object') state[k] = data[k];
        });
        saveState(); syncControls(); redrawEditors(); scheduleScan();
      } catch (e) { alert('文件解析失败：' + e.message); }
    };
    reader.readAsText(file);
  }

  function exportCSV() {
    var lines = ['mode,speed_kmh,pitch_hz,level_dbspl,timbre_0_1'];
    ['forward', 'reverse'].forEach(function (m) {
      for (var s = 0; s <= state.speedMax; s += state.scan.step) {
        lines.push([m, s.toFixed(1),
          D.interpCurve(state.curves[m].pitch, s, state.interp).toFixed(2),
          D.interpCurve(state.curves[m].level, s, state.interp).toFixed(2),
          D.interpCurve(state.curves[m].timbre, s, state.interp).toFixed(3)].join(','));
      }
    });
    downloadBlob(new Blob([lines.join('\n')], { type: 'text/csv' }), 'avas-curves.csv');
  }

  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name; a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  /* ================= 控件绑定 ================= */

  function syncControls() {
    $('speedSlider').value = state.speed;
    $('interpSel').value = state.interp;
    $('harmCount').value = state.harmonicCount;
    $('templateSel').value = state.template;
    $('vibDepth').value = state.vibratoDepth;
    $('vibRate').value = state.vibratoRate;
    $('startRamp').value = state.startRampMs;
    $('calib').value = state.calibrationDb;
    $('refDist').value = state.refDistance;
    $('scanStep').value = state.scan.step;
    $('driveSpeed').value = state.drive.speedKmh;
    $('driveLateral').value = state.drive.lateral;
    $('driveStart').value = state.drive.startDist;
    updateReadouts();
  }

  function bind() {
    $('speedSlider').addEventListener('input', function (e) {
      state.speed = +e.target.value; updateReadouts(); redrawEditors();
    });
    $('modeFwd').addEventListener('click', function () { setMode('forward'); });
    $('modeRev').addEventListener('click', function () { setMode('reverse'); });

    $('playBtn').addEventListener('click', function () {
      if (live.playing) { live.stop(); this.textContent = '▶ 试听'; }
      else { live.start(); this.textContent = '⏸ 停止'; }
    });

    $('interpSel').addEventListener('change', function (e) {
      state.interp = e.target.value; saveState(); redrawEditors(); scheduleScan();
    });
    $('harmCount').addEventListener('change', function (e) {
      state.harmonicCount = +e.target.value; saveState();
      if (live.ctx) live.lastModeSig = null; // 强制下一 tick 重建声部
      scheduleScan();
    });
    $('templateSel').addEventListener('change', function (e) {
      state.template = e.target.value; saveState(); scheduleScan();
    });
    $('vibDepth').addEventListener('input', function (e) {
      state.vibratoDepth = +e.target.value; $('vibDepthVal').textContent = (+e.target.value).toFixed(3);
    });
    $('vibRate').addEventListener('input', function (e) {
      state.vibratoRate = +e.target.value; $('vibRateVal').textContent = (+e.target.value).toFixed(1) + ' Hz';
    });
    $('startRamp').addEventListener('input', function (e) {
      state.startRampMs = +e.target.value; $('startRampVal').textContent = e.target.value + ' ms'; saveState();
    });
    $('calib').addEventListener('input', function (e) {
      state.calibrationDb = +e.target.value; $('calibVal').textContent = e.target.value + ' dB'; saveState();
    });
    $('refDist').addEventListener('input', function (e) {
      state.refDistance = +e.target.value; $('refDistVal').textContent = e.target.value + ' m'; saveState();
    });
    $('scanStep').addEventListener('change', function (e) {
      state.scan.step = +e.target.value; saveState(); scheduleScan();
    });
    $('scanNow').addEventListener('click', runScanUI);

    // 预设
    $('presetBtns').addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-preset]');
      if (!btn) return;
      applyPreset(btn.dataset.preset);
    });

    // 驶过
    $('drivePlay').addEventListener('click', function () {
      if (drive.playing) { drive.pause(); state.drive.playing = false; this.textContent = '▶ 播放驶过'; }
      else {
        state.drive.playing = true;
        drive.play();
        this.textContent = '⏸ 暂停';
      }
    });
    $('driveStop').addEventListener('click', function () {
      drive.stop(false); state.drive.playing = false;
      $('drivePlay').textContent = '▶ 播放驶过';
    });
    $('driveSpeed').addEventListener('input', function (e) {
      state.drive.speedKmh = +e.target.value; $('driveSpeedVal').textContent = e.target.value + ' km/h';
      updateDriveDuration();
    });
    $('driveLateral').addEventListener('input', function (e) {
      state.drive.lateral = +e.target.value; $('driveLateralVal').textContent = e.target.value + ' m';
    });
    $('driveStart').addEventListener('input', function (e) {
      state.drive.startDist = +e.target.value; $('driveStartVal').textContent = e.target.value + ' m';
      updateDriveDuration();
    });

    // 导入导出
    $('exportJson').addEventListener('click', exportJSON);
    $('exportCsv').addEventListener('click', exportCSV);
    $('importJson').addEventListener('change', function (e) {
      if (e.target.files[0]) importJSON(e.target.files[0]);
      e.target.value = '';
    });
    $('resetThresh').addEventListener('click', function () {
      state.thresholds = D.makeBands().reduce(function (m, b) {
        if (b.thresh !== null) m[b.fc] = b.thresh;
        return m;
      }, {});
      saveState(); renderBandTable(state.speed); scheduleScan();
    });
  }

  function updateDriveDuration() {
    var dur = 2 * state.drive.startDist / D.kmhToMs(state.drive.speedKmh);
    $('driveDur').textContent = dur.toFixed(1) + ' s';
  }

  function setMode(m) {
    state.mode = m;
    $('modeFwd').classList.toggle('active', m === 'forward');
    $('modeRev').classList.toggle('active', m === 'reverse');
    // 下一 tick 检测到签名变化后自动交叉淡变重建声部
    redrawEditors(); updateReadouts(); scheduleScan();
  }

  /* ================= 预设 ================= */

  function applyPreset(name) {
    var c = state.curves;
    if (name === 'ev-warm') {
      state.template = 'smooth'; state.harmonicCount = 8;
      c.forward.pitch = [{ x: 0, y: 150 }, { x: 10, y: 210 }, { x: 20, y: 285 }, { x: 30, y: 360 }];
      c.forward.timbre = [{ x: 0, y: 0.3 }, { x: 10, y: 0.45 }, { x: 20, y: 0.6 }, { x: 30, y: 0.72 }];
    } else if (name === 'engine-like') {
      state.template = 'hard'; state.harmonicCount = 12;
      c.forward.pitch = [{ x: 0, y: 90 }, { x: 10, y: 140 }, { x: 20, y: 200 }, { x: 30, y: 280 }];
      c.forward.timbre = [{ x: 0, y: 0.55 }, { x: 10, y: 0.65 }, { x: 20, y: 0.75 }, { x: 30, y: 0.85 }];
    } else if (name === 'chime') {
      state.template = 'pure'; state.harmonicCount = 6;
      c.forward.pitch = [{ x: 0, y: 320 }, { x: 10, y: 380 }, { x: 20, y: 460 }, { x: 30, y: 560 }];
      c.forward.timbre = [{ x: 0, y: 0.2 }, { x: 10, y: 0.28 }, { x: 20, y: 0.36 }, { x: 30, y: 0.45 }];
    }
    syncControls(); saveState(); redrawEditors(); scheduleScan();
  }

  /* ================= 启动 ================= */

  function init() {
    loadState();
    editors.pitch = new CurveEditor($('curvePitch'), 'pitch', {
      yMin: 50, yMax: 800, unit: 'Hz', color: '#5eb0ff',
      formatter: function (v) { return v.toFixed(0); }, yDigits: 1
    });
    editors.level = new CurveEditor($('curveLevel'), 'level', {
      yMin: 40, yMax: 85, unit: 'dB', color: '#46c46e',
      formatter: function (v) { return v.toFixed(0); }, yDigits: 1
    });
    editors.timbre = new CurveEditor($('curveTimbre'), 'timbre', {
      yMin: 0, yMax: 1, unit: '', color: '#f5a524',
      formatter: function (v) { return v.toFixed(2); }, yDigits: 3
    });
    editors.limits = new CurveEditor($('limitCanvas'), 'limits', {
      yMin: 40, yMax: 85, unit: 'dB', color: '#c084fc',
      formatter: function (v) { return v.toFixed(0); }, yDigits: 1,
      getPoints: function () { return state.overallLimits; }
    });
    bind();
    syncControls();
    redrawEditors();
    renderBandTable(null);
    renderScanSummary();
    updateDriveDuration();
    meterLoop();
    window.addEventListener('resize', redrawEditors);
    scheduleScan();
  }

  document.addEventListener('DOMContentLoaded', init);
})();

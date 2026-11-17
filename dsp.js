/*
 * AVAS 工具 — 纯 DSP / 数学层（无浏览器依赖，可在 Node 中测试）
 * 全局命名空间 window.AVAS
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AVAS = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var C_SOUND = 343.0; // 声速 m/s

  /* ---------------- 基础工具 ---------------- */

  function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
  function lerp(a, b, t) { return a + (b - a) * t; }
  function dbToPow(db) { return Math.pow(10, db / 10); }
  function powToDb(p) { return 10 * Math.log10(p); }
  function dbToAmp(db) { return Math.pow(10, db / 20); }
  function ampToDb(a) { return 20 * Math.log10(a); }
  function rmsToDb(rms) { return 20 * Math.log10(rms); }
  function kmhToMs(v) { return v / 3.6; }

  /** 对数能量叠加：输入 dB 数组，返回总和 dB */
  function sumDb(dbArray) {
    var p = 0;
    for (var i = 0; i < dbArray.length; i++) {
      if (dbArray[i] > -1e9) p += dbToPow(dbArray[i]);
    }
    return p > 0 ? powToDb(p) : -Infinity;
  }

  /**
   * 曲线插值。points: [{x,y}...] 按 x 升序；区间外钳位到端点。
   * method: 'linear' | 'smooth'（Fritsch–Carlson 单调三次，保证不产生过冲）
   */
  function interpCurve(points, x, method) {
    if (!points.length) return 0;
    if (x <= points[0].x) return points[0].y;
    var last = points[points.length - 1];
    if (x >= last.x) return last.y;
    var i = 0;
    while (i < points.length - 1 && points[i + 1].x < x) i++;
    var p0 = points[i], p1 = points[i + 1];
    var t = (x - p0.x) / (p1.x - p0.x);
    if (method !== 'smooth' || points.length < 2) return lerp(p0.y, p1.y, t);

    // 单调三次 Hermite（Fritsch–Carlson）
    var dk = (p1.y - p0.y) / (p1.x - p0.x);
    var mk, mk1;
    var prev = points[i - 1], next = points[i + 2];
    mk = prev ? (p1.y - prev.y) / (p1.x - prev.x) : dk;
    mk1 = next ? (next.y - p0.y) / (next.x - p0.x) : dk;
    if (dk === 0) { mk = 0; mk1 = 0; }
    else {
      if (mk * dk <= 0) mk = 0;
      if (mk1 * dk <= 0) mk1 = 0;
    }
    var h = p1.x - p0.x;
    var h00 = 2 * t * t * t - 3 * t * t + 1;
    var h10 = t * t * t - 2 * t * t + t;
    var h01 = -2 * t * t * t + 3 * t * t;
    var h11 = t * t * t - t * t;
    return h00 * p0.y + h10 * h * mk + h01 * p1.y + h11 * h * mk1;
  }

  /* ---------------- A 计权 ---------------- */

  function aWeightDb(f) {
    var f2 = f * f;
    var num = 12194.217 * 12194.217 * f2 * f2;
    var den = (f2 + 20.598997 * 20.598997) *
      Math.sqrt(f2 + 107.65265 * 107.65265) *
      Math.sqrt(f2 + 737.86223 * 737.86223) *
      (f2 + 12194.217 * 12194.217);
    return 2.0 + 20 * Math.log10(num / den);
  }

  /* ---------------- 1/3 倍频程频段（基准 1 kHz，GB/T 3240 / IEC 61260） ---------------- */

  var BAND_FC = [50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630,
    800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000];

  // UN R138 / GB 标准参考的频段声压级下限（线性、不计权）。
  // 注意：数值为参考默认值，正式认证请以现行法规版本为准 —— 表格在界面中可直接编辑。
  // null = 该频段法规未规定下限。
  var DEFAULT_THRESH = {
    50: 52, 63: 51, 80: 50, 100: 49, 125: 47, 160: 46, 200: 45, 250: 44,
    315: 43, 400: 42, 500: 41, 630: 40, 800: 39, 1000: 38, 1250: 37,
    1600: 36, 2000: 35, 2500: 34, 3150: 33, 4000: 32, 5000: 31,
    6300: 30, 8000: 29, 10000: 28
  };

  function makeBands() {
    var q = Math.pow(2, 1 / 6); // 1/3 倍频程：fc/2^(1/6) ~ fc*2^(1/6)
    return BAND_FC.map(function (fc) {
      return {
        fc: fc,
        lower: fc / q,
        upper: fc * q,
        thresh: DEFAULT_THRESH.hasOwnProperty(fc) ? DEFAULT_THRESH[fc] : null
      };
    });
  }

  /* ---------------- FFT（基 2 迭代） ---------------- */

  function FFT(n) {
    if ((n & (n - 1)) !== 0 || n < 2) throw new Error('FFT size must be power of 2');
    this.n = n;
    this.rev = new Uint32Array(n);
    var logN = Math.round(Math.log2(n));
    for (var i = 0; i < n; i++) {
      var x = i, r = 0;
      for (var b = 0; b < logN; b++) { r = (r << 1) | (x & 1); x >>= 1; }
      this.rev[i] = r;
    }
    this.cosT = new Float64Array(n / 2);
    this.sinT = new Float64Array(n / 2);
    for (var k = 0; k < n / 2; k++) {
      this.cosT[k] = Math.cos(-2 * Math.PI * k / n);
      this.sinT[k] = Math.sin(-2 * Math.PI * k / n);
    }
  }

  FFT.prototype.run = function (re, im) {
    var n = this.n;
    for (var i = 0; i < n; i++) {
      var j = this.rev[i];
      if (j > i) {
        var tr = re[i]; re[i] = re[j]; re[j] = tr;
        var ti = im[i]; im[i] = im[j]; im[j] = ti;
      }
    }
    for (var len = 2; len <= n; len <<= 1) {
      var half = len >> 1, step = n / len;
      for (var start = 0; start < n; start += len) {
        for (var k2 = 0; k2 < half; k2++) {
          var idx = k2 * step;
          var wr = this.cosT[idx], wi = this.sinT[idx];
          var a = start + k2, b = a + half;
          var vr = re[b] * wr - im[b] * wi;
          var vi = re[b] * wi + im[b] * wr;
          re[b] = re[a] - vr; im[b] = im[a] - vi;
          re[a] += vr; im[a] += vi;
        }
      }
    }
  };

  function hannWindow(n) {
    var w = new Float64Array(n);
    for (var i = 0; i < n; i++) w[i] = 0.5 * (1 - Math.cos(2 * Math.PI * i / (n - 1)));
    return w;
  }

  /**
   * 分析一段实信号 -> 各 1/3 倍频程声压级（dBFS）+ 总级（线性 / A 计权）
   * 返回 { bands:[{fc, dbfs}], overallLin, overallA, rms }
   * 频段功率按 FFT 能量占比分配，保证各频段之和等于时域真实 RMS（与窗归一化约定无关）。
   */
  function analyzeSignal(samples, fs, fftSize, bands) {
    var n = Math.min(fftSize, samples.length);
    var re = new Float64Array(fftSize), im = new Float64Array(fftSize);
    var win = hannWindow(n), off = samples.length - n;
    var rms = 0;
    for (var i = 0; i < n; i++) {
      var s = samples[off + i];
      rms += s * s;
      re[i] = s * win[i];
    }
    rms = Math.sqrt(rms / n);
    new FFT(fftSize).run(re, im);

    var nBins = fftSize / 2;
    var binW = fs / fftSize;
    var binPow = new Float64Array(nBins + 1);
    for (var k = 0; k <= nBins; k++) binPow[k] = re[k] * re[k] + im[k] * im[k];
    var totalP = binPow[0] + binPow[nBins];
    for (var k2 = 1; k2 < nBins; k2++) totalP += 2 * binPow[k2];

    // 按 1/3 倍频程边界对 FFT bin 能量做分数分配（边界 bin 按带宽比例切分）
    var bandFrac = new Float64Array(bands.length);
    for (var b = 0; b <= nBins; b++) {
      var fLo = b * binW, fHi = fLo + binW;
      var weight = (b === 0 || b === nBins) ? 1 : 2;
      var p = weight * binPow[b];
      if (p === 0) continue;
      for (var bi = 0; bi < bands.length; bi++) {
        var lo = Math.max(fLo, bands[bi].lower);
        var hi = Math.min(fHi, bands[bi].upper);
        if (hi > lo) bandFrac[bi] += p * (hi - lo) / binW;
      }
    }
    var bandDb = bands.map(function (band, idx) {
      var frac = totalP > 0 ? bandFrac[idx] / totalP : 0;
      var bandRms = rms * Math.sqrt(frac);
      // 静默频段钳到分析底噪 -90 dBFS，避免出现无工程意义的极端差值
      return { fc: band.fc, dbfs: bandRms > 0 ? Math.max(-90, 20 * Math.log10(bandRms)) : -90 };
    });

    var linPowers = bandDb.map(function (d) { return dbToPow(d.dbfs); });
    var aPowers = bandDb.map(function (d) { return dbToPow(d.dbfs + aWeightDb(d.fc)); });
    var sumP = function (a) { var s = 0; for (var i = 0; i < a.length; i++) s += a[i]; return s; };

    // 频段外能量（< 最低频段下限 或 > 最高频段上限）
    var coveredP = 0;
    for (var ci = 0; ci < bandFrac.length; ci++) coveredP += bandFrac[ci];
    var oobFrac = totalP > 0 ? Math.max(0, totalP - coveredP) / totalP : 0;
    var oobRms = rms * Math.sqrt(oobFrac);

    return {
      bands: bandDb,
      rms: rms,
      overallLin: 20 * Math.log10(rms || 1e-10),
      overallA: 10 * Math.log10(sumP(aPowers) || 1e-20),
      overallLinFromBands: 10 * Math.log10(sumP(linPowers) || 1e-20),
      outOfBandDb: oobRms > 0 ? 20 * Math.log10(oobRms) : -200
    };
  }

  /* ---------------- 谐波谱模板 ---------------- */

  /**
   * 生成归一化谐波权重（平方和 = 1，因此母线增益即合成信号 RMS）。
   * template: pure | smooth | full | hard；brightness: 0..1
   */
  function harmonicProfile(template, count, brightness) {
    var b = clamp(brightness, 0, 1);
    var raw = new Float64Array(count);
    for (var h = 1; h <= count; h++) {
      var w = 0;
      if (template === 'pure') {
        w = h === 1 ? 1 : 0.0008;
      } else if (template === 'smooth') {
        w = Math.exp(-(h - 1) * (2.4 * (1 - b) + 0.35));
      } else if (template === 'full') {
        w = Math.pow(1 / h, 0.6 + 1.5 * (1 - b));
      } else if (template === 'hard') {
        var odd = (h % 2 === 1) ? 1 : 0.65;
        w = odd * Math.pow(1 / h, 0.3 + 1.4 * (1 - b));
      }
      raw[h - 1] = w;
    }
    var norm = 0;
    for (var i = 0; i < count; i++) norm += raw[i] * raw[i];
    norm = Math.sqrt(norm);
    for (var j = 0; j < count; j++) raw[j] /= norm;
    return raw;
  }

  /* ---------------- 驶过（drive-by）几何与多普勒 ---------------- */

  /**
   * 车辆沿 y = lateral 的直线以匀速 v 行驶，t = closestAt 时距观察者最近。
   * 约定 x<0 为驶近段、x>0 为驶离段。
   * 返回瞬时距离、距离变化率、多普勒频率比（精确式，基于瞬时发射时刻）。
   */
  function driveState(t, opts) {
    var v = opts.speedMs, d = opts.lateral, t0 = opts.closestAt;
    var x = -v * (t - t0);
    var R = Math.sqrt(x * x + d * d);
    var dRdt = -v * x / R;
    var ratio = 1 / (1 + dRdt / C_SOUND); // f_obs / f_src
    return { x: x, R: R, dRdt: dRdt, ratio: ratio };
  }

  /**
   * 由观察者时刻 tObs 反解发射时刻 τ： tObs = τ + R(τ)/c （牛顿迭代）
   */
  function emissionTime(tObs, opts) {
    var v = opts.speedMs, d = opts.lateral, t0 = opts.closestAt;
    var tau = tObs;
    for (var i = 0; i < 8; i++) {
      var x = -v * (tau - t0);
      var R = Math.sqrt(x * x + d * d);
      var f = tau + R / C_SOUND - tObs;
      var df = 1 + (-v * x / R) / C_SOUND;
      tau -= f / df;
    }
    return tau;
  }

  /** 距离衰减：相对参考距离 refDist 处的声压级差（球面扩散，dB） */
  function distanceGainDb(R, refDist) {
    return -20 * Math.log10(R / refDist);
  }

  /* ---------------- 默认曲线 ---------------- */

  function defaultCurves() {
    return {
      forward: {
        pitch: [{ x: 0, y: 160 }, { x: 10, y: 220 }, { x: 20, y: 300 }, { x: 30, y: 400 }],
        level: [{ x: 0, y: 60 }, { x: 10, y: 66 }, { x: 20, y: 69 }, { x: 30, y: 71 }],
        timbre: [{ x: 0, y: 0.35 }, { x: 10, y: 0.5 }, { x: 20, y: 0.65 }, { x: 30, y: 0.8 }]
      },
      reverse: {
        pitch: [{ x: 0, y: 260 }, { x: 10, y: 260 }, { x: 20, y: 260 }, { x: 30, y: 260 }],
        level: [{ x: 0, y: 62 }, { x: 10, y: 65 }, { x: 20, y: 66 }, { x: 30, y: 66 }],
        timbre: [{ x: 0, y: 0.25 }, { x: 10, y: 0.25 }, { x: 20, y: 0.3 }, { x: 30, y: 0.3 }]
      }
    };
  }

  // 整体声压级上限参考（可在界面编辑）
  function defaultOverallLimits() {
    return [{ x: 0, y: 62 }, { x: 10, y: 70 }, { x: 20, y: 70 }, { x: 30, y: 72 }];
  }

  return {
    C_SOUND: C_SOUND,
    BAND_FC: BAND_FC,
    makeBands: makeBands,
    clamp: clamp, lerp: lerp,
    dbToPow: dbToPow, powToDb: powToDb, dbToAmp: dbToAmp, ampToDb: ampToDb,
    rmsToDb: rmsToDb, sumDb: sumDb, kmhToMs: kmhToMs,
    interpCurve: interpCurve,
    aWeightDb: aWeightDb,
    FFT: FFT, hannWindow: hannWindow, analyzeSignal: analyzeSignal,
    harmonicProfile: harmonicProfile,
    driveState: driveState, emissionTime: emissionTime, distanceGainDb: distanceGainDb,
    defaultCurves: defaultCurves, defaultOverallLimits: defaultOverallLimits
  };
});

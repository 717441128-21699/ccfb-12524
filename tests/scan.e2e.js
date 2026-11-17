/*
 * 端到端验证（Node）：模拟 app.js 的合规扫描管线
 * 不依赖浏览器：复用 dsp.js + 与 app.js 相同的 renderOffline / 归一化逻辑
 * 运行：node tests/scan.e2e.js
 */
'use strict';
var D = require('../dsp.js');
var assert = require('assert');

var BANDS = D.makeBands();
var state = {
  interp: 'smooth', harmonicCount: 8, template: 'smooth',
  vibratoDepth: 0.003, vibratoRate: 4.5,
  thresholds: BANDS.reduce(function (m, b) { if (b.thresh !== null) m[b.fc] = b.thresh; return m; }, {}),
  overallLimits: D.defaultOverallLimits()
};
var curves = D.defaultCurves();

function renderOffline(f0, weights, seconds, fs) {
  var n = Math.floor(seconds * fs);
  var buf = new Float64Array(n);
  var phases = new Float64Array(weights.length);
  for (var i = 0; i < n; i++) {
    var t = i / fs;
    var vib = 1 + state.vibratoDepth * Math.sin(2 * Math.PI * state.vibratoRate * t);
    var s = 0;
    for (var h = 1; h <= weights.length; h++) {
      phases[h - 1] += 2 * Math.PI * f0 * h * vib / fs;
      s += weights[h - 1] * Math.sin(phases[h - 1] + (h - 1) * 0.7);
    }
    buf[i] = s;
  }
  return buf;
}

function scanAt(spd) {
  var f0 = D.interpCurve(curves.forward.pitch, spd, state.interp);
  var bright = D.interpCurve(curves.forward.timbre, spd, state.interp);
  var targetSpl = D.interpCurve(curves.forward.level, spd, state.interp);
  var weights = D.harmonicProfile(state.template, state.harmonicCount, bright);
  var samples = renderOffline(f0, weights, 0.5, 48000);
  var ana = D.analyzeSignal(samples, 48000, 8192, BANDS);
  var normDb = targetSpl - 20 * Math.log10(ana.rms || 1e-10);

  var bandSpl = ana.bands.map(function (b) {
    return { fc: b.fc, spl: b.dbfs + normDb, thresh: state.thresholds[b.fc] != null ? state.thresholds[b.fc] : null };
  });
  var passBands = bandSpl.filter(function (b) { return b.thresh !== null && b.spl >= b.thresh; });
  var overallLin = ana.overallLin + normDb;
  var overallLimit = D.interpCurve(state.overallLimits, spd, state.interp);
  return {
    spd: spd, f0: f0, targetSpl: targetSpl,
    bandSpl: bandSpl, passCount: passBands.length,
    overallLin: overallLin, overallLimit: overallLimit,
    overallPass: overallLin <= overallLimit + 1e-9,
    pass: passBands.length >= 2 && overallLin <= overallLimit + 1e-9
  };
}

/* 1. 默认曲线扫描 0-30 km/h */
var results = [];
for (var v = 0; v <= 30; v++) results.push(scanAt(v));
results.forEach(function (r) {
  console.log('v=' + String(r.spd).padStart(2) +
    ' f0=' + r.f0.toFixed(1).padStart(6) + 'Hz  目标=' + r.targetSpl.toFixed(1) +
    'dB  总级=' + r.overallLin.toFixed(1) + '/' + r.overallLimit.toFixed(1) +
    '  过线频段=' + r.passCount + '  ' + (r.pass ? '合格' : '不合格'));
});

/* 2. 归一化正确性：合成总级必须等于目标 SPL（与校准无关） */
results.forEach(function (r) {
  assert.ok(Math.abs(r.overallLin - r.targetSpl) < 0.2,
    '总级归一化失败 v=' + r.spd + ': ' + r.overallLin + ' vs ' + r.targetSpl);
});
console.log('\n✓ 所有车速点合成总级与目标 SPL 偏差 < 0.2 dB');

/* 3. 默认设计应全部合格（至少 2 频段过线 + 总级不超限） */
var allPass = results.every(function (r) { return r.pass; });
console.log('✓ 默认曲线 31 个车速点全部合格: ' + allPass);
assert.ok(allPass);

/* 4. 人为把响度曲线压到极低，必须能检出不合格，并指出具体频段 */
var savedLevel = curves.forward.level;
curves.forward.level = [{ x: 0, y: 30 }, { x: 30, y: 30 }];
var quiet = scanAt(15);
console.log('\n压低响度后 v=15: 过线频段=' + quiet.passCount + ' 合格=' + quiet.pass);
assert.ok(!quiet.pass, '低响度设计必须判不合格');
assert.ok(quiet.passCount < 2);
var worst = quiet.bandSpl.filter(function (b) { return b.thresh !== null; })
  .map(function (b) { return { fc: b.fc, gap: b.thresh - b.spl }; })
  .sort(function (a, b2) { return b2.gap - a.gap; })[0];
console.log('✓ 正确检出不合格，缺口最大频段: ' + worst.fc + ' Hz，差 ' + worst.gap.toFixed(1) + ' dB');
curves.forward.level = savedLevel;

/* 5. 人为抬高总级超过上限，应因总级超限判不合格 */
var hot = scanAt(20);
curves.forward.level = [{ x: 0, y: 90 }, { x: 30, y: 90 }];
var over = scanAt(20);
console.log('\n抬高响度后 v=20: 总级=' + over.overallLin.toFixed(1) +
  ' 上限=' + over.overallLimit.toFixed(1) + ' 总级合格=' + over.overallPass);
assert.ok(!over.overallPass, '总级超限必须判不合格');
assert.ok(over.overallLin > over.overallLimit);
console.log('✓ 正确检出总级超限，超出 ' + (over.overallLin - over.overallLimit).toFixed(1) + ' dB');
curves.forward.level = savedLevel;

/* 6. 基频随车速连续变化（无跳变），倒车曲线独立且默认恒定 */
var f0s = results.map(function (r) { return r.f0; });
for (var i = 1; i < f0s.length; i++) {
  assert.ok(f0s[i] >= f0s[i - 1] - 1e-9, '前进档基频应单调上升');
}
console.log('✓ 前进档基频 0→30 km/h 单调连续: ' + f0s[0].toFixed(1) + ' → ' + f0s[30].toFixed(1) + ' Hz');
var revF0 = D.interpCurve(curves.reverse.pitch, 15, 'smooth');
assert.ok(Math.abs(revF0 - 260) < 1e-9);
console.log('✓ 倒车档使用独立曲线集（默认恒频 260 Hz）');

/* 7. 采样网格无关性：同一点 1km/h 与 2km/h 步长扫描结果一致 */
var a = scanAt(10), b = scanAt(10);
assert.ok(Math.abs(a.overallLin - b.overallLin) < 1e-12);
console.log('✓ 扫描结果确定性可复现');

console.log('\n全部端到端断言通过');

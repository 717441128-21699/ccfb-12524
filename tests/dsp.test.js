/* Node 测试：node tests/dsp.test.js（从仓库根运行） */
'use strict';
var D = require('../dsp.js');
var assert = require('assert');
var pass = 0;
function ok(name, cond, extra) {
  assert.ok(cond, name + (extra !== undefined ? ' -> ' + extra : ''));
  pass++;
  console.log('  ✓ ' + name);
}
function approx(a, b, tol) { return Math.abs(a - b) <= tol; }

/* 1. A 计权参考值：1 kHz = 0 dB，2 kHz ≈ +1.2 dB，100 Hz ≈ -19.1 dB */
ok('A-weight 1kHz ≈ 0', approx(D.aWeightDb(1000), 0, 0.05), D.aWeightDb(1000));
ok('A-weight 2kHz ≈ +1.2', approx(D.aWeightDb(2000), 1.2, 0.1), D.aWeightDb(2000));
ok('A-weight 100Hz ≈ -19.1', approx(D.aWeightDb(100), -19.1, 0.15), D.aWeightDb(100));

/* 2. 1/3 倍频程边界：100 Hz 带 89.1~112.2 */
var bands = D.makeBands();
var b100 = bands.filter(function (b) { return b.fc === 100; })[0];
ok('100Hz 带下边界', approx(b100.lower, 89.09, 0.05), b100.lower);
ok('100Hz 带上边界', approx(b100.upper, 112.25, 0.05), b100.upper);
ok('24 个频段', bands.length === 24, bands.length);

/* 3. FFT：单频正弦，能量应落在单根 bin 附近 */
(function () {
  var N = 8192, fs = 48000, f = 1000;
  var s = new Float64Array(N);
  for (var i = 0; i < N; i++) s[i] = Math.sin(2 * Math.PI * f * i / fs);
  var ana = D.analyzeSignal(s, fs, N, bands);
  ok('RMS 正弦 ≈ 0.7071', approx(ana.rms, Math.SQRT1_2, 0.01), ana.rms);
  var hit = ana.bands.filter(function (x) { return x.fc === 1000; })[0];
  ok('1 kHz 能量在 1 kHz 频段', hit.dbfs > -4, hit.dbfs);
  var quiet = ana.bands.filter(function (x) { return x.fc === 50; })[0];
  ok('50 Hz 频段应极低', quiet.dbfs < -40, quiet.dbfs);
  ok('总级 ≈ -3.01 dBFS', approx(ana.overallLin, -3.01, 0.2), ana.overallLin);
})();

/* 4. 多谐波信号：频段能量分配后总和守恒 */
(function () {
  var N = 8192, fs = 48000;
  var s = new Float64Array(N);
  for (var i = 0; i < N; i++) {
    s[i] = 0.8 * Math.sin(2 * Math.PI * 300 * i / fs) + 0.4 * Math.sin(2 * Math.PI * 900 * i / fs);
  }
  var ana = D.analyzeSignal(s, fs, N, bands);
  var expectedRms = Math.sqrt((0.8 * 0.8 + 0.4 * 0.4) / 2);
  ok('多谐波 RMS 正确', approx(ana.rms, expectedRms, 0.01), ana.rms + ' vs ' + expectedRms);
  // 频段能量 + 频段外残量 之和应守恒于时域总级（Hann 窗泄漏造成的边界 bin 误差 <0.15 dB）
  var conserved = D.sumDb([ana.overallLinFromBands, ana.outOfBandDb]);
  ok('频段+频段外求和守恒于总级', approx(conserved, ana.overallLin, 0.15),
    conserved + ' vs ' + ana.overallLin);
  // 300/900 Hz 全部落在 50Hz~10kHz 覆盖范围内，频段外残量应极低
  ok('带内信号频段外残量极低', ana.outOfBandDb < -60, ana.outOfBandDb);
  var b315 = ana.bands.filter(function (x) { return x.fc === 315; })[0];
  var b900ish = ana.bands.filter(function (x) { return x.fc === 1000; })[0];
  ok('300 Hz 落在 315 频段且为主能量', b315.dbfs > -8, b315.dbfs);
  ok('900 Hz 落在 1000 频段', b900ish.dbfs > -12, b900ish.dbfs);
})();

/* 5. 谐波权重归一化（平方和 = 1） */
['pure', 'smooth', 'full', 'hard'].forEach(function (t) {
  var w = D.harmonicProfile(t, 10, 0.6);
  var sum = 0;
  for (var i = 0; i < w.length; i++) sum += w[i] * w[i];
  ok('模板 ' + t + ' 权重平方和=1', approx(sum, 1, 1e-9), sum);
  ok('模板 ' + t + ' 长度正确', w.length === 10);
});
(function () {
  var dark = D.harmonicProfile('full', 8, 0.1);
  var bright = D.harmonicProfile('full', 8, 0.9);
  ok('亮度越高高频权重越大', bright[5] > dark[5], bright[5] + ' vs ' + dark[5]);
})();

/* 6. 曲线插值：钳位 + 单调三次不过冲 */
(function () {
  var pts = [{ x: 0, y: 100 }, { x: 10, y: 200 }, { x: 20, y: 150 }, { x: 30, y: 300 }];
  ok('左钳位', D.interpCurve(pts, -5, 'smooth') === 100);
  ok('右钳位', D.interpCurve(pts, 40, 'smooth') === 300);
  ok('线性过点', D.interpCurve(pts, 10, 'linear') === 200);
  var overshoot = false;
  for (var x = 0; x <= 30; x += 0.1) {
    var y = D.interpCurve(pts, x, 'smooth');
    if (y > 300.001 || y < 99.999) overshoot = true;
  }
  ok('单调三次无过冲', !overshoot);
})();

/* 7. 多普勒几何：驶近升频、最近点比值=1、驶离降频，且关于最近点对称 */
(function () {
  var opts = { speedMs: D.kmhToMs(20), lateral: 7.5, closestAt: 7.2 };
  var before = D.driveState(3.0, opts);
  var at = D.driveState(7.2, opts);
  var after = D.driveState(11.4, opts);
  ok('驶近 ratio > 1', before.ratio > 1, before.ratio);
  ok('最近点 ratio ≈ 1', approx(at.ratio, 1, 1e-9), at.ratio);
  ok('驶离 ratio < 1', after.ratio < 1, after.ratio);
  // 对称的是几何量（距离与 |Ṙ|）；多普勒比因 1/(1±Ṙ/c) 结构本身不严格互倒
  ok('对称点距离相等', approx(before.R, after.R, 1e-9));
  ok('对称点径向速率大小相等符号相反', approx(before.dRdt, -after.dRdt, 1e-9));
  ok('驶近比与一阶式一致', approx(before.ratio, 1 / (1 + before.dRdt / D.C_SOUND), 1e-12));
  ok('驶离比与一阶式一致', approx(after.ratio, 1 / (1 + after.dRdt / D.C_SOUND), 1e-12));
})();

/* 8. 发射时刻反解：tObs = tau + R(tau)/c 自洽 */
(function () {
  var opts = { speedMs: D.kmhToMs(30), lateral: 7.5, closestAt: 4.8 };
  var tObs = 2.0;
  var tau = D.emissionTime(tObs, opts);
  var st = D.driveState(tau, opts);
  ok('发射时刻反解自洽', approx(tau + st.R / D.C_SOUND, tObs, 1e-9),
    tau + st.R / D.C_SOUND);
  ok('发射早于接收', tau < tObs);
})();

/* 9. 距离衰减：距离加倍 -6.02 dB */
ok('距离加倍衰减 6dB', approx(D.distanceGainDb(20, 10), -6.02, 0.01), D.distanceGainDb(20, 10));
ok('参考距离 0dB', D.distanceGainDb(5, 5) === 0);

/* 10. dB 叠加：两个相同级 +3.01 dB */
ok('等强叠加 +3.01dB', approx(D.sumDb([60, 60]), 63.01, 0.01), D.sumDb([60, 60]));

console.log('\n全部 ' + pass + ' 项通过');

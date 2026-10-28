import test from 'node:test';
import assert from 'node:assert/strict';
import { planGoal } from '../client/plan.js';
import { createJournal } from '../server/journal.js';

const today = new Date(2026, 9, 3);
const sample = { sex: 'f', age: 28, height: 165, weight: 60, target: 55, activity: 1.2 };

test('planGoal：以目前每日目標推算每週減重與預計日', () => {
  const g = planGoal(sample, 1300, today);
  assert.deepEqual(g, { bmr: 1330, tdee: 1596, floor: 1330, weekly: 0.27, days: 130, date: '2027-02-10', total: 130 });
  assert.equal(planGoal(sample, 1100, today).days, Math.ceil(5 / 0.45 * 7));
  const m = planGoal({ sex: 'm', age: 30, height: 180, weight: 90, target: 80, activity: 1.55 }, 2364, today);
  assert.deepEqual(m, { bmr: 1880, tdee: 2914, floor: 1880, weekly: 0.5, days: 140, date: '2027-02-20', total: 140 });
  assert.equal(planGoal({ sex: 'f', age: 60, height: 150, weight: 40, target: 35, activity: 1.2 }, 1000, today).floor, 1200);
});
test('planGoal：目標不低於消耗不會減重；已達標為 0 天', () => {
  const none = planGoal(sample, 1600, today);
  assert.equal(none.weekly, 0); assert.equal(none.days, null); assert.equal(none.date, null); assert.equal(none.total, null);
  const done = planGoal({ ...sample, target: 60 }, 1300, today);
  assert.equal(done.days, 0); assert.equal(done.date, '2026-10-03');
});
test('planGoal：有 startDate 時從開始日倒數，過了預計日為 0', () => {
  const started = { ...sample, startDate: '2026-10-03' };
  const g = planGoal(started, 1300, new Date(2026, 9, 10));
  assert.equal(g.weekly, 0.27); assert.equal(g.total, 130); assert.equal(g.days, 123); assert.equal(g.date, '2027-02-10');
  const late = planGoal(started, 1300, new Date(2027, 6, 1));
  assert.equal(late.days, 0); assert.equal(late.total, 130); assert.equal(late.date, '2027-02-10');
  const none = planGoal(sample, 1300, new Date(2026, 9, 10));
  assert.equal(none.days, 130); assert.equal(none.total, 130); assert.equal(none.date, '2027-02-17');
});
test('偏好 plan：預設 null、驗證、保存與清除', () => {
  const db = createJournal(':memory:'); assert.equal(db.preferences().plan, null);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: { ...sample, rate: 0.5 } }); assert.deepEqual(db.preferences().plan, sample); // 舊版 rate 忽略不存
  for (const bad of [{ activity: 1.3 }, { age: 9 }, { age: 30.5 }, { sex: 'x' }, { weight: '60' }, { target: 20 }])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, ...bad } }), e => e.status === 400 || e.statusCode === 400 || /減重目標/.test(e.message));
  assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ goal: 1500 }); assert.deepEqual(db.preferences().plan, sample);
  db.updatePreferences({ plan: null }); assert.equal(db.preferences().plan, null); db.close();
});
test('偏好 plan：startDate 可選，需為有效且不在未來的日期', () => {
  const db = createJournal(':memory:'); const started = { ...sample, startDate: '2026-01-15' };
  db.updatePreferences({ plan: started }); assert.deepEqual(db.preferences().plan, started);
  for (const startDate of ['2999-01-01', '2026-02-30', '2026/01/15', 20260115])
    assert.throws(() => db.updatePreferences({ plan: { ...sample, startDate } }), e => e.status === 400);
  assert.deepEqual(db.preferences().plan, started);
  db.updatePreferences({ plan: sample }); assert.deepEqual(db.preferences().plan, sample); db.close();
});

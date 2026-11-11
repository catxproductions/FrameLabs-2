const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.resolve(__dirname, '../js/fire-effects.js'), 'utf8');

function loadEffects() {
  const window = {};
  vm.runInNewContext(source, { window }, { filename: 'fire-effects.js' });
  return window.FrameLabFireEffects;
}

test('fire visual sampling stays within budget and distributes samples across large fires', () => {
  const effects = loadEffects();
  const selected = effects.sampleIndices(10000, 160, 17);
  assert.equal(selected.length, 160);
  assert.equal(new Set(selected).size, 160);
  assert.ok(selected.every(index => Number.isInteger(index) && index >= 0 && index < 10000));

  const gaps = selected.map((value, index) => {
    const next = selected[(index + 1) % selected.length];
    return (next - value + 10000) % 10000;
  });
  assert.ok(Math.max(...gaps) - Math.min(...gaps) <= 1);
});

test('fire visual sampling handles empty, invalid, and smaller-than-budget lists', () => {
  const effects = loadEffects();
  assert.deepEqual(Array.from(effects.sampleIndices(0, 160)), []);
  assert.deepEqual(Array.from(effects.sampleIndices(3, 160)), [0, 1, 2]);
  assert.deepEqual(Array.from(effects.sampleIndices(8, 0)), []);
  assert.equal(effects.sampleIndices(20, 5).length, 5);
});

test('particle eviction is constant-time swap-and-pop and keeps the array bounded', () => {
  const effects = loadEffects();
  const particles = [{ id: 0 }, { id: 1 }, { id: 2 }, { id: 3 }];
  const nextCursor = effects.evictAtCursor(particles, 1);
  assert.equal(particles.length, 3);
  assert.deepEqual(particles.map(particle => particle.id).sort(), [0, 2, 3]);
  assert.equal(nextCursor, 1);

  const emptyCursor = effects.evictAtCursor([], 0);
  assert.equal(emptyCursor, 0);
});

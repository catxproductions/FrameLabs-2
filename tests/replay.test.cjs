const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function loadTools() {
 const sandbox = { window: {} };
 vm.runInNewContext(
  fs.readFileSync(path.join(__dirname, '../js/replay-tools.js'), 'utf8'),
  sandbox
 );
 return sandbox.window.FrameLabReplayTools;
}

test('graph clone preserves prototypes, cycles, shared references, and typed-array independence', () => {
 const tools = loadTools();
 class Node {
  constructor(value) {
   this.value = value;
   this.next = null;
  }
 }
 const first = new Node(3);
 const second = new Node(7);
 first.next = second;
 second.next = first;
 const root = {
  first,
  second,
  alias: first,
  values: new Float64Array([1.25, 2.5])
 };
 const copy = tools.cloneGraph(root);
 assert.notEqual(copy, root);
 assert.ok(copy.first instanceof Node);
 assert.equal(copy.first.next, copy.second);
 assert.equal(copy.second.next, copy.first);
 assert.equal(copy.alias, copy.first);
 assert.deepEqual(Array.from(copy.values), [1.25, 2.5]);
 copy.values[0] = 9;
 assert.equal(root.values[0], 1.25);
});

test('graph clone preserves shared ArrayBuffer backing stores and DataView offsets', () => {
 const tools = loadTools();
 const buffer = new ArrayBuffer(32);
 const values = new Float64Array(buffer, 8, 2);
 values.set([2.5, 7.5]);
 const bytes = new Uint8Array(buffer, 8, 16);
 const view = new DataView(buffer, 8, 16);
 const copy = tools.cloneGraph({ values, bytes, view });

 assert.notEqual(copy.values.buffer, buffer);
 assert.equal(copy.values.buffer, copy.bytes.buffer);
 assert.equal(copy.values.buffer, copy.view.buffer);
 assert.equal(copy.values.byteOffset, 8);
 assert.equal(copy.view.byteOffset, 8);
 assert.equal(copy.view.getFloat64(0, true), 2.5);
 copy.values[0] = 11;
 assert.equal(values[0], 2.5);
 assert.equal(copy.bytes[0], new Uint8Array(new Float64Array([11]).buffer)[0]);
});

test('memory estimator accounts for cycles and shared typed-array buffers once', () => {
 const tools = loadTools();
 const buffer = new ArrayBuffer(800);
 const root = {
  text: 'simulation',
  first: new Float64Array(buffer, 0, 50),
  second: new Uint8Array(buffer, 0, 400)
 };
 root.self = root;
 const bytes = tools.estimateBytes(root);
 assert.ok(bytes >= 800);
 assert.ok(bytes < 1300);
});

test('interpolation blends continuous values while holding discrete state until a checkpoint', () => {
 const tools = loadTools();
 const start = {
  sim: {
   time: 1,
   nodes: { a: { position: { x: 0, y: 4 }, isGroundConnected: true } },
   debris: [{ x: 10, angle: 0 }],
   localFailureCount: 0
  },
  member: { integrity: 1, failed: false, state: 'intact' }
 };
 const end = {
  sim: {
   time: 2,
   nodes: { a: { position: { x: 20, y: 8 }, isGroundConnected: false } },
   debris: [{ x: 30, angle: 1.2 }],
   localFailureCount: 1
  },
  member: { integrity: 0, failed: true, state: 'FAILED' }
 };
 const working = tools.cloneGraph(start);
 tools.interpolateInto(working, start, end, 0.5);
 assert.equal(working.sim.time, 1.5);
 assert.equal(working.sim.nodes.a.position.x, 10);
 assert.equal(working.sim.nodes.a.position.y, 6);
 assert.equal(working.sim.nodes.a.isGroundConnected, true);
 assert.equal(working.sim.debris[0].x, 20);
 assert.equal(working.sim.debris[0].angle, 0.6);
 assert.equal(working.sim.localFailureCount, 0);
 assert.equal(working.member.integrity, 0.5);
 assert.equal(working.member.failed, false);
 assert.equal(working.member.state, 'intact');
});

test('interpolation leaves arrays with changed structure at the starting checkpoint', () => {
 const tools = loadTools();
 const start = { debris: [{ id: 1, x: 2 }] };
 const end = { debris: [{ id: 1, x: 5 }, { id: 2, x: 9 }] };
 const working = tools.cloneGraph(start);
 tools.interpolateInto(working, start, end, 0.75);
 assert.equal(working.debris.length, 1);
 assert.equal(working.debris[0].x, 2);
});

test('UI locks the bake lifecycle and uses time-based interpolated replay', () => {
 const html = fs.readFileSync(path.join(__dirname, '../index.html'), 'utf8');
 const main = fs.readFileSync(path.join(__dirname, '../js/main.js'), 'utf8');
 assert.match(html, /id="precalculate"/);
 assert.match(html, /id="replayTimeline"/);
 assert.match(html, /js\/replay-tools\.js/);
 assert.match(main, /await stepPhysics\(DT\)/);
 assert.match(main, /replayRevisionAtBake/);
 assert.match(main, /replayEventSignature\(\)/);
 assert.match(main, /interpolateInto/);
 assert.match(main, /renderReplayAtTime/);
 assert.match(main, /canvas\.style\.pointerEvents='none'/);
 assert.match(main, /restoreReplayState\(baseline,\{restoreRunState:true\}\)/);
});
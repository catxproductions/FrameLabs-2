(() => {
'use strict';

const DISCRETE_KEYS = /^(?:id|key|kind|type|state|reason|direction|failed|snapped|shattered|broken|burning|detonated|spent|settled|grounded|supported|active|loaded|is[A-Z].*|localFailureCount|chainDepth|fragmentDepth|fractureHalf|impactCount|nextDebrisId|floatingClusterId)$/i;

function isDiscreteKey(key) {
 return typeof key === 'string' && DISCRETE_KEYS.test(key);
}

function cloneGraph(value, seen = new WeakMap()) {
 if (value === null || typeof value !== 'object') return value;
 if (seen.has(value)) return seen.get(value);

 if (value instanceof ArrayBuffer) {
  const copy = value.slice(0);
  seen.set(value, copy);
  return copy;
 }
 if (typeof SharedArrayBuffer !== 'undefined' && value instanceof SharedArrayBuffer) {
  const copy = new SharedArrayBuffer(value.byteLength);
  new Uint8Array(copy).set(new Uint8Array(value));
  seen.set(value, copy);
  return copy;
 }
 if (ArrayBuffer.isView(value)) {
  const buffer = cloneGraph(value.buffer, seen);
  const copy = value instanceof DataView
   ? new DataView(buffer, value.byteOffset, value.byteLength)
   : new value.constructor(buffer, value.byteOffset, value.length);
  seen.set(value, copy);
  return copy;
 }
 if (value instanceof Date) {
  const copy = new Date(value.getTime());
  seen.set(value, copy);
  return copy;
 }
 if (value instanceof RegExp) {
  const copy = new RegExp(value.source, value.flags);
  copy.lastIndex = value.lastIndex;
  seen.set(value, copy);
  return copy;
 }
 if (value instanceof Map) {
  const copy = new Map();
  seen.set(value, copy);
  for (const [key, entry] of value) copy.set(cloneGraph(key, seen), cloneGraph(entry, seen));
  return copy;
 }
 if (value instanceof Set) {
  const copy = new Set();
  seen.set(value, copy);
  for (const entry of value) copy.add(cloneGraph(entry, seen));
  return copy;
 }

 const copy = Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value));
 seen.set(value, copy);
 for (const key of Reflect.ownKeys(value)) {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) continue;
  if ('value' in descriptor) descriptor.value = cloneGraph(descriptor.value, seen);
  try {
   Object.defineProperty(copy, key, descriptor);
  } catch (_) {
   if ('value' in descriptor) copy[key] = descriptor.value;
  }
 }
 return copy;
}

function estimateBytes(value) {
 const seen = new WeakSet();
 const buffers = new WeakSet();
 let bytes = 0;

 function visit(entry) {
  if (entry == null) {
   bytes += 4;
   return;
  }
  const type = typeof entry;
  if (type === 'string') {
   bytes += entry.length * 2 + 8;
   return;
  }
  if (type === 'number' || type === 'boolean' || type === 'bigint') {
   bytes += 8;
   return;
  }
  if (type !== 'object' || seen.has(entry)) return;
  seen.add(entry);

  if (ArrayBuffer.isView(entry)) {
   if (!buffers.has(entry.buffer)) {
    buffers.add(entry.buffer);
    bytes += entry.buffer.byteLength;
   }
   bytes += 24;
   return;
  }
  if (entry instanceof ArrayBuffer ||
      (typeof SharedArrayBuffer !== 'undefined' && entry instanceof SharedArrayBuffer)) {
   if (!buffers.has(entry)) {
    buffers.add(entry);
    bytes += entry.byteLength;
   }
   return;
  }
  if (entry instanceof Map) {
   bytes += 48;
   for (const [key, item] of entry) {
    visit(key);
    visit(item);
   }
   return;
  }
  if (entry instanceof Set) {
   bytes += 32;
   for (const item of entry) visit(item);
   return;
  }

  bytes += 32;
  for (const key of Reflect.ownKeys(entry)) {
   if (typeof key === 'string') bytes += key.length * 2 + 8;
   const descriptor = Object.getOwnPropertyDescriptor(entry, key);
   if (descriptor && 'value' in descriptor) visit(descriptor.value);
  }
 }

 visit(value);
 return bytes;
}

function interpolateInto(target, start, end, amount) {
 const alpha = Math.max(0, Math.min(1, Number(amount) || 0));
 const visited = new WeakMap();

 function alreadyVisited(from, to) {
  let partners = visited.get(from);
  if (!partners) {
   partners = new WeakSet();
   visited.set(from, partners);
  }
  if (partners.has(to)) return true;
  partners.add(to);
  return false;
 }

 function walk(outParent, fromParent, toParent, key, forceDiscrete = false) {
  const discrete = forceDiscrete || isDiscreteKey(key);
  const out = outParent[key];
  const from = fromParent[key];
  const to = toParent[key];

  if (typeof from === 'number' && typeof to === 'number' &&
      Number.isFinite(from) && Number.isFinite(to)) {
   outParent[key] = discrete ? from : from + (to - from) * alpha;
   return;
  }
  if (ArrayBuffer.isView(from) && ArrayBuffer.isView(to) &&
      ArrayBuffer.isView(out) && from.constructor === to.constructor &&
      from.constructor === out.constructor && from.length === to.length &&
      from.length === out.length && !(from instanceof DataView)) {
   if (typeof BigInt64Array !== 'undefined' &&
       (from instanceof BigInt64Array || from instanceof BigUint64Array)) return;
   for (let i = 0; i < from.length; i++) {
    out[i] = discrete ? from[i] : from[i] + (to[i] - from[i]) * alpha;
   }
   return;
  }
  if (from === null || to === null || out === null ||
      typeof from !== 'object' || typeof to !== 'object' || typeof out !== 'object') {
   outParent[key] = from;
   return;
  }
  if (alreadyVisited(from, to)) return;

  if (Array.isArray(from) && Array.isArray(to) && Array.isArray(out)) {
   if (from.length !== to.length || from.length !== out.length) return;
   for (let i = 0; i < from.length; i++) walk(out, from, to, i, discrete);
   return;
  }
  if (Array.isArray(from) || Array.isArray(to) || Array.isArray(out)) return;
  if (Object.getPrototypeOf(from) !== Object.getPrototypeOf(to) ||
      Object.getPrototypeOf(from) !== Object.getPrototypeOf(out)) return;

  for (const property of Reflect.ownKeys(from)) {
   if (!Object.prototype.hasOwnProperty.call(to, property) ||
       !Object.prototype.hasOwnProperty.call(out, property)) continue;
   const fromDescriptor = Object.getOwnPropertyDescriptor(from, property);
   const toDescriptor = Object.getOwnPropertyDescriptor(to, property);
   const outDescriptor = Object.getOwnPropertyDescriptor(out, property);
   if (!fromDescriptor || !toDescriptor || !outDescriptor ||
       !('value' in fromDescriptor) || !('value' in toDescriptor) ||
       !('value' in outDescriptor)) continue;
   walk(out, from, to, property, discrete);
  }
 }

 walk({ value: target }, { value: start }, { value: end }, 'value');
 return target;
}
window.FrameLabReplayTools = Object.freeze({
 cloneGraph,
 estimateBytes,
 interpolateInto
});
})();
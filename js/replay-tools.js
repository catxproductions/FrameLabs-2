(() => {
'use strict';
function cloneGraph(value,seen=new WeakMap()){
 if(value===null||typeof value!=='object')return value;if(seen.has(value))return seen.get(value);
 if(value instanceof ArrayBuffer){const copy=value.slice(0);seen.set(value,copy);return copy}
 if(ArrayBuffer.isView(value)){if(value instanceof DataView){const copy=new DataView(cloneGraph(value.buffer,seen),value.byteOffset,value.byteLength);seen.set(value,copy);return copy}const copy=new value.constructor(value);seen.set(value,copy);return copy}
 if(value instanceof Date){const copy=new Date(value.getTime());seen.set(value,copy);return copy}
 if(value instanceof Map){const copy=new Map();seen.set(value,copy);for(const [k,v]of value)copy.set(cloneGraph(k,seen),cloneGraph(v,seen));return copy}
 if(value instanceof Set){const copy=new Set();seen.set(value,copy);for(const v of value)copy.add(cloneGraph(v,seen));return copy}
 const copy=Array.isArray(value)?[]:Object.create(Object.getPrototypeOf(value));seen.set(value,copy);
 for(const key of Reflect.ownKeys(value)){const d=Object.getOwnPropertyDescriptor(value,key);if(!d)continue;if('value'in d)d.value=cloneGraph(d.value,seen);try{Object.defineProperty(copy,key,d)}catch(_){copy[key]=d.value}}
 return copy;
}
function estimateBytes(value){const seen=new WeakSet();let bytes=0;function visit(v){if(v==null){bytes+=4;return}const t=typeof v;if(t==='string'){bytes+=v.length*2+8;return}if(t==='number'||t==='boolean'||t==='bigint'){bytes+=8;return}if(t!=='object'||seen.has(v))return;seen.add(v);if(ArrayBuffer.isView(v)){bytes+=v.byteLength+24;return}if(v instanceof ArrayBuffer){bytes+=v.byteLength;return}if(v instanceof Map){bytes+=48;for(const [k,x]of v){visit(k);visit(x)}return}if(v instanceof Set){bytes+=32;for(const x of v)visit(x);return}bytes+=32;for(const k of Reflect.ownKeys(v)){if(typeof k==='string')bytes+=k.length*2+8;visit(v[k])}}visit(value);return bytes}
window.FrameLabReplayTools=Object.freeze({cloneGraph,estimateBytes});
})();
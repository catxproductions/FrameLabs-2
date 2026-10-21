(() => {
'use strict';
const W=1100,H=680,STORY_HEIGHT=3.15,DT=1/120; // Fixed 120 Hz physics sub-step, independent of render rate.
let NX=12,NY=8;
const GRID_LEFT=145,GRID_RIGHT=955,GROUND_Y=595,MIN_BAYS=4,MAX_BAYS=40,MIN_LEVELS=3,MAX_LEVELS=24;
let STORY_PX=(GROUND_Y-120)/NY,DX=(GRID_RIGHT-GRID_LEFT)/NX;
const GRAVITY=9.81,MAX_FALL_SPEED=15,IMPACT_RESTITUTION=.12,IMPACT_TRANSFER_EFFICIENCY=.82,IMPACT_ENERGY_PER_CAPACITY=3,IMPACT_DURATION=.08,IMPACT_FORCE_NORMALIZER=.02,IMPACT_MOMENTUM_TRANSFER=.25,SHOCKWAVE_TRANSFER=.28,FAILURE_INTEGRITY=.18,FLOOR_THICKNESS=.12,CRITICAL_TILT=18*Math.PI/180,COLUMN_TILT_LIMIT=15*Math.PI/180,ROTATION_DAMPING=.28;
const PHYSICS_MODEL=window.FrameLabPhysicsModel||null;
const QUALITY_PRESETS={entry:{label:'Entry',pixelRatio:1,maxDebris:90,maxParticles:170,constraintIterations:5,contactShadows:false,atmosphere:false,wetHighlights:false},balanced:{label:'Balanced',pixelRatio:1.5,maxDebris:170,maxParticles:360,constraintIterations:8,contactShadows:true,atmosphere:true,wetHighlights:true},enthusiast:{label:'Enthusiast',pixelRatio:2,maxDebris:280,maxParticles:600,constraintIterations:11,contactShadows:true,atmosphere:true,wetHighlights:true}};
let MAX_DEBRIS=QUALITY_PRESETS.balanced.maxDebris,MAX_ATMOSPHERIC_PARTICLES=QUALITY_PRESETS.balanced.maxParticles,QUALITY_PROFILE=QUALITY_PRESETS.balanced,qualityMode='auto',showSimulationOverlays=true,gravityTether=null;
const ENVIRONMENT={moisture:0,waterLevel:0};
const IMPACT_RESISTANCE={steel:{column:1.45,beam:1.32,slab:1.18,brace:1.25},concrete:{column:1.12,beam:.96,slab:.84,brace:.86},wood:{column:.72,beam:.62,slab:.54,brace:.52},flammable:{column:.62,beam:.56,slab:.45,brace:.48},explosive:{column:.74,beam:.66,slab:.58,brace:.61}};
// Flammable and explosive are fictional sandbox materials, not real-world formulations.
const MATERIALS={steel:{label:'Steel',column:{mass:.22,capacity:28},beam:{mass:.18,capacity:18},slab:{mass:.32,capacity:15},brace:{mass:.12,capacity:13.5},color:'#78caff'},concrete:{label:'Concrete',column:{mass:.42,capacity:17},beam:{mass:.34,capacity:11},slab:{mass:.65,capacity:8},brace:{mass:.24,capacity:7.2},color:'#b4c0d0'},wood:{label:'Wood',column:{mass:.16,capacity:9},beam:{mass:.14,capacity:6},slab:{mass:.28,capacity:3.8},brace:{mass:.08,capacity:4.1},color:'#dca76a'},flammable:{label:'Flammable composite',column:{mass:.18,capacity:7.6},beam:{mass:.15,capacity:5.4},slab:{mass:.27,capacity:3.1},brace:{mass:.085,capacity:3.7},color:'#f39a52'},explosive:{label:'Explosive composite',column:{mass:.26,capacity:8.8},beam:{mass:.22,capacity:6.4},slab:{mass:.4,capacity:4.6},brace:{mass:.12,capacity:4.8},color:'#ed6ca8'}};
const MAX_CHAIN_REACTION_DEPTH=3;
const $=id=>document.getElementById(id),canvas=$('scene'),ctx=canvas.getContext('2d');
// Render in logical 1100×680 units, but use a high-DPI backing store on retina displays.
// Capping the pixel ratio at 2 preserves crisp lines without excessive memory on 3× phones.
let canvasPixelRatio=1;
function setupCanvasScale(){
 canvasPixelRatio=Math.min(QUALITY_PROFILE.pixelRatio,Math.max(1,Number(window.devicePixelRatio)||1));
 const backingWidth=Math.round(W*canvasPixelRatio),backingHeight=Math.round(H*canvasPixelRatio);
 if(canvas.width!==backingWidth)canvas.width=backingWidth;
 if(canvas.height!==backingHeight)canvas.height=backingHeight;
 ctx.setTransform(canvasPixelRatio,0,0,canvasPixelRatio,0,0);
 ctx.imageSmoothingEnabled=true;
}
setupCanvasScale();
// If the external logo is slow or unavailable, show the local fallback mark; a late successful
// image load still replaces the fallback. This avoids an empty brand slot on first paint.
const brandLogo=$('brandLogo'),brandLogoFallback=$('brandLogoFallback');
if(brandLogo&&brandLogoFallback){
 const showBrandFallback=()=>{brandLogo.classList.add('hidden');brandLogoFallback.classList.remove('hidden')};
 const showBrandLogo=()=>{brandLogo.classList.remove('hidden');brandLogoFallback.classList.add('hidden')};
 brandLogo.addEventListener('error',showBrandFallback,{once:true});
 brandLogo.addEventListener('load',showBrandLogo);
 if(brandLogo.complete&&brandLogo.naturalWidth===0)showBrandFallback();
 window.setTimeout(()=>{if(!brandLogo.complete||brandLogo.naturalWidth===0)showBrandFallback()},1800);
}
window.addEventListener('resize',()=>{setupCanvasScale();draw()},{passive:true});
// Story summaries are retained for the readout, while physical motion is driven by independent joints and members.
class Floor {
 constructor(level){
  this.level=level;
  this.position={x:0,y:level*STORY_HEIGHT};
  this.velocity={x:0,y:0};
  this.acceleration={x:0,y:0};
  this.mass=0;
  this.integrity=1;
  this.structuralIntegrity=1;
  this.connections=[];
  this.supportCapacity=0;
  this.isSupported=level===0;
  this.isFalling=false;
  this.active=level===0;
  this.contactFloor=null;
  this.lastImpactTime=-Infinity;
  this.collisionBounds={left:0,right:NX,bottom:this.position.y,top:this.position.y+FLOOR_THICKNESS};
 }
 updateCollisionBounds(){this.collisionBounds={left:0,right:NX,bottom:this.position.y,top:this.position.y+FLOOR_THICKNESS};}
}
// Joint nodes carry independent vector state. Their nominal coordinates are only the initial configuration.
class StructuralNode {
 constructor(x,level){this.key=keyOf(x,level);this.gridX=x;this.referenceLevel=level;this.reference={x:x*STORY_HEIGHT,y:level*STORY_HEIGHT};this.position={x:this.reference.x,y:this.reference.y};this.velocity={x:0,y:0};this.acceleration={x:0,y:0};this.mass=.05;this.isGroundConnected=level===0;this.isLoaded=false;this.isStressed=false;this.memberIds=[];this.lastImpactTime=-Infinity;this.isFreefalling=level>0;this.floatingClusterId=null;}
}
// Every member end has an explicit shear connection. A connection can fail without instantly deleting the whole building.
class Connection {
 constructor(id,memberId,nodeKey,shearStrength,state){this.id=id;this.memberId=memberId;this.nodeKey=nodeKey;this.shearStrength=shearStrength;this.state=state||{};this.broken=!!this.state.broken;this.reason=this.state.reason||'';this.plasticDamage=clamp(Number(this.state.plasticDamage)||0,0,1.25);this.stiffnessFactor=clamp(Number(this.state.stiffnessFactor??(1-.82*this.plasticDamage)),.12,1);this.pendingBreakUntil=this.state.pendingBreakUntil==null?null:(Number.isFinite(Number(this.state.pendingBreakUntil))?Number(this.state.pendingBreakUntil):null);this.lastDemandRatio=Math.max(0,Number(this.state.lastDemandRatio)||0);this.forceAngle=Number(this.state.forceAngle)||0;this.frictionHoldUntil=this.state.frictionHoldUntil==null?0:(Number(this.state.frictionHoldUntil)||0);}
 syncState(){this.state.broken=this.broken;this.state.reason=this.reason;this.state.plasticDamage=this.plasticDamage;this.state.stiffnessFactor=this.stiffnessFactor;this.state.pendingBreakUntil=this.pendingBreakUntil;this.state.lastDemandRatio=this.lastDemandRatio;this.state.forceAngle=this.forceAngle;this.state.frictionHoldUntil=this.frictionHoldUntil;}
 applyDemand(ratio,angle,dt,time){this.lastDemandRatio=Math.max(0,Number(ratio)||0);this.forceAngle=Number(angle)||0; if(this.lastDemandRatio>.86){const rate=.008+(this.lastDemandRatio-.86)*.16+Math.max(0,this.lastDemandRatio-1)*.26;this.plasticDamage=clamp(this.plasticDamage+dt*rate,0,1.25);}this.stiffnessFactor=clamp(1-.72*this.plasticDamage,.18,1);if(this.plasticDamage>=.76||this.lastDemandRatio>2.35){if(this.pendingBreakUntil==null)this.pendingBreakUntil=time+clamp(.17-Math.max(0,this.lastDemandRatio-1)*.035,.055,.17);this.frictionHoldUntil=Math.max(this.frictionHoldUntil,this.pendingBreakUntil);}if(this.pendingBreakUntil!=null&&this.lastDemandRatio<.50&&this.plasticDamage<.92){this.pendingBreakUntil=null;this.frictionHoldUntil=0;}this.syncState();return this.pendingBreakUntil!=null&&time>=this.pendingBreakUntil&&this.plasticDamage>=.76&&this.lastDemandRatio>.60;}
 break(reason='joint failure'){if(this.broken)return false;this.broken=true;this.reason=reason;this.pendingBreakUntil=null;this.syncState();return true;}
}
let BuildingMap=newBuildingMap();let mode='build',hover={x:0,y:1,valid:false},dragging=false,lastDragKey='',lastDragPt=null,buildLastCell=null,buildPainted=new Set(),lastAnalysis=null,frame=0,previous=performance.now();
let sim=newPhysicsState();
function countOutOfBounds(bays,levels){
 let removed=0;
 for(const [group,items] of Object.entries(BuildingMap))for(const e of Object.values(items||{})){
  const outside=group==='columns'?(e.x<0||e.x>bays||e.y<0||e.y>=levels):group==='braces'?(e.x<0||e.x>=bays||e.y<0||e.y>=levels):group==='loads'?(e.x<0||e.x>=bays||e.y<1||e.y>levels):(e.x<0||e.x>=bays||e.y<1||e.y>levels);
  if(outside)removed++;
 }
 return removed;
}
function configureGridDimensions(baysInput,levelsInput,options={}){
 const rawB=Number(baysInput),rawL=Number(levelsInput);
 const bays=clamp(Number.isFinite(rawB)?Math.round(rawB):NX,MIN_BAYS,MAX_BAYS);
 const levels=clamp(Number.isFinite(rawL)?Math.round(rawL):NY,MIN_LEVELS,MAX_LEVELS);
 $('baysInput').value=bays;$('levelsInput').value=levels;
 if(bays===NX&&levels===NY){$('gridSizeLabel').textContent=`Grid: ${NX} bays × ${NY} levels`;return true}
 const removed=countOutOfBounds(bays,levels),wasRunning=sim.running;
 if(!options.silent&&(removed>0||wasRunning||sim.debris.length>0)){
  const details=[];if(removed)details.push(`${removed} out-of-bounds design element(s) will be removed`);if(wasRunning)details.push('the simulation will pause');if(sim.debris.length)details.push('dynamic motion will be reset while debris still inside the resized area is retained');
  if(!confirm(`Resize FrameLab to ${bays} bays × ${levels} levels? ${details.join('; ')||'The grid layout will be recalculated'}.`)){$('baysInput').value=NX;$('levelsInput').value=NY;return false}
 }
 const old=sim,oldConnections=old.connectionStates||Object.create(null),oldDebris=(old.debris||[]).filter(d=>d.x>=0&&d.x<=bays*STORY_HEIGHT&&d.y<=levels*STORY_HEIGHT+STORY_HEIGHT*.8),oldNextDebrisId=old.nextDebrisId||1,oldTime=old.time||0;
 NX=bays;NY=levels;DX=(GRID_RIGHT-GRID_LEFT)/NX;STORY_PX=(GROUND_Y-120)/NY;
 for(const [key,e] of Object.entries(BuildingMap.columns))if(e.x<0||e.x>NX||e.y<0||e.y>=NY)delete BuildingMap.columns[key];
 for(const group of ['beams','slabs'])for(const [key,e] of Object.entries(BuildingMap[group]))if(e.x<0||e.x>=NX||e.y<1||e.y>NY)delete BuildingMap[group][key];
 for(const [key,e] of Object.entries(BuildingMap.braces))if(e.x<0||e.x>=NX||e.y<0||e.y>=NY)delete BuildingMap.braces[key];
 for(const [key,e] of Object.entries(BuildingMap.loads))if(e.x<0||e.x>=NX||e.y<1||e.y>NY)delete BuildingMap.loads[key];
 sim=newPhysicsState();sim.connectionStates=oldConnections;sim.debris=oldDebris;sim.nextDebrisId=oldNextDebrisId;sim.time=oldTime;sim.running=false;for(const d of sim.debris)containDebrisInGrid(d);
 $('gridSizeLabel').textContent=`Grid: ${NX} bays × ${NY} levels`;hover.valid=false;dragging=false;lastDragKey='';lastDragPt=null;refreshAll();syncButtons();
 if(!options.silent){setStatus(`Building area resized to ${NX} bays × ${NY} levels. ${removed?`${removed} out-of-bounds design element(s) removed. `:''}Simulation paused; surviving design elements were preserved.`,true);setStatus(`Grid updated: ${NX} bays × ${NY} levels. Validate to recalculate support and load paths.`,false)}
 return true;
}
function newBuildingMap(){return {columns:{},beams:{},slabs:{},braces:{},loads:{}}}
function newPhysicsState(){return {running:false,time:0,floors:Array.from({length:NY+1},(_,level)=>new Floor(level)),nodes:Object.create(null),memberLinks:[],connections:[],connectionStates:Object.create(null),collisionPairs:Object.create(null),assemblyDynamics:Object.create(null),stability:{assemblies:[],primary:null,nodeAssembly:Object.create(null),byId:Object.create(null)},floatingClusters:[],debris:[],atmosphericParticles:[],nextDebrisId:1,localFailureCount:0,lateralDisp:new Float64Array(NY+1),lateralVel:new Float64Array(NY+1),overloadTimers:{},lastImpactEnergy:0,lastRawEnergy:0,lastImpactForce:0,lastImpactStory:-1,lastImpactOutcome:'',lastEvent:'Build a frame to begin.',eventUntil:0,peakUtil:0,explosionEffects:[],pendingMaterialBlasts:[],chainExplosionsProcessed:0,lastFireSpread:0}}
function memberCount(){return ['columns','beams','slabs','braces'].reduce((n,g)=>n+Object.values(BuildingMap[g]).filter(e=>!e.failed&&!e.snapped).length,0)}
function totalCount(){return memberCount()+Object.values(BuildingMap.loads).length}
function allMembers(){return ['columns','beams','slabs','braces'].flatMap(k=>Object.entries(BuildingMap[k]).map(([key,e])=>({group:k,key,e})))}
function keyOf(x,y){return `${x},${y}`}
function braceKeyOf(x,y,direction='up'){return `${x},${y},${direction}`}
function memberGroupForKind(kind){return ({column:'columns',beam:'beams',slab:'slabs',brace:'braces'})[kind]||'beams'}
function memberKeyFor(group,e){return group==='braces'?braceKeyOf(e.x,e.y,e.direction||'up'):keyOf(e.x,e.y)}
function gridPositionForKind(px,py,kind){if(kind==='column')return snapColumn(px,py);if(kind==='brace'||kind==='crossbrace')return snapBrace(px,py);return snapBay(px,py)}
function makeElement(kind,x,y,material){const p=MATERIALS[material][kind],impactResistance=IMPACT_RESISTANCE[material][kind];return {x,y,kind,material,mass:p.mass,capacity:p.capacity,yieldStrength:p.capacity,momentCapacity:kind==='beam'?p.capacity*.50:0,impactResistance,durability:p.capacity*impactResistance*IMPACT_ENERGY_PER_CAPACITY,bendingMoment:0,momentUtilization:0,effectiveSpan:1,momentOverloadTime:0,sag:0,sagVelocity:0,plasticSag:0,sagging:false,catenaryTension:0,catenaryRatio:0,connectionFactor:1,jointDamageA:0,jointDamageB:0,plasticMoment:0,snapped:false,shattered:false,snapSag:0,snapVelocity:0,snapAge:0,snapCenterX:null,impactDamage:0,impactDeformation:0,elasticDeformation:0,plasticDeformation:0,lastImpactEnergy:0,impactStress:0,lastImpactTime:-Infinity,integrity:1,structuralIntegrity:1,failed:false,demand:0,utilization:0,unsupported:false,isLoaded:false,isStressed:false,connections:[],angle:0,strain:0,tiltAngle:0,lateralForce:0,direction:kind==='brace'?'up':undefined,fractureCount:0,burning:false,fuelRemaining:material==='flammable'?1:0,heatExposure:0,fireSpreadClock:0,burnTime:0,smokeEmissionClock:0,ignitionReason:'',explosivePrimed:false,detonated:false,chainDepth:0}}
function resetPhysics(restoreMembers=false){dragging=false;lastDragKey='';lastDragPt=null;gravityTether=null;sim=newPhysicsState();if(!restoreMembers){sim.connectionStates=Object.create(null)}if(restoreMembers){sim.connectionStates=Object.create(null);for(const {e} of allMembers()){e.integrity=1;e.structuralIntegrity=1;e.failed=false;e.snapped=false;e.shattered=false;e.snapSag=0;e.snapVelocity=0;e.snapAge=0;e.snapCenterX=null;e.momentOverloadTime=0;e.bendingMoment=0;e.momentUtilization=0;e.effectiveSpan=1;e.sag=0;e.sagVelocity=0;e.plasticSag=0;e.sagging=false;e.catenaryTension=0;e.catenaryRatio=0;e.connectionFactor=1;e.jointDamageA=0;e.jointDamageB=0;e.plasticMoment=0;e.tiltAngle=0;e.lateralForce=0;e.impactDamage=0;e.impactDeformation=0;e.elasticDeformation=0;e.plasticDeformation=0;e.impactStress=0;e.lastImpactEnergy=0;e.lastImpactTime=-Infinity;e.debrisSpawned=false;e.failureReason='';e.state='intact';e.demand=0;e.utilization=0;e.unsupported=false;e.isFreefalling=false;e.dynamicUtilization=0;e.burning=false;e.fuelRemaining=e.material==='flammable'?1:0;e.heatExposure=0;e.fireSpreadClock=0;e.burnTime=0;e.smokeEmissionClock=0;e.ignitionReason='';e.explosivePrimed=false;e.detonated=false;e.chainDepth=0}for(const l of Object.values(BuildingMap.loads)){l.integrity=1;l.failed=false}}sim.running=false;syncButtons();refreshAll()}
function screenX(x,level=0){const node=sim.nodes[keyOf(x,level)];const worldX=node?node.position.x/STORY_HEIGHT:x;return GRID_LEFT+worldX*DX+sim.lateralDisp[Math.max(0,Math.min(NY,level))]*23}
function screenYNode(x,level){const node=sim.nodes[keyOf(x,level)];const worldY=node?node.position.y:level*STORY_HEIGHT;return GROUND_Y-(worldY/STORY_HEIGHT)*STORY_PX}
function screenYLevel(level){const index=Math.max(0,Math.min(NY,level));const matching=Object.values(sim.nodes).filter(n=>n.referenceLevel===index);if(matching.length)return GROUND_Y-(matching.reduce((sum,n)=>sum+n.position.y,0)/matching.length/STORY_HEIGHT)*STORY_PX;return GROUND_Y-(sim.floors[index].position.y/STORY_HEIGHT)*STORY_PX}
function gridY(level){return GROUND_Y-level*STORY_PX}
function clamp(v,a,b){return Math.max(a,Math.min(b,v))}
function stressColor(v){const colors=[[75,158,255],[61,211,195],[183,224,109],[255,202,83],[255,91,113]];const q=clamp(v/1.25,0,1)*(colors.length-1),i=Math.min(colors.length-2,Math.floor(q)),f=q-i;return `rgb(${colors[i].map((c,j)=>Math.round(c+(colors[i+1][j]-c)*f)).join(',')})`}
function materialColor(mat){return MATERIALS[mat]?.color||'#b4c0d0'}
function rawDebrisColor(d){if(d.burning)return '#ff8b43';if(d.material==='explosive')return d.explosiveSpent?'#aa8aa4':'#f16ba9';if(d.impactCount>0||/shatter|catastrophic|impact/i.test(d.reason||''))return d.settled?'#d98e6b':'#ff9a72';return ({steel:'#69b8ed',concrete:'#c9ad87',wood:'#e0a76c',flammable:'#e8924b',explosive:'#ee6eaa'})[d.material]||'#d0aa7b'}
function debrisColor(d){const base=rawDebrisColor(d);return PHYSICS_MODEL?.shadeForMoisture?PHYSICS_MODEL.shadeForMoisture(base,ENVIRONMENT.moisture):base}
function hasColumn(x,y){const e=BuildingMap.columns[keyOf(x,y)];if(!e||e.failed||e.integrity<=0)return false;const id=`columns|${keyOf(x,y)}`,a=sim.connectionStates[connectionId(id,'a')],b=sim.connectionStates[connectionId(id,'b')];return !a?.broken&&!b?.broken}
function hasBeam(x,y){const e=BuildingMap.beams[keyOf(x,y)];if(!e||e.failed||e.snapped||e.integrity<=0)return false;const id=`beams|${keyOf(x,y)}`,a=sim.connectionStates[connectionId(id,'a')],b=sim.connectionStates[connectionId(id,'b')];return !a?.broken&&!b?.broken}
function columnStacked(x,level){if(level<1)return true;for(let y=0;y<level;y++)if(!hasColumn(x,y))return false;return true}
// A node connected to the foundation through a horizontal beam is not necessarily vertically
// supported. Cantilever nodes must be allowed to sag instead of being pinned to their grid height.
function hasDirectVerticalSupport(node){return !!node&&(node.referenceLevel===0||columnStacked(node.x,node.referenceLevel))}
function cantileverUtilizationAtNode(node){
 if(!node)return null;let worst=0,found=false;const level=node.referenceLevel;
 for(const link of sim.memberLinks){const e=link.e;if(e.kind!=='beam'||e.failed||e.snapped||e.y!==level||(link.nodeA!==node.key&&link.nodeB!==node.key))continue;
  const span=beamSpanInfo(e.x,e.y);if(span.leftSupported===span.rightSupported)continue;found=true;
  const rootX=span.leftSupported?span.left:span.right-1,root=BuildingMap.beams[keyOf(rootX,level)];
  if(root&&!root.failed&&!root.snapped)worst=Math.max(worst,Number(root.momentUtilization)||0,Number(e.momentUtilization)||0);
 }
 return found?worst:null;
}
function beamComponentHasSupport(startX,y){const seen=new Set(),queue=[startX];while(queue.length){const node=queue.shift();if(seen.has(node))continue;seen.add(node);if(node>=0&&node<=NX&&columnStacked(node,y))return true;for(const bx of [node-1,node]){if(bx<0||bx>=NX)continue;const beam=BuildingMap.beams[keyOf(bx,y)];if(beam&&hasBeam(bx,y)){const next=bx===node?bx+1:bx;if(!seen.has(next))queue.push(next)}}}return false}
function baySupported(x,y){const direct=columnStacked(x,y)&&columnStacked(x+1,y);if(direct)return true;const beam=BuildingMap.beams[keyOf(x,y)];if(!beam||!hasBeam(x,y))return false;return beamComponentHasSupport(x,y)||beamComponentHasSupport(x+1,y)}
// Estimate the clear span between surviving support paths along a continuous beam line.
function beamSpanInfo(x,y){let left=x,right=x+1,steps=0;while(left>0&&!columnStacked(left,y)&&hasBeam(left-1,y)&&steps++<=NX)left--;steps=0;while(right<NX&&!columnStacked(right,y)&&hasBeam(right,y)&&steps++<=NX)right++;const leftSupported=columnStacked(left,y),rightSupported=columnStacked(right,y);return {left,right,bays:Math.max(1,right-left),leftSupported,rightSupported,center:(left+right)*.5,y,supportMode:leftSupported&&rightSupported?'two-sided':leftSupported?'cantilever-right':rightSupported?'cantilever-left':'floating'}}
function beamBayLoad(x,y){const b=BuildingMap.beams[keyOf(x,y)];if(!b||b.failed||b.snapped)return 0;const slab=BuildingMap.slabs[keyOf(x,y)],load=BuildingMap.loads[keyOf(x,y)];const basic=(slab&&!slab.failed?slab.mass*.28:0)+(load&&!load.failed?load.mass:0)+b.mass*.7;return Math.max(basic,(Number(b.demand)||0)-Math.max(0,b.catenaryTension||0)*.09)}
function beamBendingData(beam){
 const span=beamSpanInfo(beam.x,beam.y),L=span.bays*STORY_HEIGHT,bayLoads=[];let sum=0,n=0;
 for(let x=span.left;x<span.right;x++){const load=beamBayLoad(x,beam.y);if(load>0){bayLoads.push({x,load});sum+=load;n++}else bayLoads.push({x,load:0})}
 const averageDemand=n?sum/n:Math.max(.01,beam.demand||beam.mass),w=Math.max(.01,averageDemand)/STORY_HEIGHT;
 let moment=0;
 if(span.leftSupported!==span.rightSupported){
  // A one-sided span is a cantilever, not a simply-supported beam. Integrate each bay's
  // tributary load about the fixed root so loads near the free tip get their full lever arm.
  if(span.leftSupported){for(const bay of bayLoads){if(bay.x<beam.x)continue;const lever=(bay.x+.5-beam.x)*STORY_HEIGHT;moment+=bay.load*Math.max(0,lever)}}
  else {for(const bay of bayLoads){if(bay.x>beam.x)continue;const lever=(beam.x+.5-bay.x)*STORY_HEIGHT;moment+=bay.load*Math.max(0,lever)}}
 }else if(span.leftSupported&&span.rightSupported){const d=clamp((beam.x+.5-span.left)*STORY_HEIGHT,.01,Math.max(.01,L-.01));moment=w*d*(L-d)/2}
 else {const localLength=STORY_HEIGHT;moment=w*localLength*localLength/8}
 const rootBay=span.leftSupported&&!span.rightSupported?span.left:(!span.leftSupported&&span.rightSupported?span.right-1:null);
 return {moment,span,averageDemand,lineLoad:w,bayLoads,isCantilever:span.leftSupported!==span.rightSupported,rootBay};
}
function endpointKeys(group,e){if(group==='columns')return [keyOf(e.x,e.y),keyOf(e.x,e.y+1)];if(group==='braces')return e.direction==='down'?[keyOf(e.x,e.y+1),keyOf(e.x+1,e.y)]:[keyOf(e.x,e.y),keyOf(e.x+1,e.y+1)];return [keyOf(e.x,e.y),keyOf(e.x+1,e.y)]}
function memberConnectionStrength(e){return Math.max(.05,e.capacity*clamp(e.integrity,0,1)*(e.kind==='column'?.72:e.kind==='beam'?.68:.46))}
function connectionId(memberId,end){return `${memberId}:${end}`}
function refreshMemberTopology(){
 const previousNodes=sim.nodes||Object.create(null),nodes=previousNodes,links=[],connections=[],usedNodes=new Set();
 const ensureNode=(x,y)=>{const key=keyOf(x,y);usedNodes.add(key);if(!nodes[key])nodes[key]=new StructuralNode(x,y);return nodes[key]};
 for(const {group,key,e} of allMembers()){
  if(e.failed&&e.debrisSpawned)continue;
  const [aKey,bKey]=endpointKeys(group,e),aParts=aKey.split(',').map(Number),bParts=bKey.split(',').map(Number);
  const a=ensureNode(aParts[0],aParts[1]),b=ensureNode(bParts[0],bParts[1]);
  const id=`${group}|${key}`,strength=memberConnectionStrength(e);
  const stateA=sim.connectionStates[connectionId(id,'a')]||(sim.connectionStates[connectionId(id,'a')]={broken:!!e.failed,reason:e.failed?'member failed':'',plasticDamage:e.jointDamageA||0,stiffnessFactor:clamp(1-.82*(e.jointDamageA||0),.12,1),pendingBreakUntil:null,lastDemandRatio:0,forceAngle:0,frictionHoldUntil:0});
  const stateB=sim.connectionStates[connectionId(id,'b')]||(sim.connectionStates[connectionId(id,'b')]={broken:!!e.failed,reason:e.failed?'member failed':'',plasticDamage:e.jointDamageB||0,stiffnessFactor:clamp(1-.82*(e.jointDamageB||0),.12,1),pendingBreakUntil:null,lastDemandRatio:0,forceAngle:0,frictionHoldUntil:0});
  const ca=new Connection(connectionId(id,'a'),id,aKey,strength,stateA),cb=new Connection(connectionId(id,'b'),id,bKey,strength,stateB);
  connections.push(ca,cb);e.connections=[ca.id,cb.id];
  const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y;e.angle=Math.atan2(dy,dx);e.strain=Math.hypot(dx,dy)/STORY_HEIGHT-1;
  links.push({id,group,key,e,nodeA:aKey,nodeB:bKey,connectionA:ca,connectionB:cb,restLength:group==='braces'?STORY_HEIGHT*Math.SQRT2:STORY_HEIGHT});
 }
 for(const load of Object.values(BuildingMap.loads)){ensureNode(load.x,load.y);ensureNode(load.x+1,load.y)}
 for(const key of Object.keys(nodes))if(!usedNodes.has(key))delete nodes[key];
 sim.nodes=nodes;sim.memberLinks=links;sim.connections=connections;
 for(const node of Object.values(nodes)){node.memberIds=[];node.mass=.05;node.isLoaded=false;node.isStressed=false}
 for(const link of links){const e=link.e;if(e.failed)continue;nodes[link.nodeA].memberIds.push(link.id);nodes[link.nodeB].memberIds.push(link.id);nodes[link.nodeA].mass+=Math.max(.01,e.mass*.5);nodes[link.nodeB].mass+=Math.max(.01,e.mass*.5);e.isLoaded=(e.demand||0)>.02;e.isStressed=(e.utilization||0)>.8}
 for(const load of Object.values(BuildingMap.loads)){if(load.failed)continue;const share=Math.max(.01,load.mass*.5);nodes[keyOf(load.x,load.y)].mass+=share;nodes[keyOf(load.x+1,load.y)].mass+=share;nodes[keyOf(load.x,load.y)].isLoaded=true;nodes[keyOf(load.x+1,load.y)].isLoaded=true;}
 updateNodeAnchors();
 return links;
}
function linkTransfersSupport(link){return !link.e.failed&&!link.e.snapped&&link.e.integrity>0.02&&!link.connectionA.broken&&!link.connectionB.broken}
function updateNodeAnchors(){
 const nodes=sim.nodes,adj=Object.create(null);for(const key of Object.keys(nodes))adj[key]=[];
 for(const link of sim.memberLinks){if(linkTransfersSupport(link)){adj[link.nodeA].push(link.nodeB);adj[link.nodeB].push(link.nodeA)}}
 const queue=[];for(const [key,node] of Object.entries(nodes)){node.isGroundConnected=false;node.isFreefalling=true;node.floatingClusterId=null;if(node.referenceLevel===0){node.isGroundConnected=true;queue.push(key)}}
 while(queue.length){const key=queue.shift();for(const next of adj[key]||[]){if(nodes[next]&&!nodes[next].isGroundConnected){nodes[next].isGroundConnected=true;queue.push(next)}}}
 const visited=new Set(),clusters=[];
 for(const start of Object.keys(nodes)){if(visited.has(start))continue;const nodeKeys=[],q=[start];visited.add(start);let grounded=false;while(q.length){const key=q.shift(),n=nodes[key];nodeKeys.push(key);grounded=grounded||!!n.isGroundConnected;for(const next of adj[key]||[])if(!visited.has(next)){visited.add(next);q.push(next)}}const id=`cluster:${start}`;for(const key of nodeKeys){nodes[key].floatingClusterId=id;nodes[key].isFreefalling=!grounded}clusters.push({id,nodeKeys:new Set(nodeKeys),grounded,isFloating:!grounded,mass:nodeKeys.reduce((sum,key)=>sum+Math.max(.01,nodes[key].mass||.01),0)});}
 sim.floatingClusters=clusters.filter(c=>c.isFloating);
 for(const link of sim.memberLinks){const e=link.e,a=nodes[link.nodeA],b=nodes[link.nodeB];if(!a||!b)continue;e.clusterId=a.floatingClusterId===b.floatingClusterId?a.floatingClusterId:null;e.isFreefalling=!a.isGroundConnected&&!b.isGroundConnected&&!e.failed;e.state=e.failed?(e.shattered?'SHATTERED':'FAILED'):e.snapped?'SNAPPED':e.isFreefalling?'FLOATING':(e.utilization||0)>1?'OVERLOADED':'SUPPORTED';}
 for(let level=0;level<=NY;level++){
  const floor=sim.floors[level];floor.connections=[];
  if(level>0)for(const [key,col] of Object.entries(BuildingMap.columns))if(col.y===level-1&&!col.failed&&col.integrity>0){floor.connections.push({type:'column',key,x:col.x,capacity:col.capacity*col.integrity})}
  const levelNodes=Object.values(nodes).filter(n=>n.referenceLevel===level);let mass=0;for(const group of ['beams','slabs'])for(const e of Object.values(BuildingMap[group]))if(e.y===level&&!e.failed)mass+=e.mass;for(const e of Object.values(BuildingMap.braces))if(!e.failed&&(e.y===level||e.y+1===level))mass+=e.mass*.5;for(const load of Object.values(BuildingMap.loads))if(load.y===level&&!load.failed)mass+=load.mass;for(const col of Object.values(BuildingMap.columns))if(!col.failed&&(col.y===level-1||col.y===level))mass+=col.mass*.5;
  floor.mass=mass;floor.isSupported=level===0||levelNodes.some(n=>n.isGroundConnected);floor.active=level===0||levelNodes.length>0;floor.supportCapacity=floor.connections.reduce((sum,c)=>sum+c.capacity,0);
  if(levelNodes.length){floor.position.y=levelNodes.reduce((sum,n)=>sum+n.position.y,0)/levelNodes.length;floor.velocity.y=levelNodes.reduce((sum,n)=>sum+n.velocity.y,0)/levelNodes.length;floor.isFalling=levelNodes.some(n=>n.isFreefalling&&n.velocity.y<-.12)}floor.updateCollisionBounds();
 }
}
function refreshFloorConnections(){refreshMemberTopology()}
function breakMemberConnections(link,reason){let changed=false;changed=link.connectionA.break(reason)||changed;changed=link.connectionB.break(reason)||changed;return changed}
function connectionFor(memberId,nodeKey){return sim.connections.find(c=>c.memberId===memberId&&c.nodeKey===nodeKey)}
function updateDebrisBounds(d){const hx=(Math.abs(Math.cos(d.angle))*d.length+Math.abs(Math.sin(d.angle))*d.thickness)*.5,hy=(Math.abs(Math.sin(d.angle))*d.length+Math.abs(Math.cos(d.angle))*d.thickness)*.5;d.collisionBounds={left:d.x-hx,right:d.x+hx,bottom:d.y-hy,top:d.y+hy};return d.collisionBounds}
// Keep debris inside the editable sandbox footprint. Side contacts dissipate energy rather than letting pieces drift into the blank canvas margins.
function containDebrisInGrid(d){if(!d)return false;const worldWidth=NX*STORY_HEIGHT,b=updateDebrisBounds(d),halfWidth=(b.right-b.left)*.5;let contacted=false;if(b.left<0){d.x+=-b.left+.002;if(d.vx<0)d.vx=-d.vx*.14;else d.vx*=.78;d.angularVelocity*=.78;contacted=true}else if(b.right>worldWidth){d.x-=b.right-worldWidth+.002;if(d.vx>0)d.vx=-d.vx*.14;else d.vx*=.78;d.angularVelocity*=.78;contacted=true}if(halfWidth*2>=worldWidth){d.x=worldWidth*.5;d.vx*=.1;d.angularVelocity*=.75;contacted=true}if(Math.abs(d.vx)<.035)d.vx=0;updateDebrisBounds(d);return contacted}
function addAtmosphericParticle(particle){
 if(!sim.atmosphericParticles)sim.atmosphericParticles=[];
 const particles=sim.atmosphericParticles,limit=Math.max(1,MAX_ATMOSPHERIC_PARTICLES||360);
 if(particles.length>=limit){
  // Prefer retaining fresh, impact-driven dust while trimming the oldest visual-only particles.
  let removeAt=0,oldest=-Infinity;
  for(let i=0;i<particles.length;i++){const ageScore=particles[i].age/(particles[i].life||1)+(particles[i].kind==='dust'?.18:0);if(ageScore>oldest){oldest=ageScore;removeAt=i}}
  particles.splice(removeAt,1);
 }
 particles.push(particle);
}
function spawnDustPlume(x,y,intensity=1,sourceVx=0,sourceVy=0){
 if(!Number.isFinite(x+y))return;
 intensity=clamp(Number(intensity)||1,.2,3.4);
 const count=Math.round(9+intensity*9),horizontalDrift=clamp(Number(sourceVx)||0,-3.5,3.5)*.12;
 for(let i=0;i<count;i++){
  const spread=(Math.random()*2-1),upward=Math.random(),life=6.5+Math.random()*(2.0+intensity*.4);
  addAtmosphericParticle({kind:'dust',x:x+spread*.055*intensity,y:y+(Math.random()-.5)*.08*intensity,vx:horizontalDrift+spread*(.16+Math.random()*.46)*intensity,vy:.12+upward*(.22+.22*intensity)+Math.max(0,Number(sourceVy)||0)*.035,age:0,life,size:.035+Math.random()*(.055+.025*intensity),growth:.018+Math.random()*.045,opacity:.19+Math.random()*.2,rotation:Math.random()*Math.PI,spin:(Math.random()-.5)*.45,drift: .12+Math.random()*.38,seed:Math.random()*Math.PI*2,tint:Math.random()});
 }
}
function spawnSmokePuff(x,y,sourceVx=0,sourceVy=0,scale=1){
 if(!Number.isFinite(x+y))return;
 scale=clamp(Number(scale)||1,.5,1.8);
 addAtmosphericParticle({kind:'smoke',x:x+(Math.random()-.5)*.035,y,vx:clamp((Number(sourceVx)||0)*.10+(Math.random()-.5)*.22,-.8,.8),vy:.28+Math.random()*.28+Math.max(0,Number(sourceVy)||0)*.04,age:0,life:3.8+Math.random()*2.2,size:.07+Math.random()*.055,growth:.11+Math.random()*.095,opacity:.24+Math.random()*.16,rotation:Math.random()*Math.PI,spin:(Math.random()-.5)*.22,drift:.13+Math.random()*.27,seed:Math.random()*Math.PI*2,tint:Math.random(),scale});
}
function emitFireSmoke(dt){
 const emitBudget=7;let emitted=0;
 // Member plumes originate along the burning span, rather than from a fixed screen-space point.
 for(const link of sim.memberLinks){
  const e=link.e;if(!e.burning||e.failed)continue;
  const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
  e.smokeEmissionClock=(e.smokeEmissionClock||0)+dt;
  const interval=.105+(e.x%3)*.012;
  if(e.smokeEmissionClock<interval||emitted>=emitBudget)continue;
  e.smokeEmissionClock%=interval;const t=.2+Math.random()*.6;
  spawnSmokePuff(a.position.x+(b.position.x-a.position.x)*t,a.position.y+(b.position.y-a.position.y)*t,a.velocity.x+(b.velocity.x-a.velocity.x)*t,a.velocity.y+(b.velocity.y-a.velocity.y)*t,.8+Math.random()*.45);emitted++;
 }
 for(const d of sim.debris){
  if(!d.burning||emitted>=emitBudget)continue;
  d.smokeEmissionClock=(d.smokeEmissionClock||0)+dt;
  if(d.smokeEmissionClock<.13)continue;
  d.smokeEmissionClock%=.13;spawnSmokePuff(d.x,d.y+Math.max(.04,d.thickness*.45),d.vx,d.vy,.85+Math.random()*.35);emitted++;
 }
}
function updateAtmosphericParticles(dt){
 const step=clamp(Number(dt)||0,0,.05);if(step<=0)return;
 // This visual clock runs even while physics is paused, so existing embers keep trailing smoke.
 emitFireSmoke(step);
 const particles=sim.atmosphericParticles||[];
 for(let i=particles.length-1;i>=0;i--){
  const p=particles[i];p.age+=step;
  if(p.age>=p.life){particles.splice(i,1);continue}
  const phase=p.seed+p.age*(p.kind==='smoke'?1.65:2.6),rise=p.kind==='smoke'?.27:.035;
  p.vx+=(Math.sin(phase)*p.drift-(p.vx||0)*(p.kind==='smoke'?.055:.16))*step;
  p.vy+=rise*step;p.x+=p.vx*step;p.y+=p.vy*step;p.size+=p.growth*step;p.rotation+=(p.spin||0)*step;
 }
}
function drawAtmosphericParticles(){
 const particles=sim.atmosphericParticles||[];if(!particles.length)return;
 ctx.save();ctx.globalCompositeOperation='source-over';
 for(const p of particles){
  const life=clamp(1-p.age/p.life,0,1),fadeIn=clamp(p.age/(p.kind==='smoke'?.22:.10),0,1),alpha=(p.opacity||.2)*fadeIn*Math.pow(life,p.kind==='smoke'?.72:1.15),x=GRID_LEFT+p.x/STORY_HEIGHT*DX,y=GROUND_Y-p.y/STORY_HEIGHT*STORY_PX,r=Math.max(1.15,p.size*STORY_PX*(p.kind==='smoke'?1.22:1));
  if(x<-r*2||x>W+r*2||y<-r*2||y>H+r*2||alpha<.008)continue;
  ctx.globalAlpha=alpha;
  const gradient=ctx.createRadialGradient(x-r*.18,y-r*.18,r*.035,x,y,r);
  if(p.kind==='smoke'){
   const shade=clamp(Math.round(86+p.tint*65+(1-life)*16),65,170),green=clamp(shade+3,0,185),blue=clamp(shade+9,0,195);
   gradient.addColorStop(0,`rgba(${shade},${green},${blue},.58)`);gradient.addColorStop(.38,`rgba(${shade+7},${green+5},${blue+5},.34)`);gradient.addColorStop(.74,`rgba(${shade+12},${green+10},${blue+8},.13)`);
  }else{
   const red=Math.round(143+p.tint*70),green=Math.round(116+p.tint*51),blue=Math.round(80+p.tint*36);
   gradient.addColorStop(0,`rgba(${red+18},${green+12},${blue+8},.58)`);gradient.addColorStop(.42,`rgba(${red},${green},${blue},.37)`);gradient.addColorStop(.78,`rgba(${red-7},${green-5},${blue-3},.12)`);
  }
  gradient.addColorStop(1,'rgba(0,0,0,0)');ctx.fillStyle=gradient;ctx.beginPath();ctx.ellipse(x,y,r*(p.kind==='smoke'?.90:1.12),r*(p.kind==='smoke'?1.16:.82),p.rotation||0,0,Math.PI*2);ctx.fill();
 }
 ctx.restore();
}
function spawnMemberDebris(link,reason='member failure'){
 if(!link||link.e.debrisSpawned)return null;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)return null;
 const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,fullLength=Math.max(.15,Math.hypot(dx,dy)),ux=dx/fullLength,uy=dy/fullLength,material=link.e.material,kind=link.e.kind,angle=Math.atan2(dy,dx),e=link.e;
 const nodeAngular=(dx*(b.velocity.y-a.velocity.y)-dy*(b.velocity.x-a.velocity.x))/(fullLength*fullLength),energyKick=clamp(Math.sqrt(Math.max(0,e.lastImpactEnergy||0)/Math.max(.04,e.mass))*.055,.025,.7),fractureKick=/impact|explosion|shatter|instant fracture|fracture/i.test(reason)?energyKick:.10;
 const halves=[];
 for(let i=0;i<2;i++){
  const sign=i===0?-1:1,t=i===0?.25:.75,centerOffset=(i===0?-.014:.014),halfLength=fullLength*.5;
  const fragment={id:sim.nextDebrisId++,sourceId:`${link.id}:half${i+1}`,parentSourceId:link.id,kind,material,x:a.position.x+dx*t+ux*centerOffset,y:a.position.y+dy*t+uy*centerOffset,angle:angle+sign*.012,length:halfLength,thickness:kind==='slab'?.16:kind==='column'?.12:kind==='brace'?.075:.1,mass:Math.max(.01,e.mass*.5),capacity:Math.max(.01,e.capacity*.5),impactResistance:e.impactResistance||IMPACT_RESISTANCE[material]?.[kind]||1,durability:Math.max(.25,(e.durability||e.capacity*IMPACT_ENERGY_PER_CAPACITY)*.5),integrity:clamp(e.integrity,0,1),vx:clamp(a.velocity.x+(b.velocity.x-a.velocity.x)*t+sign*ux*fractureKick,-MAX_FALL_SPEED,MAX_FALL_SPEED),vy:clamp(a.velocity.y+(b.velocity.y-a.velocity.y)*t+sign*uy*fractureKick-.025,-MAX_FALL_SPEED,MAX_FALL_SPEED),angularVelocity:clamp(nodeAngular+sign*(/impact|explosion|shatter|fracture/i.test(reason)?.12:.035),-3.4,3.4),momentOfInertia:Math.max(.01,e.mass*.5*halfLength*halfLength/12),tipDirection:sign,age:0,settled:false,grounded:false,reason:`fractured half ${i+1}/2 · ${reason}`,impactCooldown:-Infinity,impactCount:0,fragmentDepth:0,fragmented:false,fractureHalf:i+1,burning:!!e.burning,fuelRemaining:Math.max(0,(Number(e.fuelRemaining)||0)*.5),heatExposure:0,fireSpreadClock:0,explosiveSpent:!!e.detonated};
  updateDebrisBounds(fragment);halves.push(fragment);
 }
 // Keep half the original member mass in each fragment; the two pieces separate at the fracture plane.
 sim.debris.push(...halves);if(sim.debris.length>MAX_DEBRIS){sim.debris.sort((x,y)=>Number(y.settled)-Number(x.settled)||y.age-x.age);sim.debris.splice(0,sim.debris.length-MAX_DEBRIS)}e.debrisSpawned=true;e.failureReason=reason;
 const cx=(a.position.x+b.position.x)*.5,cy=(a.position.y+b.position.y)*.5;
 sim.explosionEffects.push({x:cx,y:cy,radius:.20,age:0,duration:.22,particles:Array.from({length:8},(_,i)=>({angle:i*Math.PI/4,length:.28+(i%3)*.11,size:1.1+(i%2)*.35}))});if(sim.explosionEffects.length>12)sim.explosionEffects.splice(0,sim.explosionEffects.length-12);
 return halves;
}
function failMember(link,reason='structural failure'){
 if(!link||link.e.failed)return false;const e=link.e,a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];spawnMemberDebris(link,reason);if(a&&b){const speed=Math.max(Math.hypot(a.velocity.x,a.velocity.y),Math.hypot(b.velocity.x,b.velocity.y)),impact=Math.sqrt(Math.max(0,Number(e.lastImpactEnergy)||0)/Math.max(.05,e.mass||.05)),intensity=clamp(.48+speed*.30+Math.min(1.25,impact*.12),.45,2.6);spawnDustPlume((a.position.x+b.position.x)*.5,(a.position.y+b.position.y)*.5,intensity,(a.velocity.x+b.velocity.x)*.5,(a.velocity.y+b.velocity.y)*.5)}e.failed=true;e.integrity=0;e.structuralIntegrity=0;e.shattered=/shatter|instant fracture|catastrophic impact/i.test(reason);e.state=e.shattered?'SHATTERED':'FAILED';e.failureReason=reason;breakMemberConnections(link,reason);sim.localFailureCount++;sim.lastEvent=e.shattered?`IMPACT SHATTER · ${e.kind.toUpperCase()} ${link.key}`:`LOCAL MEMBER FAILURE · ${e.kind.toUpperCase()} ${link.key}`;sim.eventUntil=sim.time+3.5;return true;
}

function analyzeStructure(){
 const nodeLoads=Array.from({length:NY+1},()=>Array(NX+1).fill(0)),issues=[],warnings=[],unsupportedFloors=[];
 let maxUtil=0,integritySum=0,integrityN=0,overloaded=0;
 const activeMember=(group,key)=>{const e=BuildingMap[group][key];if(!e||e.failed||e.snapped||e.integrity<=.001)return null;const id=`${group}|${key}`,sa=sim.connectionStates[connectionId(id,'a')],sb=sim.connectionStates[connectionId(id,'b')];if(sa?.broken||sb?.broken)return null;e.connectionFactor=clamp(Math.min(sa?.stiffnessFactor??1,sb?.stiffnessFactor??1),.18,1);return e};
 const activeColumn=(x,y)=>activeMember('columns',keyOf(x,y));
 const activeBeam=(x,y)=>activeMember('beams',keyOf(x,y));
 const beamPath=(startX,level)=>{
  const q=[{x:startX,path:[]}],seen=new Set([startX]),recipients=[];
  while(q.length){const cur=q.shift(),col=activeColumn(cur.x,level-1);if(col&&cur.path.length>0||col&&cur.x!==startX)recipients.push({x:cur.x,col,path:cur.path});
   for(const bx of [cur.x-1,cur.x]){if(bx<0||bx>=NX)continue;const beam=activeBeam(bx,level);if(!beam)continue;const nx=bx===cur.x?cur.x+1:cur.x-1;if(seen.has(nx))continue;seen.add(nx);q.push({x:nx,path:[...cur.path,bx]})}
  }
  return recipients;
 };
 for(let y=1;y<=NY;y++)for(let x=0;x<NX;x++){
  const slab=BuildingMap.slabs[keyOf(x,y)],beam=BuildingMap.beams[keyOf(x,y)],load=BuildingMap.loads[keyOf(x,y)];
  const bayMass=(slab&&!slab.failed?slab.mass:0)+(load&&!load.failed?load.mass:0)+(beam&&!beam.failed?beam.mass:0);
  nodeLoads[y][x]+=bayMass/2;nodeLoads[y][x+1]+=bayMass/2;
  if((slab&&!slab.failed||load&&!load.failed)&&!baySupported(x,y)){unsupportedFloors.push({x,y});if(!slab||slab.failed)issues.push(`Load at bay ${x+1}, level ${y} has no slab.`);else issues.push(`Bay ${x+1}, level ${y} has insufficient support.`)}
  if(load&&!load.failed)load.unsupported=!(slab&&!slab.failed)&&!baySupported(x,y);
  if(slab&&!slab.failed){const d=(load&&!load.failed?load.mass:0)+slab.mass*.28;slab.demand=d;slab.unsupported=slab.snapped||!baySupported(x,y);slab.utilization=slab.snapped?Math.max(1.05,d/Math.max(.01,slab.capacity*slab.integrity*Math.max(.18,slab.connectionFactor||1))):d/Math.max(.01,slab.capacity*slab.integrity*Math.max(.18,slab.connectionFactor||1));slab.isLoaded=d>.02;slab.isStressed=slab.utilization>.8;maxUtil=Math.max(maxUtil,slab.utilization);if(slab.utilization>1)overloaded++}
 }
 // Debris resting on a floor acts as temporary added mass; ground debris is handled as an obstacle instead.
 for(const d of sim.debris||[]){if(!d.settled||d.y<STORY_HEIGHT*.45||d.y>NY*STORY_HEIGHT+STORY_HEIGHT*.2)continue;const level=clamp(Math.round(d.y/STORY_HEIGHT),1,NY),bay=clamp(Math.floor(d.x/STORY_HEIGHT),0,NX-1);nodeLoads[level][bay]+=d.mass*.5;nodeLoads[level][bay+1]+=d.mass*.5;}
 for(const l of Object.values(BuildingMap.loads)){if(l.failed)continue;l.capacity=0;l.demand=l.mass;l.utilization=l.unsupported?9:0;l.integrity??=1;}
 const beamRedistribution=Object.create(null),columnDemand=Object.create(null);for(const [key,col] of Object.entries(BuildingMap.columns)){col.demand=0;col.unsupported=false;columnDemand[key]=0}
 let carried=Array(NX+1).fill(0),unresolved=0;
 for(let level=NY;level>=1;level--){
  const incoming=nodeLoads[level].map((v,x)=>Math.max(0,v+carried[x])),delivered=Array(NX+1).fill(0),nextCarry=Array(NX+1).fill(0);
  for(let x=0;x<=NX;x++){
   const weight=incoming[x];if(weight<.0001)continue;const col=activeColumn(x,level-1);
   if(col){delivered[x]+=weight;continue}
   const recipients=beamPath(x,level);
   if(!recipients.length){unresolved+=weight;if(weight>.04)warnings.push(`Uncarried load ${weight.toFixed(2)} at node x=${x}, level ${level} has no healthy route to a lower support.`);continue}
   // Beam continuity redistributes load to surviving neighbouring column paths in proportion to remaining capacity.
   const total=recipients.reduce((sum,r)=>sum+Math.max(.01,r.col.capacity*r.col.integrity*Math.max(.18,r.col.connectionFactor||1)),0);
   for(const r of recipients){const share=weight*Math.max(.01,r.col.capacity*r.col.integrity*Math.max(.18,r.col.connectionFactor||1))/total;delivered[r.x]+=share;for(const bx of r.path){const beamKey=keyOf(bx,level);beamRedistribution[beamKey]=(beamRedistribution[beamKey]||0)+share/Math.max(1,r.path.length)*.42}}
  }
  for(let x=0;x<=NX;x++){
   const col=activeColumn(x,level-1);if(!col||delivered[x]<=0)continue;const key=keyOf(x,level-1);col.demand+=delivered[x]+col.mass*.5;nextCarry[x]+=delivered[x]+col.mass;
  }
  carried=nextCarry;
 }
 for(const [key,col] of Object.entries(BuildingMap.columns)){
  if(col.failed){col.demand=col.mass;col.utilization=9;col.unsupported=true;continue}
  const bottomSupported=columnStacked(col.x,col.y)||beamComponentHasSupport(col.x,col.y);col.unsupported=!bottomSupported&&col.demand>.04;
  col.utilization=col.demand/Math.max(.01,col.capacity*col.integrity*Math.max(.18,col.connectionFactor||1));if(col.unsupported)col.utilization=Math.max(1.12,col.utilization);
  col.isLoaded=col.demand>.02;col.isStressed=col.utilization>.8;maxUtil=Math.max(maxUtil,col.utilization);if(col.utilization>1)overloaded++;
 }
 for(const [key,beam]of Object.entries(BuildingMap.beams)){
  if(beam.failed){beam.demand=beam.mass;beam.utilization=9;beam.unsupported=true;continue}
  const slab=BuildingMap.slabs[keyOf(beam.x,beam.y)],load=BuildingMap.loads[keyOf(beam.x,beam.y)];let d=(slab&&!slab.failed?slab.mass*.28:0)+(load&&!load.failed?load.mass:0)+beam.mass*.7+(beamRedistribution[key]||0)+Math.max(0,beam.catenaryTension||0)*.09+Math.max(0,beam.plasticSag||0)*beam.capacity*.06;
  beam.demand=d;beam.unsupported=beam.snapped||!baySupported(beam.x,beam.y);beam.isLoaded=d>.02;
  if(beam.snapped){beam.bendingMoment=Math.max(beam.bendingMoment||0,beam.momentCapacity||0);beam.momentUtilization=Math.max(1.05,beam.momentUtilization||0);beam.utilization=Math.max(1.05,d/Math.max(.01,beam.capacity*beam.integrity*Math.max(.18,beam.connectionFactor||1)),beam.momentUtilization);beam.isStressed=true;maxUtil=Math.max(maxUtil,beam.utilization);overloaded++;continue}
  const bending=beamBendingData(beam);beam.bendingMoment=bending.moment;beam.effectiveSpan=bending.span.bays;beam.momentUtilization=bending.moment/Math.max(.01,(beam.momentCapacity||beam.capacity*.42)*beam.integrity*Math.max(.18,beam.connectionFactor||1));
  beam.utilization=Math.max(d/Math.max(.01,beam.capacity*beam.integrity*Math.max(.18,beam.connectionFactor||1)),beam.momentUtilization);beam.isStressed=beam.utilization>.8;maxUtil=Math.max(maxUtil,beam.utilization);if(beam.utilization>1)overloaded++;
 }
 for(const [key,brace]of Object.entries(BuildingMap.braces)){
  if(brace.failed){brace.demand=brace.mass;brace.utilization=9;brace.unsupported=true;continue}
  const ends=endpointKeys('braces',brace),a=sim.nodes[ends[0]],b=sim.nodes[ends[1]],loadA=a?nodeLoads[a.referenceLevel]?.[a.gridX]||0:0,loadB=b?nodeLoads[b.referenceLevel]?.[b.gridX]||0:0;
  brace.demand=brace.mass*.65+(loadA+loadB)*.11+Math.abs(brace.lateralForce||0)*.22+Math.max(0,brace.impactStress||0)*brace.capacity*.08;
  const liveEnds=ends.filter(k=>sim.nodes[k]?.isGroundConnected).length;brace.unsupported=liveEnds===0;brace.utilization=brace.demand/Math.max(.01,brace.capacity*brace.integrity*Math.max(.18,brace.connectionFactor||1));if(brace.unsupported)brace.utilization=Math.max(brace.utilization,.72);
  brace.isLoaded=brace.demand>.02;brace.isStressed=brace.utilization>.8;maxUtil=Math.max(maxUtil,brace.utilization);if(brace.utilization>1)overloaded++;
 }
 for(const {e} of allMembers()){
  integritySum+=clamp(e.integrity,0,1);integrityN++;
  if(e.failed){e.integrity=0;e.structuralIntegrity=0;e.state=e.shattered?'SHATTERED':'FAILED'}else if(e.snapped){e.structuralIntegrity=e.integrity;e.state='SNAPPED'}else{e.structuralIntegrity=e.integrity;e.state=(e.utilization||0)>1?'OVERLOADED':e.isFreefalling?'FLOATING':'SUPPORTED'}
  e.isLoaded=(e.demand||0)>.02;e.isStressed=(e.utilization||0)>.8;
 }
 const count=totalCount();if(!count)issues.push('No elements in the design yet.');
 if(memberCount()>0&&Object.values(BuildingMap.slabs).every(e=>e.failed)&&Object.keys(BuildingMap.loads).length===0)issues.push('No active floor slabs or loads remain; a complete gravity load path cannot be verified.');
 for(let x=0;x<=NX;x++)for(let y=0;y<NY;y++){const c=BuildingMap.columns[keyOf(x,y)];if(c&&!c.failed&&c.y>0&&!columnStacked(c.x,c.y))warnings.push(`Column at x=${x}, story ${y+1} has a broken vertical support path.`)}
 const uniqueIssues=[...new Set(issues)],uniqueWarnings=[...new Set(warnings)];
 return {maxUtil,overloaded,unsupportedFloors,issues:uniqueIssues,warnings:uniqueWarnings,count,memberCount:memberCount(),failedMembers:allMembers().filter(({e})=>e.failed||e.snapped).length,integrity:integrityN?integritySum/integrityN:1,nodeLoads,unresolvedLoad:unresolved};
}
function getClosestSupportToCom(comX,supportPoints){if(!supportPoints.length)return null;return supportPoints.reduce((best,p)=>Math.abs(p.x-comX)<Math.abs(best.x-comX)?p:best,supportPoints[0])}
function isCoMWithinBase(comX,supportPoints){if(!supportPoints.length)return false;const xs=supportPoints.map(p=>p.x),minX=Math.min(...xs),maxX=Math.max(...xs);if(maxX-minX<STORY_HEIGHT*.08)return Math.abs(comX-minX)<=STORY_HEIGHT*.08;return comX>=minX&&comX<=maxX}
function calculateStability(analysis){
 const nodes=sim.nodes||Object.create(null),links=sim.memberLinks||[],nodeKeys=Object.keys(nodes),adj=Object.create(null),nodeAssembly=Object.create(null),components=[];
 for(const key of nodeKeys)adj[key]=[];
 for(const link of links){if(!linkTransfersSupport(link))continue;adj[link.nodeA]?.push(link.nodeB);adj[link.nodeB]?.push(link.nodeA)}
 for(const start of nodeKeys){if(nodeAssembly[start])continue;const keys=[],queue=[start],id=`asm:${start}`;nodeAssembly[start]=id;while(queue.length){const key=queue.shift();keys.push(key);for(const next of adj[key]||[])if(!nodeAssembly[next]){nodeAssembly[next]=id;queue.push(next)}}components.push({id,nodeKeys:new Set(keys),members:[],memberIds:new Set(),mass:0,weightedX:0,weightedY:0,supportPoints:[]})}
 const byId=Object.create(null);for(const c of components)byId[c.id]=c;
 const addMass=(c,m,x,y)=>{if(!c||!Number.isFinite(m)||m<=0)return;c.mass+=m;c.weightedX+=m*x;c.weightedY+=m*y};
 // Each member's mass is assigned to the connected assembly at its intact end(s).
 for(const link of links){const e=link.e;if(e.failed||e.integrity<=.02)continue;const aId=nodeAssembly[link.nodeA],bId=nodeAssembly[link.nodeB],aAlive=!link.connectionA.broken,bAlive=!link.connectionB.broken,a=nodes[link.nodeA],b=nodes[link.nodeB];if(!a||!b)continue;const m=Math.max(.01,e.mass);if(e.snapped){const ca=byId[aId],cb=byId[bId];if(ca)addMass(ca,m*(ca===cb?1:.5),a.position.x,a.position.y);if(cb&&cb!==ca)addMass(cb,m*.5,b.position.x,b.position.y);continue}let target=null;if(aAlive&&bAlive&&aId===bId)target=byId[aId];else if(aAlive)target=byId[aId];else if(bAlive)target=byId[bId];if(!target)continue;addMass(target,m,(a.position.x+b.position.x)*.5,(a.position.y+b.position.y)*.5);target.members.push(link);target.memberIds.add(link.id)}
 // Loads contribute at their actual bay centre, split between disconnected endpoint assemblies when needed.
 for(const load of Object.values(BuildingMap.loads)){if(load.failed||load.integrity<=.02)continue;const a=nodes[keyOf(load.x,load.y)],b=nodes[keyOf(load.x+1,load.y)];if(!a&&!b)continue;const aId=a?nodeAssembly[a.key]:null,bId=b?nodeAssembly[b.key]:null,ca=aId?byId[aId]:null,cb=bId?byId[bId]:null,m=Math.max(.01,load.mass);if(ca&&ca===cb)addMass(ca,m,(a.position.x+b.position.x)*.5,(a.position.y+b.position.y)*.5);else if(ca&&cb){addMass(ca,m*.5,a.position.x,a.position.y);addMass(cb,m*.5,b.position.x,b.position.y)}else if(ca)addMass(ca,m,(a.position.x+(b?.position.x??a.position.x))*.5,(a.position.y+(b?.position.y??a.position.y))*.5);else if(cb)addMass(cb,m,((a?.position.x??b.position.x)+b.position.x)*.5,((a?.position.y??b.position.y)+b.position.y)*.5)}
 // Only an intact base column with both end joints intact counts as a foundation contact.
 for(const link of links){const e=link.e;if(e.kind!=='column'||e.y!==0||e.failed||e.integrity<=.02||link.connectionA.broken||link.connectionB.broken)continue;const c=byId[nodeAssembly[link.nodeB]],base=nodes[link.nodeA];if(c&&base)c.supportPoints.push({x:base.position.x,capacity:Math.max(.01,e.capacity*e.integrity),memberId:link.id})}
 const previous=sim.assemblyDynamics||Object.create(null),nextDynamics=Object.create(null),assemblies=[];
 for(const c of components){
  if(c.mass<=.001){for(const key of c.nodeKeys){const n=nodes[key];if(n)addMass(c,Math.max(.005,n.mass||.005),n.position.x,n.position.y)}}
  c.comX=c.mass?c.weightedX/c.mass:0;c.comY=c.mass?c.weightedY/c.mass:0;c.totalMass=Math.max(.01,c.mass);c.supportPoints=c.supportPoints.filter((p,i,arr)=>arr.findIndex(q=>Math.abs(q.x-p.x)<.01)===i).sort((a,b)=>a.x-b.x);
  c.minSupportX=c.supportPoints.length?Math.min(...c.supportPoints.map(p=>p.x)):null;c.maxSupportX=c.supportPoints.length?Math.max(...c.supportPoints.map(p=>p.x)):null;
  c.withinBase=isCoMWithinBase(c.comX,c.supportPoints);c.outside=c.supportPoints.length===0||!c.withinBase;c.isFloating=c.supportPoints.length===0&&c.members.length>0&&[...c.nodeKeys].some(key=>!nodes[key]?.isGroundConnected);
  c.supportCentroid=c.supportPoints.length?c.supportPoints.reduce((sum,p)=>sum+p.x*p.capacity,0)/c.supportPoints.reduce((sum,p)=>sum+p.capacity,0):c.comX;
  c.projectedX=c.supportPoints.length?clamp(c.comX,c.minSupportX,c.maxSupportX):c.comX;
  let pivot=getClosestSupportToCom(c.comX,c.supportPoints);if(c.supportPoints.length>1&&c.comX<c.minSupportX)pivot=c.supportPoints[0];else if(c.supportPoints.length>1&&c.comX>c.maxSupportX)pivot=c.supportPoints[c.supportPoints.length-1];
  c.pivotX=pivot?pivot.x:c.comX;c.pivotY=0;c.shouldTip=c.supportPoints.length>0&&c.outside;c.tippingDirection=c.comX<c.minSupportX?'left':c.comX>c.maxSupportX?'right':'unsupported';
  c.marginWorld=c.supportPoints.length>1?Math.min(c.comX-c.minSupportX,c.maxSupportX-c.comX):c.supportPoints.length===1?STORY_HEIGHT*.5-Math.abs(c.comX-c.supportPoints[0].x):0;
  c.stabilityMetric=c.supportPoints.length>1?clamp((2*c.marginWorld/Math.max(.01,c.maxSupportX-c.minSupportX))*100,0,100):c.supportPoints.length===1?clamp((1-Math.abs(c.comX-c.supportPoints[0].x)/(STORY_HEIGHT*.5))*100,0,100):0;
  // Moment of inertia uses member and load masses already accumulated into the assembly CoM.
  let inertia=0;for(const link of c.members){const a=nodes[link.nodeA],b=nodes[link.nodeB];if(!a||!b)continue;const x=(a.position.x+b.position.x)*.5,y=(a.position.y+b.position.y)*.5;inertia+=Math.max(.01,link.e.mass)*((x-c.pivotX)**2+(y-c.pivotY)**2)}for(const key of c.nodeKeys){const n=nodes[key];if(n&&n.mass>0)inertia+=Math.min(.08,n.mass)*((n.position.x-c.pivotX)**2+n.position.y**2)}c.momentOfInertia=Math.max(.25,inertia);
  c.key=`${[...c.nodeKeys].sort().join('|')}`;let dyn=previous[c.key];if(!dyn){let overlapBest=0;for(const old of Object.values(previous)){const oldKeys=old.nodeKeys instanceof Set?old.nodeKeys:new Set(old.nodeKeys||[]);let overlap=0;for(const k of c.nodeKeys)if(oldKeys.has(k))overlap++;if(overlap>overlapBest){overlapBest=overlap;dyn=old}}}dyn={rotation:Number(dyn?.rotation)||0,angularVelocity:Number(dyn?.angularVelocity)||0,angularAcceleration:Number(dyn?.angularAcceleration)||0,torque:Number(dyn?.torque)||0,isRotating:!!dyn?.isRotating,pivotX:c.pivotX,pivotY:0,momentOfInertia:c.momentOfInertia,nodeKeys:new Set(c.nodeKeys)};dyn.pivotX=c.pivotX;dyn.pivotY=0;dyn.momentOfInertia=c.momentOfInertia;c.dynamics=dyn;if(!c.shouldTip&&Math.abs(dyn.rotation)>.01)c.tippingDirection=dyn.rotation<0?'right':'left';nextDynamics[c.key]=dyn;for(const key of c.nodeKeys)nodeAssembly[key]=c.key;c.id=c.key;assemblies.push(c);byId[c.key]=c;
 }
 sim.assemblyDynamics=nextDynamics;sim.stability={assemblies,primary:null,nodeAssembly,byId};
 const eligible=assemblies.filter(c=>c.members.length||c.supportPoints.length).sort((a,b)=>{const ar=a.supportPoints.length?1:0,br=b.supportPoints.length?1:0;if(ar!==br)return br-ar;return b.totalMass-a.totalMass});
 const risk=eligible.filter(c=>c.shouldTip||c.isFloating).sort((a,b)=>b.totalMass-a.totalMass);sim.stability.primary=risk[0]||eligible[0]||null;
 // Translational and rotational inertia are exposed in the live assembly details for diagnostics.
 for(const c of assemblies){
  const dyn=c.dynamics,angle=Math.abs(dyn.rotation),excess=Math.max(0,angle-CRITICAL_TILT),multiplier=Math.exp(Math.min(3.1,excess*6.0))*(dyn.isRotating?1+Math.min(1.3,Math.abs(dyn.angularVelocity)*.22):1);
  for(const link of c.members){const e=link.e,base=Number(e.utilization)||0;e.dynamicUtilization=base*multiplier+(dyn.isRotating?Math.min(1.5,Math.abs(dyn.angularVelocity)*.12):0);if(e.dynamicUtilization>base){e.utilization=Math.max(base,e.dynamicUtilization);if(analysis){analysis.maxUtil=Math.max(analysis.maxUtil,e.utilization);if(base<=1&&e.utilization>1)analysis.overloaded++}}}
 }
}
function calculateCollapseDynamics(assembly,dt){
 const dyn=assembly.dynamics;if(!dyn)return;dyn.pivotX=assembly.pivotX;dyn.pivotY=0;dyn.momentOfInertia=assembly.momentOfInertia;
 if(assembly.shouldTip){const leverArm=assembly.comX-assembly.pivotX;dyn.torque=-leverArm*assembly.totalMass*GRAVITY;dyn.angularAcceleration=clamp(dyn.torque/Math.max(.25,dyn.momentOfInertia),-4,4);dyn.isRotating=true;}
 else{dyn.torque=0;dyn.angularAcceleration=0;dyn.angularVelocity*=Math.exp(-ROTATION_DAMPING*dt);if(Math.abs(dyn.angularVelocity)<.008&&Math.abs(dyn.rotation)<.006){dyn.angularVelocity=0;dyn.rotation=0;dyn.isRotating=false}}
 dyn.angularVelocity=clamp(dyn.angularVelocity+dyn.angularAcceleration*dt,-2.8,2.8);dyn.rotation+=dyn.angularVelocity*dt;
 if(Math.abs(dyn.rotation)>CRITICAL_TILT&&assembly.members.length&&sim.time>=sim.eventUntil-.04){sim.lastEvent=`OVERTURNING INSTABILITY · ${assembly.tippingDirection.toUpperCase()}`;sim.eventUntil=sim.time+2.5}
}
function updateStabilityDynamics(dt){calculateStability(lastAnalysis||analyzeStructure());for(const assembly of sim.stability.assemblies)calculateCollapseDynamics(assembly,dt)}
let lastParallelScanAt=0,parallelScanBusy=false,parallelScanSignature='';
function scheduleParallelComputeScan(force=false){
 if(!window.FrameLabCompute||parallelScanBusy)return;
 const now=performance.now();
 if(!force&&now-lastParallelScanAt<900)return;
 // Only scan live structural members. Failed/snapped members are already out of
 // the authoritative structure and should not inflate this supplemental metric.
 const members=allMembers().filter(({e})=>!e.failed&&!e.snapped&&Number(e.integrity??1)>.001);
 const signature=`${members.length}:${Object.keys(BuildingMap.loads).length}`;
 if(!force&&signature===parallelScanSignature&&now-lastParallelScanAt<1800)return;
 lastParallelScanAt=now;parallelScanSignature=signature;parallelScanBusy=true;
 const demands=new Float32Array(members.length),capacities=new Float32Array(members.length);
 for(let i=0;i<members.length;i++){
  const e=members[i].e;
  const rawDemand=Number(e.demand);
  demands[i]=Number.isFinite(rawDemand)?Math.max(0,rawDemand):0;
  const rawCapacity=Number(e.capacity);
  const capacity=Number.isFinite(rawCapacity)?Math.max(0,rawCapacity):0;
  const integrity=clamp(Number(e.integrity??1)||0,0,1);
  const rawConnectionFactor=Number(e.connectionFactor??1);
  const connectionFactor=clamp(Number.isFinite(rawConnectionFactor)?rawConnectionFactor:1,.18,1);
  capacities[i]=Math.max(.01,capacity*integrity*connectionFactor);
 }
 window.FrameLabCompute.scan(demands,capacities).then(result=>{
  const sub=$('computeSub');
  if(sub)sub.textContent=`Supplemental demand/capacity scan · ${result.overloaded} at ≥100% · peak ${Math.round(result.maxUtil*100)}%`;
 }).catch(()=>{
  const sub=$('computeSub');
  if(sub)sub.textContent='Supplemental scan unavailable; structural analysis is still running normally.';
 }).finally(()=>{parallelScanBusy=false;});
}
function refreshAnalysis(){refreshMemberTopology();lastAnalysis=analyzeStructure();calculateStability(lastAnalysis);scheduleParallelComputeScan();return lastAnalysis}
function refreshAll(){refreshAnalysis();updateMetrics();draw()}
function updateMetrics(){const a=lastAnalysis||refreshAnalysis();$('utilMetric').textContent=a.maxUtil>=9?'∞':`${Math.round(a.maxUtil*100)}%`;$('utilMetric').style.color=a.maxUtil>=1?'#ff8290':a.maxUtil>=.72?'#ffcf73':'#73dfd1';$('memberMetric').textContent=`${a.memberCount} / ${Object.keys(BuildingMap.loads).length}`;const jointIntegrity=sim.connections.length?sim.connections.filter(c=>!c.broken).length/sim.connections.length:1;const overallIntegrity=.82*a.integrity+.18*jointIntegrity;$('integrityMetric').textContent=`${Math.round(overallIntegrity*100)}%`;$('timeMetric').textContent=`${sim.time.toFixed(1)} s`;$('stateMetric').textContent=sim.running?'Running · node/member physics':'Paused · editable';$('impactMetric').textContent=sim.lastImpactEnergy?sim.lastImpactEnergy.toFixed(2):'—';$('impactSub').textContent=sim.lastImpactEnergy?`${sim.lastImpactOutcome||'IMPACT'} · Level ${sim.lastImpactStory+1} · force ${sim.lastImpactForce.toFixed(1)} units`:'No impact recorded';const stability=sim.stability.primary;if(!stability){$('stabilityMetric').textContent=memberCount()?'NO STABLE ASSEMBLY':'—';$('stabilitySub').textContent=memberCount()?'No intact assembly with a connected foundation support':'Center of mass vs. base supports';$('stabilityMetric').style.color=memberCount()?'#ff8290':'#73dfd1'}else{const dyn=stability.dynamics,angle=Math.abs(dyn.rotation)*180/Math.PI;$('stabilityMetric').textContent=stability.supportPoints.length===0?'UNSUPPORTED':(stability.shouldTip||angle>=18)?`TILT ${angle.toFixed(0)}°`:`${Math.round(stability.stabilityMetric)}%`;$('stabilityMetric').style.color=stability.shouldTip||angle>=18?'#ff8290':stability.stabilityMetric<35?'#ffcf73':'#73dfd1';const margin=stability.supportPoints.length>1?stability.marginWorld/STORY_HEIGHT:Math.abs(stability.comX-(stability.supportPoints[0]?.x??stability.comX))/STORY_HEIGHT;$('stabilitySub').textContent=stability.supportPoints.length?`CoM margin ${stability.outside?'−':''}${Math.abs(margin).toFixed(2)} bays · ${stability.supportPoints.length} support(s) · ${angle.toFixed(1)}° tilt · ${sim.floatingClusters.length} floating cluster(s)`:`No foundation support in this assembly · ${sim.floatingClusters.length} floating cluster(s)`}$('liveDot').classList.toggle('running',sim.running);$('simulate').textContent=sim.running?'Ⅱ Pause':'▶ Simulate';const moving=sim.floors.slice(1).find(f=>f.isFalling||f.velocity.y<-.15);$('caseTitle').textContent=moving?`Independent member motion · level ${moving.level}`:(stability?.shouldTip||Math.abs(stability?.dynamics.rotation||0)>=CRITICAL_TILT)?`Directional instability · ${stability.tippingDirection}`:sim.running?'Sandbox physics running':`${a.count} components · ready`;}
function setStatus(message,event=false){$(event?'eventInfo':'validationResult').textContent=message}
function setMode(next){if(next!=='tether')gravityTether=null;mode=next;dragging=false;lastDragKey='';lastDragPt=null;buildLastCell=null;buildPainted=new Set();hover.valid=false;document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode))});updateToolStatus();draw();}
function updateToolStatus(){const kind=$('componentType').value;$('braceDirectionWrap').classList.toggle('hidden',kind!=='brace');const label=mode==='build'?`Build · ${$('componentType').selectedOptions[0].text}`:mode==='demolish'?'Demolition · click or drag to delete':mode==='load'?'Apply load · click a bay to add mass':mode==='push'?'Push · click a level to apply lateral impulse':mode==='ignite'?'Ignite · click flammable or explosive composites':mode==='tether'?'Gravity tether · drag a joint or debris with a damped spring':`Explosion · power ${$('explosionPower').value} · click inside the grid`;$('toolStatus').textContent=label;$('canvasTip').textContent=mode==='build'?'Build: click or drag to draw continuous columns, beams, slabs, diagonal braces, or X-bracing':mode==='demolish'?'Demolish: click or drag to delete; click debris to clear it':mode==='load'?'Apply load: click any bay to add mass':mode==='push'?'Push: click a level to push the structure left or right':mode==='ignite'?'Ignite: click a flammable composite to start a fire, or an explosive composite to trigger it':mode==='tether'?'Gravity tether: drag a joint or loose fragment; release to let it swing freely':'Explosion: click anywhere inside the grid to apply a radial blast';canvas.style.cursor=mode==='push'?'ew-resize':mode==='explosion'?'cell':mode==='ignite'?'copy':mode==='tether'?'grab':'crosshair'}
function isGridTarget(px,py,kind){
 if(px<GRID_LEFT-8||px>GRID_RIGHT+8||py<gridY(NY)-8||py>GROUND_Y+10)return false;
 if(kind==='column'){
  const x=Math.round((px-GRID_LEFT)/DX),lineX=GRID_LEFT+x*DX;
  return x>=0&&x<=NX&&Math.abs(px-lineX)<=Math.max(11,DX*.22)&&py>=gridY(NY)-4&&py<=GROUND_Y+5;
 }
 if(kind==='brace'||kind==='crossbrace')return px>=GRID_LEFT-2&&px<=GRID_RIGHT+2&&py>=gridY(NY)-2&&py<=GROUND_Y+2;
 if(px<GRID_LEFT-2||px>GRID_RIGHT+2)return false;
 const level=clamp(Math.round((GROUND_Y-py)/STORY_PX),1,NY);
 return Math.abs(py-gridY(level))<=13;
}
function snapColumn(px,py){let x=clamp(Math.round((px-GRID_LEFT)/DX),0,NX),story=0,best=Infinity;for(let y=0;y<NY;y++){const d=Math.abs(py-(gridY(y)+gridY(y+1))/2);if(d<best){best=d;story=y}}return{x,y:story}}
function snapBay(px,py){let x=0,bestX=Infinity;for(let i=0;i<NX;i++){const d=Math.abs(px-(GRID_LEFT+(i+.5)*DX));if(d<bestX){bestX=d;x=i}}let y=1,bestY=Infinity;for(let i=1;i<=NY;i++){const d=Math.abs(py-gridY(i));if(d<bestY){bestY=d;y=i}}return{x,y}}
function snapBrace(px,py){let x=0,bestX=Infinity;for(let i=0;i<NX;i++){const d=Math.abs(px-(GRID_LEFT+(i+.5)*DX));if(d<bestX){bestX=d;x=i}}const y=clamp(Math.floor((GROUND_Y-py)/STORY_PX),0,NY-1);return{x,y}}
function canvasCoords(e){const r=canvas.getBoundingClientRect();return{x:(e.clientX-r.left)*(W/r.width),y:(e.clientY-r.top)*(H/r.height)}}
function worldCoords(px,py){return{x:(px-GRID_LEFT)/DX*STORY_HEIGHT,y:(GROUND_Y-py)/STORY_PX*STORY_HEIGHT}}
function waterSurfaceWorld(){return ENVIRONMENT.waterLevel>0?NY*STORY_HEIGHT*ENVIRONMENT.waterLevel:-Infinity}
function getContactResponse(materialA,materialB,speed=0){return PHYSICS_MODEL?.contactResponse?PHYSICS_MODEL.contactResponse(materialA,materialB,speed,ENVIRONMENT.moisture):{staticFriction:.5,dynamicFriction:.32,restitution:IMPACT_RESTITUTION,elasticity:.45,density:1}}
function addImpactDeformation(e,amount){if(!e||!Number.isFinite(amount)||amount<=0)return;const materialElasticity=PHYSICS_MODEL?.materials?.[e.material]?.elasticity??.45;if(!Number.isFinite(e.plasticDeformation))e.plasticDeformation=Math.max(0,Number(e.impactDeformation)||0);if(!Number.isFinite(e.elasticDeformation))e.elasticDeformation=0;e.elasticDeformation=clamp(e.elasticDeformation+amount*materialElasticity,0,1.1);e.plasticDeformation=clamp(e.plasticDeformation+amount*(1-materialElasticity),0,1.5);e.impactDeformation=clamp(e.plasticDeformation+e.elasticDeformation,0,1.5)}
function updateSoftMemberDeformation(dt){for(const {e} of allMembers()){if(e.failed||!(e.elasticDeformation>1e-4))continue;e.elasticDeformation*=Math.exp(-3.8*dt);e.impactDeformation=clamp((e.plasticDeformation||0)+e.elasticDeformation,0,1.5)}}
function springForce(targetX,targetY,anchorX,anchorY,velocityX=0,velocityY=0,maxForce=34){let fx=(targetX-anchorX)*24-velocityX*7.5,fy=(targetY-anchorY)*24-velocityY*7.5;const magnitude=Math.hypot(fx,fy);if(magnitude>maxForce){const scale=maxForce/magnitude;fx*=scale;fy*=scale}return{x:fx,y:fy}}
function findGravityTetherTarget(px,py){let best=null,bestDistance=Infinity;const world=worldCoords(px,py);for(const d of sim.debris){const dx=Math.cos(d.angle)*d.length*.5,dy=Math.sin(d.angle)*d.length*.5,x1=GRID_LEFT+(d.x-dx)/STORY_HEIGHT*DX,y1=GROUND_Y-(d.y-dy)/STORY_HEIGHT*STORY_PX,x2=GRID_LEFT+(d.x+dx)/STORY_HEIGHT*DX,y2=GROUND_Y-(d.y+dy)/STORY_HEIGHT*STORY_PX,sx=x2-x1,sy=y2-y1,den=sx*sx+sy*sy,t=den>1e-6?clamp(((px-x1)*sx+(py-y1)*sy)/den,0,1):.5,dist=Math.hypot(px-(x1+sx*t),py-(y1+sy*t));if(dist<bestDistance&&dist<=28){best={kind:'debris',id:d.id,worldX:world.x,worldY:world.y};bestDistance=dist}}for(const node of Object.values(sim.nodes)){if(node.referenceLevel===0)continue;const x=screenX(node.gridX,node.referenceLevel),y=screenYNode(node.gridX,node.referenceLevel),dist=Math.hypot(px-x,py-y);if(dist<bestDistance&&dist<=24){best={kind:'node',nodeKey:node.key};bestDistance=dist}}if(!best)return null;if(best.kind==='debris'){const d=sim.debris.find(item=>item.id===best.id);if(!d)return null;const dx=world.x-d.x,dy=world.y-d.y,c=Math.cos(d.angle),s=Math.sin(d.angle);best.localX=dx*c+dy*s;best.localY=-dx*s+dy*c;best.targetX=world.x;best.targetY=world.y;best.targetScreenX=px;best.targetScreenY=py}else{best.targetX=world.x;best.targetY=world.y;best.targetScreenX=px;best.targetScreenY=py}return best}
function beginGravityTether(p,e){const target=findGravityTetherTarget(p.x,p.y);if(!target){setStatus('Gravity tether: click close to a structural joint or loose debris piece, then drag.',true);return false}gravityTether=target;if(target.kind==='debris'){const d=sim.debris.find(item=>item.id===target.id);if(d){d.settled=false;d.grounded=false}}dragging=true;canvas.setPointerCapture?.(e.pointerId);sim.running=true;syncButtons();setStatus('Gravity tether engaged. The cursor is connected by a damped spring; release to let the object swing and settle.',true);return true}
function drawGravityTether(){if(!gravityTether)return;let ax=0,ay=0;if(gravityTether.kind==='debris'){const d=sim.debris.find(item=>item.id===gravityTether.id);if(!d){gravityTether=null;return}const c=Math.cos(d.angle),s=Math.sin(d.angle),lx=gravityTether.localX||0,ly=gravityTether.localY||0;ax=GRID_LEFT+(d.x+lx*c-ly*s)/STORY_HEIGHT*DX;ay=GROUND_Y-(d.y+lx*s+ly*c)/STORY_HEIGHT*STORY_PX}else{const node=sim.nodes[gravityTether.nodeKey];if(!node){gravityTether=null;return}ax=screenX(node.gridX,node.referenceLevel);ay=screenYNode(node.gridX,node.referenceLevel)}const tx=GRID_LEFT+(gravityTether.targetX||0)/STORY_HEIGHT*DX,ty=GROUND_Y-(gravityTether.targetY||0)/STORY_HEIGHT*STORY_PX;ctx.save();ctx.strokeStyle='rgba(100,229,231,.9)';ctx.lineWidth=2;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(tx,ty);ctx.stroke();ctx.setLineDash([]);ctx.fillStyle='rgba(91,229,231,.16)';ctx.strokeStyle='#76eff0';ctx.beginPath();ctx.arc(tx,ty,7,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.beginPath();ctx.arc(ax,ay,4,0,Math.PI*2);ctx.fillStyle='#e5ffff';ctx.fill();ctx.restore()}

function mutateLayout(msg){const analysis=refreshAnalysis();updateMetrics();draw();setStatus(msg,true);setStatus(`Design changed. Live estimates refreshed; peak modeled utilization is ${(analysis.maxUtil*100).toFixed(0)}%. Select Validate for a written structural check.`,false);if(sim.running)setStatus(msg+' Physics is continuing with the updated BuildingMap.',true)}
function placeOneRaw(group,key,kind,x,y,material,direction){
 const existing=BuildingMap[group][key];if(existing&&!existing.failed&&!existing.snapped&&existing.material===material&&existing.direction===(direction||existing.direction))return false;
 for(const suffix of ['a','b'])delete sim.connectionStates[connectionId(`${group}|${key}`,suffix)];
 const e=makeElement(kind,x,y,material);if(kind==='brace')e.direction=direction||'up';BuildingMap[group][key]=e;return true;
}
function placeElementRaw(x,y){
 const selected=$('componentType').value,material=$('material').value;
 if(selected==='brace'){const dir=$('braceDirection').value,key=braceKeyOf(x,y,dir);return placeOneRaw('braces',key,'brace',x,y,material,dir)}
 if(selected==='crossbrace'){let changed=false;for(const dir of ['up','down'])changed=placeOneRaw('braces',braceKeyOf(x,y,dir),'brace',x,y,material,dir)||changed;return changed}
 const kind=selected,group=memberGroupForKind(kind),key=keyOf(x,y);return placeOneRaw(group,key,kind,x,y,material);
}
function placeElement(x,y){if(placeElementRaw(x,y))mutateLayout(`${MATERIALS[$('material').value].label} ${$('componentType').selectedOptions[0].text.toLowerCase()} placed at ${x}, ${y}.`);else setStatus(`A matching component already exists at ${x}, ${y}.`,true)}
function paintLineBetween(from,to){if(!from||!to)return 0;let x0=from.x,y0=from.y,x1=to.x,y1=to.y,dx=Math.abs(x1-x0),sx=x0<x1?1:-1,dy=-Math.abs(y1-y0),sy=y0<y1?1:-1,err=dx+dy,changed=0;const kind=$('componentType').value;for(;;){x0=clamp(x0,0,kind==='column'?NX:NX-1);y0=clamp(y0,kind==='column'||kind==='brace'||kind==='crossbrace'?0:1,kind==='column'||kind==='brace'||kind==='crossbrace'?NY-1:NY);const signature=`${kind}:${x0},${y0}`;if(!buildPainted.has(signature)){buildPainted.add(signature);if(placeElementRaw(x0,y0))changed++}if(x0===x1&&y0===y1)break;const e2=2*err;if(e2>=dy){err+=dy;x0+=sx}if(e2<=dx){err+=dx;y0+=sy}}return changed}
function snapForBuild(px,py){return gridPositionForKind(px,py,$('componentType').value)}
function addLoad(x,y){const key=keyOf(x,y),amount=Number($('loadAmount').value);if(!BuildingMap.loads[key])BuildingMap.loads[key]={x,y,mass:0,capacity:0,integrity:1,failed:false,kind:'load'};BuildingMap.loads[key].mass=Math.min(100,BuildingMap.loads[key].mass+amount);mutateLayout(`Load at bay ${x+1}, level ${y} increased to ${BuildingMap.loads[key].mass.toFixed(1)} relative mass units.`)}
function pointSegmentDistance(px,py,x1,y1,x2,y2){const dx=x2-x1,dy=y2-y1,den=dx*dx+dy*dy;const t=den?clamp(((px-x1)*dx+(py-y1)*dy)/den,0,1):0;return Math.hypot(px-(x1+t*dx),py-(y1+t*dy))}
function nearestElement(px,py){let best=null;const consider=(group,key,e,x1,y1,x2,y2)=>{if(group!=='loads'&&group!=='debris'&&(e.failed||e.debrisSpawned))return;const d=pointSegmentDistance(px,py,x1,y1,x2,y2);if(!best||d<best.distance)best={group,key,e,distance:d}};for(const [key,e]of Object.entries(BuildingMap.columns))consider('columns',key,e,screenX(e.x,e.y),screenYNode(e.x,e.y),screenX(e.x,e.y+1),screenYNode(e.x,e.y+1));for(const group of ['beams','slabs'])for(const [key,e]of Object.entries(BuildingMap[group])){const offset=group==='slabs'?-5:0;consider(group,key,e,screenX(e.x,e.y),screenYNode(e.x,e.y)+offset,screenX(e.x+1,e.y),screenYNode(e.x+1,e.y)+offset)}for(const [key,e]of Object.entries(BuildingMap.braces)){const ep=endpointKeys('braces',e).map(k=>sim.nodes[k]);if(ep[0]&&ep[1])consider('braces',key,e,GRID_LEFT+ep[0].position.x/STORY_HEIGHT*DX,GROUND_Y-ep[0].position.y/STORY_HEIGHT*STORY_PX,GRID_LEFT+ep[1].position.x/STORY_HEIGHT*DX,GROUND_Y-ep[1].position.y/STORY_HEIGHT*STORY_PX)}for(const [key,e]of Object.entries(BuildingMap.loads)){const yy=(screenYNode(e.x,e.y)+screenYNode(e.x+1,e.y))/2,xx=(screenX(e.x,e.y)+screenX(e.x+1,e.y))/2;consider('loads',key,e,xx-5,yy-22,xx+5,yy-22)}for(const d of sim.debris){const dx=Math.cos(d.angle)*d.length*.5,dy=Math.sin(d.angle)*d.length*.5,x1=GRID_LEFT+(d.x-dx)/STORY_HEIGHT*DX,x2=GRID_LEFT+(d.x+dx)/STORY_HEIGHT*DX,y1=GROUND_Y-(d.y-dy)/STORY_HEIGHT*STORY_PX,y2=GROUND_Y-(d.y+dy)/STORY_HEIGHT*STORY_PX;consider('debris',String(d.id),d,x1,y1,x2,y2)}return best}
function demolishAt(px,py){const found=nearestElement(px,py);if(!found||found.distance>19){lastDragKey='';return false}if(lastDragKey===found.group+'|'+found.key)return false;lastDragKey=found.group+'|'+found.key;if(found.group==='loads'){delete BuildingMap.loads[found.key];mutateLayout(`Removed load at coordinate ${found.key}.`);return true}if(found.group==='debris'){const index=sim.debris.findIndex(d=>String(d.id)===String(found.key));if(index<0)return false;sim.debris.splice(index,1);mutateLayout('Removed fallen debris from the scene. No structural ghost was left behind.');return true}const id=`${found.group}|${found.key}`;delete BuildingMap[found.group][found.key];for(const end of ['a','b'])delete sim.connectionStates[connectionId(id,end)];delete sim.overloadTimers[id];for(const k of Object.keys(sim.collisionPairs))if(k.includes(id))delete sim.collisionPairs[k];mutateLayout(`Deleted ${found.group.slice(0,-1)} at ${found.key}. The member vanished immediately; remaining support paths and loads were recalculated.`);return true}
function pushAt(x,y,px){const dir=px<(GRID_LEFT+GRID_RIGHT)/2?-1:1;for(let level=Math.max(1,y);level<=NY;level++){const attenuation=Math.max(.35,1-(level-y)*.075);sim.lateralVel[level]+=dir*4.4*attenuation}for(const node of Object.values(sim.nodes))if(node.referenceLevel>=Math.max(1,y)&&!node.isGroundConnected)node.velocity.x+=dir*1.1;sim.running=true;syncButtons();setStatus(`Lateral impulse applied ${dir<0?'left':'right'} at level ${y}.`,true);updateMetrics()}
function distanceToWorldSegment(px,py,a,b){const dx=b.x-a.x,dy=b.y-a.y,den=dx*dx+dy*dy,t=den?clamp(((px-a.x)*dx+(py-a.y)*dy)/den,0,1):0;return Math.hypot(px-(a.x+t*dx),py-(a.y+t*dy))}
function igniteMember(link,reason='heat'){
 if(!link||!link.e||link.e.material!=='flammable'||link.e.failed||link.e.burning)return false;
 const e=link.e;e.burning=true;e.fuelRemaining=clamp(Number(e.fuelRemaining??1),.05,1);e.heatExposure=0;e.fireSpreadClock=0;e.burnTime=0;e.ignitionReason=reason;e.lastEventTime=sim.time;
 sim.lastEvent=`IGNITION · ${e.kind.toUpperCase()} · ${reason.toUpperCase()}`;sim.eventUntil=sim.time+2.6;return true;
}
function queueMaterialBlastAt(x,y,power,sourceId='',depth=0,reason='explosive composite'){
 if(sim.pendingMaterialBlasts.length===0&&(sim.chainExplosionsProcessed||0)>=16)sim.chainExplosionsProcessed=0;
 if(depth>MAX_CHAIN_REACTION_DEPTH||sim.pendingMaterialBlasts.length>=24)return false;
 sim.pendingMaterialBlasts.push({x,y,power:clamp(Number(power)||4,1.8,9),sourceId,depth,reason});return true;
}
function triggerExplosiveMember(link,power,depth=0,reason='heat or impact'){
 if(!link||!link.e||link.e.material!=='explosive'||link.e.detonated||link.e.failed||depth>=MAX_CHAIN_REACTION_DEPTH)return false;
 const e=link.e,a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)return false;
 const x=(a.position.x+b.position.x)*.5,y=(a.position.y+b.position.y)*.5;e.detonated=true;e.explosivePrimed=false;e.burning=false;e.chainDepth=depth+1;
 queueMaterialBlastAt(x,y,power,link.id,depth+1,reason);
 failMember(link,`EXPLOSIVE COMPOSITE DETONATION · ${reason}`);
 sim.lastEvent=`CHAIN REACTION · EXPLOSIVE ${e.kind.toUpperCase()}`;sim.eventUntil=sim.time+3.2;return true;
}
function applyRadialBlastWorld(cx,cy,power,options={}){
 power=clamp(Number(power)||4,1,10);const depth=clamp(Number(options.depth)||0,0,MAX_CHAIN_REACTION_DEPTH),radius=(1.05+power*.22)*STORY_HEIGHT;
 const effect={x:cx,y:cy,radius,power,age:0,duration:.92,particles:Array.from({length:24},(_,i)=>({angle:(Math.PI*2*i/24)+Math.sin(i*2.17)*.07,length:.35+((i*37)%11)/11*.8,size:1.1+(i%4)*.45}))};
 spawnDustPlume(cx,cy,clamp(.55+power*.18,.65,2.35),0,power*.04);
 sim.explosionEffects.push(effect);if(sim.explosionEffects.length>12)sim.explosionEffects.splice(0,sim.explosionEffects.length-12);
 let deliveredEnergy=0,damaged=0,fractured=0,ignited=0,detonated=0;
 for(const node of Object.values(sim.nodes)){
  const dx=node.position.x-cx,dy=node.position.y-cy,d=Math.hypot(dx,dy);if(d>=radius)continue;const f=Math.pow(Math.max(0,1-d/radius),1.65);if(f<.006)continue;
  let ux,uy;if(d<.06){ux=(node.gridX%2===0?-1:1)*.32;uy=.95;const n=Math.hypot(ux,uy);ux/=n;uy/=n}else{ux=dx/d;uy=dy/d}
  const impulse=power*.52*f;node.velocity.x=clamp(node.velocity.x+ux*impulse,-MAX_FALL_SPEED,MAX_FALL_SPEED);node.velocity.y=clamp(node.velocity.y+uy*impulse+power*.055*f,-MAX_FALL_SPEED,MAX_FALL_SPEED);node.lastImpactTime=sim.time;node.isStressed=true;
 }
 // Member heat/energy checks happen before ordinary fracture, so reactive materials can start a contained chain reaction.
 for(const link of [...sim.memberLinks]){
  const e=link.e;if(!e||e.failed||e.debrisSpawned)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
  const dist=distanceToWorldSegment(cx,cy,a.position,b.position);if(dist>=radius)continue;const f=Math.pow(Math.max(0,1-dist/radius),1.65);if(f<.006)continue;
  if(e.material==='flammable'&&power*f>=1.05){e.heatExposure=(e.heatExposure||0)+power*f*.42;if(e.heatExposure>=.48&&igniteMember(link,'blast heat'))ignited++}
  if(e.material==='explosive'&&!e.detonated&&power*f>=2.25&&depth<MAX_CHAIN_REACTION_DEPTH){if(triggerExplosiveMember(link,clamp(2.4+power*f*.46,2.4,8),depth,'nearby blast')){detonated++;fractured++;continue}}
  const energy=power*power*.72*f,durability=impactDurability(e),ratio=energy/Math.max(.1,durability);deliveredEnergy+=energy;e.lastImpactEnergy=energy;e.lastImpactTime=sim.time;e.impactStress=clamp((e.impactStress||0)+ratio*.82,0,5);addImpactDeformation(e,ratio*.16);e.integrity=clamp(e.integrity-ratio*.34,0,1);e.structuralIntegrity=e.integrity;damaged++;
  if(energy>=durability*1.04||e.integrity<=FAILURE_INTEGRITY){if(failMember(link,`explosion impact · ${energy.toFixed(1)} energy units`))fractured++}
 }
 // Shockwave weakens nearby joints; sufficiently strong local shear breaks a member.
 for(const conn of sim.connections){const node=sim.nodes[conn.nodeKey];if(!node||conn.broken)continue;const d=Math.hypot(node.position.x-cx,node.position.y-cy);if(d>=radius)continue;const f=Math.pow(Math.max(0,1-d/radius),1.65),shock=power*power*.22*f;if(shock<.08)continue;const ratio=shock/Math.max(.1,conn.shearStrength);conn.lastDemandRatio=Math.max(conn.lastDemandRatio,ratio);conn.plasticDamage=clamp(conn.plasticDamage+ratio*.075,0,1.25);conn.stiffnessFactor=clamp(1-.72*conn.plasticDamage,.18,1);conn.forceAngle=Math.atan2(node.position.y-cy,node.position.x-cx);conn.syncState();if(shock>conn.shearStrength*1.65){const connectedMember=sim.memberLinks.find(l=>l.id===conn.memberId);if(connectedMember&&failMember(connectedMember,'INSTANT FRACTURE · EXPLOSION SHOCKWAVE SHEAR'))fractured++}}
 for(const d of sim.debris){const dx=d.x-cx,dy=d.y-cy,dist=Math.hypot(dx,dy);if(dist>=radius)continue;const f=Math.pow(Math.max(0,1-dist/radius),1.65);let ux=dist>.05?dx/dist:((d.id%2)?1:-1),uy=dist>.05?dy/dist:.3;if(dist<=.05){const n=Math.hypot(ux,uy);ux/=n;uy/=n}d.vx=clamp((d.vx||0)+ux*power*.52*f,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.vy=clamp((d.vy||0)+uy*power*.52*f+power*.055*f,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.angularVelocity=clamp((d.angularVelocity||0)+ux*uy*power*.032*f,-3.4,3.4);d.settled=false;d.grounded=false;d.reason='disturbed by blast';updateDebrisBounds(d);
  if(d.material==='flammable'&&power*f>=1.25)d.burning=true;
  if(d.material==='explosive'&&!d.explosiveSpent&&power*f>=2.25&&depth<MAX_CHAIN_REACTION_DEPTH){d.explosiveSpent=true;d.reason='spent explosive composite';queueMaterialBlastAt(d.x,d.y,clamp(2.5+power*f*.42,2.5,8),`debris:${d.id}`,depth+1,'explosive debris chain')}
 }
 sim.lastRawEnergy=deliveredEnergy;sim.lastImpactEnergy=deliveredEnergy;sim.lastImpactForce=power*power*.72/IMPACT_DURATION;sim.lastImpactStory=Math.max(0,Math.min(NY,Math.round(cy/STORY_HEIGHT)));sim.lastImpactOutcome=options.internal?'MATERIAL CHAIN BLAST':`BLAST · power ${power}`;
 sim.lastEvent=options.internal?`CHAIN BLAST · POWER ${power.toFixed(1)} · ${fractured} fracture(s)`:`RADIAL BLAST · POWER ${power} · ${fractured} member/joint failure(s)`;sim.eventUntil=sim.time+2.2;if(fractured>0)sim.localFailureCount+=1;
 if(options.internal){sim.chainExplosionsProcessed=(sim.chainExplosionsProcessed||0)+1;return {damaged,fractured,ignited,detonated,energy:deliveredEnergy}}
 refreshAnalysis();updateMetrics();draw();return {damaged,fractured,ignited,detonated,energy:deliveredEnergy};
}
function processPendingMaterialBlasts(maxPerStep=2){let processed=0;while(sim.pendingMaterialBlasts.length&&processed<maxPerStep&&(sim.chainExplosionsProcessed||0)<16){const blast=sim.pendingMaterialBlasts.shift();applyRadialBlastWorld(blast.x,blast.y,blast.power,{internal:true,depth:blast.depth,sourceId:blast.sourceId,reason:blast.reason});processed++}if((sim.chainExplosionsProcessed||0)>=16&&sim.pendingMaterialBlasts.length){sim.pendingMaterialBlasts.length=0;sim.lastEvent='CHAIN REACTION CAPPED · MAXIMUM SAFE SIMULATION DEPTH';sim.eventUntil=sim.time+3}}
function updateMaterialHazards(dt){
 const links=sim.memberLinks.filter(l=>!l.e.failed&&l.e.integrity>.001),byNode=Object.create(null);for(const link of links){(byNode[link.nodeA]||(byNode[link.nodeA]=[])).push(link);(byNode[link.nodeB]||(byNode[link.nodeB]=[])).push(link)}
 const burnQueue=[],detonateQueue=[];
 for(const link of links){const e=link.e;if(e.material!=='flammable'||!e.burning)continue;
  e.burnTime=(e.burnTime||0)+dt;e.fuelRemaining=Math.max(0,(Number(e.fuelRemaining??1))-dt*.085);e.integrity=Math.max(0,e.integrity-dt*(.045+(1-e.fuelRemaining)*.075));e.structuralIntegrity=e.integrity;e.impactStress=clamp((e.impactStress||0)+dt*.06,0,5);e.fireSpreadClock=(e.fireSpreadClock||0)+dt;
  if(e.fireSpreadClock>=.55){e.fireSpreadClock-=.55;for(const nk of [link.nodeA,link.nodeB])for(const neighbor of byNode[nk]||[]){if(neighbor===link||neighbor.e.failed)continue;const joint=neighbor.nodeA===nk?neighbor.connectionA:neighbor.connectionB;if(joint?.broken)continue;const n=neighbor.e;if(n.material==='flammable'&&!n.burning){n.heatExposure=(n.heatExposure||0)+.62;if(n.heatExposure>=1.0)burnQueue.push([neighbor,'spread from adjacent fire'])}else if(n.material==='explosive'&&!n.detonated){n.heatExposure=(n.heatExposure||0)+.72;n.explosivePrimed=true;if(n.heatExposure>=.72)detonateQueue.push([neighbor,5.2,'heated by adjacent fire'])}}}
  if(e.fuelRemaining<=0||e.integrity<=FAILURE_INTEGRITY)burnQueue.push([link,'burned through']);
 }
 for(const [link,reason] of burnQueue){if(!link.e.failed){if(reason==='burned through')failMember(link,'FLAMMABLE MEMBER BURNED THROUGH');else igniteMember(link,reason)}}
 for(const [link,power,reason] of detonateQueue)if(!link.e.detonated&&!link.e.failed)triggerExplosiveMember(link,power,0,reason);
 // Fire can also reach detached combustible debris. Spent explosive debris cannot re-trigger.
 const burningSources=links.filter(l=>l.e.material==='flammable'&&l.e.burning).slice(0,96);
 for(const d of sim.debris){
  if(d.material==='flammable'&&d.burning){d.fuelRemaining=Math.max(0,(Number(d.fuelRemaining??.5))-dt*.08);d.integrity=Math.max(0,(Number(d.integrity??.5))-dt*.075);if(d.fuelRemaining<=0){d.burning=false;d.reason='burned-out flammable debris'} }
  if(d.material==='explosive'&&!d.explosiveSpent){let heated=false;for(const source of burningSources){const a=sim.nodes[source.nodeA],b=sim.nodes[source.nodeB];if(a&&b&&distanceToWorldSegment(d.x,d.y,a.position,b.position)<STORY_HEIGHT*.34){heated=true;break}}if(heated){d.heatExposure=(d.heatExposure||0)+dt;if(d.heatExposure>.55){d.explosiveSpent=true;d.reason='spent explosive debris';queueMaterialBlastAt(d.x,d.y,5.0,`debris:${d.id}`,0,'heated explosive debris')}}}
 }
}
function detonateAt(px,py){
 if(px<GRID_LEFT||px>GRID_RIGHT||py<gridY(NY)||py>GROUND_Y){setStatus('Place the virtual explosion inside the visible building grid.',true);return false}
 const power=clamp(Number($('explosionPower').value)||5,1,10),cx=(px-GRID_LEFT)/DX*STORY_HEIGHT,cy=(GROUND_Y-py)/STORY_PX*STORY_HEIGHT;
 sim.chainExplosionsProcessed=0;sim.pendingMaterialBlasts=[];
 const result=applyRadialBlastWorld(cx,cy,power,{user:true,depth:0});sim.running=true;syncButtons();
 setStatus(`Virtual blast at bay ${(cx/STORY_HEIGHT+.5).toFixed(1)}, level ${(cy/STORY_HEIGHT).toFixed(1)} · power ${power} · damaged ${result.damaged} member(s) · ${result.fractured} fracture(s) · ${result.ignited} ignition(s) · ${result.detonated} reactive material(s) triggered. Fire and chain reactions are active in the sandbox.`,true);
 setStatus(`Blast applied as a simplified game-physics effect. Peak current utilization ${(lastAnalysis.maxUtil*100).toFixed(0)}%; reset physics to restore structural integrity.`,false);return true;
}
function drawMaterialEffects(){
 // Small animated flame glyphs follow active flammable structural members; no external assets needed.
 for(const link of sim.memberLinks){const e=link.e;if(!e.burning||e.failed)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
  const x1=GRID_LEFT+a.position.x/STORY_HEIGHT*DX,y1=GROUND_Y-a.position.y/STORY_HEIGHT*STORY_PX,x2=GRID_LEFT+b.position.x/STORY_HEIGHT*DX,y2=GROUND_Y-b.position.y/STORY_HEIGHT*STORY_PX;
  ctx.save();ctx.lineCap='round';ctx.strokeStyle='rgba(255,113,52,.5)';ctx.lineWidth=8;ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();
  const length=Math.hypot(x2-x1,y2-y1),count=clamp(Math.floor(length/25),1,8);
  for(let i=0;i<count;i++){const t=(i+.5)/count,x=x1+(x2-x1)*t,y=y1+(y2-y1)*t,phase=sim.time*9+i*2.1+e.x*.7,h=5+Math.abs(Math.sin(phase))*7,w=2.4+Math.abs(Math.cos(phase))*1.6;
   ctx.globalAlpha=.72+.2*Math.sin(phase);ctx.fillStyle=i%2?'#ffb347':'#ff743c';ctx.beginPath();ctx.moveTo(x-w,y+2);ctx.quadraticCurveTo(x-w*1.7,y-h*.35,x,y-h);ctx.quadraticCurveTo(x+w*1.7,y-h*.35,x+w,y+2);ctx.closePath();ctx.fill();ctx.fillStyle='#ffe29a';ctx.beginPath();ctx.ellipse(x,y-h*.28,w*.42,h*.25,0,0,Math.PI*2);ctx.fill();
  }ctx.restore();
 }
 for(const d of sim.debris){if(!d.burning)continue;const x=GRID_LEFT+d.x/STORY_HEIGHT*DX,y=GROUND_Y-d.y/STORY_HEIGHT*STORY_PX;ctx.save();ctx.globalAlpha=.75;ctx.fillStyle='#ff8542';ctx.beginPath();ctx.ellipse(x,y-4,3+Math.abs(Math.sin(sim.time*8+d.id))*2,6+Math.abs(Math.cos(sim.time*7+d.id))*3,0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#ffe4a0';ctx.beginPath();ctx.ellipse(x,y-4,1.3,3.2,0,0,Math.PI*2);ctx.fill();ctx.restore()}
 // Primed explosive elements blink before a heat-triggered chain reaction.
 for(const link of sim.memberLinks){const e=link.e;if(!e.explosivePrimed||e.failed)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const x=GRID_LEFT+(a.position.x+b.position.x)*.5/STORY_HEIGHT*DX,y=GROUND_Y-(a.position.y+b.position.y)*.5/STORY_HEIGHT*STORY_PX;ctx.save();ctx.globalAlpha=.5+.5*Math.sin(sim.time*18);ctx.strokeStyle='#ff68ac';ctx.lineWidth=2;ctx.beginPath();ctx.arc(x,y,5+Math.sin(sim.time*12)*2,0,Math.PI*2);ctx.stroke();ctx.restore()}
}
function drawExplosionEffects(){
 for(const fx of sim.explosionEffects||[]){const t=clamp(fx.age/fx.duration,0,1),fade=1-t,cx=GRID_LEFT+fx.x/STORY_HEIGHT*DX,cy=GROUND_Y-fx.y/STORY_HEIGHT*STORY_PX,rx=fx.radius/STORY_HEIGHT*DX,ry=fx.radius/STORY_HEIGHT*STORY_PX;
  ctx.save();ctx.globalAlpha=Math.max(0,fade*.38);const glow=ctx.createRadialGradient(cx,cy,1,cx,cy,Math.max(rx,ry)*.45);glow.addColorStop(0,'rgba(255,245,202,.86)');glow.addColorStop(.35,'rgba(255,156,83,.52)');glow.addColorStop(1,'rgba(255,72,81,0)');ctx.fillStyle=glow;ctx.beginPath();ctx.ellipse(cx,cy,rx*.55,ry*.55,0,0,Math.PI*2);ctx.fill();
  for(let ring=0;ring<3;ring++){const r=.16+t*(.9+ring*.18);ctx.globalAlpha=Math.max(0,fade*(.9-ring*.22));ctx.strokeStyle=ring===0?'#fff0b4':ring===1?'#ff9b57':'#ff5d73';ctx.lineWidth=Math.max(1.2,3.1*(1-t)-ring*.45);ctx.beginPath();ctx.ellipse(cx,cy,rx*r,ry*r,0,0,Math.PI*2);ctx.stroke()}
  for(const part of fx.particles){const distance=part.length*t,ex=cx+Math.cos(part.angle)*rx*distance,ey=cy+Math.sin(part.angle)*ry*distance;ctx.globalAlpha=Math.max(0,fade);ctx.strokeStyle=part.size>2?'#ffcf86':'#fff0bd';ctx.lineWidth=part.size;ctx.beginPath();ctx.moveTo(cx+Math.cos(part.angle)*rx*distance*.72,cy+Math.sin(part.angle)*ry*distance*.72);ctx.lineTo(ex,ey);ctx.stroke();if(t<.72){ctx.fillStyle='#ff976b';ctx.beginPath();ctx.arc(ex,ey,part.size*(1-t),0,Math.PI*2);ctx.fill()}}
  ctx.restore();
 }
}
function igniteAt(px,py){const found=nearestElement(px,py);if(!found||found.distance>20||found.group==='loads'||found.group==='debris'){setStatus('Click directly on a flammable or explosive structural member.',true);return false}const link=sim.memberLinks.find(l=>l.id===`${found.group}|${found.key}`);if(!link){setStatus('That component has no active structural connection to ignite.',true);return false}const e=link.e;if(e.material==='flammable'){if(!igniteMember(link,'manual ignition tool')){setStatus('That flammable component is already burning or has failed.',true);return false}sim.running=true;syncButtons();setStatus(`Fire started on ${e.kind} at ${found.key}. Nearby connected flammable members may ignite; burning gradually reduces integrity and capacity.`,true);return true}if(e.material==='explosive'){if(triggerExplosiveMember(link,5.2,0,'manual ignition tool')){sim.chainExplosionsProcessed=0;sim.running=true;syncButtons();setStatus(`Explosive composite triggered at ${found.key}. A bounded virtual blast and chain reaction will now propagate through nearby sandbox members.`,true);return true}setStatus('That explosive composite has already detonated or failed; reset physics to restore it.',true);return false}setStatus(`The selected member is ${MATERIALS[e.material]?.label||e.material}; only flammable and explosive composites react to the Ignite tool.`,true);return false}
function handleCanvasDown(e){
 e.preventDefault();const p=canvasCoords(e);
 if(mode==='build'){
  const kind=$('componentType').value;
  if(!isGridTarget(p.x,p.y,kind)){setStatus(kind==='column'?'Click or drag near a vertical grid line to place columns.':'Click or drag inside the grid to draw connected components.',true);return}
  dragging=true;buildLastCell=snapForBuild(p.x,p.y);buildPainted=new Set();canvas.setPointerCapture?.(e.pointerId);const n=paintLineBetween(buildLastCell,buildLastCell);if(n)mutateLayout(`Continuous placement: added ${n} ${$('componentType').selectedOptions[0].text.toLowerCase()} segment(s).`);else draw();
 }else if(mode==='demolish'){
  dragging=true;lastDragKey='';lastDragPt={x:p.x,y:p.y};demolishAt(p.x,p.y);canvas.setPointerCapture?.(e.pointerId);
 }else if(mode==='load'||mode==='push'){
  if(!isGridTarget(p.x,p.y,'bay')){setStatus('Click inside the grid, near a floor line, to target a bay or level.',true);return}
  const pos=snapBay(p.x,p.y);if(mode==='load')addLoad(pos.x,pos.y);else pushAt(pos.x,pos.y,p.x);
 }else if(mode==='ignite'){igniteAt(p.x,p.y)}else if(mode==='explosion'){detonateAt(p.x,p.y)}else if(mode==='tether'){beginGravityTether(p,e)}
}
function handlePointerMove(e){const p=canvasCoords(e);if(mode==='tether'&&dragging&&gravityTether){const world=worldCoords(p.x,p.y);gravityTether.targetX=world.x;gravityTether.targetY=world.y;gravityTether.targetScreenX=p.x;gravityTether.targetScreenY=p.y;hover.valid=false;draw();return}const kind=$('componentType').value,valid=mode==='explosion'?(p.x>=GRID_LEFT&&p.x<=GRID_RIGHT&&p.y>=gridY(NY)&&p.y<=GROUND_Y):mode==='ignite'?((nearestElement(p.x,p.y)?.distance??Infinity)<=20):isGridTarget(p.x,p.y,kind==='build'?kind:'bay'),pos=gridPositionForKind(p.x,p.y,kind);hover={...pos,valid:valid&&mode!=='demolish'};
 if(dragging&&mode==='build'&&valid&&buildLastCell){const next=snapForBuild(p.x,p.y);if(next.x!==buildLastCell.x||next.y!==buildLastCell.y){const n=paintLineBetween(buildLastCell,next);buildLastCell=next;if(n)mutateLayout(`Continuous placement: added ${n} ${kind==='crossbrace'?'X-bracing':kind==='brace'?'diagonal brace':kind}(s).`);else draw()}}
 else if(dragging&&mode==='demolish'&&lastDragPt&&Math.hypot(p.x-lastDragPt.x,p.y-lastDragPt.y)>9){lastDragPt={x:p.x,y:p.y};demolishAt(p.x,p.y)}draw()}
function handlePointerUp(){if(mode==='tether')gravityTether=null;dragging=false;lastDragKey='';lastDragPt=null;buildLastCell=null;buildPainted=new Set();draw()}
function targetStoryElements(story,floorLevel){const targets=[];for(const e of Object.values(BuildingMap.columns))if(e.y===story)targets.push(e);for(const group of ['beams','slabs'])for(const e of Object.values(BuildingMap[group]))if(e.y===floorLevel)targets.push(e);for(const e of Object.values(BuildingMap.braces))if(e.y===floorLevel||e.y+1===floorLevel)targets.push(e);return targets}
function physicalComponent(nodeKey){
 const adjacency=Object.create(null);for(const key of Object.keys(sim.nodes))adjacency[key]=[];
 // Only unsevered joints transfer component mass. A member with one open end is a local hinge, not a support path.
 for(const link of sim.memberLinks){if(!linkTransfersSupport(link))continue;adjacency[link.nodeA].push({node:link.nodeB,link});adjacency[link.nodeB].push({node:link.nodeA,link})}
 const seenNodes=new Set([nodeKey]),memberIds=new Set(),queue=[nodeKey];while(queue.length){const key=queue.shift();for(const edge of adjacency[key]||[]){memberIds.add(edge.link.id);if(!seenNodes.has(edge.node)){seenNodes.add(edge.node);queue.push(edge.node)}}}
 // A one-ended member contributes its own mass to the component on its still-attached side.
 for(const link of sim.memberLinks){if(link.e.failed||link.e.integrity<=0)continue;if(!link.connectionA.broken&&seenNodes.has(link.nodeA))memberIds.add(link.id);if(!link.connectionB.broken&&seenNodes.has(link.nodeB))memberIds.add(link.id)}
 let mass=0;for(const link of sim.memberLinks)if(memberIds.has(link.id))mass+=Math.max(.01,link.e.mass);for(const load of Object.values(BuildingMap.loads)){if(seenNodes.has(keyOf(load.x,load.y))||seenNodes.has(keyOf(load.x+1,load.y)))mass+=load.mass}
 return {nodeKeys:seenNodes,memberIds,mass:Math.max(.05,mass),signature:[...memberIds].sort().join(';')||nodeKey};
}
function impactDurability(e){
 const base=Math.max(.5,Number(e.durability)||Math.max(.5,e.capacity*IMPACT_ENERGY_PER_CAPACITY*(e.impactResistance||1)));
 return base*Math.max(.08,clamp(e.integrity,0,1));
}
function applyTargetImpulse(link,hitPoint,vx,vy,sourceMass){
 const e=link?.e,a=sim.nodes[link?.nodeA],b=sim.nodes[link?.nodeB];if(!e||!a||!b)return {dvx:0,dvy:0};
 const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,den=dx*dx+dy*dy;
 const t=den>.0001?clamp(((hitPoint.x-a.position.x)*dx+(hitPoint.y-a.position.y)*dy)/den,0,1):.5;
 // Treat the contact as an impulse shared between the two joint nodes. Member capacity
 // is strength, not inertia; using it as mass previously made strong members unrealistically immovable.
 const scale=IMPACT_MOMENTUM_TRANSFER*IMPACT_TRANSFER_EFFICIENCY;
 const impulseX=Math.max(0,sourceMass)*vx*scale,impulseY=Math.max(0,sourceMass)*vy*scale;
 let dvax=0,dvay=0,dvbx=0,dvby=0;
 if(a.referenceLevel>0){const mA=Math.max(.06,a.mass||.06);dvax=clamp(impulseX*(1-t)/mA,-2.2,2.2);dvay=clamp(impulseY*(1-t)/mA,-2.2,2.2);a.velocity.x=clamp(a.velocity.x+dvax,-5,5);a.velocity.y=clamp(a.velocity.y+dvay,-MAX_FALL_SPEED,MAX_FALL_SPEED)}
 if(b.referenceLevel>0){const mB=Math.max(.06,b.mass||.06);dvbx=clamp(impulseX*t/mB,-2.2,2.2);dvby=clamp(impulseY*t/mB,-2.2,2.2);b.velocity.x=clamp(b.velocity.x+dvbx,-5,5);b.velocity.y=clamp(b.velocity.y+dvby,-MAX_FALL_SPEED,MAX_FALL_SPEED)}
 const offset=t-.5;addImpactDeformation(e,Math.abs(offset)*Math.hypot(dvax+dvbx,dvay+dvby)*.11);
 e.lateralForce=(e.lateralForce||0)+(dvax+dvbx)*e.mass;
 return {dvx:dvax+dvbx,dvy:dvay+dvby,t,impulse:Math.hypot(impulseX,impulseY)};
}
function impactOneMember(link,energy,impactForce,hitPoint,velocity,sourceMass,reason='impact',impulseShare=1){
 const e=link?.e;if(!e||e.failed||e.snapped||e.integrity<=.001)return {failed:false,shattered:false};
 const durability=impactDurability(e),energyRatio=energy/Math.max(.5,durability),normalizedForce=Math.max(0,impactForce)*IMPACT_FORCE_NORMALIZER;
 if(e.material==='flammable'&&energyRatio>.14)igniteMember(link,'impact heat');
 if(e.material==='explosive'&&!e.detonated&&(energyRatio>.30||normalizedForce/Math.max(.5,e.capacity*(e.impactResistance||1))>.72)&&triggerExplosiveMember(link,clamp(3.2+energyRatio*.45,3.2,7.5),0,'impact ignition'))return {failed:true,shattered:true,energyRatio,forceRatio:1};
 const forceCapacity=Math.max(.5,e.capacity*(e.impactResistance||1)*Math.max(.12,e.integrity));
 const forceRatio=normalizedForce/forceCapacity;
 applyTargetImpulse(link,hitPoint,velocity.x,velocity.y,sourceMass*clamp(impulseShare,0,1));
 e.lastImpactEnergy=(e.lastImpactEnergy||0)+energy;e.lastImpactTime=sim.time;e.impactDamage=clamp((e.impactDamage||0)+Math.min(.45,energyRatio*.16+forceRatio*.035),0,.98);
 e.impactStress=clamp((e.impactStress||0)+Math.min(1.8,energyRatio*.12+forceRatio*.16),0,5);
 addImpactDeformation(e,Math.min(.8,energyRatio*.3+forceRatio*.08));
 e.integrity=clamp(e.integrity-Math.min(.58,energyRatio*.14+forceRatio*.035),0,1);e.structuralIntegrity=e.integrity;
 const endA=link.connectionA,endB=link.connectionB,nearA=Math.hypot(hitPoint.x-sim.nodes[link.nodeA].position.x,hitPoint.y-sim.nodes[link.nodeA].position.y)<=Math.hypot(hitPoint.x-sim.nodes[link.nodeB].position.x,hitPoint.y-sim.nodes[link.nodeB].position.y),hitConnection=nearA?endA:endB;
 const forceFracture=forceRatio>=1.45,energyFracture=energy>=durability,fracture=forceFracture||energyFracture;
 if(fracture){dampLinkRelativeMotion(link,.48);failMember(link,`SHATTERED BY IMPACT · ${reason} · ${energy.toFixed(1)} energy / ${durability.toFixed(1)} durability`);return {failed:true,shattered:true,energyRatio,forceRatio}}
 // Non-catastrophic joint demand contributes to plastic damage; the connection solver then
 // provides several frames of frictional resistance before a member actually separates.
 if(hitConnection&&!hitConnection.broken){const ratio=Math.max(0,forceRatio*.82+energyRatio*.18);const angle=Math.atan2(velocity.y,velocity.x);hitConnection.applyDemand(ratio,angle,1/60,sim.time);if(hitConnection.plasticDamage>.2){if(nearA)e.jointDamageA=hitConnection.plasticDamage;else e.jointDamageB=hitConnection.plasticDamage;}}
 if(e.integrity<=FAILURE_INTEGRITY||(e.utilization||0)+e.impactStress>1.48&&energyRatio>.18){failMember(link,`impact deformation exceeded remaining integrity · ${reason}`);return {failed:true,shattered:false,energyRatio,forceRatio}}
 e.state='DEFORMED';return {failed:false,shattered:false,energyRatio,forceRatio};
}
function propagateShockwave(originLink,energy,hitPoint,velocity={x:0,y:0}){
 if(!originLink||energy<=.01)return {count:0,failed:0};const endpointSet=new Set([originLink.nodeA,originLink.nodeB]),neighbors=[];
 for(const link of sim.memberLinks){if(link.id===originLink.id||link.e.failed||link.e.snapped||link.e.integrity<=.001)continue;const shared=[link.nodeA,link.nodeB].filter(key=>endpointSet.has(key));if(shared.some(key=>!(key===link.nodeA?link.connectionA:link.connectionB).broken))neighbors.push(link)}
 const unique=[...new Map(neighbors.map(l=>[l.id,l])).values()];let failed=0;
 for(const link of unique){const e=link.e,share=energy/Math.max(1,unique.length),durability=impactDurability(e),ratio=share/Math.max(.5,durability);e.impactStress=clamp((e.impactStress||0)+Math.min(1.8,ratio*.42),0,5);e.impactDamage=clamp((e.impactDamage||0)+Math.min(.28,ratio*.055),0,.98);addImpactDeformation(e,Math.min(.42,ratio*.16));e.integrity=clamp(e.integrity-Math.min(.3,ratio*.07),0,1);e.structuralIntegrity=e.integrity;e.lastImpactEnergy=(e.lastImpactEnergy||0)+share;e.lastImpactTime=sim.time;
  // A small part of the shock impulse reaches the adjacent joint, but it decays with distance.
  for(const key of [link.nodeA,link.nodeB]){const n=sim.nodes[key];if(!n||n.referenceLevel===0)continue;n.velocity.x=clamp(n.velocity.x+Math.sign(n.position.x-hitPoint.x||1)*Math.min(.32,ratio*.045),-5,5);n.velocity.y=clamp(n.velocity.y+Math.min(.22,ratio*.025),-MAX_FALL_SPEED,MAX_FALL_SPEED)}
  if(share>=durability*.5||((e.utilization||0)+e.impactStress>1.25&&ratio>.12)||e.integrity<=FAILURE_INTEGRITY){if(failMember(link,`SHOCKWAVE FRACTURE · ${share.toFixed(1)} transferred energy`))failed++}
 }
 return {count:unique.length,failed};
}
function handleMemberImpact(node,targetLink,relativeSpeed,body){
 const cooldownKey=`impact:${body.signature}|${targetLink.id}`;if(sim.time-(sim.collisionPairs[cooldownKey]??-Infinity)<.22)return;sim.collisionPairs[cooldownKey]=sim.time;
 const mass=Math.max(.02,body.mass||.02),incoming={x:Number(node.velocity?.x)||0,y:Number(node.velocity?.y)||0},hitLink=targetLink,na=sim.nodes[hitLink.nodeA],nb=sim.nodes[hitLink.nodeB],dx=(nb?.position.x||0)-(na?.position.x||0),dy=(nb?.position.y||0)-(na?.position.y||0),den=dx*dx+dy*dy,t=den>.0001?clamp(((node.position.x-(na?.position.x||0))*dx+(node.position.y-(na?.position.y||0))*dy)/den,0,1):.5,targetVx=na&&nb?na.velocity.x+(nb.velocity.x-na.velocity.x)*t:0,targetVy=na&&nb?na.velocity.y+(nb.velocity.y-na.velocity.y)*t:0,velocity={x:incoming.x-targetVx,y:incoming.y-targetVy},speed=Math.max(0,relativeSpeed,Math.hypot(velocity.x,velocity.y));if(speed<.38)return;if(Math.hypot(velocity.x,velocity.y)<.02)velocity.y=-speed;
 const raw=.5*mass*speed*speed,transfer=raw*(1-IMPACT_RESTITUTION*IMPACT_RESTITUTION)*IMPACT_TRANSFER_EFFICIENCY,impulse=mass*speed,force=impulse/IMPACT_DURATION,normalizedForce=force*IMPACT_FORCE_NORMALIZER;
 sim.lastRawEnergy=raw;sim.lastImpactEnergy=transfer;sim.lastImpactForce=force;sim.lastImpactStory=Math.max(0,targetLink.e.y-1);sim.lastImpactOutcome='IMPACT';if(speed>1.05)spawnDustPlume(node.position.x,node.position.y,clamp((speed-.65)*.40,.25,2.0),velocity.x*.15,Math.abs(velocity.y)*.04);
 const targetLevel=targetLink.e.y,gx=node.position.x/STORY_HEIGHT;
 const local=targetStoryElements(targetLevel-1,targetLevel).filter(e=>{if(e.kind==='column')return Math.abs(e.x-gx)<=1.05;return gx>=e.x-.05&&gx<=e.x+1.05}).filter(e=>!e.failed&&!e.snapped);
 if(!local.includes(targetLink.e)&&!targetLink.e.failed&&!targetLink.e.snapped)local.unshift(targetLink.e);
 const entries=local.map(e=>{const proximity=e===targetLink.e?2.2:e.kind==='column'?Math.max(.18,1-Math.abs(e.x-gx)*.68):Math.max(.2,1-Math.abs((e.x+.5)-gx)*.65);return {e,weight:proximity}}),weightSum=entries.reduce((s,v)=>s+v.weight,0)||1;
 let failed=0,shattered=0,deformed=0,primaryLink=null;
 for(const item of entries){const e=item.e,group=memberGroupForKind(e.kind),memberKey=memberKeyFor(group,e),link=sim.memberLinks.find(l=>l.id===`${group}|${memberKey}`);if(!link)continue;if(e===targetLink.e)primaryLink=link;const energyShare=transfer*(1-SHOCKWAVE_TRANSFER)*item.weight/weightSum;const result=impactOneMember(link,energyShare,force*item.weight/weightSum,node.position,velocity,mass,'falling member',item.weight/weightSum);if(result.failed)failed++;if(result.shattered)shattered++;if(!result.failed)deformed++}
 const shockEnergy=transfer*SHOCKWAVE_TRANSFER,shock=propagateShockwave(primaryLink||targetLink,shockEnergy,node.position,velocity);failed+=shock.failed;
 const storySummary=sim.floors[targetLevel];storySummary.lastImpactTime=sim.time;storySummary.structuralIntegrity=local.length?local.reduce((sum,e)=>sum+e.integrity,0)/local.length:storySummary.structuralIntegrity;storySummary.integrity=storySummary.structuralIntegrity;
 sim.lastImpactOutcome=shattered?'SHATTERED':failed?'CASCADE FRACTURE':deformed?'DEFORMED + SHOCKWAVE':'SHOCKWAVE';sim.lastEvent=shattered?`IMPACT SHATTER · LEVEL ${targetLevel}`:failed?`LOCAL IMPACT CASCADE · LEVEL ${targetLevel}`:shock.count?`IMPACT SHOCKWAVE · ${shock.count} NEIGHBOR(S)`:`IMPACT ABSORBED · LEVEL ${targetLevel}`;sim.eventUntil=sim.time+4;node.lastImpactTime=sim.time;
 setStatus(`${sim.lastEvent}. Kinetic energy ${raw.toFixed(2)}; transferred ${transfer.toFixed(2)}; impulse ${impulse.toFixed(2)}; force estimate ${force.toFixed(1)} units.`,true);refreshAnalysis();
}
function handleGroundImpact(node,speed,body){
 if(speed<.5)return;
 const cooldownKey=`${body.signature}|ground`;if(sim.time-(sim.collisionPairs[cooldownKey]??-Infinity)<.45)return;sim.collisionPairs[cooldownKey]=sim.time;
 const mass=Math.max(.02,body.mass||.02),velocity={x:Number(node.velocity?.x)||0,y:Number(node.velocity?.y)||0};if(Math.hypot(velocity.x,velocity.y)<.02)velocity.y=-speed;speed=Math.max(speed,Math.hypot(velocity.x,velocity.y));const raw=.5*mass*speed*speed,transfer=raw*(1-IMPACT_RESTITUTION*IMPACT_RESTITUTION)*IMPACT_TRANSFER_EFFICIENCY,impulse=mass*speed,force=impulse/IMPACT_DURATION,gx=node.position.x/STORY_HEIGHT;
 sim.lastRawEnergy=raw;sim.lastImpactEnergy=transfer;sim.lastImpactForce=force;sim.lastImpactStory=0;sim.lastImpactOutcome='GROUND IMPACT';spawnDustPlume(node.position.x,0,clamp(.42+speed*.34,.5,2.45),velocity.x*.18,Math.abs(velocity.y)*.035);
 // Ground impacts load the nearest surviving foundation members, not the collapsing assembly itself.
 let candidates=sim.memberLinks.filter(link=>!body.memberIds?.has(link.id)&&link.e.kind==='column'&&link.e.y===0&&!link.e.failed&&!link.e.snapped&&link.e.integrity>0).sort((a,b)=>Math.abs(a.e.x-gx)-Math.abs(b.e.x-gx));
 if(!candidates.length)candidates=sim.memberLinks.filter(link=>link.e.kind==='column'&&link.e.y===0&&!link.e.failed&&!link.e.snapped&&link.e.integrity>0).sort((a,b)=>Math.abs(a.e.x-gx)-Math.abs(b.e.x-gx));
 const local=candidates.filter(link=>Math.abs(link.e.x-gx)<=1.4).slice(0,4);if(!local.length)local.push(...candidates.slice(0,Math.min(2,candidates.length)));
 const contactWeights=local.map(link=>1/(.35+Math.abs(link.e.x-gx))),contactWeightSum=contactWeights.reduce((sum,w)=>sum+w,0)||1;let failed=0,shattered=0;
 for(let i=0;i<local.length;i++){const link=local[i],share=contactWeights[i]/contactWeightSum,allocated=transfer*(1-SHOCKWAVE_TRANSFER)*share;const result=impactOneMember(link,allocated,force*share,node.position,velocity,mass,'ground impact',share);if(result.failed)failed++;if(result.shattered)shattered++}
 const shock=local.length?propagateShockwave(local[0],transfer*SHOCKWAVE_TRANSFER,{x:node.position.x,y:0},velocity):{count:0,failed:0};failed+=shock.failed;
 sim.lastImpactOutcome=shattered?'GROUND SHATTER':failed?'GROUND SHOCK CASCADE':'GROUND DEFORMATION';sim.lastEvent=shattered?`GROUND IMPACT SHATTER · ${shattered} MEMBER(S)`:failed?`GROUND SHOCKWAVE FAILURE · ${failed} MEMBER(S)`:shock.count?'GROUND SHOCKWAVE · FOUNDATION MEMBERS DEFORMED':'GROUND CONTACT';sim.eventUntil=sim.time+4;
 const story=sim.floors[1];story.lastImpactTime=sim.time;if(local.length){story.structuralIntegrity=local.reduce((sum,link)=>sum+link.e.integrity,0)/local.length;story.integrity=story.structuralIntegrity}
 setStatus(`${sim.lastEvent}. Kinetic energy ${raw.toFixed(2)}; transferred ${transfer.toFixed(2)}; impulse ${impulse.toFixed(2)}; force estimate ${force.toFixed(1)} units.`,true);if(failed||shock.count)refreshAnalysis();
}
function resolveNodeCollisions(previousY){
 const nodes=Object.values(sim.nodes);
 for(const node of nodes){
  const asm=sim.stability.byId[sim.stability.nodeAssembly[node.key]],rotating=!!(asm&&asm.dynamics.isRotating&&asm.supportPoints.length);if((node.isGroundConnected&&!rotating)||node.referenceLevel===0)continue;
  if(node.position.y<=FLOOR_THICKNESS){const speed=Math.max(0,-node.velocity.y),body=physicalComponent(node.key),impactNode={key:node.key,position:{x:node.position.x,y:0},velocity:{x:node.velocity.x,y:node.velocity.y},lastImpactTime:node.lastImpactTime};node.position.y=FLOOR_THICKNESS;node.velocity.y=0;node.acceleration.y=0;if(speed>.5)handleGroundImpact(impactNode,speed,body);continue;}
  const body=physicalComponent(node.key);
  // Falling joints can strike intact column sides as well as horizontal floors. Resolve the
  // closest point against each segment so local clusters cannot simply pass through columns.
  for(const link of sim.memberLinks.slice()){const e=link.e;if(e.kind!=='column'||e.failed||e.snapped||e.integrity<=.01||body.memberIds.has(link.id))continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const sx=b.position.x-a.position.x,sy=b.position.y-a.position.y,den=sx*sx+sy*sy,t=den>.0001?clamp(((node.position.x-a.position.x)*sx+(node.position.y-a.position.y)*sy)/den,0,1):.5,qx=a.position.x+sx*t,qy=a.position.y+sy*t;let nx=node.position.x-qx,ny=node.position.y-qy,dist=Math.hypot(nx,ny);const radius=.105;if(dist>=radius)continue;if(dist<1e-5){const side=node.position.x<((a.position.x+b.position.x)*.5)?-1:node.position.x>((a.position.x+b.position.x)*.5)?1:(node.velocity.x>=0?-1:1);nx=side;ny=0;dist=.001}nx/=dist;ny/=dist;const targetVx=a.velocity.x+(b.velocity.x-a.velocity.x)*t,targetVy=a.velocity.y+(b.velocity.y-a.velocity.y)*t,preVx=node.velocity.x,preVy=node.velocity.y,relVx=preVx-targetVx,relVy=preVy-targetVy,vn=relVx*nx+relVy*ny,closing=Math.max(0,-vn),impactNode={key:node.key,position:{x:qx,y:qy},velocity:{x:preVx,y:preVy},lastImpactTime:node.lastImpactTime};node.position.x+=nx*(radius-dist+.002);node.position.y+=ny*(radius-dist+.002);if(vn<0){node.velocity.x-=nx*(1+IMPACT_RESTITUTION)*vn;node.velocity.y-=ny*(1+IMPACT_RESTITUTION)*vn;const tx=-ny,ty=nx,vt=(node.velocity.x-targetVx)*tx+(node.velocity.y-targetVy)*ty;node.velocity.x-=tx*vt*.24;node.velocity.y-=ty*vt*.24}if(closing>.5)handleMemberImpact(impactNode,link,closing,body);node.lastImpactTime=closing>.5?sim.time:node.lastImpactTime;
  }
  const bodyAfter=physicalComponent(node.key);let best=null;
  for(const link of sim.memberLinks){const e=link.e;if((e.kind!=='slab'&&e.kind!=='beam'&&e.kind!=='brace')||e.failed||e.snapped||e.integrity<=0||e.y>=node.referenceLevel||bodyAfter.memberIds.has(link.id))continue;
   const na=sim.nodes[link.nodeA],nb=sim.nodes[link.nodeB];if(!na||!nb)continue;
   const minX=Math.min(na.position.x,nb.position.x)-.04,maxX=Math.max(na.position.x,nb.position.x)+.04;if(node.position.x<minX||node.position.x>maxX)continue;
   const dx=nb.position.x-na.position.x,t=Math.abs(dx)>.001?clamp((node.position.x-na.position.x)/dx,0,1):.5;const surfaceY=na.position.y+(nb.position.y-na.position.y)*t+FLOOR_THICKNESS,surfaceVy=na.velocity.y+(nb.velocity.y-na.velocity.y)*t;const before=previousY[node.key]??node.position.y;
   if(before>=surfaceY-.04&&node.position.y<surfaceY&&surfaceVy-node.velocity.y>.02&&(!best||surfaceY>best.surfaceY))best={link,na,nb,surfaceY,surfaceVy,t};
  }
  // Settled near-horizontal debris can temporarily act as a weak obstacle under falling nodes.
  for(const d of sim.debris){if(!d.settled||Math.abs(d.angle)>.42)continue;const half=d.length*.5,lo=d.x-half,hi=d.x+half;if(node.position.x<lo||node.position.x>hi)continue;const surfaceY=d.y+d.thickness*.5,before=previousY[node.key]??node.position.y;if(before>=surfaceY-.04&&node.position.y<surfaceY&&-node.velocity.y>.02&&(!best||surfaceY>best.surfaceY))best={debris:d,surfaceY,surfaceVy:0,t:.5};}
  if(best){const incoming={key:node.key,position:{x:node.position.x,y:best.surfaceY},velocity:{x:node.velocity.x,y:node.velocity.y},lastImpactTime:node.lastImpactTime},targetVel=best.surfaceVy??(best.na?best.na.velocity.y+(best.nb.velocity.y-best.na.velocity.y)*best.t:0),rel=Math.max(0,targetVel-node.velocity.y);node.position.y=best.surfaceY;node.velocity.y=targetVel+rel*IMPACT_RESTITUTION;node.velocity.x*=.96;node.acceleration.y=0;if(best.link&&rel>.35)handleMemberImpact(incoming,best.link,rel,body);else if(best.debris&&rel>.45){const d=best.debris;d.settled=false;d.grounded=false;d.vx=clamp(d.vx+node.velocity.x*Math.max(.02,node.mass)/Math.max(.05,d.mass)*.08,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.vy=clamp(d.vy-rel*Math.max(.02,node.mass)/Math.max(.05,d.mass)*.10,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.angularVelocity=clamp(d.angularVelocity+(node.position.x-d.x)*rel*.025,-2.6,2.6);}}
 }
}
async function projectMemberConstraints(){
 // The CPU worker executes the ordered Gauss-Seidel constraint iterations and velocity projection.
 // A main-thread compatibility mode is available if workers are not desired/available.
 const activeSimulation=sim;
 if(!window.FrameLabCompute?.projectConstraints){
  for(let iteration=0;iteration<QUALITY_PROFILE.constraintIterations;iteration++){
   for(const link of sim.memberLinks){if(!linkTransfersSupport(link))continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
    const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,dist=Math.hypot(dx,dy);if(dist<1e-5)continue;
    const jointStiffness=Math.min(link.connectionA.stiffnessFactor||1,link.connectionB.stiffnessFactor||1),holding=(link.connectionA.pendingBreakUntil!=null&&sim.time<link.connectionA.pendingBreakUntil)||(link.connectionB.pendingBreakUntil!=null&&sim.time<link.connectionB.pendingBreakUntil),constraintGain=holding?Math.max(.48,jointStiffness):jointStiffness;
    const error=(dist-link.restLength)/dist,wa=a.referenceLevel===0?0:1/Math.max(.08,a.mass),wb=b.referenceLevel===0?0:1/Math.max(.08,b.mass),sum=wa+wb;if(sum<=0)continue;
    const corrX=dx*error*constraintGain,corrY=dy*error*constraintGain;a.position.x+=corrX*wa/sum;a.position.y+=corrY*wa/sum;b.position.x-=corrX*wb/sum;b.position.y-=corrY*wb/sum;
   }
  }
  for(const link of sim.memberLinks){if(!linkTransfersSupport(link))continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
   const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,dist=Math.hypot(dx,dy);if(dist<1e-5)continue;const nx=dx/dist,ny=dy/dist;
   const jointStiffness=Math.min(link.connectionA.stiffnessFactor||1,link.connectionB.stiffnessFactor||1),holding=(link.connectionA.pendingBreakUntil!=null&&sim.time<link.connectionA.pendingBreakUntil)||(link.connectionB.pendingBreakUntil!=null&&sim.time<link.connectionB.pendingBreakUntil),constraintGain=holding?Math.max(.48,jointStiffness):jointStiffness;
   const rel=((b.velocity.x-a.velocity.x)*nx+(b.velocity.y-a.velocity.y)*ny)*constraintGain;
   if(Math.abs(rel)<1e-5)continue;const wa=a.referenceLevel===0?0:1/Math.max(.08,a.mass),wb=b.referenceLevel===0?0:1/Math.max(.08,b.mass),sum=wa+wb;if(sum<=0)continue;
   a.velocity.x+=nx*rel*wa/sum;a.velocity.y+=ny*rel*wa/sum;b.velocity.x-=nx*rel*wb/sum;b.velocity.y-=ny*rel*wb/sum;
  }
  return;
 }
 const nodes=Object.values(sim.nodes),indices=new Map(nodes.map((node,index)=>[node.key,index]));
 const state=new Float64Array(nodes.length*5);
 for(let i=0;i<nodes.length;i++){
  const node=nodes[i],base=i*5;
  state[base]=node.position.x;state[base+1]=node.position.y;state[base+2]=node.velocity.x;state[base+3]=node.velocity.y;
  state[base+4]=node.referenceLevel===0?0:1/Math.max(.08,node.mass);
 }
 const edgeRows=[];
 for(const link of sim.memberLinks){
  if(!linkTransfersSupport(link))continue;
  const aIndex=indices.get(link.nodeA),bIndex=indices.get(link.nodeB);if(aIndex==null||bIndex==null)continue;
  const jointStiffness=Math.min(link.connectionA.stiffnessFactor||1,link.connectionB.stiffnessFactor||1);
  const holding=(link.connectionA.pendingBreakUntil!=null&&sim.time<link.connectionA.pendingBreakUntil)||(link.connectionB.pendingBreakUntil!=null&&sim.time<link.connectionB.pendingBreakUntil);
  const constraintGain=holding?Math.max(.48,jointStiffness):jointStiffness;
  edgeRows.push(aIndex,bIndex,link.restLength,constraintGain);
 }
 if(!edgeRows.length)return;
 const solved=await window.FrameLabCompute.projectConstraints(state,new Float64Array(edgeRows),QUALITY_PROFILE.constraintIterations);
 if(sim!==activeSimulation)return;
 for(let i=0;i<nodes.length;i++){
  const node=nodes[i],base=i*5;node.position.x=solved[base];node.position.y=solved[base+1];node.velocity.x=solved[base+2];node.velocity.y=solved[base+3];
 }
}
async function integrateMotionBatch(packed,dt){
 if(window.FrameLabCompute?.integrateBodies){
  const result=await window.FrameLabCompute.integrateBodies(packed,dt);
  return result.data;
 }
 // Defensive fallback for a page loaded without the optional compute-backends script.
 const stride=13,step=clamp(Number(dt)||0,0,.05);
 for(let i=0;i<packed.length/stride;i++){
  const b=i*stride,maxVX=Math.max(0,packed[b+10]),maxVY=Math.max(0,packed[b+11]),maxOmega=Math.max(0,packed[b+12]);
  const vx=clamp(packed[b+2]+packed[b+4]*step,-maxVX,maxVX),vy=clamp(packed[b+3]+packed[b+5]*step,-maxVY,maxVY);
  const omega=clamp(packed[b+7]+packed[b+8]*step,-maxOmega,maxOmega)*clamp(packed[b+9],0,1);
  packed[b+2]=vx;packed[b+3]=vy;packed[b]+=vx*step;packed[b+1]+=vy*step;packed[b+7]=omega;packed[b+6]+=omega*step;
 }
 return packed;
}

async function updateMemberPhysics(dt){
 const activeSimulation=sim;
 refreshMemberTopology();calculateStability(lastAnalysis||analyzeStructure());
 const previousY=Object.create(null),stability=sim.stability,nodeAssembly=stability.nodeAssembly,byId=stability.byId,snapForces=Object.create(null),nodeDensity=Object.create(null);if(ENVIRONMENT.waterLevel>0&&PHYSICS_MODEL){for(const link of sim.memberLinks){if(link.e.failed)continue;const density=PHYSICS_MODEL.materials[link.e.material]?.density||2,weight=Math.max(.01,link.e.mass);for(const key of [link.nodeA,link.nodeB]){const bucket=nodeDensity[key]||(nodeDensity[key]={mass:0,weighted:0});bucket.mass+=weight;bucket.weighted+=density*weight}}}
 const sagVertical=Object.create(null),spanPulls=Object.create(null);for(const link of sim.memberLinks){const e=link.e;if(e.kind!=='beam'||e.failed)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;if(e.snapped){const center=Number.isFinite(e.snapCenterX)?e.snapCenterX:(a.position.x+b.position.x)*.5,sagFactor=clamp((e.snapSag||0)/(STORY_HEIGHT*.55),0,1),pull=clamp((.48+.34*Math.max(1,e.momentUtilization))*sagFactor,0,2.6);snapForces[link.nodeA]=(snapForces[link.nodeA]||0)+Math.sign(center-a.position.x)*pull;snapForces[link.nodeB]=(snapForces[link.nodeB]||0)+Math.sign(center-b.position.x)*pull;const groupKey=`${e.y}:${e.snapLeft}:${e.snapRight}`,row=spanPulls[groupKey]||(spanPulls[groupKey]={level:e.y,left:e.snapLeft,right:e.snapRight,center,pull:0});row.pull=Math.max(row.pull,clamp((.35+.26*Math.max(1,e.momentUtilization))*sagFactor,0,1.8));continue;}if(!e.sagging||e.sag<.01)continue;const center=(a.position.x+b.position.x)*.5,sagFactor=clamp(e.sag/(STORY_HEIGHT*.34),0,1),pull=clamp(.05+(e.catenaryRatio||0)*.20+sagFactor*.48,0,1.5),vertical=clamp(sagFactor*.18+Math.max(0,e.momentUtilization-.55)*.08+Math.abs(e.sagVelocity||0)*.035,0,.48);snapForces[link.nodeA]=(snapForces[link.nodeA]||0)+Math.sign(center-a.position.x)*pull;snapForces[link.nodeB]=(snapForces[link.nodeB]||0)+Math.sign(center-b.position.x)*pull;sagVertical[link.nodeA]=(sagVertical[link.nodeA]||0)+vertical*.5;sagVertical[link.nodeB]=(sagVertical[link.nodeB]||0)+vertical*.5;const groupKey=`${e.y}:${e.x}`;const row=spanPulls[groupKey]||(spanPulls[groupKey]={level:e.y,left:e.x,right:e.x+1,center,pull:0});row.pull=Math.max(row.pull,pull*.45)}for(const row of Object.values(spanPulls)){for(const x of [row.left,row.right]){const nodeKey=keyOf(x,row.level),n=sim.nodes[nodeKey];if(n)snapForces[nodeKey]=(snapForces[nodeKey]||0)+Math.sign(row.center-n.position.x)*row.pull;}}
 const motionNodes=[];
 for(const node of Object.values(sim.nodes)){
  previousY[node.key]=node.position.y;
  if(node.referenceLevel===0){node.position.x=node.reference.x;node.position.y=0;node.velocity.x=0;node.velocity.y=0;node.acceleration.x=0;node.acceleration.y=0;continue;}
  const assembly=byId[nodeAssembly[node.key]],dyn=assembly?.dynamics,rotating=!!(dyn&&dyn.isRotating&&assembly.supportPoints.length),directVerticalSupport=hasDirectVerticalSupport(node);
  const cantileverUtil=node.isGroundConnected&&!directVerticalSupport?cantileverUtilizationAtNode(node):null,cantileverSupported=cantileverUtil!==null,isTetheredNode=gravityTether?.kind==='node'&&gravityTether.nodeKey===node.key,tetherForce=isTetheredNode?springForce(gravityTether.targetX,gravityTether.targetY,node.position.x,node.position.y,node.velocity.x,node.velocity.y,34):{x:0,y:0},nodeSubmerged=ENVIRONMENT.waterLevel>0&&PHYSICS_MODEL?PHYSICS_MODEL.submergedFraction(node.position.y-.10,node.position.y+.10,waterSurfaceWorld()):0,nodeDensityValue=nodeDensity[node.key]?.mass?nodeDensity[node.key].weighted/nodeDensity[node.key].mass:2,nodeBuoyancy=GRAVITY*nodeSubmerged/Math.max(.3,nodeDensityValue),mediumDrag=.018+nodeSubmerged*1.25;
  // Keep ordinary two-sided frames pinned to their structural reference unless the node lies
  // on a genuine one-sided overhang. Its spring-like lateral settling still runs through the compute backend.
  if(node.isGroundConnected&&!rotating&&!cantileverSupported&&!isTetheredNode){
   node.acceleration.x=-2.4*(node.position.x-node.reference.x)-1.15*node.velocity.x+(snapForces[node.key]||0);
   node.acceleration.y=0;
   motionNodes.push({node,pinned:true,ax:node.acceleration.x,ay:0,alpha:0,damping:1,maxVX:5,maxVY:MAX_FALL_SPEED,maxOmega:3.4});
   continue;
  }
  // A one-sided cantilever gradually gives way under load, then enters full gravity after root failure.
  const cantileverGravity=cantileverSupported?clamp((cantileverUtil-.58)*2.2,0,1):1;
  node.acceleration.x=-.22*node.velocity.x+(snapForces[node.key]||0)-mediumDrag*node.velocity.x+clamp(tetherForce.x/Math.max(.12,node.mass),-18,18);
  node.acceleration.y=(directVerticalSupport?0:-GRAVITY*cantileverGravity)+nodeBuoyancy-mediumDrag*node.velocity.y-(sagVertical[node.key]||0)+clamp(tetherForce.y/Math.max(.12,node.mass),-18,18);
  if(rotating){
   // Angular acceleration about the surviving pivot contributes tangential acceleration to each joint.
   const rx=node.position.x-dyn.pivotX,ry=node.position.y-dyn.pivotY;
   node.acceleration.x+=-dyn.angularAcceleration*ry;
   node.acceleration.y+=dyn.angularAcceleration*rx;
  }
  motionNodes.push({node,pinned:false,ax:node.acceleration.x,ay:node.acceleration.y,alpha:0,damping:1,maxVX:5,maxVY:MAX_FALL_SPEED,maxOmega:3.4});
 }
 if(motionNodes.length){
  const stride=window.FrameLabCompute?.bodyStride||13,packed=new Float32Array(motionNodes.length*stride);
  for(let i=0;i<motionNodes.length;i++){
   const m=motionNodes[i],n=m.node,b=i*stride;
   packed[b]=n.position.x;packed[b+1]=n.position.y;packed[b+2]=n.velocity.x;packed[b+3]=n.velocity.y;
   packed[b+4]=m.ax;packed[b+5]=m.ay;packed[b+6]=0;packed[b+7]=0;packed[b+8]=m.alpha;packed[b+9]=m.damping;
   packed[b+10]=m.maxVX;packed[b+11]=m.maxVY;packed[b+12]=m.maxOmega;
  }
  const result=await integrateMotionBatch(packed,dt);
  if(sim!==activeSimulation)return;
  for(let i=0;i<motionNodes.length;i++){
   const m=motionNodes[i],n=m.node,b=i*stride;
   n.position.x=result[b];n.position.y=m.pinned?n.reference.y:result[b+1];
   n.velocity.x=result[b+2];n.velocity.y=m.pinned?0:result[b+3];
   if(m.pinned){n.acceleration.y=0;} 
  }
 }
 await projectMemberConstraints();if(sim!==activeSimulation)return;resolveNodeCollisions(previousY);await projectMemberConstraints();if(sim!==activeSimulation)return;resolveNodeCollisions(previousY);
 const worldWidth=NX*STORY_HEIGHT;for(const node of Object.values(sim.nodes)){if(node.referenceLevel>0){if(node.position.x<0){node.position.x=0;if(node.velocity.x<0)node.velocity.x=-node.velocity.x*.10;else node.velocity.x*=.80}if(node.position.x>worldWidth){node.position.x=worldWidth;if(node.velocity.x>0)node.velocity.x=-node.velocity.x*.10;else node.velocity.x*=.80}}}
 for(const node of Object.values(sim.nodes)){if(node.position.y<FLOOR_THICKNESS){node.position.y=FLOOR_THICKNESS;if(node.velocity.y<0)node.velocity.y=0}if(node.referenceLevel===0){node.position.x=node.reference.x;node.position.y=0;node.velocity.x=0;node.velocity.y=0}}
 refreshMemberTopology();calculateStability(lastAnalysis||analyzeStructure());
}
async function updateDebris(dt){
 const activeSimulation=sim;
 const motionSnapshots=new Map(),motionBodies=[];
 // Age/remove settled fragments first, then send all live rigid-body force integration
 // to the same CPU-worker/WebGPU kernel used by structural joints.
 for(let i=sim.debris.length-1;i>=0;i--){
  const d=sim.debris[i];d.age+=dt;
  const tetheredDebris=gravityTether?.kind==='debris'&&gravityTether.id===d.id;
  if(d.age>26&&!tetheredDebris){sim.debris.splice(i,1);continue}
  if(d.settled&&!tetheredDebris)continue;
  if(tetheredDebris){d.settled=false;d.grounded=false}
  const oldBounds=updateDebrisBounds(d),oldX=d.x,oldY=d.y;
  const projectedWidth=Math.abs(Math.cos(d.angle))*d.length+Math.abs(Math.sin(d.angle))*d.thickness;
  const projectedHeight=Math.abs(Math.sin(d.angle))*d.length+Math.abs(Math.cos(d.angle))*d.thickness;
  const projectedArea=Math.max(.025,projectedWidth*Math.max(.04,d.thickness));
  const submerged=ENVIRONMENT.waterLevel>0&&PHYSICS_MODEL?PHYSICS_MODEL.submergedFraction(oldBounds.bottom,oldBounds.top,waterSurfaceWorld()):0;
  const environmentForce=PHYSICS_MODEL?PHYSICS_MODEL.environmentAcceleration({vx:d.vx,vy:d.vy,area:projectedArea,mass:d.mass,material:d.material,submerged,gravity:GRAVITY}):{ax:-.13*d.vx,ay:-GRAVITY-.13*d.vy};
  let tetherFx=0,tetherFy=0,angularAcceleration=0;
  if(tetheredDebris){
   const c=Math.cos(d.angle),sn=Math.sin(d.angle),offsetX=(gravityTether.localX||0)*c-(gravityTether.localY||0)*sn,offsetY=(gravityTether.localX||0)*sn+(gravityTether.localY||0)*c;
   const anchorX=d.x+offsetX,anchorY=d.y+offsetY,anchorVx=d.vx-d.angularVelocity*offsetY,anchorVy=d.vy+d.angularVelocity*offsetX;
   const spring=springForce(gravityTether.targetX,gravityTether.targetY,anchorX,anchorY,anchorVx,anchorVy,30);
   tetherFx=spring.x;tetherFy=spring.y;angularAcceleration=(offsetX*tetherFy-offsetY*tetherFx)/Math.max(.03,d.momentOfInertia);
  }
  const effectiveMass=Math.max(.08,d.mass),ax=environmentForce.ax+tetherFx/effectiveMass,ay=environmentForce.ay+tetherFy/effectiveMass;
  const predictedVX=clamp(d.vx+ax*dt,-MAX_FALL_SPEED,MAX_FALL_SPEED);
  const angularDamping=Math.exp(-(.22+Math.max(0,.7-Math.abs(predictedVX))*.18+submerged*1.6)*dt);
  motionSnapshots.set(d.id,{oldX,oldY,oldBounds,oldBottom:oldBounds.bottom});
  motionBodies.push({d,ax,ay,angularAcceleration,angularDamping});
 }
 if(motionBodies.length){
  const stride=window.FrameLabCompute?.bodyStride||13,packed=new Float32Array(motionBodies.length*stride);
  for(let i=0;i<motionBodies.length;i++){
   const m=motionBodies[i],d=m.d,b=i*stride;
   packed[b]=d.x;packed[b+1]=d.y;packed[b+2]=d.vx;packed[b+3]=d.vy;packed[b+4]=m.ax;packed[b+5]=m.ay;
   packed[b+6]=d.angle;packed[b+7]=d.angularVelocity;packed[b+8]=m.angularAcceleration;packed[b+9]=m.angularDamping;
   packed[b+10]=MAX_FALL_SPEED;packed[b+11]=MAX_FALL_SPEED;packed[b+12]=3.4;
  }
  const result=await integrateMotionBatch(packed,dt);
  if(sim!==activeSimulation)return;
  for(let i=0;i<motionBodies.length;i++){
   const d=motionBodies[i].d,b=i*stride;d.x=result[b];d.y=result[b+1];d.vx=result[b+2];d.vy=result[b+3];d.angle=result[b+6];d.angularVelocity=result[b+7];
   updateDebrisBounds(d);
  }
 }
 for(let i=sim.debris.length-1;i>=0;i--){
  const d=sim.debris[i],snapshot=motionSnapshots.get(d.id);if(!snapshot)continue;
  const oldX=snapshot.oldX,oldY=snapshot.oldY,oldBounds=snapshot.oldBounds,oldBottom=snapshot.oldBottom;
  let bounds=updateDebrisBounds(d),halfY=(bounds.top-bounds.bottom)*.5,columnContact=null;
  // Side impacts against columns use a swept centre path plus the closest point on the actual segment.
  // This catches slender debris that would otherwise tunnel through a column at high speed.
  for(const link of sim.memberLinks){const e=link.e;if(e.kind!=='column'||e.failed||e.snapped||e.integrity<=.01||d.sourceId===link.id)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const sx=b.position.x-a.position.x,sy=b.position.y-a.position.y,len=Math.hypot(sx,sy),den=sx*sx+sy*sy;if(len<.001)continue;const tx=sx/len,ty=sy/len,nlx=-ty,nly=tx,minX=Math.min(a.position.x,b.position.x)-d.length*.5-.12,maxX=Math.max(a.position.x,b.position.x)+d.length*.5+.12,minY=Math.min(a.position.y,b.position.y)-d.length*.5-.12,maxY=Math.max(a.position.y,b.position.y)+d.length*.5+.12;if(Math.max(oldX,d.x)<minX||Math.min(oldX,d.x)>maxX||Math.max(oldY,d.y)<minY||Math.min(oldY,d.y)>maxY)continue;
   const qT=clamp(((d.x-a.position.x)*sx+(d.y-a.position.y)*sy)/den,0,1),qx=a.position.x+sx*qT,qy=a.position.y+sy*qT;let nx=d.x-qx,ny=d.y-qy,dist=Math.hypot(nx,ny),radius=debrisProjectionRadius(d,nx/(dist||1),ny/(dist||1))+.065,depth=radius-dist,cx=d.x,cy=d.y,t=qT,swept=false;
   if(depth<=0){const oldSide=(oldX-a.position.x)*nlx+(oldY-a.position.y)*nly,newSide=(d.x-a.position.x)*nlx+(d.y-a.position.y)*nly;if(oldSide*newSide>0||Math.abs(oldSide-newSide)<1e-6)continue;const alpha=clamp(oldSide/(oldSide-newSide),0,1);cx=oldX+(d.x-oldX)*alpha;cy=oldY+(d.y-oldY)*alpha;const along=(cx-a.position.x)*tx+(cy-a.position.y)*ty;if(along<-.12||along>len+.12)continue;const side=oldSide>=0?1:-1;nx=nlx*side;ny=nly*side;t=clamp(along/len,0,1);radius=debrisProjectionRadius(d,nx,ny)+.065;depth=radius;dist=0;swept=true;}
   else{nx/=Math.max(1e-6,dist);ny/=Math.max(1e-6,dist)}
   if(depth>0&&(!columnContact||depth>columnContact.depth))columnContact={link,a,b,t,qx:a.position.x+sx*t,qy:a.position.y+sy*t,nx,ny,depth,cx,cy,radius,swept,dist};}
  if(columnContact){const c=columnContact,surfaceVx=c.a.velocity.x+(c.b.velocity.x-c.a.velocity.x)*c.t,surfaceVy=c.a.velocity.y+(c.b.velocity.y-c.a.velocity.y)*c.t,preVx=d.vx,preVy=d.vy,rvx=preVx-surfaceVx,rvy=preVy-surfaceVy,vn=rvx*c.nx+rvy*c.ny,closing=Math.max(0,-vn),impactNode={position:{x:c.qx,y:c.qy},velocity:{x:preVx,y:preVy},lastImpactTime:sim.time};if(c.swept){d.x=c.cx+c.nx*(c.radius+.002);d.y=c.cy+c.ny*(c.radius+.002)}else{d.x+=c.nx*(c.depth+.002);d.y+=c.ny*(c.depth+.002)}if(vn<0){const response=getContactResponse(d.material,c.link.e.material,closing),j=-(1+response.restitution)*vn;d.vx+=j*c.nx;d.vy+=j*c.ny;const tx=-c.ny,ty=c.nx,vt=(d.vx-surfaceVx)*tx+(d.vy-surfaceVy)*ty,grip=clamp(response.dynamicFriction*.72,.06,.72);d.vx-=tx*vt*grip;d.vy-=ty*vt*grip;const rx=c.qx-d.x,ry=c.qy-d.y;d.angularVelocity=clamp(d.angularVelocity+(rx*(j*c.ny)-ry*(j*c.nx))/Math.max(.02,d.momentOfInertia),-3,3);if(d.settled&&closing>.65){d.settled=false;d.grounded=false}}
   if(closing>.55)handleMemberImpact(impactNode,c.link,closing,{mass:d.mass,memberIds:new Set(),signature:`debris:${d.id}`});bounds=updateDebrisBounds(d);halfY=(bounds.top-bounds.bottom)*.5;}
  let contact=null;
  for(const link of sim.memberLinks){
   const e=link.e;if(e.failed||e.snapped||(e.kind!=='beam'&&e.kind!=='slab')||e.integrity<=.01)continue;
   const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
   const left=Math.min(a.position.x,b.position.x),right=Math.max(a.position.x,b.position.x);
   // Sweep the debris AABB from the previous transform to the current transform. Checking
   // only the final X coordinate can miss a thin floor when a long fragment moves sideways.
   const sweptLeft=Math.min(oldBounds.left,bounds.left),sweptRight=Math.max(oldBounds.right,bounds.right);
   if(sweptRight<left||sweptLeft>right)continue;
   const dx=b.position.x-a.position.x,xEstimate=clamp(d.x,left,right),tEstimate=Math.abs(dx)>.001?clamp((xEstimate-a.position.x)/dx,0,1):.5;
   const estimatedSurface=a.position.y+(b.position.y-a.position.y)*tEstimate+FLOOR_THICKNESS;
   if(oldBottom<estimatedSurface-.045||bounds.bottom>=estimatedSurface||d.vy>=(a.velocity.y+(b.velocity.y-a.velocity.y)*tEstimate)-.02)continue;
   const crossingT=clamp((oldBottom-estimatedSurface)/Math.max(1e-6,oldBottom-bounds.bottom),0,1),crossingX=oldX+(d.x-oldX)*crossingT;
   const contactX=clamp(crossingX,left,right),t=Math.abs(dx)>.001?clamp((contactX-a.position.x)/dx,0,1):.5;
   const surfaceY=a.position.y+(b.position.y-a.position.y)*t+FLOOR_THICKNESS,surfaceVy=a.velocity.y+(b.velocity.y-a.velocity.y)*t,surfaceVx=a.velocity.x+(b.velocity.x-a.velocity.x)*t;
   if(oldBottom>=surfaceY-.045&&bounds.bottom<surfaceY&&d.vy<surfaceVy-.02&&(!contact||surfaceY>contact.surface))contact={link,surface:surfaceY,surfaceVx,surfaceVy,t,x:contactX};
  }
  const groundHit=bounds.bottom<=0;
  if(contact){
   const target=contact.link,closingSpeed=Math.max(0,contact.surfaceVy-d.vy),impactNode={position:{x:d.x,y:contact.surface},velocity:{x:d.vx,y:d.vy},lastImpactTime:sim.time};
   const response=getContactResponse(d.material,target.e.material,closingSpeed),grip=clamp(response.dynamicFriction*.68,.07,.70);d.y=contact.surface+halfY;d.vy=contact.surfaceVy+closingSpeed*response.restitution;d.vx=contact.surfaceVx+(d.vx-contact.surfaceVx)*(1-grip);d.angularVelocity=clamp(d.angularVelocity+(contact.x-(sim.nodes[target.nodeA].position.x+sim.nodes[target.nodeB].position.x)*.5)*closingSpeed*Math.max(.01,d.mass)/Math.max(.02,d.momentOfInertia)*.012,-2.8,2.8)*(1-grip*.20);
   if(closingSpeed>.45){d.impactCount=(d.impactCount||0)+1;d.reason+=' · impact '+d.impactCount;handleMemberImpact(impactNode,target,closingSpeed,{mass:d.mass,memberIds:new Set(),signature:`debris:${d.id}`});}
   const nearVertical=d.kind==='column'&&Math.abs(Math.sin(d.angle))>.70;if(nearVertical&&closingSpeed>.45)d.angularVelocity=d.tipDirection*Math.max(.28,Math.abs(d.angularVelocity));
   if(closingSpeed<.65&&Math.abs(d.angularVelocity)<.18&&(d.kind!=='column'||Math.abs(Math.sin(d.angle))<.80)){d.settled=true;d.vx=contact.surfaceVx;d.vy=contact.surfaceVy;d.angularVelocity=0;d.angle=Math.round(d.angle/(Math.PI/2))*(Math.PI/2);d.y=contact.surface+(Math.abs(Math.cos(d.angle))*d.thickness+Math.abs(Math.sin(d.angle))*d.length)*.5;}
   updateDebrisBounds(d);
  }else if(groundHit){
   const closingSpeed=Math.max(0,-d.vy),impactNode={position:{x:d.x,y:0},velocity:{x:d.vx,y:d.vy},lastImpactTime:sim.time},response=getContactResponse(d.material,'concrete',closingSpeed),grip=clamp(response.dynamicFriction*.66,.07,.68);d.y=halfY;d.vy=closingSpeed*response.restitution;d.vx*=1-grip;const nearVertical=d.kind==='column'&&Math.abs(Math.sin(d.angle))>.70;
   if(nearVertical&&closingSpeed>.45){d.angularVelocity=d.tipDirection*Math.max(.28,Math.abs(d.angularVelocity));d.vx+=d.tipDirection*.025}else d.angularVelocity*=.55;
   const body={mass:d.mass,memberIds:new Set(),signature:`debris:${d.id}`};if(!d.grounded&&closingSpeed>.45)handleGroundImpact(impactNode,closingSpeed,body);d.grounded=true;
   if(closingSpeed<.65&&Math.abs(d.angularVelocity)<.16&&(d.kind!=='column'||Math.abs(Math.sin(d.angle))<.80)){d.settled=true;d.vx=0;d.vy=0;d.angularVelocity=0;d.y=halfY;}updateDebrisBounds(d);
  }
  if(Math.abs(d.x)>NX*STORY_HEIGHT*1.8){d.x=clamp(d.x,-NX*STORY_HEIGHT*.5,NX*STORY_HEIGHT*1.5);d.vx*=-.25}
 }
 resolveDebrisCollisions(dt);for(const d of sim.debris)containDebrisInGrid(d);
}
function debrisProjectionRadius(d,axisX,axisY){const ux=Math.cos(d.angle),uy=Math.sin(d.angle),vx=-uy,vy=ux;return Math.abs(ux*axisX+uy*axisY)*d.length*.5+Math.abs(vx*axisX+vy*axisY)*d.thickness*.5}
function debrisInverseMass(d){return (d.settled ? .12 : 1)/Math.max(.025,d.mass)}
function debrisInertia(d){return Math.max(.01,d.mass*(d.length*d.length+d.thickness*d.thickness)/12)}
function fragmentDebris(d,energy){
 if(!d||d.fragmentDepth>=2||d.length<.24||sim.debris.length>=MAX_DEBRIS-1)return false;const index=sim.debris.indexOf(d);if(index<0)return false;
 const childMass=Math.max(.015,d.mass*.44),childLength=Math.max(.10,d.length*.52),childThickness=Math.max(.035,d.thickness*.72),kick=clamp(Math.sqrt(Math.max(.01,energy)/Math.max(.05,d.mass))*.20,.25,2.2),next=[];
 for(const sign of [-1,1]){const child={...d,id:sim.nextDebrisId++,sourceId:`fragment:${d.id}`,x:d.x+Math.cos(d.angle)*sign*childLength*.18,y:d.y+Math.sin(d.angle)*sign*childLength*.18,angle:d.angle+sign*.10,length:childLength,thickness:childThickness,mass:childMass,capacity:Math.max(.01,d.capacity*.38),durability:Math.max(.5,d.durability*.34),integrity:.62,vx:clamp(d.vx+sign*Math.cos(d.angle)*kick,-MAX_FALL_SPEED,MAX_FALL_SPEED),vy:clamp(d.vy+sign*Math.sin(d.angle)*kick+.12,-MAX_FALL_SPEED,MAX_FALL_SPEED),angularVelocity:clamp(d.angularVelocity+sign*.32,-3.2,3.2),momentOfInertia:Math.max(.01,childMass*childLength*childLength/12),age:0,settled:false,grounded:false,fragmentDepth:(d.fragmentDepth||0)+1,fragmented:false,reason:`fragmented after impact · ${d.material}`,impactCooldown:-Infinity,impactCount:(d.impactCount||0)+1};updateDebrisBounds(child);next.push(child)}
 sim.debris.splice(index,1,...next);return true;
}
function resolveDebrisCollisions(dt){
 if(sim.debris.length<2)return;const cellSize=STORY_HEIGHT*1.25,buckets=new Map(),pairs=new Set(),live=sim.debris.slice(),debrisById=new Map(live.map(d=>[d.id,d]));
 for(const d of live){updateDebrisBounds(d);const b=d.collisionBounds,x0=Math.floor(b.left/cellSize),x1=Math.floor(b.right/cellSize),y0=Math.floor(b.bottom/cellSize),y1=Math.floor(b.top/cellSize);for(let x=x0;x<=x1;x++)for(let y=y0;y<=y1;y++){const k=`${x}:${y}`;if(!buckets.has(k))buckets.set(k,[]);buckets.get(k).push(d)}}
 for(const bucket of buckets.values())for(let i=0;i<bucket.length;i++)for(let j=i+1;j<bucket.length;j++){const a=bucket[i],b=bucket[j];if(a===b)continue;const key=a.id<b.id?`${a.id}:${b.id}`:`${b.id}:${a.id}`;pairs.add(key)}
 const fragments=[];
 for(const pairKey of pairs){const [idA,idB]=pairKey.split(':').map(Number),a=debrisById.get(idA),b=debrisById.get(idB);if(!a||!b||!sim.debris.includes(a)||!sim.debris.includes(b))continue;if(a.settled&&b.settled)continue;
  const ba=a.collisionBounds,bb=b.collisionBounds;if(ba.right<bb.left||bb.right<ba.left||ba.top<bb.bottom||bb.top<ba.bottom)continue;
  const dx=b.x-a.x,dy=b.y-a.y,rvCenterX=b.vx-a.vx,rvCenterY=b.vy-a.vy,axes=[[Math.cos(a.angle),Math.sin(a.angle)],[-Math.sin(a.angle),Math.cos(a.angle)],[Math.cos(b.angle),Math.sin(b.angle)],[-Math.sin(b.angle),Math.cos(b.angle)]];let minOverlap=Infinity,nx=0,ny=0,closingOverlap=Infinity,closingNx=0,closingNy=0,separated=false;
  for(const axis of axes){const [ax,ay]=axis,projection=dx*ax+dy*ay,dist=Math.abs(projection),ra=debrisProjectionRadius(a,ax,ay),rb=debrisProjectionRadius(b,ax,ay),overlap=ra+rb-dist;if(overlap<=0){separated=true;break}const sign=projection>=0?1:-1,cx=ax*sign,cy=ay*sign;if(overlap<minOverlap){minOverlap=overlap;nx=cx;ny=cy}if(rvCenterX*cx+rvCenterY*cy<-.015&&overlap<closingOverlap){closingOverlap=overlap;closingNx=cx;closingNy=cy}}
  if(separated||!Number.isFinite(minOverlap))continue;if(Number.isFinite(closingOverlap)){minOverlap=closingOverlap;nx=closingNx;ny=closingNy}
  const imA=debrisInverseMass(a),imB=debrisInverseMass(b),sum=imA+imB;if(sum<=0)continue;const correction=Math.max(0,minOverlap-.006)*.72/sum;a.x-=nx*correction*imA;b.x+=nx*correction*imB;a.y-=ny*correction*imA;b.y+=ny*correction*imB;
  const tangentX=-ny,tangentY=nx,raN=debrisProjectionRadius(a,nx,ny),rbN=debrisProjectionRadius(b,nx,ny),tangentOffset=(dx*tangentX+dy*tangentY)*.5,contactX=(a.x+nx*raN+tangentX*tangentOffset+b.x-nx*rbN)/2,contactY=(a.y+ny*raN+tangentY*tangentOffset+b.y-ny*rbN)/2,rAx=contactX-a.x,rAy=contactY-a.y,rBx=contactX-b.x,rBy=contactY-b.y;
  const pointVel=(d,rx,ry)=>({x:d.vx-d.angularVelocity*ry,y:d.vy+d.angularVelocity*rx});let va=pointVel(a,rAx,rAy),vb=pointVel(b,rBx,rBy),rvx=vb.x-va.x,rvy=vb.y-va.y,vn=rvx*nx+rvy*ny;let normalImpulse=0;
  if(vn<0){const response=getContactResponse(a.material,b.material,Math.abs(vn)),ia=debrisInertia(a),ib=debrisInertia(b),ca=rAx*ny-rAy*nx,cb=rBx*ny-rBy*nx,denom=imA+imB+ca*ca/ia+cb*cb/ib;if(denom>1e-8){normalImpulse=clamp(-(1+response.restitution)*vn/denom,0,Math.max(.1,(a.mass+b.mass)*MAX_FALL_SPEED*1.8));a.vx-=normalImpulse*imA*nx;a.vy-=normalImpulse*imA*ny;b.vx+=normalImpulse*imB*nx;b.vy+=normalImpulse*imB*ny;a.angularVelocity=clamp(a.angularVelocity-normalImpulse*ca/ia,-3.4,3.4);b.angularVelocity=clamp(b.angularVelocity+normalImpulse*cb/ib,-3.4,3.4);
    va=pointVel(a,rAx,rAy);vb=pointVel(b,rBx,rBy);rvx=vb.x-va.x;rvy=vb.y-va.y;const vt=rvx*tangentX+rvy*tangentY,ta=rAx*tangentY-rAy*tangentX,tb=rBx*tangentY-rBy*tangentX,tDenom=imA+imB+ta*ta/ia+tb*tb/ib;let jt=tDenom>1e-8?-vt/tDenom:0;jt=clamp(jt,-normalImpulse*clamp(response.dynamicFriction,.06,.82),normalImpulse*clamp(response.dynamicFriction,.06,.82));a.vx-=jt*imA*tangentX;a.vy-=jt*imA*tangentY;b.vx+=jt*imB*tangentX;b.vy+=jt*imB*tangentY;a.angularVelocity=clamp(a.angularVelocity-jt*ta/ia,-3.4,3.4);b.angularVelocity=clamp(b.angularVelocity+jt*tb/ib,-3.4,3.4);
   }}
  if(normalImpulse>.08){if(a.settled&&normalImpulse>.3){a.settled=false;a.grounded=false}if(b.settled&&normalImpulse>.3){b.settled=false;b.grounded=false}}
  const closing=Math.max(0,-vn),reducedMass=imA+imB>0?1/(imA+imB):0,energy=.5*reducedMass*closing*closing;
  const stamp=`debris-impact:${pairKey}`,freshImpact=sim.time-(sim.collisionPairs[stamp]??-Infinity)>.18;if(closing>.8&&energy>.05&&freshImpact){sim.collisionPairs[stamp]=sim.time;const damageA=Math.min(.35,energy/Math.max(1,a.durability||1)*.22),damageB=Math.min(.35,energy/Math.max(1,b.durability||1)*.22);a.integrity=clamp((a.integrity??1)-damageA,0,1);b.integrity=clamp((b.integrity??1)-damageB,0,1);a.impactCount=(a.impactCount||0)+1;b.impactCount=(b.impactCount||0)+1;a.reason=a.reason||'debris collision';b.reason=b.reason||'debris collision';if((energy>Math.max(1,(a.durability||1)*.85)||a.integrity<.12)&&a.fragmentDepth<2)fragments.push([a,energy]);if((energy>Math.max(1,(b.durability||1)*.85)||b.integrity<.12)&&b.fragmentDepth<2)fragments.push([b,energy]);}
  a.vx=clamp(a.vx,-MAX_FALL_SPEED,MAX_FALL_SPEED);b.vx=clamp(b.vx,-MAX_FALL_SPEED,MAX_FALL_SPEED);a.vy=clamp(a.vy,-MAX_FALL_SPEED,MAX_FALL_SPEED);b.vy=clamp(b.vy,-MAX_FALL_SPEED,MAX_FALL_SPEED);updateDebrisBounds(a);updateDebrisBounds(b);
 }
 const uniqueFragments=[...new Map(fragments.map(([d,e])=>[d.id,[d,e]])).values()];for(const [d,e] of uniqueFragments)if(sim.debris.includes(d)&&sim.debris.length<MAX_DEBRIS)fragmentDebris(d,e);
 if(sim.debris.length>MAX_DEBRIS){sim.debris.sort((a,b)=>Number(b.settled)-Number(a.settled)||b.age-a.age);sim.debris.splice(0,sim.debris.length-MAX_DEBRIS)}
}
function snapBeamAtMidspan(link,bending){
 const e=link?.e;if(!e||e.failed||e.snapped)return false;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)return false;
 e.bendingMoment=bending.moment;e.momentUtilization=bending.moment/Math.max(.01,e.momentCapacity*Math.max(.18,e.integrity));e.momentOverloadTime=0;e.lateralForce=Math.min(8,bending.moment/Math.max(.1,e.momentCapacity));
 const matchingSlab=BuildingMap.slabs[keyOf(e.x,e.y)];const changed=failMember(link,`INSTANT FRACTURE · MID-SPAN BENDING CAPACITY EXCEEDED · ${bending.moment.toFixed(1)} moment units`);
 const deckLink=sim.memberLinks.find(l=>l.group==='slabs'&&l.key===keyOf(e.x,e.y));if(matchingSlab&&!matchingSlab.failed&&deckLink)failMember(deckLink,'INSTANT FRACTURE · DECK SPLIT AFTER BEAM FAILURE');
 e.snapped=true;e.state='SHATTERED';sim.lastEvent=`MID-SPAN FRACTURE · BAY ${e.x+1} · LEVEL ${e.y}`;sim.eventUntil=sim.time+3.5;
 for(const key of [link.nodeA,link.nodeB]){const n=sim.nodes[key];if(n){n.velocity.x=clamp(n.velocity.x+Math.sign((a.position.x+b.position.x)*.5-n.position.x)*.045*e.lateralForce,-5,5);n.isStressed=true}}
 return changed;
}
function failCantileverRoot(rootLink,bending){
 if(!rootLink||rootLink.e.failed)return false;const e=rootLink.e,bay=keyOf(e.x,e.y);
 let changed=failMember(rootLink,`CANTILEVER ROOT FAILURE · bending demand ${Number(e.momentUtilization||0).toFixed(2)}× capacity`);
 // A deck in the same root bay can otherwise leave a false connection to the grounded node.
 const deck=BuildingMap.slabs[bay],deckLink=sim.memberLinks.find(l=>l.group==='slabs'&&l.key===bay);
 if(deck&&!deck.failed&&!deck.snapped&&deckLink)changed=failMember(deckLink,'cantilever deck detached with its overloaded root beam')||changed;
 sim.lastEvent=`CANTILEVER ROOT FAILURE · LEVEL ${e.y} · BAY ${e.x+1}`;sim.eventUntil=sim.time+3.5;
 return changed;
}
function evaluateBeamBending(dt){
 const candidates=[],bySpan=Object.create(null);
 for(const link of sim.memberLinks){
  const e=link.e;if(e.kind!=='beam'||e.failed||e.snapped||e.integrity<=.02)continue;
  const bending=beamBendingData(e);e.bendingMoment=bending.moment;e.effectiveSpan=bending.span.bays;
  e.momentUtilization=bending.moment/Math.max(.01,(e.momentCapacity||e.capacity*.42)*e.integrity*Math.max(.18,e.connectionFactor||1));
  const span=bending.span,unsupportedEnd=!span.leftSupported||!span.rightSupported,oneSided=span.leftSupported!==span.rightSupported,spanGain=Math.max(0,span.bays-1);
  if(e.momentUtilization>.56||unsupportedEnd||span.bays>1)e.sagging=true;
  // Cantilevers show more deformation with overhang length and demand; the anchored root
  // receives the largest bending moment and is the expected failure location.
  if(e.momentUtilization>.88)e.plasticSag=Math.min(STORY_HEIGHT*.30,(e.plasticSag||0)+dt*STORY_HEIGHT*.026*Math.max(0,e.momentUtilization-.78));
  const cantileverSag=oneSided?(Math.min(.16,spanGain*.022)+.035):0;
  const elasticRatio=clamp((e.momentUtilization-.48)*.23+spanGain*.028+(unsupportedEnd?.035:0)+cantileverSag,0,.29);
  const targetSag=Math.min(STORY_HEIGHT*.34,STORY_HEIGHT*elasticRatio+(e.plasticSag||0));
  if(e.sag==null)e.sag=0;if(e.sagVelocity==null)e.sagVelocity=0;
  const sagAccel=(targetSag-e.sag)*22-e.sagVelocity*7.8;
  e.sagVelocity=clamp(e.sagVelocity+sagAccel*dt,-1.1,1.7);
  e.sag=clamp(e.sag+e.sagVelocity*dt,Math.max(0,e.plasticSag||0),STORY_HEIGHT*.38);
  if(e.sag<.012&&e.momentUtilization<.46&&!(e.plasticSag>0)){e.sag=0;e.sagVelocity=0;e.sagging=false}
  const length=Math.max(STORY_HEIGHT,span.bays*STORY_HEIGHT),lineLoad=Math.max(.01,bending.averageDemand)/Math.max(.1,length);
  const tensionRaw=lineLoad*length*length/(8*Math.max(e.sag,STORY_HEIGHT*.035));
  const anchored=span.leftSupported&&span.rightSupported;
  // Catenary tension is useful only with two effective horizontal anchors; a cantilever must
  // resist its overhang primarily through root bending instead of being artificially tension-held.
  e.catenaryTension=anchored&&(e.sagging||span.bays>1)?clamp(tensionRaw,0,e.capacity*.62):clamp(tensionRaw*.35,0,e.capacity*.34);
  e.catenaryRatio=clamp(e.catenaryTension/Math.max(.1,e.capacity*.70),0,1.25);
  const rawOver=Math.max(0,e.momentUtilization-1);
  if(e.momentUtilization>1.02)e.momentOverloadTime=(e.momentOverloadTime||0)+dt*(1+Math.min(1.8,rawOver*.55));
  else e.momentOverloadTime=Math.max(0,(e.momentOverloadTime||0)-dt*.35);
  e.plasticMoment=clamp((e.plasticMoment||0)+dt*Math.max(0,e.momentUtilization-.7)*.12,0,3);
  if(e.momentOverloadTime>=.20){
   const catenaryCanHold=anchored&&e.catenaryRatio<1.9&&e.sag<STORY_HEIGHT*.30;
   const cantileverRootYield=oneSided&&e.momentUtilization>1.02&&e.momentOverloadTime>=.20;
   const severeBending=e.momentUtilization>1.38&&e.momentOverloadTime>=.30;
   const excessiveSag=e.sag>=STORY_HEIGHT*.32&&e.momentUtilization>1.08&&e.momentOverloadTime>=.22;
   if(cantileverRootYield||((severeBending||excessiveSag)&&!catenaryCanHold)){const groupKey=`${e.y}:${span.left}:${span.right}`,item={link,bending,util:e.momentUtilization};(bySpan[groupKey]||(bySpan[groupKey]=[])).push(item);candidates.push(item)}
  }
 }
 let changed=false;
 for(const group of Object.values(bySpan)){
  const first=group[0],span=first.bending.span,oneSided=span.leftSupported!==span.rightSupported;
  if(oneSided){
   const rootBay=span.leftSupported?span.left:span.right-1;
   const rootLink=sim.memberLinks.find(l=>l.e.kind==='beam'&&l.e.y===span.y&&l.e.x===rootBay&&!l.e.failed&&!l.e.snapped);
   if(rootLink&&rootLink.e.momentUtilization>1.02&&rootLink.e.momentOverloadTime>=.20){const rootBending=beamBendingData(rootLink.e);changed=failCantileverRoot(rootLink,rootBending)||changed;continue}
  }
  const maxMoment=Math.max(...group.map(c=>c.bending.moment));
  for(const item of group)if(item.bending.moment>=maxMoment*.90)changed=snapBeamAtMidspan(item.link,item.bending)||changed;
 }
 if(changed){refreshMemberTopology();refreshAnalysis();setStatus('Bending failure: overloaded cantilever roots detached at their fixed support, while two-sided spans can yield and hinge near mid-span. Remaining load paths were recalculated.',true)}
 return changed;
}
function updateSnappedBeamHinges(dt){for(const link of sim.memberLinks){const e=link.e;if(e.kind!=='beam'||!e.snapped||e.failed)continue;e.snapAge=(e.snapAge||0)+dt;const targetAccel=GRAVITY*(.12+Math.min(.8,Math.max(0,e.momentUtilization-1)*.12));e.snapVelocity=Math.min(2.6,(e.snapVelocity||0)+targetAccel*dt);e.snapSag=Math.min(STORY_HEIGHT*.70,(e.snapSag||0)+e.snapVelocity*dt);const span=Math.max(STORY_HEIGHT,(e.effectiveSpan||1)*STORY_HEIGHT),lineLoad=Math.max(.01,e.demand||e.mass)/span;e.catenaryTension=clamp(lineLoad*span*span/(8*Math.max(e.snapSag,STORY_HEIGHT*.045)),0,e.capacity*1.8);e.catenaryRatio=clamp(e.catenaryTension/Math.max(.1,e.capacity*.70),0,1.25)}}
function dampLinkRelativeMotion(link,retain=.62){
 const a=sim.nodes[link?.nodeA],b=sim.nodes[link?.nodeB];if(!a||!b)return;
 const ma=Math.max(.08,a.mass||.08),mb=Math.max(.08,b.mass||.08),sum=ma+mb;
 for(const axis of ['x','y']){const centre=(a.velocity[axis]*ma+b.velocity[axis]*mb)/sum;a.velocity[axis]=clamp(centre+(a.velocity[axis]-centre)*retain,-MAX_FALL_SPEED,MAX_FALL_SPEED);b.velocity[axis]=clamp(centre+(b.velocity[axis]-centre)*retain,-MAX_FALL_SPEED,MAX_FALL_SPEED)}
}
function updateJointYielding(dt){
 let changed=false;
 for(const link of sim.memberLinks){
  const e=link.e;if(e.failed)continue;
  const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;
  const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y,len=Math.max(.001,Math.hypot(dx,dy)),ux=dx/len,uy=dy/len;
  const util=clamp(Number(e.utilization)||0,0,4),moment=clamp(Number(e.momentUtilization)||0,0,4),cat=clamp(Number(e.catenaryRatio)||0,0,3.2),cap=Math.max(.1,e.capacity||1),impact=clamp(Number(e.impactStress)||0,0,5);
  let verticalDemand=0,horizontalDemand=0;
  if(e.kind==='beam'){
   horizontalDemand=cap*(.12+.34*cat+.035*Math.abs(e.lateralForce||0)/cap);
   verticalDemand=cap*(.10+.31*moment+.12*Math.max(0,util-.68)+.045*impact);
  }else if(e.kind==='column'){
   const tiltRatio=clamp(Math.abs(e.tiltAngle||0)/COLUMN_TILT_LIMIT,0,2.5);
   verticalDemand=cap*(.12+.43*Math.max(0,util-.25));
   horizontalDemand=Math.abs(e.lateralForce||0)*.40+cap*(.05+.13*tiltRatio+.035*impact);
  }else{
   horizontalDemand=cap*(.035+.12*cat);
   verticalDemand=cap*(.08+.24*util+.04*impact);
  }
  for(const [end,conn] of [['a',link.connectionA],['b',link.connectionB]]){
   if(conn.broken)continue;
   const side=end==='a'?1:-1;
   // Force is assembled in world coordinates, then resolved into axial and shear components
   // of the actual joint orientation; tilted columns therefore see a different shear demand.
   let fx,fy;
   if(e.kind==='beam'){const direction=(b.position.x>=a.position.x?1:-1)*side;fx=direction*horizontalDemand;fy=-verticalDemand;}
   else if(e.kind==='column'){fx=(e.lateralForce||0)*.4+side*Math.sign((a.position.x+b.position.x)*.5-NX*STORY_HEIGHT*.5||1)*horizontalDemand;fy=-verticalDemand;}
   else{const direction=(b.position.x>=a.position.x?1:-1)*side;fx=direction*horizontalDemand;fy=-verticalDemand;}
   const axial=Math.abs(fx*ux+fy*uy),shear=Math.abs(-fx*uy+fy*ux),jointStrength=Math.max(.1,conn.shearStrength*Math.max(.2,conn.stiffnessFactor));
   const ratio=Math.hypot(axial/(jointStrength*1.25),shear/jointStrength),angle=Math.atan2(fy,fx);
   const ready=conn.applyDemand(ratio,angle,dt,sim.time);
   if(end==='a')e.jointDamageA=conn.plasticDamage;else e.jointDamageB=conn.plasticDamage;
   if(conn.pendingBreakUntil!=null&&sim.time<conn.pendingBreakUntil){
    // A short frictional hold dissipates relative motion over several frames before release.
    dampLinkRelativeMotion(link,.91);
   }
   if(ready){
    dampLinkRelativeMotion(link,.46);
    const angleDeg=(angle*180/Math.PI).toFixed(0);
    failMember(link,`PLASTIC JOINT SEPARATION · ${end.toUpperCase()} END · force angle ${angleDeg}° · demand ratio ${ratio.toFixed(2)}`);
    sim.lastEvent=`JOINT SEPARATION · ${e.kind.toUpperCase()} ${link.key}`;sim.eventUntil=sim.time+3.2;changed=true;break;
   }
  }
  if(changed)break;
 }
 if(changed)refreshAnalysis();
 return changed;
}
function evaluateColumnTiltFailures(){let changed=false;for(const link of sim.memberLinks){const e=link.e;if(e.kind!=='column'||e.failed||e.integrity<=0)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const dx=b.position.x-a.position.x,dy=b.position.y-a.position.y;e.tiltAngle=Math.atan2(Math.abs(dx),Math.max(.01,Math.abs(dy)));if(e.tiltAngle>COLUMN_TILT_LIMIT){failMember(link,`column tilt exceeded ${(COLUMN_TILT_LIMIT*180/Math.PI).toFixed(0)}° limit`);changed=true}}if(changed)refreshAnalysis();return changed}
async function stepPhysics(dt){
 const activeSimulation=sim;
 sim.time+=dt;for(const fx of sim.explosionEffects||[])fx.age+=dt;sim.explosionEffects=(sim.explosionEffects||[]).filter(fx=>fx.age<fx.duration);processPendingMaterialBlasts(2);if(sim.time-(sim.lastCollisionCleanup||0)>2){for(const [k,t] of Object.entries(sim.collisionPairs))if(sim.time-t>2)delete sim.collisionPairs[k];sim.lastCollisionCleanup=sim.time}let a=refreshAnalysis();updateStabilityDynamics(dt);evaluateBeamBending(dt);updateSnappedBeamHinges(dt);a=refreshAnalysis();updateJointYielding(dt);
 // Member capacities degrade locally; tilt-induced demand and yielding joints feed the same failure threshold.
 for(const link of sim.memberLinks){const e=link.e;if(e.failed||e.snapped)continue;const util=e.utilization||0;if(util>1){sim.overloadTimers[link.id]=(sim.overloadTimers[link.id]||0)+dt;const rate=Math.min(.7,.14+(util-1)*.22);e.integrity=Math.max(0,e.integrity-dt*rate);if(e.integrity<=FAILURE_INTEGRITY){failMember(link,'sustained overload / local redistribution');sim.lastEvent=`OVERLOAD FAILURE · ${e.kind.toUpperCase()} (${link.key})`;sim.eventUntil=sim.time+3}}else sim.overloadTimers[link.id]=Math.max(0,(sim.overloadTimers[link.id]||0)-dt*.15)}
 refreshAnalysis();
 // Retain global lateral excitation while adding local angular motion about each assembly's remaining pivot.
 const old=Array.from(sim.lateralDisp);for(let level=1;level<=NY;level++){const below=old[level-1]-old[level],above=level<NY?old[level+1]-old[level]:0;const ax=below*10+above*5-3.8*sim.lateralVel[level];sim.lateralVel[level]=clamp(sim.lateralVel[level]+ax*dt,-7,7);sim.lateralDisp[level]=clamp(sim.lateralDisp[level]+sim.lateralVel[level]*dt,-2.6,2.6);sim.floors[level].position.x=sim.lateralDisp[level];sim.floors[level].velocity.x=sim.lateralVel[level];sim.floors[level].acceleration.x=ax}
 sim.lateralDisp[0]=0;sim.lateralVel[0]=0;await updateMemberPhysics(dt);if(sim!==activeSimulation)return;updateMaterialHazards(dt);evaluateColumnTiltFailures();await updateDebris(dt);if(sim!==activeSimulation)return;for(const d of sim.debris){containDebrisInGrid(d);d.y=clamp(d.y,-.02,NY*STORY_HEIGHT+STORY_HEIGHT*.8);d.vx=clamp(d.vx,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.vy=clamp(d.vy,-MAX_FALL_SPEED,MAX_FALL_SPEED);d.angularVelocity=clamp(d.angularVelocity,-3.4,3.4);if(!Number.isFinite(d.x+d.y+d.vx+d.vy+d.angle+d.angularVelocity)){d.x=clamp((d.x||0),-10,50);d.y=0;d.vx=0;d.vy=0;d.angularVelocity=0;d.settled=true;updateDebrisBounds(d)}}a=refreshAnalysis();sim.peakUtil=Math.max(sim.peakUtil,a.maxUtil);lastAnalysis=a;if(sim.localFailureCount!==(sim.reportedFailureCount??0)){sim.reportedFailureCount=sim.localFailureCount;const failedNow=allMembers().filter(({e})=>e.failed||e.snapped).length;const report=`DYNAMIC FAILURE ACTIVE · ${failedNow} member(s) failed or hinged, ${sim.floatingClusters.length} floating cluster(s), peak current utilization ${a.maxUtil>=9?'unbounded':(a.maxUtil*100).toFixed(0)+'%'}. Static validation is refreshed; pause to inspect the load-path overlay.`;$('validationResult').textContent=report;$('eventInfo').textContent=`${sim.lastEvent||'Local member failure'} · ${failedNow} member(s) affected. Last transferred impact energy: ${sim.lastImpactEnergy.toFixed(2)} illustrative units.`;}
 const primary=sim.stability.primary,hasSupport=!!(primary&&primary.supportPoints.length),movingDebris=sim.debris.some(d=>!d.settled),airborneNodes=Object.values(sim.nodes).some(n=>n.referenceLevel>0&&!n.isGroundConnected&&n.position.y>FLOOR_THICKNESS+.16);if(sim.running&&sim.localFailureCount>0&&!hasSupport&&!movingDebris&&!airborneNodes&&!(sim.explosionEffects||[]).length){sim.running=false;syncButtons();setStatus('TOTAL COLLAPSE: all foundation support paths are lost and debris has settled. Click Reset physics to restore the current design, or Example frame to load a fresh building.',false);setStatus('Collapse complete · simulation paused. The model has no remaining foundation-connected assembly.',true)}else if(sim.running&&!totalCount()&&!sim.debris.length&&!(sim.explosionEffects||[]).length){sim.running=false;syncButtons()}
}
function drawGrid(){
 const grad=ctx.createLinearGradient(0,0,0,H);grad.addColorStop(0,'#0b1625');grad.addColorStop(1,'#09111c');ctx.fillStyle=grad;ctx.fillRect(0,0,W,H);
 if(QUALITY_PROFILE.atmosphere){
  const haze=ctx.createRadialGradient(W*.60,H*.37,10,W*.60,H*.37,W*.70);haze.addColorStop(0,'rgba(107,151,184,.075)');haze.addColorStop(1,'rgba(7,14,24,0)');ctx.fillStyle=haze;ctx.fillRect(0,0,W,H);
 }
 if(ENVIRONMENT.waterLevel>0){
  const surfaceY=GROUND_Y-(waterSurfaceWorld()/STORY_HEIGHT)*STORY_PX;
  ctx.save();const water=ctx.createLinearGradient(0,surfaceY,0,GROUND_Y+8);water.addColorStop(0,'rgba(55,173,205,.20)');water.addColorStop(1,'rgba(27,83,130,.34)');ctx.fillStyle=water;ctx.fillRect(GRID_LEFT,surfaceY,GRID_RIGHT-GRID_LEFT,GROUND_Y-surfaceY+8);
  ctx.strokeStyle='rgba(115,230,245,.55)';ctx.lineWidth=1.2;ctx.beginPath();ctx.moveTo(GRID_LEFT,surfaceY);ctx.lineTo(GRID_RIGHT,surfaceY);ctx.stroke();
  if(QUALITY_PROFILE.atmosphere){ctx.globalAlpha=.35;for(let i=0;i<6;i++){const y=surfaceY+7+i*11;if(y<GROUND_Y){ctx.beginPath();ctx.moveTo(GRID_LEFT+((i*37)%80),y);ctx.bezierCurveTo(GRID_LEFT+90,y-2,GRID_RIGHT-100,y+2,GRID_RIGHT-((i*29)%85),y);ctx.stroke()}}}
  ctx.restore();
 }
 ctx.save();ctx.strokeStyle='rgba(111,146,184,.11)';ctx.lineWidth=1;
 if(showSimulationOverlays){for(let x=0;x<=NX;x++){const xx=GRID_LEFT+x*DX;ctx.beginPath();ctx.moveTo(xx,75);ctx.lineTo(xx,GROUND_Y+5);ctx.stroke()}for(let y=0;y<=NY;y++){ctx.beginPath();ctx.moveTo(GRID_LEFT-35,gridY(y));ctx.lineTo(GRID_RIGHT+30,gridY(y));ctx.stroke()}}
 ctx.strokeStyle='#536b87';ctx.lineWidth=3;ctx.beginPath();ctx.moveTo(GRID_LEFT-24,GROUND_Y+2);ctx.lineTo(GRID_RIGHT+24,GROUND_Y+2);ctx.stroke();
 if(showSimulationOverlays){ctx.fillStyle='#90a5bf';ctx.font='11px ui-monospace,monospace';ctx.textAlign='right';for(let y=1;y<=NY;y++)ctx.fillText(`L${String(y).padStart(2,'0')}`,GRID_LEFT-43,gridY(y)+4);ctx.textAlign='left';ctx.fillStyle='#8195ae';ctx.fillText('GROUND / BASE',GRID_LEFT-40,GROUND_Y+25)}
 ctx.restore();
}
function rawElementColor(e){const display=$('displayMode').value;if(e.failed)return e.debrisSpawned?'#788697':'#ff526b';if(e.burning)return Math.sin(sim.time*13+e.x)>0?'#ff9b4a':'#ff693e';if(e.material==='explosive'&&e.explosivePrimed)return Math.sin(sim.time*18)>0?'#ff70ad':'#a94e91';if(e.snapped)return Math.sin(sim.time*9)>0?'#ff526b':'#c64b62';if(display==='material')return materialColor(e.material);if(display==='integrity')return stressColor(1-clamp(e.integrity,0,1));if(display==='loadpath'){
 const group=memberGroupForKind(e.kind),keys=endpointKeys(group,e),a=sim.nodes[keys[0]],b=sim.nodes[keys[1]];
 if(a?.isGroundConnected&&b?.isGroundConnected)return '#43d7d0';if(a?.isGroundConnected||b?.isGroundConnected)return '#ffca69';return Math.sin(sim.time*9)>0?'#ff6578':'#647287';
 }return stressColor(Math.max(e.utilization||0,e.dynamicUtilization||0,e.momentUtilization||0,(e.jointDamageA||0)*1.18,(e.jointDamageB||0)*1.18,(e.impactStress||0)*.45))}
function elementColor(e){const base=rawElementColor(e);return PHYSICS_MODEL?.shadeForMoisture?PHYSICS_MODEL.shadeForMoisture(base,ENVIRONMENT.moisture):base}
function drawCollapseNotice(){const st=sim.stability?.primary;if(!sim.localFailureCount||st?.supportPoints?.length||!sim.debris.length)return;ctx.save();ctx.fillStyle='rgba(43,22,31,.94)';ctx.strokeStyle='rgba(255,101,120,.82)';ctx.lineWidth=1.2;ctx.beginPath();ctx.roundRect(316,72,468,34,8);ctx.fill();ctx.stroke();ctx.fillStyle='#ffc0c9';ctx.font='bold 10px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText('TOTAL COLLAPSE · CLICK RESET PHYSICS TO RESTORE',550,93);ctx.restore()}
function drawContactShadows(){
 if(!QUALITY_PROFILE.contactShadows)return;
 ctx.save();ctx.globalCompositeOperation='multiply';
 // Canvas2D contact occlusion is an inexpensive 2D approximation, not a 3D SSCS pass.
 for(const link of sim.memberLinks){if(link.e.failed||link.e.snapped)continue;if(link.e.kind!=='column')continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const y=GROUND_Y-(Math.min(a.position.y,b.position.y)/STORY_HEIGHT)*STORY_PX;if(y<GROUND_Y-2)continue;const x=GRID_LEFT+(a.position.x/STORY_HEIGHT)*DX;ctx.fillStyle='rgba(0,0,0,.24)';ctx.beginPath();ctx.ellipse(x,y+3,Math.max(3,DX*.10),3,0,0,Math.PI*2);ctx.fill()}
 for(const d of sim.debris){if(d.y>STORY_HEIGHT*.65||!d.settled)continue;const x=GRID_LEFT+d.x/STORY_HEIGHT*DX,y=GROUND_Y-d.y/STORY_HEIGHT*STORY_PX;ctx.fillStyle='rgba(0,0,0,.25)';ctx.beginPath();ctx.ellipse(x,y+2,Math.max(3,d.length/STORY_HEIGHT*DX*.46),Math.max(1.5,d.thickness/STORY_HEIGHT*STORY_PX*.48),d.angle,0,Math.PI*2);ctx.fill()}
 ctx.restore();
}
function drawWetHighlights(){
 if(!QUALITY_PROFILE.wetHighlights||ENVIRONMENT.moisture<.18)return;
 ctx.save();ctx.globalAlpha=.10+ENVIRONMENT.moisture*.22;ctx.strokeStyle='#d9fcff';ctx.lineWidth=1.1;ctx.lineCap='round';
 for(const link of sim.memberLinks){const e=link.e;if(e.failed||e.snapped)continue;const a=sim.nodes[link.nodeA],b=sim.nodes[link.nodeB];if(!a||!b)continue;const x1=GRID_LEFT+a.position.x/STORY_HEIGHT*DX,y1=GROUND_Y-a.position.y/STORY_HEIGHT*STORY_PX,x2=GRID_LEFT+b.position.x/STORY_HEIGHT*DX,y2=GROUND_Y-b.position.y/STORY_HEIGHT*STORY_PX;ctx.beginPath();ctx.moveTo(x1,y1-1.2);ctx.lineTo(x2,y2-1.2);ctx.stroke()}
 ctx.restore();
}
function draw(){drawGrid();drawContactShadows();const levelY=l=>screenYLevel(l);const line=(x1,y1,x2,y2,color,width,dash=[])=>{ctx.save();ctx.strokeStyle=color;ctx.lineWidth=width;ctx.lineCap='round';ctx.setLineDash(dash);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);ctx.stroke();ctx.restore()};
 // Diagonal and X-bracing are first-class members with real endpoint connections.
 for(const [key,e]of Object.entries(BuildingMap.braces)){if(e.failed&&e.debrisSpawned)continue;const ep=endpointKeys('braces',e).map(k=>sim.nodes[k]);if(!ep[0]||!ep[1])continue;const x1=GRID_LEFT+ep[0].position.x/STORY_HEIGHT*DX,y1=GROUND_Y-ep[0].position.y/STORY_HEIGHT*STORY_PX,x2=GRID_LEFT+ep[1].position.x/STORY_HEIGHT*DX,y2=GROUND_Y-ep[1].position.y/STORY_HEIGHT*STORY_PX;line(x1,y1,x2,y2,'rgba(2,8,16,.88)',8);line(x1,y1,x2,y2,elementColor(e),e.failed?4:3.8,e.failed?[4,3]:[]);if(showSimulationOverlays&&(e.integrity<.82||e.impactStress>.28)&&!e.failed){const mx=(x1+x2)/2,my=(y1+y2)/2;line(mx-3,my-4,mx+2,my+1,'#ff6578',1.5);line(mx+2,my+1,mx-1,my+5,'#ff6578',1.5)}}
 // Beams and slabs are separate map elements; both carry their own utilization and integrity.
 for(const [key,e]of Object.entries(BuildingMap.beams)){if(e.failed&&e.debrisSpawned)continue;const x1=screenX(e.x,e.y),y1=screenYNode(e.x,e.y),x2=screenX(e.x+1,e.y),y2=screenYNode(e.x+1,e.y);line(x1,y1,x2,y2,'rgba(2,8,16,.85)',9);if(e.snapped){const sag=(e.snapSag||0)/STORY_HEIGHT*STORY_PX,mx=(x1+x2)/2,my=(y1+y2)/2+sag;line(x1,y1,mx-4,my,'#ff526b',4.8,[4,2]);line(mx+4,my,x2,y2,'#ff526b',4.8,[4,2]);ctx.save();ctx.strokeStyle='#ffd0d7';ctx.lineWidth=1.6;ctx.beginPath();ctx.moveTo(mx-5,my-4);ctx.lineTo(mx+1,my+2);ctx.lineTo(mx-2,my+5);ctx.lineTo(mx+5,my+8);ctx.stroke();ctx.restore()}else{const mx=(x1+x2)/2,baseY=(y1+y2)/2,sagPixels=(!e.snapped?Math.max(0,e.sag||0):0)/STORY_HEIGHT*STORY_PX,bend=sagPixels+clamp(e.impactDeformation||0,0,1.4)*15;ctx.save();ctx.strokeStyle=elementColor(e);ctx.lineWidth=4.8;ctx.lineCap='round';ctx.setLineDash(e.failed?[4,4]:[]);ctx.beginPath();ctx.moveTo(x1,y1);ctx.quadraticCurveTo(mx,baseY+bend,x2,y2);ctx.stroke();ctx.restore();if(showSimulationOverlays&&(e.integrity<.82||e.impactStress>.28)&&!e.failed){ctx.save();ctx.strokeStyle=e.impactStress>1?'#ff435e':'#ff6477';ctx.lineWidth=1.5;ctx.beginPath();ctx.moveTo(mx-4,baseY+bend-4);ctx.lineTo(mx+1,baseY+bend+1);ctx.lineTo(mx-2,baseY+bend+4);ctx.lineTo(mx+5,baseY+bend+7);ctx.stroke();ctx.restore()}}}
 for(const [key,e]of Object.entries(BuildingMap.slabs)){if(e.failed&&e.debrisSpawned)continue;const x1=screenX(e.x,e.y),x2=screenX(e.x+1,e.y),baseY1=screenYNode(e.x,e.y)-5,baseY2=screenYNode(e.x+1,e.y)-5,beam=BuildingMap.beams[keyOf(e.x,e.y)],sag=(beam?.snapped?(beam.snapSag||0)/STORY_HEIGHT*STORY_PX*.72:(beam?.sag||0)/STORY_HEIGHT*STORY_PX*.78)+clamp((beam?.impactDeformation||0)+(e.impactDeformation||0)*.55,0,1.5)*10,y1=baseY1,y2=baseY2,ym=(y1+y2)/2+sag;ctx.save();ctx.fillStyle=elementColor(e);ctx.globalAlpha=e.failed?.72:.6;ctx.beginPath();ctx.moveTo(x1,y1-3);if(beam?.snapped)ctx.lineTo((x1+x2)/2,ym-3);ctx.lineTo(x2,y2-3);ctx.lineTo(x2,y2+3);if(beam?.snapped)ctx.lineTo((x1+x2)/2,ym+3);ctx.lineTo(x1,y1+3);ctx.closePath();ctx.fill();ctx.globalAlpha=1;ctx.strokeStyle=(e.failed||e.snapped)?'#ff6477':'rgba(228,242,255,.5)';ctx.lineWidth=1;ctx.beginPath();ctx.moveTo(x1,y1-3);if(beam?.snapped)ctx.lineTo((x1+x2)/2,ym-3);ctx.lineTo(x2,y2-3);ctx.lineTo(x2,y2+3);if(beam?.snapped)ctx.lineTo((x1+x2)/2,ym+3);ctx.lineTo(x1,y1+3);ctx.closePath();ctx.stroke();if(showSimulationOverlays&&(e.integrity<.82&&!e.failed||beam?.snapped)){ctx.strokeStyle='#ff6477';ctx.beginPath();ctx.moveTo((x1+x2)/2-4,ym-4);ctx.lineTo((x1+x2)/2+2,ym);ctx.lineTo((x1+x2)/2-1,ym+3);ctx.stroke()}ctx.restore()}
 for(const [key,e]of Object.entries(BuildingMap.columns)){if(e.failed&&e.debrisSpawned)continue;const x1=screenX(e.x,e.y),y1=screenYNode(e.x,e.y),x2=screenX(e.x,e.y+1),y2=screenYNode(e.x,e.y+1);line(x1,y1,x2,y2,'rgba(1,7,16,.85)',10);line(x1,y1,x2,y2,elementColor(e),5.5);if(showSimulationOverlays&&(e.integrity<.82||e.impactStress>.28)&&!e.failed){const xm=(x1+x2)/2,ym=(y1+y2)/2;line(xm-4,ym-6,xm+2,ym-1,e.impactStress>1?'#ff435e':'#ff6477',1.6);line(xm+2,ym-1,xm-1,ym+3,'#ff6477',1.6)}}
 if(showSimulationOverlays)for(const [key,e]of Object.entries(BuildingMap.loads)){const y=(screenYNode(e.x,e.y)+screenYNode(e.x+1,e.y))/2,x=(screenX(e.x,e.y)+screenX(e.x+1,e.y))/2;ctx.save();ctx.strokeStyle='#ffb86a';ctx.fillStyle='#ffb86a';ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(x,y-27);ctx.lineTo(x,y-8);ctx.stroke();ctx.beginPath();ctx.moveTo(x-5,y-13);ctx.lineTo(x,y-7);ctx.lineTo(x+5,y-13);ctx.closePath();ctx.fill();ctx.font='10px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(`+${e.mass.toFixed(1)}`,x,y-32);ctx.restore()}
 // Broken member-end connections are shown explicitly at their actual joint location.
 if(showSimulationOverlays)for(const connection of sim.connections){if(!connection.broken)continue;const node=sim.nodes[connection.nodeKey];if(!node)continue;const [gx,gy]=connection.nodeKey.split(',').map(Number),x=screenX(gx,gy),y=screenYNode(gx,gy);ctx.save();ctx.strokeStyle='#ff526b';ctx.lineWidth=2.2;ctx.beginPath();ctx.moveTo(x-5,y-5);ctx.lineTo(x+5,y+5);ctx.moveTo(x-5,y+5);ctx.lineTo(x+5,y-5);ctx.stroke();ctx.restore()}
 if(showSimulationOverlays){drawStabilityVector();drawCollapseNotice()}
 // Detached members retain mass and collide with the ground or surviving floor members.
 ctx.save();ctx.beginPath();ctx.rect(GRID_LEFT,75,GRID_RIGHT-GRID_LEFT,GROUND_Y-75);ctx.clip();for(const d of sim.debris){const dx=Math.cos(d.angle)*d.length*.5,dy=Math.sin(d.angle)*d.length*.5,x1=GRID_LEFT+(d.x-dx)/STORY_HEIGHT*DX,x2=GRID_LEFT+(d.x+dx)/STORY_HEIGHT*DX,y1=GROUND_Y-(d.y-dy)/STORY_HEIGHT*STORY_PX,y2=GROUND_Y-(d.y+dy)/STORY_HEIGHT*STORY_PX;line(x1,y1,x2,y2,'rgba(1,7,16,.9)',d.thickness>.13?7:5);line(x1,y1,x2,y2,debrisColor(d),d.settled?4.1:4.4,d.settled?[]:[4,3]);if(showSimulationOverlays&&(d.impactCount>0||/shatter|impact/i.test(d.reason||''))){const mx=(x1+x2)/2,my=(y1+y2)/2;line(mx-4,my-3,mx+1,my+1,'#ffcc9b',1.5);line(mx+1,my+1,mx-1,my+5,'#ffcc9b',1.5)}if(showSimulationOverlays&&!d.settled&&sim.running){ctx.fillStyle='#ffcf86';ctx.beginPath();ctx.arc((x1+x2)/2,(y1+y2)/2,2.2,0,Math.PI*2);ctx.fill()}}ctx.restore();
 if(showSimulationOverlays)for(const node of Object.values(sim.nodes)){if(node.referenceLevel===0)continue;const x=screenX(node.gridX,node.referenceLevel),y=screenYNode(node.gridX,node.referenceLevel);ctx.fillStyle=node.isGroundConnected?'rgba(214,237,255,.78)':'#ffb56c';ctx.beginPath();ctx.arc(x,y,2.3,0,Math.PI*2);ctx.fill()}
 if(showSimulationOverlays&&$('displayMode').value==='loadpath'){
  for(const [key,e]of Object.entries(BuildingMap.columns)){if(e.failed)continue;const x=screenX(e.x,e.y),yTop=screenYNode(e.x,e.y+1),yBot=screenYNode(e.x,e.y);const bottom=sim.nodes[keyOf(e.x,e.y)],top=sim.nodes[keyOf(e.x,e.y+1)];ctx.save();ctx.strokeStyle=bottom?.isGroundConnected&&top?.isGroundConnected?'rgba(67,215,208,.85)':'rgba(255,101,120,.82)';ctx.fillStyle=ctx.strokeStyle;ctx.lineWidth=1.4;ctx.setLineDash(bottom?.isGroundConnected&&top?.isGroundConnected?[]:[4,4]);ctx.beginPath();ctx.moveTo(x,yTop+5);ctx.lineTo(x,yBot-5);ctx.stroke();ctx.setLineDash([]);if(bottom?.isGroundConnected&&top?.isGroundConnected){ctx.beginPath();ctx.moveTo(x-3,yBot-10);ctx.lineTo(x,yBot-4);ctx.lineTo(x+3,yBot-10);ctx.closePath();ctx.fill()}ctx.restore()}
 }
 // Unsupported bays are highlighted with a dashed warning outline before physics begins.
 if(showSimulationOverlays){const a=lastAnalysis||analyzeStructure();for(const b of a.unsupportedFloors){const x1=GRID_LEFT+b.x*DX,x2=x1+DX,y=screenYLevel(b.y);ctx.save();ctx.strokeStyle='rgba(255,101,120,.75)';ctx.lineWidth=1.5;ctx.setLineDash([5,4]);ctx.strokeRect(x1+3,y-12,x2-x1-6,20);ctx.restore()}}
 // Editor hover preview snaps to a grid segment.
 if(showSimulationOverlays&&hover.valid&&!sim.running&&mode==='build'){const x=hover.x,y=hover.y;ctx.save();ctx.strokeStyle='rgba(75,220,222,.8)';ctx.lineWidth=2;ctx.setLineDash([4,4]);if(mode==='build'&&$('componentType').value==='column'){const xx=GRID_LEFT+x*DX;ctx.beginPath();ctx.moveTo(xx,gridY(y));ctx.lineTo(xx,gridY(y+1));ctx.stroke()}else if(mode==='build'&&['brace','crossbrace'].includes($('componentType').value)){const x1=GRID_LEFT+x*DX,x2=x1+DX,y1=gridY(y),y2=gridY(y+1);ctx.beginPath();ctx.moveTo(x1,y1);ctx.lineTo(x2,y2);if($('componentType').value==='crossbrace'||$('braceDirection').value==='down'){ctx.moveTo(x1,y2);ctx.lineTo(x2,y1)}ctx.stroke()}else{const xx=GRID_LEFT+x*DX,yy=gridY(y);ctx.strokeRect(xx+2,yy-9,DX-4,18)}ctx.restore()}
 drawWetHighlights();drawMaterialEffects();drawExplosionEffects();drawAtmosphericParticles();drawGravityTether();
 if(showSimulationOverlays&&sim.lastEvent&&sim.time<sim.eventUntil&&sim.time>0){ctx.save();ctx.fillStyle='rgba(52,24,36,.9)';ctx.strokeStyle='rgba(255,103,120,.65)';ctx.beginPath();ctx.roundRect(650,24,410,35,8);ctx.fill();ctx.stroke();ctx.fillStyle='#ffacb6';ctx.font='bold 11px ui-monospace,monospace';ctx.textAlign='center';ctx.fillText(sim.lastEvent.slice(0,58),855,46);ctx.restore()}
}
function drawStabilityVector(){
 const st=sim.stability.primary;if(!st||!st.members.length&&!st.supportPoints.length)return;
 const gridX=st.comX/STORY_HEIGHT,gridYValue=st.comY/STORY_HEIGHT,level=Math.round(clamp(gridYValue,0,NY));
 const comX=GRID_LEFT+gridX*DX+sim.lateralDisp[level]*23,comY=GROUND_Y-gridYValue*STORY_PX;
 const projectedX=GRID_LEFT+(st.projectedX/STORY_HEIGHT)*DX,baseY=GROUND_Y-8;
 const left=st.supportPoints.length?GRID_LEFT+(st.minSupportX/STORY_HEIGHT)*DX:GRID_LEFT,right=st.supportPoints.length?GRID_LEFT+(st.maxSupportX/STORY_HEIGHT)*DX:GRID_LEFT;
 const danger=st.shouldTip||Math.abs(st.dynamics.rotation)>=CRITICAL_TILT,color=danger?'#ff6578':st.stabilityMetric<35?'#ffca69':'#43d7d0';
 ctx.save();ctx.lineWidth=1.8;ctx.strokeStyle=color;ctx.fillStyle=color;ctx.setLineDash([5,4]);ctx.beginPath();ctx.moveTo(comX,comY);ctx.lineTo(comX,baseY);ctx.stroke();ctx.setLineDash([]);
 if(st.supportPoints.length){ctx.lineWidth=4;ctx.globalAlpha=.8;ctx.beginPath();ctx.moveTo(left,baseY);ctx.lineTo(right,baseY);ctx.stroke();ctx.globalAlpha=1;ctx.lineWidth=2;ctx.beginPath();ctx.moveTo(comX,baseY);ctx.lineTo(projectedX,baseY);ctx.stroke();ctx.beginPath();ctx.arc(projectedX,baseY,4,0,Math.PI*2);ctx.fill()}
 ctx.beginPath();ctx.arc(comX,comY,5.5,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#07121e';ctx.lineWidth=1.5;ctx.stroke();ctx.font='bold 11px ui-monospace,monospace';ctx.textAlign='left';ctx.fillStyle=color;ctx.fillText('CoM',comX+8,comY-7);
 const angleDeg=Math.abs(st.dynamics.rotation)*180/Math.PI;const label=st.supportPoints.length?(st.shouldTip?`TIPPING ${st.tippingDirection.toUpperCase()}`:angleDeg>=18?`TILT ${angleDeg.toFixed(0)}° · CASCADING STRESS`:`STABILITY VECTOR · ${Math.round(st.stabilityMetric)}%`):'NO BASE SUPPORT';ctx.font='bold 10px ui-monospace,monospace';ctx.textAlign=st.shouldTip&&st.tippingDirection==='left'?'left':'left';ctx.fillText(label,GRID_LEFT+5,65);ctx.restore();
}
function validateDesign(){const a=refreshAnalysis();draw();if(!a.count){setStatus('Empty design. Place columns, beams and slabs before validating.');return}const detached=Object.values(sim.nodes).filter(n=>n.referenceLevel>0&&!n.isGroundConnected).length,st=sim.stability.primary,angleDeg=st?Math.abs(st.dynamics.rotation)*180/Math.PI:0,stabilityText=!st?'No assembly stability estimate available.':!st.supportPoints.length?'No foundation supports remain for the highlighted assembly.':st.shouldTip?`Center of mass lies ${Math.abs(st.marginWorld/STORY_HEIGHT).toFixed(2)} bay-widths outside the support span; predicted tipping is toward the ${st.tippingDirection}.`:angleDeg>=18?`Assembly tilt is ${angleDeg.toFixed(0)}°, above the 18° cascading-stress threshold; the current lean is toward the ${st.tippingDirection}.`:`Center-of-mass projection is within the support span (${Math.round(st.stabilityMetric)}% stability margin).`;const msg=a.issues.length||detached?`INSUFFICIENT SUPPORT · ${a.issues.length} static issue(s), ${detached} joint(s) without a continuous healthy path to the foundation. ${stabilityText} ${a.issues.slice(0,2).join(' ')}`:st?.shouldTip?`DIRECTIONAL TIPPING RISK · ${st.tippingDirection.toUpperCase()}. ${stabilityText}`:angleDeg>=18?`CASCADE RISK · TILT-INDUCED MEMBER STRESS IS ABOVE THE CRITICAL ANGLE. ${stabilityText}`:a.maxUtil>1?`OVER CAPACITY · Peak utilization ${(a.maxUtil*100).toFixed(0)}%. ${a.overloaded} member(s) exceed modeled capacity. ${stabilityText}`:`STRUCTURALLY SOUND IN THIS MODEL · Peak utilization ${(a.maxUtil*100).toFixed(0)}%. ${stabilityText}`;setStatus(a.failedMembers?`${msg} ${a.failedMembers} member(s) are failed or hinged and excluded from active capacity; detached failed members become debris.`:msg);if(a.warnings.length)setStatus(`Notes: ${a.warnings.slice(0,2).join(' ')}`,true);else setStatus('Validation includes local column load paths, capacity redistribution to connected neighboring supports, floating-cluster detection and member integrity. This remains a simplified educational estimate.',true)}
function syncButtons(){document.querySelectorAll('[data-mode]').forEach(b=>{b.classList.toggle('active',b.dataset.mode===mode);b.setAttribute('aria-pressed',String(b.dataset.mode===mode))});$('liveDot').classList.toggle('running',sim.running);$('simulate').textContent=sim.running?'Ⅱ Pause':'▶ Simulate';$('simulate').setAttribute('aria-pressed',String(sim.running))}
function startOrPause(){if(sim.running){sim.running=false;syncButtons();updateMetrics();return}if(!totalCount()&&!sim.debris.length){setStatus('Build at least one component before starting physics.');return}refreshAnalysis();sim.running=true;sim.peakUtil=lastAnalysis.maxUtil;syncButtons();setStatus('Simulation started. Local load redistribution, bending fracture, debris rigid-body motion, swept contact checks, mass-weighted impulses, rotated debris collisions with friction and angular response, material impact resistance, deformation, fragmentation and distance-limited shockwave damage are active.',true);}
function clearDesign(){if(!confirm('Clear all columns, beams, slabs and loads?'))return;BuildingMap=newBuildingMap();resetPhysics(false);setStatus('Empty design. Place columns, beams and slabs, then choose Validate.',false);setStatus('Design cleared. Build Mode is ready.',true)}
function exampleFrame(){BuildingMap=newBuildingMap();const supports=[...new Set([Math.round(NX*.16),Math.round(NX*.42),Math.round(NX*.68),Math.round(NX*.92)].map(x=>clamp(x,0,NX)))].sort((a,b)=>a-b),levels=Math.min(4,NY);for(const x of supports)for(let y=0;y<levels;y++)BuildingMap.columns[keyOf(x,y)]=makeElement('column',x,y,'steel');for(let y=1;y<=levels;y++)for(let x=supports[0];x<supports[supports.length-1];x++){BuildingMap.beams[keyOf(x,y)]=makeElement('beam',x,y,'steel');BuildingMap.slabs[keyOf(x,y)]=makeElement('slab',x,y,'concrete')}const midBay=clamp(Math.floor((supports[0]+supports[supports.length-1])*.5),0,NX-1);for(const x of [clamp(midBay-1,0,NX-1),midBay])if(x<NX)BuildingMap.loads[keyOf(x,levels)]={x,y:levels,mass:2,capacity:0,integrity:1,failed:false,kind:'load'};for(const y of [1,Math.min(3,levels-1)])if(y<NY){const x=clamp(midBay-1,0,NX-1);for(const direction of ['up','down']){const k=braceKeyOf(x,y,direction);BuildingMap.braces[k]=makeElement('brace',x,y,'steel');BuildingMap.braces[k].direction=direction}}resetPhysics(true);validateDesign();setStatus(`Example frame loaded for a ${NX}-bay × ${NY}-level grid: ${levels} modeled levels with mixed steel/concrete members and roof loads.`,true)}
function saveJSON(){const payload={format:'FrameLab BuildingMap',version:1,dimensions:{bays:NX,levels:NY,storyHeight:STORY_HEIGHT},materialLibrary:MATERIALS,BuildingMap};const blob=new Blob([JSON.stringify(payload,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='framelab-building-design.json';document.body.appendChild(a);a.click();a.remove();window.setTimeout(()=>URL.revokeObjectURL(url),1500);setStatus('Design JSON export created. This file includes the editable design and saved member state, but not a live simulation replay.',true)}
function loadJSONFile(file){if(!file)return;if(file.size>10*1024*1024){setStatus('JSON import stopped: choose a file smaller than 10 MB.',true);return}const reader=new FileReader();reader.onload=()=>{try{const payload=JSON.parse(String(reader.result));if(payload.format&&payload.format!=='FrameLab BuildingMap')throw new Error('This file is not a FrameLab BuildingMap export.');const source=payload.BuildingMap||payload.buildingMap;if(!source||typeof source!=='object')throw new Error('No BuildingMap object was found.');if(payload.dimensions&&Number.isFinite(Number(payload.dimensions.bays))&&Number.isFinite(Number(payload.dimensions.levels)))configureGridDimensions(payload.dimensions.bays,payload.dimensions.levels,{silent:true});const next=newBuildingMap();for(const group of ['columns','beams','slabs','braces']){const input=source[group]||{};for(const [key,raw]of Object.entries(input)){const x=Number(raw.x),y=Number(raw.y),kind=group.slice(0,-1),mat=String(raw.material||'steel'),minY=kind==='column'||kind==='brace'?0:1,maxY=kind==='column'||kind==='brace'?NY-1:NY,maxX=kind==='column'?NX:NX-1;if(!Number.isInteger(x)||!Number.isInteger(y)||x<0||x>maxX||y<minY||y>maxY||!MATERIALS[mat]||!MATERIALS[mat][kind])continue;const e=makeElement(kind,x,y,mat);if(kind==='brace')e.direction=raw.direction==='down'?'down':'up';e.mass=clamp(Number(raw.mass)||e.mass,.01,1000);e.capacity=clamp(Number(raw.capacity)||e.capacity,.01,10000);e.yieldStrength=e.capacity;e.momentCapacity=kind==='beam'?clamp(Number(raw.momentCapacity)||e.capacity*.50,.01,100000):0;e.integrity=clamp(Number(raw.integrity??1),0,1);e.failed=Boolean(raw.failed)||e.integrity<=0;e.snapped=Boolean(raw.snapped)&&!e.failed;e.snapSag=clamp(Number(raw.snapSag)||0,0,STORY_HEIGHT*.7);e.snapVelocity=clamp(Number(raw.snapVelocity)||0,0,3.2);e.snapCenterX=raw.snapCenterX!=null&&Number.isFinite(Number(raw.snapCenterX))?Number(raw.snapCenterX):null;e.snapLeft=Number.isFinite(Number(raw.snapLeft))?Number(raw.snapLeft):null;e.snapRight=Number.isFinite(Number(raw.snapRight))?Number(raw.snapRight):null;e.momentOverloadTime=clamp(Number(raw.momentOverloadTime)||0,0,10);e.sag=clamp(Number(raw.sag)||0,0,STORY_HEIGHT*.38);e.sagVelocity=clamp(Number(raw.sagVelocity)||0,-1.1,1.7);e.plasticSag=clamp(Number(raw.plasticSag)||0,0,STORY_HEIGHT*.30);e.sagging=Boolean(raw.sagging);e.catenaryTension=clamp(Number(raw.catenaryTension)||0,0,10000);e.catenaryRatio=clamp(Number(raw.catenaryRatio)||0,0,3.2);e.jointDamageA=clamp(Number(raw.jointDamageA)||0,0,1.25);e.jointDamageB=clamp(Number(raw.jointDamageB)||0,0,1.25);e.plasticMoment=clamp(Number(raw.plasticMoment)||0,0,3);e.impactResistance=clamp(Number(raw.impactResistance)||e.impactResistance,.1,4);e.durability=clamp(Number(raw.durability)||e.capacity*e.impactResistance*IMPACT_ENERGY_PER_CAPACITY,.1,100000);e.shattered=Boolean(raw.shattered);e.impactDamage=clamp(Number(raw.impactDamage)||0,0,.98);e.impactDeformation=clamp(Number(raw.impactDeformation)||0,0,1.5);e.plasticDeformation=clamp(Number(raw.plasticDeformation??e.impactDeformation)||0,0,1.5);e.elasticDeformation=clamp(Number(raw.elasticDeformation)||0,0,1.5);e.impactDeformation=clamp(e.plasticDeformation+e.elasticDeformation,0,1.5);e.impactStress=clamp(Number(raw.impactStress)||0,0,5);e.lastImpactEnergy=clamp(Number(raw.lastImpactEnergy)||0,0,1e9);e.burning=Boolean(raw.burning)&&mat==='flammable'&&!e.failed;const importedFuel=Number(raw.fuelRemaining??(mat==='flammable'?1:0));e.fuelRemaining=clamp(Number.isFinite(importedFuel)?importedFuel:(mat==='flammable'?1:0),0,1);e.heatExposure=clamp(Number(raw.heatExposure)||0,0,10);e.fireSpreadClock=clamp(Number(raw.fireSpreadClock)||0,0,2);e.burnTime=clamp(Number(raw.burnTime)||0,0,10000);e.ignitionReason=String(raw.ignitionReason||'');e.explosivePrimed=Boolean(raw.explosivePrimed)&&mat==='explosive'&&!e.failed;e.detonated=Boolean(raw.detonated);e.chainDepth=clamp(Number(raw.chainDepth)||0,0,MAX_CHAIN_REACTION_DEPTH);e.state=e.failed?(e.shattered?'SHATTERED':'FAILED'):e.snapped?'SNAPPED':'intact';next[group][group==='braces'?braceKeyOf(x,y,e.direction):keyOf(x,y)]=e}}for(const [key,raw]of Object.entries(source.loads||{})){const x=Number(raw.x),y=Number(raw.y);if(Number.isInteger(x)&&Number.isInteger(y)&&x>=0&&x<NX&&y>=1&&y<=NY)next.loads[keyOf(x,y)]={x,y,mass:clamp(Number(raw.mass)||2,.01,100),capacity:0,integrity:clamp(Number(raw.integrity??1),0,1),failed:Boolean(raw.failed),kind:'load'}}BuildingMap=next;resetPhysics(false);for(const link of [...sim.memberLinks])if(link.e.failed&&!link.e.debrisSpawned)spawnMemberDebris(link,'loaded failed member');refreshAnalysis();draw();setStatus(`Loaded ${totalCount()} saved elements from ${file.name}; ${sim.debris.length} failed member(s) restored as debris.`,true);setStatus('Design imported. Live estimates refreshed; select Validate for a written structural check.',false)}catch(err){setStatus(`Could not load JSON: ${err.message}`)}};reader.readAsText(file)}
let builtinExamplesCache=null;
const BUILTIN_MATERIAL_CODES={s:'steel',c:'concrete',w:'wood',f:'flammable',e:'explosive'};
function getBuiltinExamples(){if(!builtinExamplesCache){const node=$('builtinExamplesData');builtinExamplesCache=JSON.parse(node?node.textContent:'{}')}return builtinExamplesCache}
function loadSelectedExample(){
 const select=$('exampleFrames'),id=select?.value;if(!id){setStatus('Choose one of the saved example buildings first.',false);return}
 let preset;try{preset=getBuiltinExamples()[id]}catch(err){setStatus(`Could not read built-in examples: ${err.message}`,false);return}
 if(!preset){setStatus('That built-in example could not be found.',false);return}
 const map={columns:{},beams:{},slabs:{},braces:{},loads:{}};
 for(const group of ['columns','beams','slabs','braces']){
  for(const row of preset.data[group]||[]){const [x,y,code,directionCode]=row,material=BUILTIN_MATERIAL_CODES[code]||'steel';const raw={x,y,material};let key=`${x},${y}`;if(group==='braces'){raw.direction=directionCode==='d'?'down':'up';key=`${x},${y},${raw.direction}`}map[group][key]=raw}
 }
 for(const row of preset.data.loads||[]){const [x,y,mass]=row;map.loads[`${x},${y}`]={x,y,mass,kind:'load'}}
 const payload={format:'FrameLab BuildingMap',version:1,dimensions:preset.dimensions||{bays:40,levels:24,storyHeight:3.15},BuildingMap:map};
 try{const fileName=`FrameLab - ${preset.label}.json`;const file=new File([JSON.stringify(payload)],fileName,{type:'application/json'});setStatus(`Loading ${preset.label} (${preset.memberCount.toLocaleString()} members)…`,true);loadJSONFile(file)}catch(err){setStatus(`Could not load ${preset.label}: ${err.message}`,false)}
}
function benchmarkCPUPhysics(){
 const count=6000,iterations=8,x=new Float64Array(count),y=new Float64Array(count),vx=new Float64Array(count),vy=new Float64Array(count);
 for(let i=0;i<count;i++){x[i]=(i%97)*.031;y[i]=(i%53)*.047;vx[i]=((i%13)-6)*.003;vy[i]=((i%17)-8)*.002}
 const t0=performance.now();let energy=0;
 for(let k=0;k<iterations;k++)for(let i=1;i<count;i++){
  const dx=x[i]-x[i-1],dy=y[i]-y[i-1],dist=Math.max(.001,Math.hypot(dx,dy)),error=(dist-.04)*.18,fx=dx/dist*error,fy=dy/dist*error;
  x[i]-=fx;x[i-1]+=fx*.5;y[i]-=fy;y[i-1]+=fy*.5;vx[i]=vx[i]*.998+fx*.02;vy[i]=vy[i]*.998+fy*.02;energy+=Math.abs(error)+Math.abs(vx[i])+Math.abs(vy[i]);
 }
 const elapsed=Math.max(.01,performance.now()-t0);
 // Consume the result so an optimizing engine cannot elide the benchmark workload.
 if(!Number.isFinite(energy))return 999;
 return elapsed;
}
function applyQualityProfile(name,announce=true){
 const next=QUALITY_PRESETS[name]||QUALITY_PRESETS.balanced;QUALITY_PROFILE=next;MAX_DEBRIS=next.maxDebris;MAX_ATMOSPHERIC_PARTICLES=next.maxParticles;setupCanvasScale();
 if(sim.debris.length>MAX_DEBRIS){sim.debris.sort((a,b)=>Number(a.settled)-Number(b.settled)||a.age-b.age);sim.debris.length=MAX_DEBRIS;}if(sim.atmosphericParticles?.length>MAX_ATMOSPHERIC_PARTICLES)sim.atmosphericParticles.splice(0,sim.atmosphericParticles.length-MAX_ATMOSPHERIC_PARTICLES);
 if(announce){const status=$('qualityStatus');if(status)status.textContent=`${next.label} · ${next.constraintIterations} constraint iterations · up to ${next.maxDebris} debris pieces · ${next.maxParticles} particle budget · ${next.pixelRatio}× render scale${qualityMode==='auto'?' (automatic)':' (manual)'}`;draw()}
}
async function runPerformanceBenchmark(){
 const status=$('qualityStatus');if(status)status.textContent='Benchmarking CPU constraints, live body integration, and optional GPU compute…';
 // Defer work until the first paint so the initial interface remains responsive.
 await new Promise(resolve=>window.setTimeout(resolve,120));
 const cpuMs=benchmarkCPUPhysics();let physicsResult={available:false,preferGPU:false,reason:'CPU worker selected until WebGPU physics is benchmarked'},gpuResult={available:false,averageMs:null,throughput:0,reason:'GPU compute unavailable'};
 try{if(window.FrameLabCompute?.benchmarkPhysicsBackends)physicsResult=await window.FrameLabCompute.benchmarkPhysicsBackends()}catch(error){physicsResult={available:false,preferGPU:false,reason:error?.message||'Physics backend benchmark failed'}}
 try{if(window.FrameLabCompute?.benchmarkGPU)gpuResult=await window.FrameLabCompute.benchmarkGPU()}catch(error){gpuResult={available:false,averageMs:null,throughput:0,reason:error?.message||'GPU check failed'}}
 const chosen=PHYSICS_MODEL?.chooseQualityTier?PHYSICS_MODEL.chooseQualityTier({cpuMs,cores:navigator.hardwareConcurrency||4,memoryGB:navigator.deviceMemory||4,gpuExpected:!!gpuResult.available,gpuMs:gpuResult.averageMs}):'balanced';
 if(qualityMode==='auto')applyQualityProfile(chosen,false);else applyQualityProfile(qualityMode,false);
 if(status){const physicsText=physicsResult.available?`physics kernel CPU ${physicsResult.cpuAverageMs.toFixed(2)} ms / GPU ${physicsResult.gpuAverageMs.toFixed(2)} ms · Auto ${physicsResult.preferGPU?'prefers GPU':'prefers CPU'}`:physicsResult.reason;const gpuText=gpuResult.available?`diagnostic GPU scan ${(gpuResult.averageMs||0).toFixed(1)} ms (${Math.round(gpuResult.throughput||0).toLocaleString()}/s)`:gpuResult.reason||'GPU scan not available';status.textContent=`${qualityMode==='auto'?'Auto selected':'Manual'}: ${QUALITY_PROFILE.label} · CPU probe ${cpuMs.toFixed(1)} ms · ${physicsText} · ${gpuText}.`}
 const modeSelect=$('computeMode');if(modeSelect?.value==='auto'){const note=$('computeModeStatus');if(note)note.textContent=physicsResult.available?`Auto benchmark: CPU ${physicsResult.cpuAverageMs.toFixed(2)} ms, GPU ${physicsResult.gpuAverageMs.toFixed(2)} ms. ${physicsResult.preferGPU?'Large motion batches use WebGPU.':'CPU worker is faster or tied, so Auto stays on CPU.'} GPU errors always fall back to CPU. Structural analysis and collision/failure rules remain CPU-side.`: `Auto is using CPU worker integration because ${physicsResult.reason.toLowerCase()}. Structural analysis and collision/failure rules remain CPU-side.`;const sub=$('computeSub');if(sub&&note)sub.textContent=note.textContent;}
 draw();
}
let physicsAccumulator=0,physicsStepBusy=false;
const MAX_PHYSICS_STEPS_PER_FRAME=8;
async function processPhysicsSteps(){
 if(physicsStepBusy)return;
 physicsStepBusy=true;let steps=0;
 try{
  while(physicsAccumulator+1e-9>=DT&&steps<MAX_PHYSICS_STEPS_PER_FRAME&&sim.running){
   await stepPhysics(DT);
   physicsAccumulator=Math.max(0,physicsAccumulator-DT);steps++;
  }
 }catch(error){
  console.error('FrameLab physics backend failed:',error);
  sim.running=false;syncButtons();setStatus(`Physics step failed safely: ${error?.message||'compute backend error'}. Select Auto or CPU worker and restart the simulation.`,true);
 }finally{
  if(!sim.running)physicsAccumulator=0;
  physicsStepBusy=false;
  if(steps>0){if((frame++%4)===0)updateMetrics();draw()}
  if(sim.running&&physicsAccumulator+1e-9>=DT)void processPhysicsSteps();
 }
}
function animate(now){
 // Rendering continues on requestAnimationFrame while numerical kernels run asynchronously.
 // Physics retains the fixed 120 Hz step and bounded accumulator, with no overlapping step jobs.
 const elapsed=Math.min(.05,Math.max(0,(now-previous)/1000));previous=now;updateAtmosphericParticles(elapsed);
 if(sim.running){
  physicsAccumulator=Math.min(physicsAccumulator+elapsed,DT*MAX_PHYSICS_STEPS_PER_FRAME);
  if(!physicsStepBusy)void processPhysicsSteps();
  if(!physicsStepBusy&&(frame++%4)===0){refreshAnalysis();updateMetrics()}
  draw();
 }else physicsAccumulator=0;
 requestAnimationFrame(animate);
}

document.querySelectorAll('[data-mode]').forEach(b=>b.addEventListener('click',()=>setMode(b.dataset.mode)));
document.addEventListener('keydown',e=>{
 const target=e.target,tag=(target?.tagName||'').toLowerCase();
 if(target?.isContentEditable||['input','select','textarea'].includes(tag)||e.altKey||e.ctrlKey||e.metaKey)return;
 if(e.code==='Space'&&tag==='button')return; // Let native button activation handle Space.
 const key=e.key.toLowerCase();
 if(key==='b'){e.preventDefault();setMode('build')}
 else if(key==='d'){e.preventDefault();setMode('demolish')}
 else if(key==='l'){e.preventDefault();setMode('load')}
 else if(key==='p'){e.preventDefault();setMode('push')}
 else if(key==='e'){e.preventDefault();setMode('explosion')}
 else if(key==='i'){e.preventDefault();setMode('ignite')}
 else if(key==='t'){e.preventDefault();setMode('tether')}
 else if(key==='v'){e.preventDefault();validateDesign()}
 else if(e.code==='Space'){e.preventDefault();startOrPause()}
 else if(e.key==='Escape'){dragging=false;lastDragKey='';lastDragPt=null;hover.valid=false;draw()}
});$('componentType').addEventListener('change',()=>{buildPainted=new Set();updateToolStatus();draw()});$('braceDirection').addEventListener('change',draw);$('loadAmount').addEventListener('input',()=>{$('loadOut').textContent=Number($('loadAmount').value).toFixed(1)});$('explosionPower').addEventListener('input',()=>{$('explosionOut').textContent=$('explosionPower').value;updateToolStatus()});$('applyDimensions').addEventListener('click',()=>configureGridDimensions($('baysInput').value,$('levelsInput').value));$('baysInput').addEventListener('keydown',e=>{if(e.key==='Enter')configureGridDimensions($('baysInput').value,$('levelsInput').value)});$('levelsInput').addEventListener('keydown',e=>{if(e.key==='Enter')configureGridDimensions($('baysInput').value,$('levelsInput').value)});$('displayMode').addEventListener('change',draw);$('validate').addEventListener('click',validateDesign);$('simulate').addEventListener('click',startOrPause);$('resetPhysics').addEventListener('click',()=>{resetPhysics(true);setStatus('Physics reset. Member integrity and joint motion were restored; the design layout was preserved.',true);setStatus('Physics reset. Run Validate for a fresh written assessment of the restored design.',false)});$('example').addEventListener('click',exampleFrame);$('loadExample').addEventListener('click',loadSelectedExample);$('exampleFrames').addEventListener('keydown',e=>{if(e.key==='Enter'){e.preventDefault();loadSelectedExample()}});$('clear').addEventListener('click',clearDesign);$('save').addEventListener('click',saveJSON);$('loadJson').addEventListener('click',()=>$('fileInput').click());$('fileInput').addEventListener('change',e=>{loadJSONFile(e.target.files?.[0]);e.target.value=''});canvas.addEventListener('pointerdown',handleCanvasDown);canvas.addEventListener('pointermove',handlePointerMove);canvas.addEventListener('pointerup',handlePointerUp);canvas.addEventListener('pointercancel',handlePointerUp);canvas.addEventListener('pointerleave',()=>{if(!dragging){hover.valid=false;draw()}});$('loadOut').textContent=Number($('loadAmount').value).toFixed(1);$('explosionOut').textContent=$('explosionPower').value;$('gridSizeLabel').textContent=`Grid: ${NX} bays × ${NY} levels`;setMode('build');refreshAll();syncButtons();
const cpuWarning=$('cpuWarning'),dismissCpuWarning=$('dismissCpuWarning');
if(dismissCpuWarning) dismissCpuWarning.addEventListener('click',()=>{if(cpuWarning?.close)cpuWarning.close();else cpuWarning?.removeAttribute('open')});
// Show on every page load; intentionally do not persist dismissal between visits.
if(cpuWarning){if(typeof cpuWarning.showModal==='function'){try{cpuWarning.showModal()}catch(_){cpuWarning.setAttribute('open','')}}else cpuWarning.setAttribute('open','')}
const viewModeToggle=$('viewModeToggle'),viewModeLabel=$('viewModeLabel');
function setSimulationOnly(enabled){
 document.body.classList.toggle('simulation-only',!!enabled);
 viewModeToggle?.setAttribute('aria-pressed',String(!!enabled));
 viewModeToggle?.setAttribute('aria-label',enabled?'Show FrameLab interface':'Hide interface and show simulation only');
 viewModeToggle?.setAttribute('title',enabled?'Show interface (H)':'Toggle simulation-only view (H)');
 if(viewModeLabel)viewModeLabel.textContent=enabled?'Show UI':'Hide UI';
 // Refit the canvas backing store after CSS layout changes without changing physics.
 if(typeof setupCanvasScale==='function')setupCanvasScale();
 draw();
}
viewModeToggle?.addEventListener('click',()=>setSimulationOnly(!document.body.classList.contains('simulation-only')));
document.addEventListener('keydown',e=>{
 if(e.code!=='KeyH'||e.repeat||e.altKey||e.ctrlKey||e.metaKey)return;
 const target=e.target,tag=(target?.tagName||'').toLowerCase();
 if(target?.isContentEditable||['input','select','textarea','button'].includes(tag))return;
 e.preventDefault();setSimulationOnly(!document.body.classList.contains('simulation-only'));
});
const overlayToggle=$('overlayToggle'),overlayModeLabel=$('overlayModeLabel');
function setSimulationOverlays(enabled){showSimulationOverlays=!!enabled;overlayToggle?.setAttribute('aria-pressed',String(showSimulationOverlays));overlayToggle?.setAttribute('aria-label',showSimulationOverlays?'Hide simulation annotations':'Show simulation annotations');overlayToggle?.setAttribute('title',showSimulationOverlays?'Hide simulation annotations (O)':'Show simulation annotations (O)');if(overlayModeLabel)overlayModeLabel.textContent=showSimulationOverlays?'Icons: On':'Icons: Off';draw()}
overlayToggle?.addEventListener('click',()=>setSimulationOverlays(!showSimulationOverlays));
document.addEventListener('keydown',e=>{if(e.code!=='KeyO'||e.repeat||e.altKey||e.ctrlKey||e.metaKey)return;const target=e.target,tag=(target?.tagName||'').toLowerCase();if(target?.isContentEditable||['input','select','textarea','button'].includes(tag))return;e.preventDefault();setSimulationOverlays(!showSimulationOverlays)});
$('qualityPreset')?.addEventListener('change',e=>{const selected=e.target.value;qualityMode=selected==='auto'?'auto':selected;if(selected==='auto'){runPerformanceBenchmark()}else{applyQualityProfile(selected);const status=$('qualityStatus');if(status)status.textContent=`Manual ${QUALITY_PROFILE.label} preset. CPU probe does not override manual quality.`}});
function applyPhysicsComputeMode(){const mode=$('computeMode')?.value||'auto';window.FrameLabCompute?.setMode(mode);const note=$('computeModeStatus');if(note)note.textContent=mode==='gpu'?'WebGPU performs body motion integration when available; failures fall back to CPU worker. Structural analysis, contact resolution, and failure rules remain CPU-side.':mode==='cpu'?'Live body motion integration is computed in the CPU worker. Structural analysis, contact resolution, and failure rules remain CPU-side.':mode==='main'?'Live motion integration stays on the main CPU thread. Use this as a compatibility/debug fallback.':'Auto uses the CPU worker unless real integration benchmarks show WebGPU is at least 15% faster; large batches then use GPU. GPU errors fall back to CPU. Structural analysis, contact resolution, and failure rules remain CPU-side.';const sub=$('computeSub');if(sub)sub.textContent=note?.textContent||'CPU/GPU body integration with CPU structural solver';}
$('computeMode')?.addEventListener('change',applyPhysicsComputeMode);
$('surfaceMoisture')?.addEventListener('input',e=>{ENVIRONMENT.moisture=clamp(Number(e.target.value)/100,0,1);$('moistureOut').textContent=`${Math.round(ENVIRONMENT.moisture*100)}%`;draw()});
$('waterLevel')?.addEventListener('input',e=>{ENVIRONMENT.waterLevel=clamp(Number(e.target.value)/100,0,1);$('waterOut').textContent=ENVIRONMENT.waterLevel===0?'Dry':`${Math.round(ENVIRONMENT.waterLevel*100)}% height`;draw()});
applyPhysicsComputeMode();
runPerformanceBenchmark();
requestAnimationFrame(animate);
})();

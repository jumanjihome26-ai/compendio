// EL COMPENDIO DEL BALUARTE · V8.0 · Motor de datos para la sincronización (Fase 1)
// Contiene SOLO lógica de datos (sin pantalla, sin Dropbox):
//  - normalise: migra un JSON v1 a v2 de forma compatible (solo AÑADE campos; nunca quita ni cambia contenido).
//  - snapshot + seal: anotan fecha de cambio y registran borrados al guardar.
//  - merge: fusiona dos copias lista por lista y tarea por tarea (gana el cambio más reciente).
// Formato v2 (compatible con v1): cada lista lleva metaAt/updatedAt, cada tarea y plantilla lleva updatedAt,
// y el JSON tiene un registro «deleted» con los borrados (con copia del elemento borrado) durante RETENTION_DAYS días.
(function(root){
"use strict";
const EPOCH="1970-01-01T00:00:00.000Z";
const RETENTION_DAYS=90;
const clone=x=>JSON.parse(JSON.stringify(x));
const gid=()=>(root.crypto&&root.crypto.randomUUID)?root.crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
const nkey=v=>String(v||"").trim().normalize("NFC").toLocaleLowerCase("es");
const ms=s=>{const n=Date.parse(s);return isNaN(n)?0:n;};
const maxIso=(...a)=>a.reduce((m,x)=>ms(x)>ms(m)?x:m,EPOCH);
function stable(o){
  if(Array.isArray(o))return "["+o.map(stable).join(",")+"]";
  if(o&&typeof o==="object")return "{"+Object.keys(o).sort().map(k=>JSON.stringify(k)+":"+stable(o[k])).join(",")+"}";
  return JSON.stringify(o===undefined?null:o);
}
// Gana el más reciente según el campo f; si empatan, desempata de forma determinista (así A+B = B+A).
function newer(x,y,f){const d=ms(x[f])-ms(y[f]);if(d)return d>0?x:y;return stable(x)>=stable(y)?x:y;}
const minStr=(a,b)=>String(a)<=String(b)?a:b;

// ---------- migración v1 → v2 (idempotente, solo añade) ----------
function normalise(input){
  const d=clone(input);let changed=false;
  const need=(o,k,v)=>{if(o[k]===undefined||o[k]===null||o[k]===""){o[k]=v;changed=true;}};
  if(d.version!==2){d.version=2;changed=true;}
  if(!d.format){d.format="compendio-baluarte";changed=true;}
  if(!Array.isArray(d.deleted)){d.deleted=[];changed=true;}
  if(!Array.isArray(d.templates)){d.templates=[];changed=true;}
  for(const l of d.lists){
    need(l,"createdAt",l.updatedAt||EPOCH);
    need(l,"updatedAt",l.createdAt);
    need(l,"metaAt",l.updatedAt);
    for(const t of l.tasks){need(t,"id",gid());need(t,"updatedAt",l.updatedAt);}
  }
  for(const l of d.templates){
    need(l,"createdAt",l.updatedAt||EPOCH);
    need(l,"updatedAt",l.createdAt);
    for(const t of l.tasks){need(t,"id",gid());need(t,"updatedAt",l.updatedAt);}
  }
  return {data:d,changed};
}

// ---------- instantánea del estado guardado (para detectar qué ha cambiado) ----------
const metaSig=l=>stable([l.name||"",l.description||"",l.illustration||""]);
const tplSig=l=>stable([metaSig(l),(l.tasks||[]).map(t=>[t.id,t.text,!!t.done])]);
function snapshot(d){
  const s={lists:{},templates:{}};
  for(const l of d.lists){const tasks={};for(const t of l.tasks)tasks[t.id]={text:t.text,done:!!t.done};s.lists[l.id]={name:l.name,meta:metaSig(l),tasks,raw:clone(l)};}
  for(const l of (d.templates||[]))s.templates[l.id]={name:l.name,sig:tplSig(l),raw:clone(l)};
  return s;
}

// ---------- sellado: fecha de cambio y registro de borrados al guardar ----------
const tsKey=t=>t.type+"|"+t.id+(t.type==="task"?"|"+t.listId:"");
function addTomb(d,t){
  const k=tsKey(t);const i=d.deleted.findIndex(x=>tsKey(x)===k);
  if(i<0)d.deleted.push(t);else d.deleted[i]=newer(d.deleted[i],t,"deletedAt");
}
function lastActivity(l){return Math.max(ms(l.updatedAt),ms(l.metaAt),ms(l.createdAt),...l.tasks.map(t=>ms(t.updatedAt)));}
function prune(d,now){
  const n=ms(now),keep=[];const seen=new Set();
  for(const t of d.deleted){
    if(!t||!t.type||!t.deletedAt)continue;
    if(n-ms(t.deletedAt)>RETENTION_DAYS*864e5)continue;
    let live=false;
    if(t.type==="list")live=d.lists.some(l=>(l.id===t.id||(nkey(l.name)&&nkey(l.name)===nkey(t.name)))&&lastActivity(l)>ms(t.deletedAt));
    else if(t.type==="template")live=d.templates.some(l=>l.id===t.id&&ms(l.updatedAt)>ms(t.deletedAt));
    else if(t.type==="task"){const l=d.lists.find(x=>x.id===t.listId);live=!!(l&&l.tasks.some(x=>x.id===t.id&&ms(x.updatedAt)>ms(t.deletedAt)));}
    if(live)continue;
    const k=tsKey(t);if(seen.has(k))continue;seen.add(k);keep.push(t);
  }
  d.deleted=keep;
}
function sealTasks(l,old,now){
  const cur=l.tasks;const curIds=new Set(cur.map(t=>t.id));const oldIds=Object.keys(old.tasks);
  const matched=new Set();
  for(const t of cur)if(old.tasks[t.id])matched.add(t.id);
  const oldFor=new Map();
  for(const t of cur){
    if(old.tasks[t.id]){oldFor.set(t,t.id);continue;}
    const c=oldIds.find(id=>!matched.has(id)&&!curIds.has(id)&&nkey(old.tasks[id].text)===nkey(t.text));
    if(c){matched.add(c);oldFor.set(t,c);}
  }
  let touched=false;
  for(const t of cur){
    const oid=oldFor.get(t);const o=oid?old.tasks[oid]:null;
    if(!o||o.text!==t.text||!!o.done!==!!t.done){t.updatedAt=now;touched=true;}
    else if(!t.updatedAt)t.updatedAt=l.updatedAt||now;
  }
  return {touched,vanished:oldIds.filter(id=>!matched.has(id)&&!curIds.has(id))};
}
// Anota en «data» lo que ha cambiado respecto a «base» (instantánea anterior). Modifica data en su sitio.
function seal(base,data,now){
  now=now||new Date().toISOString();
  if(!Array.isArray(data.deleted))data.deleted=[];
  if(!Array.isArray(data.templates))data.templates=[];
  const usedOld=new Set();const pair=new Map();
  for(const l of data.lists)if(base.lists[l.id]&&!usedOld.has(l.id)){pair.set(l,l.id);usedOld.add(l.id);}
  for(const l of data.lists){
    if(pair.has(l))continue;const k=nkey(l.name);if(!k)continue;
    const id=Object.keys(base.lists).find(i=>!usedOld.has(i)&&nkey(base.lists[i].name)===k);
    if(id){pair.set(l,id);usedOld.add(id);}
  }
  for(const l of data.lists){
    const oid=pair.get(l);
    if(!oid){l.createdAt=l.createdAt||now;l.metaAt=now;l.updatedAt=now;for(const t of l.tasks){if(!t.id)t.id=gid();t.updatedAt=now;}continue;}
    const old=base.lists[oid];
    if(metaSig(l)!==old.meta){l.metaAt=now;l.updatedAt=now;}
    else{l.metaAt=l.metaAt||l.updatedAt||now;}
    const r=sealTasks(l,old,now);
    if(r.touched)l.updatedAt=now;
    for(const id of r.vanished){addTomb(data,{type:"task",id,listId:l.id,listName:l.name,text:old.tasks[id].text,deletedAt:now});l.updatedAt=now;}
    l.updatedAt=l.updatedAt||now;
  }
  for(const id of Object.keys(base.lists))if(!usedOld.has(id))addTomb(data,{type:"list",id,name:base.lists[id].name,deletedAt:now,snapshot:base.lists[id].raw});
  const curT=new Set(data.templates.map(t=>t.id));
  for(const t of data.templates){
    const o=base.templates[t.id];
    if(!o||o.sig!==tplSig(t)){t.updatedAt=now;t.createdAt=t.createdAt||now;for(const x of t.tasks)if(!x.id)x.id=gid();for(const x of t.tasks)x.updatedAt=x.updatedAt||now;}
  }
  for(const id of Object.keys(base.templates))if(!curT.has(id))addTomb(data,{type:"template",id,name:base.templates[id].name,deletedAt:now,snapshot:base.templates[id].raw});
  prune(data,now);
  return data;
}

// ---------- fusión de dos copias ----------
function mergeTombs(a,b){
  const m=new Map();
  for(const t of [...a,...b]){if(!t||!t.type||!t.deletedAt)continue;const k=tsKey(t);m.set(k,m.has(k)?newer(m.get(k),t,"deletedAt"):t);}
  return [...m.values()].sort((x,y)=>stable(x)<stable(y)?-1:1);
}
function taskDead(ts,ids,listIds,listName,updatedAt){
  return ts.some(t=>t.type==="task"&&ids.includes(t.id)&&(listIds.includes(t.listId)||nkey(t.listName)===nkey(listName))&&ms(t.deletedAt)>=ms(updatedAt));
}
function mergeTasks(la,lb,ts,listIds,listName){
  const usedB=new Set();const pairs=new Map();
  for(const t of la.tasks){const o=lb.tasks.find(x=>x.id===t.id&&!usedB.has(x));if(o){pairs.set(t,o);usedB.add(o);}}
  for(const t of la.tasks){
    if(pairs.has(t))continue;const k=nkey(t.text);
    const o=lb.tasks.find(x=>!usedB.has(x)&&!la.tasks.some(y=>y.id===x.id)&&nkey(x.text)===k);
    if(o){pairs.set(t,o);usedB.add(o);}
  }
  const entryA=new Map(),entryB=new Map();
  for(const t of la.tasks){const e={a:t,b:pairs.get(t)||null};entryA.set(t,e);if(e.b)entryB.set(e.b,e);}
  for(const t of lb.tasks)if(!entryB.has(t))entryB.set(t,{a:null,b:t});
  const aFirst=newer(la,lb,"updatedAt")===la;
  const order=aFirst?[...la.tasks.map(t=>entryA.get(t)),...lb.tasks.filter(t=>!usedB.has(t)).map(t=>entryB.get(t))]
                    :[...lb.tasks.map(t=>entryB.get(t)),...la.tasks.filter(t=>!pairs.has(t)).map(t=>entryA.get(t))];
  const out=[];
  for(const e of order){
    const w=e.a&&e.b?newer(e.a,e.b,"updatedAt"):(e.a||e.b);
    const ids=[e.a,e.b].filter(Boolean).map(x=>x.id);
    const r=clone(w);if(ids.length>1)r.id=minStr(ids[0],ids[1]);
    if(taskDead(ts,ids,listIds,listName,r.updatedAt))continue;
    out.push(r);
  }
  return out;
}
function mergeList(la,lb,ts){
  const w=newer(la,lb,"metaAt");const m=clone(w);
  m.id=minStr(la.id,lb.id);m.createdAt=ms(la.createdAt)<=ms(lb.createdAt)?la.createdAt:lb.createdAt;
  m.metaAt=w.metaAt;m.updatedAt=maxIso(la.updatedAt,lb.updatedAt);
  m.tasks=mergeTasks(la,lb,ts,[la.id,lb.id],m.name);
  return m;
}
function listDead(l,ids,ts){
  return ts.some(t=>t.type==="list"&&(ids.includes(t.id)||(nkey(l.name)&&nkey(l.name)===nkey(t.name)))&&ms(t.deletedAt)>=lastActivity(l));
}
function merge(A,B,now){
  now=now||new Date().toISOString();
  const a=normalise(A).data,b=normalise(B).data;
  const ts=mergeTombs(a.deleted,b.deleted);
  const usedB=new Set();const match=new Map();
  for(const la of a.lists){const lb=b.lists.find(x=>x.id===la.id&&!usedB.has(x));if(lb){match.set(la,lb);usedB.add(lb);}}
  for(const la of a.lists){
    if(match.has(la))continue;const k=nkey(la.name);if(!k)continue;
    const lb=b.lists.find(x=>!usedB.has(x)&&nkey(x.name)===k);if(lb){match.set(la,lb);usedB.add(lb);}
  }
  const lists=[];
  const push=(l,ids)=>{if(listDead(l,ids,ts))return;l.tasks=l.tasks.filter(t=>!taskDead(ts,[t.id],ids,l.name,t.updatedAt));lists.push(l);};
  for(const la of a.lists){const lb=match.get(la);if(lb)push(mergeList(la,lb,ts),[la.id,lb.id]);else push(clone(la),[la.id]);}
  for(const lb of b.lists)if(!usedB.has(lb))push(clone(lb),[lb.id]);
  const tm=new Map();
  for(const t of [...a.templates,...b.templates])tm.set(t.id,tm.has(t.id)?newer(tm.get(t.id),t,"updatedAt"):t);
  const templates=[...tm.values()].filter(t=>!ts.some(x=>x.type==="template"&&x.id===t.id&&ms(x.deletedAt)>=ms(t.updatedAt))).map(clone);
  const out={format:"compendio-baluarte",version:2,exportedAt:now,lists,templates,deleted:ts};
  prune(out,now);
  return out;
}

const api={EPOCH,RETENTION_DAYS,normalise,snapshot,seal,merge,prune,stable,nkey};
if(typeof module!=="undefined"&&module.exports)module.exports=api;
root.CompendioSync=api;
})(typeof window!=="undefined"?window:globalThis);

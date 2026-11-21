let lists=[], templates=[], currentView="all", currentListId=null, editingId=null;
let refocusNewTask=false;
let rootHandle=null, dataDirHandle=null, exportDirHandle=null, backupDirHandle=null;
const $=id=>document.getElementById(id);
const uid=()=>crypto.randomUUID?crypto.randomUUID():Date.now().toString(36)+Math.random().toString(36).slice(2);
const clone=x=>JSON.parse(JSON.stringify(x));
const EMPTY_DATA={format:"compendio-baluarte",version:1,exportedAt:null,lists:[],templates:[]};
// ===== V6 · MODO NAVEGADOR (Android, iPad y navegadores sin acceso a carpetas) =====
// En Windows/Chrome de escritorio se sigue usando la carpeta y el JSON maestro (sin cambios).
// Donde no existe showDirectoryPicker (Android, iPad/Safari, Firefox...) los datos se guardan en el
// almacenamiento del navegador (IndexedDB) con la MISMA estructura JSON, y se pasan entre
// dispositivos con Exportar / Importar. Para forzarlo en escritorio: index.html?modo=navegador
// V6.3: algunos Chrome de Android SÍ ofrecen showDirectoryPicker, pero el modo carpeta es solo para ordenador.
// Móvil/tablet = teléfono o tableta (por el agente de usuario, o por tener puntero táctil y ningún ratón).
const IS_MOBILE_DEVICE=/Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent)||(navigator.userAgentData&&navigator.userAgentData.mobile===true)||(!/Windows/i.test(navigator.userAgent)&&!!window.matchMedia&&matchMedia("(pointer:coarse)").matches&&!matchMedia("(any-pointer:fine)").matches);
const WEB_MODE=!window.showDirectoryPicker||IS_MOBILE_DEVICE||/[?&]modo=navegador\b/.test(location.search);
let webDB=null;
// V6.2 · Cada copia del Compendio recuerda SU carpeta. Chrome comparte el almacén entre todos los
// index.html abiertos desde el disco; por eso la clave lleva el identificador de la copia (instancia.js)
// y, además, se comprueba que la carpeta elegida contiene ese mismo identificador.
const INSTANCE=window.COMPENDIO_INSTANCE||"sin-instancia";
const HANDLE_KEY="root:"+INSTANCE;
async function folderBelongsToThisCopy(handle){
  if(INSTANCE==="sin-instancia")return true;
  try{const fh=await handle.getFileHandle("instancia.js");const text=await (await fh.getFile()).text();return text.includes('"'+INSTANCE+'"');}
  catch{return false;}
}
function openWebDB(){return new Promise((resolve,reject)=>{if(webDB)return resolve(webDB);if(!window.indexedDB)return reject(new Error("Este navegador no permite guardar datos locales (IndexedDB)."));const req=indexedDB.open("CompendioDatos",1);req.onupgradeneeded=()=>{const db=req.result;db.createObjectStore("master");db.createObjectStore("backups");db.createObjectStore("meta");};req.onsuccess=()=>{webDB=req.result;resolve(webDB);};req.onerror=()=>reject(req.error);req.onblocked=()=>reject(new Error("Base de datos bloqueada por otra pestaña."));});}
async function idbOp(store,mode,fn){const db=await openWebDB();return await new Promise((resolve,reject)=>{const tx=db.transaction(store,mode);let r;try{r=fn(tx.objectStore(store));}catch(e){reject(e);return;}tx.oncomplete=()=>resolve(r?r.result:undefined);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||new Error("Operación cancelada"));});}
const idbGet=(store,key)=>idbOp(store,"readonly",s=>s.get(key));
const idbPut=(store,key,val)=>idbOp(store,"readwrite",s=>s.put(val,key));
const idbKeys=store=>idbOp(store,"readonly",s=>s.getAllKeys());
async function writeMaster(data){
  if(WEB_MODE)await idbPut("master","data",JSON.stringify(data,null,2));
  else await writeHandle(await dataDirHandle.getFileHandle("Compendio-del-Baluarte.json"),data);
}
async function deliverFile(filename,text){
  // Compartir (Guardar en Archivos, Drive, Dropbox...) si el sistema lo permite; si no, descargar.
  const blob=new Blob([text],{type:"application/json"});
  try{
    const file=new File([blob],filename,{type:"application/json"});
    if(navigator.canShare&&navigator.canShare({files:[file]})){
      try{await navigator.share({files:[file],title:filename});return "shared";}
      catch(e){if(e&&e.name==="AbortError")return "cancelled";}
    }
  }catch{}
  const a=document.createElement("a");a.href=URL.createObjectURL(blob);a.download=filename;a.style.display="none";document.body.appendChild(a);a.click();
  setTimeout(()=>{URL.revokeObjectURL(a.href);a.remove();},10000);
  return "downloaded";
}
function pickOption(title,options){
  return new Promise(resolve=>{
    const d=$("menuDialog");$("menuTitle").textContent=title;const box=$("menuOptions");box.innerHTML="";let chosen=null;
    options.forEach(o=>{const b=document.createElement("button");b.type="button";b.className="menu-opt"+(o.danger?" danger":"");b.textContent=o.label;b.onclick=()=>{chosen=o.value;d.close();};box.appendChild(b);});
    d.onclose=()=>resolve(chosen);
    d.onclick=e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();};
    $("menuCancel").onclick=()=>d.close();
    d.showModal();
  });
}
async function initialiseWeb(){
  let raw=await idbGet("master","data");
  let loaded;
  if(raw==null){loaded=clone(EMPTY_DATA);await idbPut("master","data",JSON.stringify(EMPTY_DATA,null,2));}
  else{
    try{loaded=JSON.parse(raw);}catch{throw new Error("Los datos guardados en este dispositivo no son un JSON válido. No los he sobrescrito para proteger tu información.");}
    if(!validData(loaded))throw new Error("Los datos guardados en este dispositivo no tienen una estructura válida. No los he modificado.");
  }
  lists=Array.isArray(loaded.lists)?loaded.lists:[];
  templates=Array.isArray(loaded.templates)?loaded.templates:[];
  await loadIllustrations();
  render();
  document.body.classList.remove("app-locked");
  $("accessGate").hidden=true;
  $("saveStatus").textContent="● Datos guardados en este dispositivo";
  try{if(navigator.storage&&navigator.storage.persist)navigator.storage.persist();}catch{}
  showWebNotice();
}
async function showWebNotice(){
  try{
    const standalone=(window.matchMedia&&matchMedia("(display-mode: standalone)").matches)||navigator.standalone===true;
    if(standalone)return;
    if(await idbGet("meta","noticeDismissed"))return;
    $("webNotice").hidden=false;
    $("webNoticeClose").onclick=async()=>{$("webNotice").hidden=true;try{await idbPut("meta","noticeDismissed",true);}catch{}};
  }catch{}
}
async function startWebMode(){
  $("changeFolderBtn").hidden=true;
  try{await initialiseWeb();}
  catch(err){
    document.body.classList.add("app-locked");$("accessGate").hidden=false;
    $("gateTitle").textContent="No se pueden abrir los datos";
    $("gateText").textContent=err.message;
    $("connectFolderBtn").hidden=true;document.querySelector(".access-explainer").hidden=true;document.querySelector(".access-warning").hidden=true;document.querySelector(".access-card small").hidden=true;
    console.error(err);
  }
}
async function webExport(){
  const filename=`YEISON_Compendio_${stamp()}.json`;
  const r=await deliverFile(filename,JSON.stringify(currentData(),null,2));
  if(r==="cancelled")return;
  toast("¡EXPORTACIÓN COMPLETADA!\n"+(r==="shared"?"Archivo compartido: ":"Archivo descargado en tu dispositivo: ")+filename);
}
async function webBackup(){
  const name=`BK_Compendio-del-Baluarte_${stamp()}.json`;
  const raw=JSON.stringify(currentData(),null,2);
  const delivery=deliverFile(name,raw);
  await idbPut("backups",name,raw);
  const r=await delivery;
  toast("¡COPIA DE SEGURIDAD COMPLETADA!\nCopia interna guardada: "+name+(r==="cancelled"?"":(r==="shared"?"\nArchivo compartido.":"\nArchivo descargado en tu dispositivo.")));
}
function chooseWebRestoreSource(){
  // V7.1 · iPad/iOS solo abre el selector de archivos si input.click() ocurre DENTRO del toque del usuario
  // (sin esperas ni cierres de ventana por medio). Por eso el botón de elegir archivo hace el clic de forma síncrona
  // y las copias internas se cargan después, sin bloquear la apertura.
  return new Promise(resolve=>{
    const d=$("menuDialog"),box=$("menuOptions");
    $("menuTitle").textContent="Restaurar una copia";box.innerHTML="";
    let done=false;const finish=v=>{if(done)return;done=true;resolve(v);};
    const input=document.createElement("input");input.type="file";input.hidden=true; // sin «accept»: algunos móviles ocultan los .json
    input.onchange=()=>{const f=input.files[0]||null;finish(f);if(d.open)d.close();};
    d.appendChild(input);
    const fileBtn=document.createElement("button");fileBtn.type="button";fileBtn.className="menu-opt";fileBtn.textContent="Elegir un archivo del dispositivo…";
    fileBtn.onclick=()=>input.click(); // síncrono, dentro del gesto
    box.appendChild(fileBtn);
    idbKeys("backups").then(keys=>{
      keys.sort().reverse().slice(0,8).forEach(k=>{
        const b=document.createElement("button");b.type="button";b.className="menu-opt";b.textContent="Copia interna: "+k.replace(/^BK_/,"").replace(/\.json$/,"");
        b.onclick=()=>{finish({name:k,text:()=>idbGet("backups",k)});d.close();};box.appendChild(b);
      });
    }).catch(()=>{});
    d.onclose=()=>{finish(null);input.remove();};
    d.onclick=e=>{if(e.target!==d)return;const r=d.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)d.close();};
    $("menuCancel").onclick=()=>d.close();
    d.showModal();
  });
}
let toastTimer=null; function toast(msg){const t=$("toast");t.textContent=msg;t.classList.add("show");clearTimeout(toastTimer);toastTimer=setTimeout(()=>t.classList.remove("show"),5200);}
function escapeHTML(s=""){return String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));}
function counts(l){const done=l.tasks.filter(t=>t.done).length;return {done,total:l.tasks.length,pct:l.tasks.length?Math.round(done/l.tasks.length*100):0};}
function currentData(){return {format:"compendio-baluarte",version:1,exportedAt:new Date().toISOString(),lists,templates};}
function validData(data){return !!data&&(!data.format||data.format==="compendio-baluarte")&&Array.isArray(data.lists)&&(!("templates" in data)||Array.isArray(data.templates))&&data.lists.every(x=>x&&typeof x.id==="string"&&Array.isArray(x.tasks))&&(!data.templates||data.templates.every(x=>x&&typeof x.id==="string"&&Array.isArray(x.tasks)));}
function parseCompendioFile(text){let parsed=JSON.parse(text);if(typeof parsed==="string")parsed=JSON.parse(parsed);return parsed;}
function normaliseData(data){return {format:"compendio-baluarte",version:1,exportedAt:data.exportedAt||null,lists:data.lists,templates:Array.isArray(data.templates)?data.templates:[]};}
function openHandleDB(){return new Promise((resolve,reject)=>{const req=indexedDB.open("CompendioAccessOnly",1);req.onupgradeneeded=()=>req.result.createObjectStore("handles");req.onsuccess=()=>resolve(req.result);req.onerror=()=>reject(req.error);});}
async function storeRootHandle(handle){const db=await openHandleDB();await new Promise((resolve,reject)=>{const tx=db.transaction("handles","readwrite");tx.objectStore("handles").put(handle,HANDLE_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();}
async function getStoredRootHandle(){const db=await openHandleDB();const value=await new Promise((resolve,reject)=>{const tx=db.transaction("handles","readonly");const req=tx.objectStore("handles").get(HANDLE_KEY);req.onsuccess=()=>resolve(req.result||null);req.onerror=()=>reject(req.error);});db.close();return value;}
async function clearStoredRootHandle(){const db=await openHandleDB();await new Promise((resolve,reject)=>{const tx=db.transaction("handles","readwrite");tx.objectStore("handles").delete(HANDLE_KEY);tx.oncomplete=resolve;tx.onerror=()=>reject(tx.error);});db.close();}
async function hasWritePermission(handle){return (await handle.queryPermission({mode:"readwrite"}))==="granted";}
async function requestWritePermission(handle){return (await handle.requestPermission({mode:"readwrite"}))==="granted";}
async function initialiseFolders(handle){
  rootHandle=handle;
  dataDirHandle=await rootHandle.getDirectoryHandle("DATOS",{create:true});
  exportDirHandle=await rootHandle.getDirectoryHandle("EXPORTACION",{create:true});
  backupDirHandle=await rootHandle.getDirectoryHandle("BACKUP",{create:true});
  try{illusDirHandle=await rootHandle.getDirectoryHandle("ILUSTRACIONES",{create:true});await loadIllustrations();}catch(e){console.warn("ILUSTRACIONES:",e);}
  const dataFile=await dataDirHandle.getFileHandle("Compendio-del-Baluarte.json",{create:true});
  const file=await dataFile.getFile();
  if(file.size===0){await writeHandle(dataFile,EMPTY_DATA);}
  const loaded=await readMaster();
  lists=Array.isArray(loaded.lists)?loaded.lists:[];
  templates=Array.isArray(loaded.templates)?loaded.templates:[];
  render();
  document.body.classList.remove("app-locked");
  $("accessGate").hidden=true;
  $("saveStatus").textContent="● JSON maestro conectado";
}
async function readMaster(){
  const fh=await dataDirHandle.getFileHandle("Compendio-del-Baluarte.json");
  const file=await fh.getFile();
  let data;
  try{data=JSON.parse(await file.text());}catch{throw new Error("El JSON maestro existe, pero no contiene JSON válido. No lo he sobrescrito para proteger tus datos.");}
  if(!validData(data))throw new Error("El archivo Compendio-del-Baluarte.json no tiene una estructura válida. No lo he modificado.");
  return data;
}
async function writeTextHandle(fileHandle,text){
  const writable=await fileHandle.createWritable();
  try{await writable.write(text);await writable.close();}
  catch(err){try{await writable.abort();}catch{}throw err;}
}
async function writeHandle(fileHandle,data){
  await writeTextHandle(fileHandle,JSON.stringify(data,null,2));
}
async function saveData(){
  try{
    if(!WEB_MODE&&!dataDirHandle)throw new Error("Primero debes conectar la carpeta del Compendio.");
    const payload=currentData();
    await writeMaster(payload);
    $("saveStatus").textContent=WEB_MODE?"● Guardado en este dispositivo":"● Guardado en DATOS/Compendio-del-Baluarte.json";
    $("saveStatus").classList.remove("save-error");
  }catch(err){
    $("saveStatus").textContent="● Error al guardar";$("saveStatus").classList.add("save-error");
    alert("No se han podido guardar los cambios en el JSON maestro.\n\n"+err.message+"\n\n"+(WEB_MODE?"Comprueba que el navegador permite guardar datos en este dispositivo y que queda espacio libre.":"Comprueba que la carpeta sigue disponible y que Chrome conserva el permiso."));throw err;
  }
}
function stamp(){const d=new Date();const p=n=>String(n).padStart(2,"0");return `${d.getFullYear()}-${p(d.getMonth()+1)}-${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;}
async function createFileInDirectory(dirHandle,filename,content){
  let name=filename, n=1;
  while(true){try{const fh=await dirHandle.getFileHandle(name,{create:true});const existing=await fh.getFile();if(existing.size>0){name=filename.replace(/\.json$/i,`_${n++}.json`);continue;}await writeTextHandle(fh,content);return name;}catch(err){throw err;}}
}
async function backupCurrentMaster(prefix="Compendio-del-Baluarte"){
  if(WEB_MODE){const raw=await idbGet("master","data");if(raw==null)throw new Error("No hay datos que copiar.");const n=`BK_${prefix}_${stamp()}.json`;await idbPut("backups",n,raw);return n;}
  const source=await dataDirHandle.getFileHandle("Compendio-del-Baluarte.json");
  const file=await source.getFile();
  const name=`BK_${prefix}_${stamp()}.json`;
  return await createFileInDirectory(backupDirHandle,name,await file.text());
}
async function ensureConnected(){
  if(WEB_MODE)return true;
  if(!rootHandle)return false;
  if(await hasWritePermission(rootHandle))return true;
  $("accessGate").hidden=false;document.body.classList.add("app-locked");
  $("gateTitle").textContent="Permiso de acceso pendiente";
  $("gateText").textContent="Chrome recuerda la carpeta, pero necesita que confirmes de nuevo el permiso de lectura y escritura.";
  return false;
}
async function connectFolder(){
  if(!window.showDirectoryPicker){alert("Esta versión necesita Google Chrome actualizado y la API de acceso a carpetas. Ábrela en Chrome para continuar.");return;}
  try{
    let handle=null;
    // Recuperar la carpeta recordada y comprobar que es la raíz del proyecto.
    // La comprobación se hace después de obtener el permiso, para no descartar
    // una carpeta válida cuando Chrome necesita renovar la autorización.
    try{
      handle=await getStoredRootHandle();
      if(handle){
        let granted=false;
        try{
          granted=await hasWritePermission(handle);
          if(!granted)granted=await requestWritePermission(handle);
          if(granted){
            await handle.getFileHandle("index.html");
            await handle.getFileHandle("app.js");
            if(!await folderBelongsToThisCopy(handle))throw new Error("La carpeta recordada pertenece a otra copia del Compendio.");
          }
        }catch(staleError){
          console.warn("El acceso recordado no está disponible o no corresponde a la carpeta principal. Se solicitará de nuevo.",staleError);
          granted=false;
        }
        if(!granted){
          await clearStoredRootHandle();
          handle=null;
        }
      }
    }catch(storedError){
      console.warn("No se pudo recuperar el acceso anterior. Se solicitará una carpeta nueva.",storedError);
      try{await clearStoredRootHandle();}catch{}
      handle=null;
    }
    if(!handle){
      // No depender de una ubicación inicial concreta: en algunos equipos
      // Chrome no puede resolver el directorio conocido "documents".
      try{
        handle=await window.showDirectoryPicker({id:"compendio-baluarte-root",mode:"readwrite"});
      }catch(pickerError){
        if(pickerError.name==="NotFoundError"){
          handle=await window.showDirectoryPicker({mode:"readwrite"});
        }else{
          throw pickerError;
        }
      }
      let granted=await hasWritePermission(handle);
      if(!granted)granted=await requestWritePermission(handle);
      if(!granted)throw new Error("No se concedió permiso de lectura y escritura a la carpeta seleccionada.");
      // Exigir los dos archivos propios de la aplicación antes de guardar
      // la carpeta o crear DATOS, EXPORTACION y BACKUP.
      try{
        await handle.getFileHandle("index.html");
        await handle.getFileHandle("app.js");
      }catch(invalidRoot){
        alert("La carpeta seleccionada no es la carpeta principal del Compendio. Selecciona la carpeta que contiene index.html y app.js. No se ha creado ni modificado ninguna carpeta.");
        return;
      }
      if(!await folderBelongsToThisCopy(handle)){
        alert("La carpeta seleccionada pertenece a OTRA copia o versión del Compendio (su archivo instancia.js no coincide con el index.html que has abierto).\n\nSelecciona la carpeta principal donde está ESTE index.html (la que contiene index.html, app.js e instancia.js). No selecciones DATOS.\n\nNo se ha creado ni modificado nada.");
        return;
      }
      if(!confirm(`Has seleccionado esta carpeta:\n\n${handle.name}\n\n¿Es la carpeta principal de EL COMPENDIO DEL BALUARTE?\n\nSelecciona la carpeta que contiene index.html y app.js. El acceso quedará limitado a esa carpeta y a su contenido.`))return;
      await storeRootHandle(handle);
    }
    await initialiseFolders(handle);
    toast("Carpeta del Compendio conectada.");
  }catch(err){
    if(err.name==="AbortError")return;
    alert("No se pudo conectar la carpeta del Compendio.\n\n"+err.message+"\n\nSi has movido o descomprimido de nuevo la carpeta, vuelve a seleccionar la carpeta principal que contiene index.html.");
  }
}

function renderNav(){
  const nav=$("listNav");
  nav.innerHTML=lists.map(l=>`<button class="nav-item ${currentView==="list"&&currentListId===l.id?"active":""}" data-list="${l.id}"><span>◦</span>${escapeHTML(l.name)}<b>${l.tasks.filter(t=>!t.done).length}</b></button>`).join("");
  nav.querySelectorAll("[data-list]").forEach(b=>b.onclick=()=>openList(b.dataset.list));
  $("allCount").textContent=lists.length;$("templateCount").textContent=templates.length;
}

// ===== V7 · ILUSTRACIONES POR LISTA =====
// Cada lista puede guardar un campo OPCIONAL `illustration` (nombre del archivo de imagen). Es un campo nuevo y compatible:
// los JSON anteriores siguen leyéndose igual. Las imágenes viven FUERA del JSON:
//  · Windows: carpeta ILUSTRACIONES del proyecto (la rellenas tú).  · Móvil/iPad: las incluidas en la app + las que añadas en el dispositivo.
const IMG_EXT=/\.(png|jpe?g|webp|gif|svg|avif)$/i;
const ILLUS_FOCUS={01_ALMA:[62,40],MECARTI:[65,40],RARITO:[38,40],VOCECITA:[38,33],MCGIVER:[57,35],PYTHI:[43,40],PLANI:[43,46],REPITE:[47,41],RESOPLON:[51,34],"REGISTRO-DE-LECTURAS":[35,40]};
let illus=new Map(),illusUrls=[],illusDirHandle=null,imgDB=null,pendingIllus="";
const illusBase=n=>String(n||"").replace(/\.[^.]+$/,"");
const illusLabel=n=>illusBase(n).replace(/[-_]+/g," ");
const illusFocus=n=>ILLUS_FOCUS[illusBase(n).toUpperCase()]||[50,32];
function illusMedallion(name,cls=""){
  if(!name)return "";
  const it=illus.get(name);
  if(!it)return `<span class="medallion missing ${cls}" title="Ilustración «${escapeHTML(illusLabel(name))}» no disponible en este dispositivo">✧</span>`;
  const [x,y]=illusFocus(name);
  return `<span class="medallion ${cls}" title="${escapeHTML(illusLabel(name))}"><img src="${it.url}" alt="" style="object-position:${x}% ${y}%;transform-origin:${x}% ${y}%"></span>`;
}
function openImgDB(){return new Promise((res,rej)=>{if(imgDB)return res(imgDB);if(!window.indexedDB)return rej(new Error("IndexedDB no disponible"));const q=indexedDB.open("CompendioIlustraciones",1);q.onupgradeneeded=()=>q.result.createObjectStore("images");q.onsuccess=()=>{imgDB=q.result;res(imgDB);};q.onerror=()=>rej(q.error);});}
async function imgOp(mode,fn){const db=await openImgDB();return new Promise((res,rej)=>{const tx=db.transaction("images",mode);let r;try{r=fn(tx.objectStore("images"));}catch(e){rej(e);return;}tx.oncomplete=()=>res(r?r.result:undefined);tx.onerror=()=>rej(tx.error);tx.onabort=()=>rej(tx.error);});}
const imgKeys=()=>imgOp("readonly",s=>s.getAllKeys());
const imgGet=k=>imgOp("readonly",s=>s.get(k));
const imgPut=(k,v)=>imgOp("readwrite",s=>s.put(v,k));
const imgDel=k=>imgOp("readwrite",s=>s.delete(k));
async function loadIllustrations(){
  illusUrls.forEach(u=>{try{URL.revokeObjectURL(u);}catch{}});illusUrls=[];
  const m=new Map();
  try{
    if(!WEB_MODE){
      if(illusDirHandle)for await(const [n,h] of illusDirHandle.entries()){if(h.kind==="file"&&IMG_EXT.test(n)){try{const u=URL.createObjectURL(await h.getFile());illusUrls.push(u);m.set(n,{name:n,url:u,user:false});}catch{}}}
    }else{
      try{const r=await fetch("ilustraciones/ilustraciones.json");if(r.ok){for(const n of await r.json())if(typeof n==="string"&&IMG_EXT.test(n))m.set(n,{name:n,url:"ilustraciones/"+encodeURIComponent(n),user:false});}}catch{}
      try{for(const k of await imgKeys()){const v=await imgGet(k);if(v&&v.data){const u=URL.createObjectURL(new Blob([v.data],{type:v.type||"image/jpeg"}));illusUrls.push(u);m.set(k,{name:k,url:u,user:true});}}}catch{}
    }
  }catch(e){console.warn("Ilustraciones:",e);}
  illus=new Map([...m.entries()].sort((a,b)=>a[0].localeCompare(b[0],"es")));
}
function loadImageFile(file){return new Promise((res,rej)=>{const u=URL.createObjectURL(file);const i=new Image();i.onload=()=>{URL.revokeObjectURL(u);res(i);};i.onerror=()=>{URL.revokeObjectURL(u);rej(new Error("No se pudo leer la imagen."));};i.src=u;});}
async function addIllustration(file){
  if(!file)return null;
  if(!/^image\//.test(file.type||"")&&!IMG_EXT.test(file.name||""))throw new Error("El archivo elegido no es una imagen.");
  const base=illusBase(file.name).replace(/[\\/:*?"<>|]+/g,"").trim().slice(0,50)||"ILUSTRACION";
  let name;
  if(WEB_MODE){
    name=base+".jpg";
    if(illus.get(name)&&!confirm(`Ya existe una ilustración llamada «${name}». ¿Sustituirla?`))return null;
    const im=await loadImageFile(file);const k=Math.min(1,760/Math.max(im.naturalWidth,im.naturalHeight));
    const c=document.createElement("canvas");c.width=Math.max(1,Math.round(im.naturalWidth*k));c.height=Math.max(1,Math.round(im.naturalHeight*k));
    const cx=c.getContext("2d");cx.fillStyle="#fff";cx.fillRect(0,0,c.width,c.height);cx.drawImage(im,0,0,c.width,c.height);
    const blob=await new Promise(r=>c.toBlob(r,"image/jpeg",0.85));
    await imgPut(name,{type:"image/jpeg",data:await blob.arrayBuffer()});
  }else{
    if(!illusDirHandle)throw new Error("La carpeta ILUSTRACIONES no está disponible.");
    const ext=(file.name.match(/\.[^.]+$/)||[".png"])[0].toLowerCase();name=base+ext;
    const exists=await illusDirHandle.getFileHandle(name).then(()=>true,()=>false);
    if(exists&&!confirm(`Ya existe «${name}» en la carpeta ILUSTRACIONES. ¿Sustituirla?`))return null;
    const fh=await illusDirHandle.getFileHandle(name,{create:true});const w=await fh.createWritable();await w.write(file);await w.close();
  }
  await loadIllustrations();return name;
}
function paintIllusPreview(){$("illusPreview").innerHTML=pendingIllus?illusMedallion(pendingIllus,"big"):'<span class="illus-none">Sin ilustración</span>';$("illusClear").hidden=!pendingIllus;}
async function openIllusPicker(){
  await loadIllustrations();
  const cells=[`<div class="illus-cell"><button type="button" class="illus-tile${pendingIllus?"":" sel"}" data-pick=""><span class="illus-img none">∅</span><b>Sin ilustración</b></button></div>`];
  for(const it of illus.values()){const [x,y]=illusFocus(it.name);cells.push(`<div class="illus-cell"><button type="button" class="illus-tile${it.name===pendingIllus?" sel":""}" data-pick="${escapeHTML(it.name)}"><img class="illus-img" src="${it.url}" alt="" style="object-position:${x}% ${y}%"><b>${escapeHTML(illusLabel(it.name))}</b></button>${it.user?`<button type="button" class="illus-del" data-del="${escapeHTML(it.name)}" title="Quitar esta imagen del dispositivo" aria-label="Quitar imagen">×</button>`:""}</div>`);}
  $("illusGrid").innerHTML=cells.join("");
  $("illusHelp").textContent=WEB_MODE?"Pulsa «Añadir imagen» para incluir tus propias ilustraciones; se guardan solo en este dispositivo. Para ver el mismo enanito en otro dispositivo, añade allí una imagen con el mismo nombre.":"Puedes añadir imágenes con el botón, o copiarlas directamente a la carpeta ILUSTRACIONES del proyecto (png, jpg, webp) y volver a abrir este selector.";
  $("illusGrid").querySelectorAll("[data-pick]").forEach(b=>b.onclick=()=>{pendingIllus=b.dataset.pick;paintIllusPreview();$("illusDialog").close();});
  $("illusGrid").querySelectorAll("[data-del]").forEach(b=>b.onclick=async e=>{e.stopPropagation();const n=b.dataset.del;if(!confirm(`¿Quitar la imagen «${n}» de este dispositivo? Las listas que la usen mostrarán un círculo vacío hasta que añadas otra con el mismo nombre.`))return;try{await imgDel(n);}catch(err){alert("No se pudo quitar: "+err.message);}openIllusPicker();});
  if(!$("illusDialog").open)$("illusDialog").showModal();
}
$("illusChoose").onclick=()=>openIllusPicker();
$("illusClear").onclick=()=>{pendingIllus="";paintIllusPreview();};
$("illusClose").onclick=()=>$("illusDialog").close();
$("illusAdd").onclick=()=>$("illusFile").click();
$("illusFile").onchange=async e=>{const f=e.target.files[0];e.target.value="";if(!f)return;try{const n=await addIllustration(f);if(n){pendingIllus=n;paintIllusPreview();await openIllusPicker();toast("Imagen añadida: "+n);}}catch(err){alert("No se pudo añadir la imagen: "+err.message);}};

function render(){
  renderNav();const area=$("listArea");
  if(currentView==="list"){const l=lists.find(x=>x.id===currentListId);if(!l){currentView="all";render();return;}renderDetail(l);return;}
  const isTemplates=currentView==="templates";
  $("viewEyebrow").textContent=isTemplates?"REPERTORIO DE PLANTILLAS":"TU ARCHIVO PERSONAL";
  $("viewTitle").textContent=isTemplates?"Plantillas":"Todas las listas";
  $("viewSubtitle").textContent=isTemplates?"Modelos preparados para volver a emprender una misión.":"Tus asuntos, proyectos y pequeñas conquistas, reunidos en un mismo lugar.";
  const data=isTemplates?templates:lists;
  if(!data.length){
    area.innerHTML=`<div class="empty"><div class="empty-mark">❧</div><h2>${isTemplates?"Todavía no hay plantillas":"El Compendio espera su primer registro"}</h2><p>${isTemplates?"Guarda cualquier lista como plantilla para reutilizarla.":"Toda expedición comienza con una primera anotación."}</p><button class="primary-btn" id="emptyCreate">${isTemplates?"Ir a mis listas":"＋ Crear mi primera lista"}</button></div>`;
    $("emptyCreate").onclick=()=>{if(isTemplates){currentView="all";render();}else openListDialog();};return;
  }
  area.innerHTML=`<div class="list-grid">${data.map(l=>{const c=counts(l);return `<article class="list-card" data-card="${l.id}"><div class="card-top">${l.illustration?illusMedallion(l.illustration):'<span class="card-symbol">✧</span>'}<button class="dots" data-menu="${l.id}" title="Opciones">⋯</button></div><h3>${escapeHTML(l.name)}</h3><p>${escapeHTML(l.description||"Sin descripción")}</p><div class="progress-row"><span>${isTemplates?"PLANTILLA":`${c.done} de ${c.total} tareas`}</span><span>${isTemplates?l.tasks.length+" tareas":c.pct+"%"}</span></div><div class="progress-track"><div class="progress-fill" style="width:${isTemplates?0:c.pct}%"></div></div></article>`}).join("")}</div>`;
  area.querySelectorAll("[data-card]").forEach(c=>c.onclick=e=>{if(e.target.closest("[data-menu]"))return;if(isTemplates)useTemplate(c.dataset.card);else openList(c.dataset.card);});
  area.querySelectorAll("[data-menu]").forEach(b=>b.onclick=e=>{e.stopPropagation();cardMenu(b.dataset.menu,isTemplates);});
}
async function cardMenu(id,isTemplate){
  const l=(isTemplate?templates:lists).find(x=>x.id===id);if(!l)return;
  const action=await pickOption(`Opciones para «${l.name}»`,isTemplate?[{label:"Crear lista desde plantilla",value:"1"},{label:"Eliminar plantilla",value:"2",danger:true}]:[{label:"Guardar como plantilla",value:"1"},{label:"Duplicar lista",value:"2"},{label:"Eliminar lista",value:"3",danger:true}]);
  if(isTemplate){if(action==="1")useTemplate(id);if(action==="2"&&confirm("¿Eliminar esta plantilla?")){templates=templates.filter(x=>x.id!==id);saveData().then(render);}}
  else{
    if(action==="1")saveTemplate(l);
    if(action==="2")duplicateList(l);
    if(action==="3"&&confirm("¿Eliminar esta lista y sus tareas?")){lists=lists.filter(x=>x.id!==id);currentView="all";currentListId=null;saveData().then(render);}
  }
}
async function saveTemplate(l){
  const t={...clone(l),id:uid(),name:/^PLANTILLA - /i.test(l.name)?l.name:"PLANTILLA - "+l.name,createdAt:new Date().toISOString(),tasks:l.tasks.map(x=>({...x,done:false}))};
  templates.push(t);await saveData();render();toast("Plantilla guardada en el Compendio.");
}
async function duplicateList(l){
  const copy={...clone(l),id:uid(),name:l.name+" (copia)",createdAt:new Date().toISOString(),tasks:l.tasks.map(t=>({...t,id:uid()}))};
  lists.push(copy);await saveData();render();toast("Lista duplicada.");
}
async function useTemplate(id){
  const t=templates.find(x=>x.id===id);if(!t)return;
  const l={...clone(t),id:uid(),name:String(t.name||"").replace(/^PLANTILLA - /i,"")||t.name,createdAt:new Date().toISOString(),tasks:t.tasks.map(x=>({id:uid(),text:x.text,done:false}))};
  delete l.updatedAt;lists.push(l);currentView="list";currentListId=l.id;await saveData();render();toast("Nueva lista creada desde la plantilla.");
}
function openList(id){currentView="list";currentListId=id;render();}
function renderDetail(l){
  $("viewEyebrow").textContent="REGISTRO DE EXPEDICIÓN";$("viewTitle").textContent=l.name;$("viewSubtitle").textContent=l.description||"Cada tarea completada es un paso más en el camino.";
  const c=counts(l);
  $("listArea").innerHTML=`<div class="detail-head"><button class="back-btn" id="backBtn">← Volver</button>${l.illustration?illusMedallion(l.illustration,"big"):""}<div style="min-width:0"><h2>${escapeHTML(l.name)}</h2><p class="detail-desc">${escapeHTML(l.description||"Registro de tareas")}</p></div><div class="detail-actions"><button class="small-btn" id="editList">Editar nombre</button><button class="small-btn" id="saveTemplate">Guardar como plantilla</button><button class="small-btn" id="duplicateList">Duplicar</button><button class="small-btn" id="resetList">Reiniciar tareas</button></div></div><div class="progress-row" style="margin:0 2px 8px"><span>AVANCE DE LA EXPEDICIÓN</span><span>${c.done}/${c.total} · ${c.pct}%</span></div><div class="progress-track" style="height:5px;margin-bottom:17px"><div class="progress-fill" style="width:${c.pct}%"></div></div><div class="task-panel">${l.tasks.length?l.tasks.map(t=>`<div class="task-row ${t.done?"done":""}" data-task-row="${t.id}"><input class="task-check" type="checkbox" data-check="${t.id}" ${t.done?"checked":""}><span class="task-text">${escapeHTML(t.text)}</span><button class="small-btn edit-task" data-edit-task="${t.id}" title="Editar tarea" aria-label="Editar tarea">✎</button><button class="delete-task" data-delete="${t.id}" title="Eliminar tarea">×</button></div>`).join(""):`<div class="empty" style="border:0;padding:28px 12px;background:transparent"><div class="empty-mark">✧</div><p>Esta expedición aún no tiene tareas.</p></div>`}</div><form class="add-task" id="addTaskForm"><input id="newTask" maxlength="140" placeholder="Añadir una nueva tarea..." autocomplete="off"><button class="primary-btn">＋ Añadir</button></form>`;
  $("backBtn").onclick=()=>{currentView="all";currentListId=null;render();};
  $("editList").onclick=()=>openListDialog(l);$("saveTemplate").onclick=()=>saveTemplate(l);$("duplicateList").onclick=()=>duplicateList(l);
  $("resetList").onclick=async()=>{
    const completed=l.tasks.filter(t=>t.done).length;if(!completed){toast("Esta lista ya está reiniciada.");return;}
    if(!confirm(`Se reiniciarán todas las tareas completadas de «${l.name}».\n\nSe conservarán las ${l.tasks.length} tareas y se desmarcarán ${completed}.\n\n¿Continuar?`))return;
    l.tasks=l.tasks.map(t=>({...t,done:false}));l.updatedAt=new Date().toISOString();await saveData();render();toast("Lista reiniciada. ¡Expedición lista para empezar de nuevo!");
  };
  $("addTaskForm").onsubmit=async e=>{
    e.preventDefault();const v=$("newTask").value.trim();if(!v)return;
    refocusNewTask=true;
    l.tasks.push({id:uid(),text:v,done:false});l.updatedAt=new Date().toISOString();await saveData();render();
  };
  if(!window.matchMedia("(pointer:coarse)").matches||refocusNewTask)$("newTask").focus();
  refocusNewTask=false;
  $("listArea").querySelectorAll("[data-check]").forEach(ch=>ch.onchange=async()=>{
    const t=l.tasks.find(x=>x.id===ch.dataset.check);if(t)t.done=ch.checked;
    l.updatedAt=new Date().toISOString();await saveData();render();
  });
  $("listArea").querySelectorAll("[data-delete]").forEach(b=>b.onclick=async()=>{
    l.tasks=l.tasks.filter(x=>x.id!==b.dataset.delete);l.updatedAt=new Date().toISOString();await saveData();render();
  });
  $("listArea").querySelectorAll("[data-edit-task]").forEach(b=>b.onclick=()=>{
    const task=l.tasks.find(x=>x.id===b.dataset.editTask);if(!task)return;
    const row=b.closest("[data-task-row]");
    row.innerHTML=`<form class="add-task edit-task-form"><input class="edit-task-input" maxlength="140" value="${escapeHTML(task.text)}" aria-label="Texto de la tarea"><button class="primary-btn" type="submit" title="Guardar">Guardar</button><button class="quiet-btn cancel-edit-task" type="button" title="Cancelar">Cancelar</button></form>`;
    const form=row.querySelector("form"), input=row.querySelector("input");
    const cancel=()=>render();
    row.querySelector(".cancel-edit-task").onclick=cancel;
    input.focus();input.select();
    input.onkeydown=e=>{if(e.key==="Escape"){e.preventDefault();cancel();}};
    form.onsubmit=async e=>{
      e.preventDefault();const value=input.value.trim();if(!value){input.focus();return;}
      task.text=value;l.updatedAt=new Date().toISOString();await saveData();render();toast("Tarea actualizada.");
    };
  });
}
function openListDialog(l=null){
  editingId=l?.id||null;$("dialogTitle").textContent=l?"Editar lista":"Crear una lista";
  $("listName").value=l?.name||"";$("listDesc").value=l?.description||"";pendingIllus=l?.illustration||"";paintIllusPreview();$("listDialog").showModal();$("listName").focus();
}
$("listForm").onsubmit=async e=>{
  e.preventDefault();const name=$("listName").value.trim();if(!name)return;
  let l=editingId?lists.find(x=>x.id===editingId):null;
  if(l){l.name=name;l.description=$("listDesc").value.trim();if(pendingIllus)l.illustration=pendingIllus;else delete l.illustration;l.updatedAt=new Date().toISOString();}
  else{l={id:uid(),name,description:$("listDesc").value.trim(),createdAt:new Date().toISOString(),tasks:[]};if(pendingIllus)l.illustration=pendingIllus;lists.push(l);}
  await saveData();$("listDialog").close();currentView=editingId?"list":"all";currentListId=editingId||null;render();toast(editingId?"Registro actualizado.":"Lista creada.");
};
$("cancelDialog").onclick=()=>$("listDialog").close();
$("newListBtn").onclick=()=>openListDialog();$("newListSide").onclick=()=>openListDialog();
document.querySelectorAll("[data-view]").forEach(b=>b.onclick=()=>{currentView=b.dataset.view;currentListId=null;render();});

async function saveJSONToDirectory(dirHandle,filename,data){
  const content=JSON.stringify(data,null,2);
  return await createFileInDirectory(dirHandle,filename,content);
}
$("exportBtn").onclick=async()=>{
  try{if(WEB_MODE){await webExport();return;}if(!await ensureConnected())return;const filename=await saveJSONToDirectory(exportDirHandle,`YEISON_Compendio_${stamp()}.json`,currentData());toast("¡EXPORTACIÓN COMPLETADA!\nArchivo guardado en EXPORTACION: "+filename);}
  catch(e){alert("No se pudo exportar: "+e.message);}
};
$("backupBtn").onclick=async()=>{
  try{if(WEB_MODE){await webBackup();return;}if(!await ensureConnected())return;const filename=await backupCurrentMaster();toast("¡COPIA DE SEGURIDAD COMPLETADA!\nArchivo guardado en BACKUP: "+filename);}
  catch(e){alert("No se pudo crear el BACKUP: "+e.message);}
};
async function chooseJSONFile(kind){
  const input=$(kind==="import"?"importFile":"restoreFile");
  const startHandle=kind==="import"?exportDirHandle:backupDirHandle;
  if(!WEB_MODE&&window.showOpenFilePicker){
    try{
      const [handle]=await window.showOpenFilePicker({
        id:kind==="import"?"compendio-import":"compendio-restore",
        startIn:startHandle||"documents",
        multiple:false,
        types:[{description:"Archivos JSON",accept:{"application/json":[".json"]}}]
      });
      return await handle.getFile();
    }catch(err){if(err.name==="AbortError")return null;throw err;}
  }
  if(WEB_MODE)input.removeAttribute("accept"); // algunos móviles ocultan .json si se filtra por tipo
  return await new Promise(resolve=>{
    input.onchange=()=>resolve(input.files[0]||null);
    input.oncancel=()=>resolve(null);
    input.click();
  });
}
$("importBtn").onclick=async()=>{
  try{const file=await chooseJSONFile("import");if(file)await processImportFile(file);}
  catch(err){alert("No se pudo abrir el archivo para importar: "+err.message);}
};
$("restoreBtn").onclick=async()=>{
  try{const file=WEB_MODE?await chooseWebRestoreSource():await chooseJSONFile("restore");if(file)await processRestoreFile(file);}
  catch(err){alert("No se pudo abrir la copia para restaurar: "+err.message);}
};
async function processImportFile(file){
  try{
    if(!await ensureConnected())return;
    let data=parseCompendioFile(await file.text());
    if(!validData(data))throw Error("El archivo no contiene una estructura de Compendio válida (se necesita una lista de listas con tareas).");
    data=normaliseData(data);
    if(!confirm(`Se importarán ${data.lists.length} listas y ${data.templates.length} plantillas. Si una lista ya existe con el mismo nombre, se sustituirá COMPLETAMENTE por la del archivo importado (incluidas sus tareas y estados de completado). Las listas que no existan se añadirán. No se crearán duplicados por diferencias de identificador. ¿Continuar?`))return;
    const report={newLists:[],updatedLists:[],newTemplates:[],updatedTemplates:[]};
    const normalName=value=>String(value||"").trim().normalize("NFC").toLocaleLowerCase("es");
    // Consolidar posibles duplicados locales por nombre antes de aplicar la importación.
    const uniqueLists=[];const listIndexByName=new Map();
    for(const local of lists){
      const key=normalName(local.name);
      if(key&&listIndexByName.has(key))continue;
      if(key)listIndexByName.set(key,uniqueLists.length);
      uniqueLists.push(local);
    }
    lists=uniqueLists;
    for(const imported of data.lists){
      const key=normalName(imported.name);
      let i=key?listIndexByName.get(key):undefined;
      if(i===undefined)i=lists.findIndex(x=>x.id===imported.id);
      if(i>=0){if(!imported.illustration&&lists[i].illustration)imported.illustration=lists[i].illustration;lists[i]=imported;if(key)listIndexByName.set(key,i);report.updatedLists.push(imported.name||"Lista sin nombre");}
      else{const newIndex=lists.length;lists.push(imported);if(key)listIndexByName.set(key,newIndex);report.newLists.push(imported.name||"Lista sin nombre");}
    }
    // Las plantillas mantienen su comportamiento anterior: actualización por identificador.
    for(const t of data.templates){const i=templates.findIndex(x=>x.id===t.id);if(i>=0){templates[i]=t;report.updatedTemplates.push(t.name||"Plantilla sin nombre");}else{templates.push(t);report.newTemplates.push(t.name||"Plantilla sin nombre");}}
    await saveData();render();
    const section=(title,items)=>`${title} (${items.length})\n${items.length?items.map(x=>`• ${x}`).join("\n"):"• Ninguno"}`;
    alert(["IMPORTACIÓN COMPLETADA",`Archivo: ${file.name}`,"",section("LISTAS NUEVAS",report.newLists),"",section("LISTAS ACTUALIZADAS",report.updatedLists),"",section("PLANTILLAS NUEVAS",report.newTemplates),"",section("PLANTILLAS ACTUALIZADAS",report.updatedTemplates)].join("\n"));
  }catch(err){alert("No se pudo importar el archivo: "+err.message);}
  } 
$("importFile").onchange=async e=>{const file=e.target.files[0];if(file)await processImportFile(file);e.target.value="";};
async function processRestoreFile(file){
  try{
    if(!await ensureConnected())return;
    let data=parseCompendioFile(await file.text());
    if(!validData(data))throw Error("El archivo no contiene una estructura de Compendio válida (se necesita una lista de listas con tareas).");
    data=normaliseData(data);
    if(!confirm(`RESTAURAR COPIA COMPLETA\n\nArchivo: ${file.name}\nIncluye ${data.lists.length} listas y ${data.templates.length} plantillas.\n\nSe sustituirán los datos actuales. Antes se guardará automáticamente una copia del JSON maestro actual en ${WEB_MODE?"las copias internas del dispositivo":"BACKUP"}.\n\n¿Continuar?`))return;
    const backup=await backupCurrentMaster("ANTES_DE_RESTAURAR");
    await writeMaster(data);
    lists=clone(data.lists);templates=clone(data.templates);render();
    alert(`RESTAURACIÓN COMPLETADA\n\nArchivo: ${file.name}\nListas restauradas: ${data.lists.length}\nPlantillas restauradas: ${data.templates.length}\n\nCopia previa guardada en ${WEB_MODE?"las copias internas del dispositivo":"BACKUP"}:\n${backup}`);
  }catch(err){alert("No se pudo restaurar la copia: "+err.message);}
  }
$("restoreFile").onchange=async e=>{const file=e.target.files[0];if(file)await processRestoreFile(file);e.target.value="";};
$("connectFolderBtn").onclick=connectFolder;
$("changeFolderBtn").onclick=async()=>{
  if(!confirm("¿Quieres seleccionar otra carpeta para EL COMPENDIO DEL BALUARTE? Los datos de la carpeta actual no se moverán ni se borrarán."))return;
  await clearStoredRootHandle();rootHandle=null;dataDirHandle=null;exportDirHandle=null;backupDirHandle=null;
  document.body.classList.add("app-locked");$("accessGate").hidden=false;
  $("gateTitle").textContent="Conectar EL COMPENDIO DEL BALUARTE";
  $("gateText").textContent="Selecciona únicamente la carpeta principal del Compendio. No selecciones la unidad completa.";
};
(async()=>{
  if(WEB_MODE){await startWebMode();return;}
  try{
    const handle=await getStoredRootHandle();
    if(handle){
      if(await hasWritePermission(handle)){
        try{
          // Validar la raíz antes de inicializar o crear carpetas de datos.
          await handle.getFileHandle("index.html");
          await handle.getFileHandle("app.js");
          if(!await folderBelongsToThisCopy(handle))throw new Error("otra copia");
          rootHandle=handle;
          await initialiseFolders(handle);
          return;
        }catch(invalidRoot){
          await clearStoredRootHandle();
          $("gateText").textContent="La carpeta recordada no corresponde a esta copia del Compendio. Selecciona la carpeta principal donde está el index.html que has abierto (la que contiene index.html, app.js e instancia.js). Nunca DATOS.";
        }
      }else{
        // La renovación del permiso requiere el clic del usuario. Se conserva
        // el identificador para reutilizar la misma carpeta al pulsar el botón.
        document.body.classList.add("app-locked");
        $("accessGate").hidden=false;
        $("gateTitle").textContent="Permiso de acceso pendiente";
        $("gateText").textContent="Chrome recuerda la carpeta principal del Compendio, pero necesita que confirmes de nuevo el permiso de lectura y escritura. Pulsa el botón para concederlo sin tener que seleccionar otra vez la carpeta.";
        $("connectFolderBtn").textContent="Conceder permiso a la carpeta recordada";
        return;
      }
    }
    document.body.classList.add("app-locked");$("accessGate").hidden=false;
  }catch(err){document.body.classList.add("app-locked");$("accessGate").hidden=false;console.error(err);}
})();
// V6: funcionamiento sin conexión cuando se abre desde una dirección web (móvil/iPad). En file:// no se registra.
if("serviceWorker" in navigator&&/^https?:$/.test(location.protocol)){window.addEventListener("load",()=>navigator.serviceWorker.register("sw.js").catch(e=>console.warn("Service worker no registrado",e)));}

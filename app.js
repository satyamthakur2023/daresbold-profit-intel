/* ==========================================================
   Cladus P&L Intelligence — app.js
   Full master build: parsing · caching · AI · exports · all tabs
   ========================================================== */

'use strict';

// ── State ──────────────────────────────────────────────────
const S = {
  summary:   null,
  skuRows:   [],
  orders:    [],
  reports:   [],
  activeReportId: 'all',
  activeTab: 'overview',
  customerServiceFeeMin: 5,
  customerServiceFeeMax: 10,
  costs:     {},       // { skuId: { product,packing,other } }
  charts:    {},
  ordersFiltered: [],
  ordersPage: 1,
  ordersPageSize: 50,
  discPage:  1,
  discFiltered: [],
  actionsDone: {},
};

// ── Colour palette ─────────────────────────────────────────
const PAL = ['#7c6fff','#00e0b0','#ff5f6d','#ffc849','#4fc3f7',
             '#b388ff','#fd79a8','#56e2c2','#ffb347','#6dd5fa',
             '#f78ca0','#a1c4fd','#43e97b','#fa709a','#fee140'];
const α = (hex, a) => {
  const r=parseInt(hex.slice(1,3),16), g=parseInt(hex.slice(3,5),16), b=parseInt(hex.slice(5,7),16);
  return `rgba(${r},${g},${b},${a})`;
};

// ── Formatters ─────────────────────────────────────────────
const fmt  = n => (n==null||isNaN(n)) ? '—' : '₹'+Number(n).toLocaleString('en-IN',{minimumFractionDigits:2,maximumFractionDigits:2});
const fmtN = n => (n==null||isNaN(n)) ? '—' : Number(n).toLocaleString('en-IN');
const pct  = n => (n==null||isNaN(n)) ? '—' : Number(n).toFixed(1)+'%';
const safe = v => (v==null||v===''||v==='Generation in progress') ? 0 : parseFloat(v)||0;
const safeStr = v => String(v||'').trim();

// ── DOM helpers ────────────────────────────────────────────
const $  = id => document.getElementById(id);
const show = id => $(id) && ($(id).style.display='');
const hide = id => $(id) && ($(id).style.display='none');
const destroyChart = id => { if(S.charts[id]){S.charts[id].destroy();delete S.charts[id];} };

// ── Loading overlay ────────────────────────────────────────
function loading(on, msg='Processing…', pct=0){
  let el=$('loadingOverlay');
  if(on){
    if(!el){
      el=document.createElement('div'); el.id='loadingOverlay'; el.className='loading-overlay';
      el.innerHTML=`<div class="spinner"></div><div class="loading-text">${msg}</div>
        <div class="loading-progress"><div class="loading-bar" id="lbar" style="width:${pct}%"></div></div>`;
      document.body.appendChild(el);
    } else {
      el.querySelector('.loading-text').textContent=msg;
      const b=el.querySelector('#lbar'); if(b) b.style.width=pct+'%';
    }
  } else { if(el) el.remove(); }
}

// ═══════════════════════════════════════════════════════════
// ENCRYPTED LOCAL STORAGE — IndexedDB + Web Crypto
// ═══════════════════════════════════════════════════════════
const LOCAL_DB_NAME = 'cladus_dashboard';
const LOCAL_DB_VERSION = 1;
const LOCAL_STORE_NAME = 'sessions';
const LOCAL_SESSION_ID = 'active';
const LOCAL_KEY_ID = 'device-key';
const CACHE_KEY = 'cladus_session_v2';
const COSTS_KEY = 'cladus_costs_v2';
const COST_DEFAULTS_VERSION_KEY = 'cladus_cost_defaults_version';
const DEFAULT_COSTS = Object.freeze({product:80,packing:5,other:0});
const RETURN_PACKING_COST = 5;
const LEGACY_COST_DEFAULTS_VERSION = '80-5';
let localDbPromise;
let sessionEncryptionKey;
let saveQueue=Promise.resolve();
let saveDebounce;

function openLocalDatabase(){
  if(!window.indexedDB) throw new Error('This browser does not support private local database storage.');
  if(!localDbPromise){
    localDbPromise=new Promise((resolve,reject)=>{
      const request=indexedDB.open(LOCAL_DB_NAME,LOCAL_DB_VERSION);
      request.onupgradeneeded=()=>{
        if(!request.result.objectStoreNames.contains(LOCAL_STORE_NAME)){
          request.result.createObjectStore(LOCAL_STORE_NAME,{keyPath:'id'});
        }
      };
      request.onsuccess=()=>resolve(request.result);
      request.onerror=()=>reject(request.error||new Error('Could not open the local database.'));
      request.onblocked=()=>reject(new Error('The local database is blocked by another open tab. Close other dashboard tabs and try again.'));
    });
  }
  return localDbPromise;
}

async function readLocalSession(){
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const store=db.transaction(LOCAL_STORE_NAME,'readonly').objectStore(LOCAL_STORE_NAME);
    const request=store.get(LOCAL_SESSION_ID);
    request.onsuccess=()=>{
      if(request.result){
        resolve(request.result);
        return;
      }
      const allRequest=store.getAll();
      allRequest.onsuccess=()=>{
        const saved=allRequest.result.filter(record=>record.id!==LOCAL_KEY_ID).sort((a,b)=>(b.ts||0)-(a.ts||0));
        resolve(saved[0]||null);
      };
      allRequest.onerror=()=>reject(allRequest.error||new Error('Could not read saved local sessions.'));
    };
    request.onerror=()=>reject(request.error||new Error('Could not read the saved local session.'));
  });
}

async function writeLocalSession(record){
  if(record.id!==LOCAL_SESSION_ID) throw new Error('Invalid local session record.');
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(LOCAL_STORE_NAME,'readwrite');
    transaction.objectStore(LOCAL_STORE_NAME).put(record);
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error||new Error('Could not save the local session.'));
    transaction.onabort=()=>reject(transaction.error||new Error('Saving the local session was cancelled.'));
  });
}

async function removeLocalSession(){
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(LOCAL_STORE_NAME,'readwrite');
    transaction.objectStore(LOCAL_STORE_NAME).clear();
    transaction.oncomplete=()=>resolve();
    transaction.onerror=()=>reject(transaction.error||new Error('Could not delete the saved local session.'));
    transaction.onabort=()=>reject(transaction.error||new Error('Deleting the local session was cancelled.'));
  });
}

function setCacheStatus(message,isError=false){
  const chip=$('metaCacheStatus');
  if(chip){
    chip.textContent=message;
    chip.style.display='';
    chip.classList.toggle('cache-status-error',isError);
  }
  if(isError) console.error(message);
}

async function getDeviceEncryptionKey(){
  if(!window.crypto?.subtle) throw new Error('Encrypted local storage requires a secure browser connection (HTTPS or localhost).');
  if(sessionEncryptionKey) return sessionEncryptionKey;

  const db=await openLocalDatabase();
  const generatedKey=await crypto.subtle.generateKey({name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  return new Promise((resolve,reject)=>{
    const transaction=db.transaction(LOCAL_STORE_NAME,'readwrite');
    const store=transaction.objectStore(LOCAL_STORE_NAME);
    const request=store.get(LOCAL_KEY_ID);
    request.onsuccess=()=>{
      if(request.result){
        sessionEncryptionKey=request.result.key;
      }else{
        sessionEncryptionKey=generatedKey;
        store.add({id:LOCAL_KEY_ID,key:generatedKey});
      }
    };
    request.onerror=()=>reject(request.error||new Error('Could not read the local encryption key.'));
    transaction.oncomplete=()=>resolve(sessionEncryptionKey);
    transaction.onabort=()=>{
      void readDeviceEncryptionKey().then(key=>{
        if(key){
          sessionEncryptionKey=key;
          resolve(key);
        }else{
          reject(transaction.error||new Error('Could not create the local encryption key.'));
        }
      },reject);
    };
  });
}

async function readDeviceEncryptionKey(){
  const db=await openLocalDatabase();
  return new Promise((resolve,reject)=>{
    const request=db.transaction(LOCAL_STORE_NAME,'readonly').objectStore(LOCAL_STORE_NAME).get(LOCAL_KEY_ID);
    request.onsuccess=()=>resolve(request.result?.key||null);
    request.onerror=()=>reject(request.error||new Error('Could not read the local encryption key.'));
  });
}

async function encryptSession(payload,key){
  const iv=crypto.getRandomValues(new Uint8Array(12));
  const plaintext=new TextEncoder().encode(JSON.stringify(payload));
  const ciphertext=await crypto.subtle.encrypt({name:'AES-GCM',iv},key,plaintext);
  return {
    id:LOCAL_SESSION_ID,
    version:2,
    iv:Array.from(iv),
    ciphertext,
    ts:payload.ts,
  };
}

async function decryptDeviceSession(record,key){
  const iv=new Uint8Array(record.iv);
  const plaintext=await crypto.subtle.decrypt({name:'AES-GCM',iv},key,record.ciphertext);
  return JSON.parse(new TextDecoder().decode(plaintext));
}

function legacySession(){
  const sessionRaw=localStorage.getItem(CACHE_KEY);
  if(!sessionRaw) return null;
  const payload=JSON.parse(sessionRaw);
  if(!Array.isArray(payload.orders)||!payload.orders.length) return null;
  const costsRaw=localStorage.getItem(COSTS_KEY);
  payload.costs=costsRaw?JSON.parse(costsRaw):{};
  if(localStorage.getItem(COST_DEFAULTS_VERSION_KEY)!==LEGACY_COST_DEFAULTS_VERSION){
    Object.keys(payload.costs).forEach(sku=>{
      const cost=payload.costs[sku]||{};
      if(safe(cost.product)===0&&safe(cost.packing)===0&&safe(cost.other)===0){
        payload.costs[sku]={...DEFAULT_COSTS};
      }
    });
  }
  return payload;
}

function applySessionPayload(payload){
  S.costs=payload.costs&&typeof payload.costs==='object'?payload.costs:{};
  const feeRange=payload.customerServiceFeeRange||{};
  const feeMin=Number(feeRange.min);
  const feeMax=Number(feeRange.max);
  S.customerServiceFeeMin=Number.isFinite(feeMin)&&feeMin>=0?feeMin:5;
  S.customerServiceFeeMax=Number.isFinite(feeMax)&&feeMax>=S.customerServiceFeeMin?feeMax:Math.max(10,S.customerServiceFeeMin);
  S.reports=Array.isArray(payload.reports)&&payload.reports.length
    ?payload.reports
    :[{
      id:'report-0',
      label:payload.summary?.period||'Uploaded report',
      fileName:'Uploaded report',
      summary:payload.summary||{},
      skuRows:Array.isArray(payload.skuRows)?payload.skuRows:[],
      orders:Array.isArray(payload.orders)?payload.orders:[],
    }];
  S.activeReportId=payload.activeReportId||'all';
  const availableTabs=new Set([...document.querySelectorAll('.tab-btn[data-tab]')].map(button=>button.dataset.tab));
  S.activeTab=availableTabs.has(payload.activeTab)?payload.activeTab:'overview';
  if(S.activeReportId!=='all'&&!S.reports.some(report=>report.id===S.activeReportId)){
    S.activeReportId='all';
  }
  activateReportData(S.activeReportId,false);
  initCosts();
  enrichOrders();
  const age=Math.max(0,Math.round((Date.now()-(payload.ts||Date.now()))/60000));
  setCacheStatus(`🔒 Saved locally · ${age}m ago`);
}

async function unlockLocalSession(record){
  if(record.version!==2) throw new Error('This saved session uses the old passphrase encryption. To continue without passphrase prompts, clear the old saved data and re-import your Excel report.');
  const key=await getDeviceEncryptionKey();
  const payload=await decryptDeviceSession(record,key);
  applySessionPayload(payload);
  return true;
}

async function checkForSavedSession(){
  try{
    const record=await readLocalSession();
    const hasLegacy=!record&&!!legacySession();
    if((record&&record.version===2)||hasLegacy){
      show('cachedSessionAlert');
      $('cachedSessionAlert').querySelector('span').textContent='🔒 Restoring your encrypted dashboard…';
      hide('btnLoadCache');
      show('btnClearLocalData');
      await restoreLocalSession();
      return;
    }
    if(record||hasLegacy){
      const oldPassphraseRecord=record&&record.version!==2;
      $('cachedSessionAlert').querySelector('span').textContent=oldPassphraseRecord
        ? '⚠️ An older passphrase-protected session cannot be opened automatically. Clear it and re-import your report to use automatic local encryption.'
        : record
          ? '🔒 Encrypted local session found.'
          : '⚠️ An older unencrypted local session was found; restoring will encrypt it.';
      show('cachedSessionAlert');
      if(oldPassphraseRecord) hide('btnLoadCache');
      else show('btnLoadCache');
      show('btnClearLocalData');
    }
  }catch(error){
    setCacheStatus(`Local dashboard restore failed: ${error.message}`,true);
    if($('cachedSessionAlert')){
      $('cachedSessionAlert').querySelector('span').textContent=`⚠️ Automatic restore failed: ${error.message}`;
      show('cachedSessionAlert');
      show('btnLoadCache');
    }
  }
}

async function restoreLocalSession(){
  const record=await readLocalSession();
  if(record){
    const unlocked=await unlockLocalSession(record);
    if(!unlocked) return;
  }else{
    const payload=legacySession();
    if(!payload) return;
    applySessionPayload(payload);
    await getDeviceEncryptionKey();
    await saveSession();
  }
  hide('cachedSessionAlert');
  hide('uploadScreen');
  hide('costScreen');
  show('dashScreen');
  updateHeaderMeta();
  buildReportTabs();
  buildDashboard();
  switchTab(S.activeTab);
}

async function persistSession(){
  if(!S.orders.length) return true;
  syncActiveReportState();
  const record=await readLocalSession();
  if(record&&record.version!==2) throw new Error('This saved session uses the old passphrase encryption. Clear it before saving with automatic local encryption.');
  const key=await getDeviceEncryptionKey();
  const payload={
    reports:S.reports,
    activeReportId:S.activeReportId,
    activeTab:S.activeTab,
    customerServiceFeeRange:{min:S.customerServiceFeeMin,max:S.customerServiceFeeMax},
    costs:S.costs,
    ts:Date.now(),
  };
  const encrypted=await encryptSession(payload,key);
  await writeLocalSession(encrypted);
  localStorage.removeItem(CACHE_KEY);
  localStorage.removeItem(COSTS_KEY);
  localStorage.removeItem(COST_DEFAULTS_VERSION_KEY);
  setCacheStatus('🔒 Encrypted and saved '+new Date().toLocaleTimeString());
  show('btnClearLocalData');
  return true;
}

function saveSession(){
  const operation=saveQueue.then(async()=>{
    try{
      return await persistSession();
    }catch(error){
      setCacheStatus(`Local save failed: ${error.message}`,true);
      return false;
    }
  });
  saveQueue=operation.catch(()=>{});
  return operation;
}

function scheduleSaveSession(){
  clearTimeout(saveDebounce);
  saveDebounce=setTimeout(()=>{ void saveSession(); },500);
}

async function clearCache(){
  clearTimeout(saveDebounce);
  await saveQueue;
  await removeLocalSession();
  let legacyStorageError;
  try{
    localStorage.removeItem(CACHE_KEY);
    localStorage.removeItem(COSTS_KEY);
    localStorage.removeItem(COST_DEFAULTS_VERSION_KEY);
  }catch(error){
    legacyStorageError=error;
  }
  sessionEncryptionKey=null;
  S.summary=null;
  S.skuRows=[];
  S.orders=[];
  S.reports=[];
  S.activeReportId='all';
  S.activeTab='overview';
  S.costs={};
  S.ordersFiltered=[];
  S.discFiltered=[];
  Object.keys(S.charts).forEach(destroyChart);
  hide('dashScreen');
  hide('costScreen');
  show('uploadScreen');
  hide('reportMeta');
  hide('btnSaveSession');
  hide('btnExportAll');
  hide('btnAiSummary');
  hide('btnCalculationGuide');
  hide('btnAddReports');
  hide('btnClearLocalData');
  hide('cachedSessionAlert');
  hide('reportTabs');
  if(legacyStorageError) throw new Error(`Encrypted data was deleted, but old browser cache cleanup failed: ${legacyStorageError.message}`);
  setCacheStatus('🔒 Saved local data deleted.');
}

// Auto-save locally every 60 seconds.
setInterval(()=>{ if(S.orders.length) void saveSession(); },60000);
window.addEventListener('pagehide',()=>{
  if(S.orders.length) void saveSession();
});

window.addEventListener('load',()=>{ void checkForSavedSession(); });

$('btnLoadCache')?.addEventListener('click',async()=>{
  try{
    await restoreLocalSession();
  }catch(error){
    alert(`Could not restore the local session: ${error.message}`);
  }
});

$('btnClearLocalData')?.addEventListener('click',async()=>{
  if(!confirm('Delete saved data and clear the currently loaded report from this browser? You will need to re-import the Excel report.')) return;
  try{
    await clearCache();
  }catch(error){
    setCacheStatus(`Could not delete local data: ${error.message}`,true);
    alert(`Could not delete local data: ${error.message}`);
  }
});

$('btnSaveSession')?.addEventListener('click',async()=>{
  if(await saveSession()) alert('Dashboard data encrypted and saved on this device.');
});

// ═══════════════════════════════════════════════════════════
// FILE UPLOAD + DRAG & DROP
// ═══════════════════════════════════════════════════════════
$('fileInput')?.addEventListener('change',e=>readFiles(Array.from(e.target.files||[])));
$('addReportsInput')?.addEventListener('change',e=>readFiles(Array.from(e.target.files||[]),'append'));
$('btnAddReports')?.addEventListener('click',()=>$('addReportsInput')?.click());

const dz=$('dropZone');
if(dz){
  dz.addEventListener('dragover', e=>{ e.preventDefault(); dz.classList.add('drag-over'); });
  dz.addEventListener('dragleave',()=> dz.classList.remove('drag-over'));
  dz.addEventListener('drop',e=>{
    e.preventDefault();
    dz.classList.remove('drag-over');
    readFiles(Array.from(e.dataTransfer.files||[]));
  });
}

function readWorkbookFile(file){
  return new Promise((resolve,reject)=>{
    const reader=new FileReader();
    reader.onerror=()=>reject(new Error(`Unable to read "${file.name}".`));
    reader.onabort=()=>reject(new Error(`Reading "${file.name}" was cancelled.`));
    reader.onload=event=>{
      try{
        const workbook=XLSX.read(event.target.result,{type:'array'});
        resolve(parseWorkbook(workbook,file));
      }catch(error){
        reject(new Error(`Could not parse "${file.name}": ${error.message}`));
      }
    };
    reader.readAsArrayBuffer(file);
  });
}

async function readFiles(files,mode='replace'){
  const selected=files.filter(file=>/\.(xlsx|xls)$/i.test(file.name));
  if(!selected.length){
    if(files.length) alert('Select one or more .xlsx or .xls Flipkart reports.');
    return;
  }

  const append=mode==='append'&&S.reports.length>0;
  const selectedFileKeys=new Set();
  const duplicateFiles=selected.filter(file=>{
    const key=`${file.name.toLowerCase()}|${file.size}|${file.lastModified}`;
    if(selectedFileKeys.has(key)) return true;
    selectedFileKeys.add(key);
    return S.reports.some(report=>{
      if(safeStr(report.fileName).toLowerCase()!==file.name.toLowerCase()) return false;
      return report.fileSize==null||report.fileLastModified==null
        ||(report.fileSize===file.size&&report.fileLastModified===file.lastModified);
    });
  });
  if(duplicateFiles.length){
    alert(`These report files are already in the workspace: ${duplicateFiles.map(file=>file.name).join(', ')}`);
    return;
  }

  if(append) syncActiveReportState();
  const previousReports=S.reports;
  const previousActiveReportId=S.activeReportId;
  const previousActiveTab=S.activeTab;
  const previousCosts=S.costs;
  const parsedReports=[];
  try{
    S.costs={...S.costs};
    for(let index=0;index<selected.length;index++){
      const file=selected[index];
      loading(true,`Reading report ${index+1} of ${selected.length}: ${file.name}`,Math.round(index/selected.length*100));
      const report=await readWorkbookFile(file);
      if(!report.orders.length) throw new Error(`"${file.name}" does not contain any order rows. No reports were loaded.`);
      parsedReports.push(report);
    }

    S.reports=append?[...previousReports,...parsedReports]:parsedReports;
    S.activeReportId=append?previousActiveReportId:'all';
    S.activeTab=append?previousActiveTab:'overview';
    activateReportData(S.activeReportId,false);
    initCosts();
    enrichOrders();
    buildReportTabs();
    loading(true,'Reports ready',100);
    setTimeout(()=>{
      loading(false);
      updateHeaderMeta();
      if(append){
        Object.keys(S.charts).forEach(destroyChart);
        buildDashboard();
        switchTab(S.activeTab);
        void saveSession();
      }else{
        showCostScreen();
        void saveSession();
      }
    },250);
  }catch(error){
    S.reports=previousReports;
    S.activeReportId=previousActiveReportId;
    S.activeTab=previousActiveTab;
    S.costs=previousCosts;
    loading(false);
    alert(error.message);
  }finally{
    $('fileInput').value='';
    $('addReportsInput').value='';
  }
}

// ═══════════════════════════════════════════════════════════
// WORKBOOK PARSER
// ═══════════════════════════════════════════════════════════
function reportPeriodLabel(summary,fileName){
  const dates=safeStr(summary.period).match(/\d{4}-\d{2}-\d{2}/g);
  if(dates?.length){
    const date=new Date(`${dates[0]}T12:00:00`);
    if(!Number.isNaN(date.getTime())){
      return date.toLocaleDateString('en-IN',{month:'short',year:'numeric'});
    }
  }
  return safeStr(fileName).replace(/\.(xlsx|xls)$/i,'')||'Uploaded report';
}

function aggregateReports(reports){
  const summary={
    period:reports.length===1
      ?reports[0].summary?.period||reports[0].label
      :`All months · ${fmtN(reports.length)} reports`,
  };
  reports.forEach(report=>{
    Object.entries(report.summary||{}).forEach(([key,value])=>{
      if(typeof value==='number'&&Number.isFinite(value)) summary[key]=(summary[key]||0)+value;
    });
  });
  const skuMap=new Map();
  reports.forEach(report=>{
    (report.skuRows||[]).forEach(row=>{
      let total=skuMap.get(row.skuId);
      if(!total){
        total={skuId:row.skuId};
        skuMap.set(row.skuId,total);
      }
      Object.entries(row).forEach(([key,value])=>{
        if(key!=='skuId'&&typeof value==='number'&&Number.isFinite(value)){
          total[key]=(total[key]||0)+value;
        }
      });
    });
  });
  return{
    summary,
    skuRows:[...skuMap.values()],
    orders:reports.flatMap(report=>(report.orders||[]).map(order=>({...order,_reportId:report.id}))),
  };
}

function syncActiveReportState(){
  if(!S.reports.length) return;
  if(S.activeReportId==='all'){
    const reportById=new Map(S.reports.map(report=>[
      report.id,
      new Map((report.orders||[]).map(order=>[`${order.orderId}|${order.itemId}`,order])),
    ]));
    S.orders.forEach(order=>{
      const source=reportById.get(order._reportId)?.get(`${order.orderId}|${order.itemId}`);
      if(source&&Object.hasOwn(order,'returnProductCostLost')){
        source.returnProductCostLost=order.returnProductCostLost;
      }
    });
    return;
  }
  const report=S.reports.find(item=>item.id===S.activeReportId);
  if(!report) return;
  report.summary=S.summary;
  report.skuRows=S.skuRows;
  report.orders=S.orders;
}

function activateReportData(reportId,preserveActive=true){
  if(preserveActive) syncActiveReportState();
  if(reportId==='all'){
    const aggregated=aggregateReports(S.reports);
    S.summary=aggregated.summary;
    S.skuRows=aggregated.skuRows;
    S.orders=aggregated.orders;
    return;
  }
  const report=S.reports.find(item=>item.id===reportId);
  if(!report) throw new Error('The selected monthly report is no longer available.');
  S.summary=report.summary||{};
  S.skuRows=report.skuRows||[];
  S.orders=report.orders||[];
}

function buildReportTabs(){
  const container=$('reportTabs');
  if(!container) return;
  container.replaceChildren();
  if(S.reports.length<2){
    hide('reportTabs');
    return;
  }
  const counts=new Map();
  const addButton=(id,label)=>{
    const button=document.createElement('button');
    button.className=`report-tab${S.activeReportId===id?' active':''}`;
    button.type='button';
    button.dataset.reportId=id;
    button.setAttribute('role','tab');
    button.setAttribute('aria-selected',String(S.activeReportId===id));
    button.textContent=label;
    const report=S.reports.find(item=>item.id===id);
    if(report){
      button.title=`${report.fileName||report.label} · ${fmtN(report.orders?.length||0)} order rows`;
      button.setAttribute('aria-label',`${label}: ${button.title}`);
    }
    container.append(button);
  };
  addButton('all',`📊 All Months (${S.reports.length})`);
  S.reports.forEach(report=>{
    const count=(counts.get(report.label)||0)+1;
    counts.set(report.label,count);
    addButton(report.id,count>1?`${report.label} (${count})`:report.label);
  });
  container.onclick=event=>{
    const button=event.target.closest('button[data-report-id]');
    if(button) switchReport(button.dataset.reportId);
  };
  show('reportTabs');
}

function switchReport(reportId){
  if(reportId===S.activeReportId) return;
  try{
    syncActiveReportState();
    S.activeReportId=reportId;
    activateReportData(reportId,false);
    initCosts();
    enrichOrders();
    Object.keys(S.charts).forEach(destroyChart);
    updateHeaderMeta();
    buildReportTabs();
    buildDashboard();
    switchTab(S.activeTab);
    scheduleSaveSession();
  }catch(error){
    alert(`Could not open this report view: ${error.message}`);
  }
}

function parseWorkbook(wb,file){
  const previous={summary:S.summary,skuRows:S.skuRows,orders:S.orders,costs:S.costs};
  try{
    const find=(...keys)=>wb.SheetNames.find(n=>keys.some(k=>n.toLowerCase().includes(k.toLowerCase())));
    const toRows=name=>name?XLSX.utils.sheet_to_json(wb.Sheets[name],{header:1,defval:''}):[];

    S.summary=parseSummary(toRows(find('Overall','Summary','PNL','Report')));
    S.skuRows=parseSKU(toRows(find('SKU','Product','sku-level','SKU-level')));
    S.orders=parseOrders(toRows(find('Order','Orders P','order p')));
    S.costs=previous.costs;
    enrichOrders();
    initCosts();
    return{
      id:`report-${file.lastModified||0}-${file.size||0}-${Math.random().toString(36).slice(2,8)}`,
      label:reportPeriodLabel(S.summary,file.name),
      fileName:file.name,
      fileSize:file.size,
      fileLastModified:file.lastModified,
      summary:S.summary,
      skuRows:S.skuRows,
      orders:S.orders,
    };
  }finally{
    S.summary=previous.summary;
    S.skuRows=previous.skuRows;
    S.orders=previous.orders;
    S.costs=previous.costs;
  }
}

// ── Enrich orders with extra computed fields ───────────────
function enrichOrders(){
  const orderExpenseTotal=S.orders.reduce((total,order)=>total+safe(order.expenses),0);
  const orderSettlementTotal=S.orders.reduce((total,order)=>total+safe(order.bankSettlement),0);
  const accountedSales=S.orders.reduce((total,order)=>total+safe(order.accNetSales),0);
  const sharedExpense=safe(S.summary?.totalExpenses)-orderExpenseTotal;
  const settlementAdjustment=safe(S.summary?.bankSettlement)-orderSettlementTotal-sharedExpense;
  S.orders.forEach(o=>{
    // Seller discount = FSP - accNetSales (approximate per order)
    o.sellerDiscount = safe(o.fsp) > 0 && safe(o.accNetSales) > 0
      ? Math.max(0, safe(o.fsp)*safe(o.netUnits) - safe(o.accNetSales)) : 0;
    o.discPct = (safe(o.fsp)*safe(o.netUnits))>0
      ? (o.sellerDiscount/(safe(o.fsp)*safe(o.netUnits)))*100 : 0;
    o.taxes = Math.abs(safe(o.gst))+Math.abs(safe(o.tcs))+Math.abs(safe(o.tds||0));
    o.fixedFee = Math.abs(safe(o.fixedFee||0));
    o.sharedExpenseAllocation=accountedSales>0
      ? sharedExpense*(safe(o.accNetSales)/accountedSales) : 0;
    o.settlementAdjustment=accountedSales>0
      ? settlementAdjustment*(safe(o.accNetSales)/accountedSales) : 0;
  });
}

// ── Parse Summary Sheet ────────────────────────────────────
function parseSummary(rows){
  const d={};
  rows.forEach(r=>{
    const k=safeStr(r[0]), v=r[1];
    if(k.includes('Orders Reciev')||k.includes('Orders Receiv')) d.period=safeStr(v);
    if(k.includes('Generated on')) d.generated=safeStr(v);
    if(k==='Gross Sales')          { d.grossSales=safe(v); d.grossUnits=safe(r[2]); }
    if(k==='Returns and Cancellations') { d.returnsCancelAmt=safe(v); d.returnsCancelUnits=safe(r[2]); }
    if(k.match(/^•\s*RTO/))        { d.rtoAmt=safe(v);    d.rtoUnits=safe(r[2]); }
    if(k.match(/^•\s*RVP/))        { d.rvpAmt=safe(v);    d.rvpUnits=safe(r[2]); }
    if(k.match(/^•\s*Cancell/))    { d.cancelAmt=safe(v); d.cancelUnits=safe(r[2]); }
    if(k==='Estimated Net Sales')  { d.netSales=safe(v);   d.netUnits=safe(r[2]); }
    if(k==='Accounted Net Sales (Seller Price)') d.accountedNetSales=safe(v);
    if(k==='Seller-Funded Discount')             d.sellerDiscount=safe(v);
    if(k==='Customer Add-Ons Amount')            d.customerAddons=safe(v);
    if(k==='Total Expenses')                     d.totalExpenses=safe(v);
    if(k.match(/^•\s*Commission/))               d.commissionFee=safe(v);
    if(k.match(/^•\s*Fixed Fee/))                d.fixedFee=safe(v);
    if(k.match(/^•\s*Reverse Shipp/))            d.reverseShipping=safe(v);
    if(k.match(/^•\s*Ads$/))                     d.ads=safe(v);
    if(k.match(/^•\s*Google Ads/))               d.googleAds=safe(v);
    if(k.match(/^•\s*Taxes \(GST\)/))            d.gst=safe(v);
    if(k.match(/^•\s*Taxes \(TCS\)/))            d.tcs=safe(v);
    if(k.match(/^•\s*Taxes \(TDS\)/))            d.tds=safe(v);
    if(k.match(/^•\s*Customer Add-ons Amount Recovery/)) d.addonsRecovery=safe(v);
    if(k.match(/^•\s*Pick and Pack/))            d.pickPack=safe(v);
    if(k.match(/^•\s*Forward Ship/))             d.fwdShipping=safe(v);
    if(k.match(/^•\s*Storage/))                  d.storage=safe(v);
    if(k.match(/Rewards & Other/))               d.rewards=safe(v);
    if(k==='Bank Settlement (Projected)')        d.bankSettlement=safe(v);
    if(k==='Input Tax Credits')                  d.itc=safe(v);
    if(k.match(/^•\s*GST.*TCS/))                d.itcGstTcs=safe(v);
    if(k.match(/^•\s*TDS/))                     d.itcTds=safe(v);
    if(k==='Earnings on Platform')               d.platformEarnings=safe(v);
    if(k==='Total Expected Bank Settlement')     d.totalExpectedSettlement=safe(v);
    if(k.startsWith('Already Paid'))             d.alreadyPaid=safe(v);
    if(k.startsWith('Pending'))                   d.pendingSettlement=safe(v);
  });
  return d;
}

function reportHeaders(rows, headerIndex){
  const primary=rows[headerIndex]||[];
  const secondary=rows[headerIndex+1]||[];
  const hasSubheaders=secondary.some(value=>
    /\b(?:rto|rvp|commission|fixed fee|shipping|taxes|transaction amount|payment date|account type|neft id)\b/i.test(safeStr(value))
  );
  return primary.map((value,index)=>
    [safeStr(value),hasSubheaders?safeStr(secondary[index]):''].filter(Boolean).join(' ')
  );
}

// ── Parse SKU-level Sheet ──────────────────────────────────
function parseSKU(rows){
  if(!rows.length) return [];
  let hi=rows.findIndex(r=>r.some(c=>safeStr(c).toLowerCase().includes('sku id')));
  if(hi<0) hi=0;
  const hdr=reportHeaders(rows,hi);
  const ci=(...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex(h=>lo.some(n=>h.toLowerCase().includes(n))); };
  const afi=(from,...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex((h,i)=>i>from&&lo.some(n=>h.toLowerCase().includes(n))); };
  const afiExact=(from,...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex((h,i)=>i>from&&lo.includes(h.trim().toLowerCase())); };

  const iSku=ci('sku id');
  const iGross=ci('gross units');
  const iRetU=ci('returned & cancelled units','returned &amp; cancelled units');
  const iRTO=afi(iRetU,'rto');
  const iRVP=afi(iRetU,'rvp');
  const iCanc=afiExact(iRetU,'cancellations','cancelled units');
  const iNet=ci('net units');
  const iNetS=ci('estimated net sales');
  const iAccNet=ci('accounted net sales');
  const iOIV=ci('sum of order item value','order item value');
  const iExp=ci('total expenses');
  const iComm=afi(iExp,'commission fee');
  const iFixed=afi(iExp,'fixed fee');
  const iPnP=afi(iExp,'pick and pack');
  const iFwdS=afi(iExp,'forward shipping');
  const iRevS=afi(iExp,'reverse shipping');
  const iAds=afi(iExp,'ads');
  const iGST=afi(iExp,'taxes (gst)');
  const iTCS=afi(iExp,'taxes (tcs)');
  const iTDS=afi(iExp,'taxes (tds)');
  const iAddonsR=afi(iExp,'customer add-ons amount recovery');
  const iBankS=ci('bank settlement');
  const iITC=ci('input tax credits');
  const iEarn=ci('net earnings','earnings per');
  const iEarnPU=ci('earnings per unit');

  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i];
    const skuId=safeStr(r[iSku]);
    if(!skuId||skuId==='0'||skuId.toLowerCase()==='sku id') continue;
    out.push({
      skuId,
      grossUnits:    safe(r[iGross]),
      returnedUnits: iRetU>=0?safe(r[iRetU]):0,
      rtoUnits:      iRTO>=0?safe(r[iRTO]):0,
      rvpUnits:      iRVP>=0?safe(r[iRVP]):0,
      cancelUnits:   iCanc>=0?safe(r[iCanc]):0,
      netUnits:      safe(r[iNet]),
      netSales:      safe(r[iNetS]),
      oiv:           iOIV>=0?safe(r[iOIV]):0,
      accNetSales:   safe(r[iAccNet]),
      totalExpenses: safe(r[iExp]),
      commissionFee: iComm>=0?safe(r[iComm]):0,
      fixedFee:      iFixed>=0?safe(r[iFixed]):0,
      pickPack:      iPnP>=0?safe(r[iPnP]):0,
      fwdShipping:   iFwdS>=0?safe(r[iFwdS]):0,
      revShipping:   iRevS>=0?safe(r[iRevS]):0,
      ads:           iAds>=0?safe(r[iAds]):0,
      gst:           iGST>=0?safe(r[iGST]):0,
      tcs:           iTCS>=0?safe(r[iTCS]):0,
      tds:           iTDS>=0?safe(r[iTDS]):0,
      addonsRecovery:iAddonsR>=0?safe(r[iAddonsR]):0,
      bankSettlement:safe(r[iBankS]),
      itc:           safe(r[iITC]),
      platformEarnings: iEarn>=0?safe(r[iEarn]):0,
      earningsPerUnit:  iEarnPU>=0?safe(r[iEarnPU]):0,
    });
  }
  return out;
}

// ── Parse Orders P&L Sheet ─────────────────────────────────
function parseOrders(rows){
  if(!rows.length) return [];
  let hi=rows.findIndex(r=>r.some(c=>safeStr(c).toLowerCase().includes('order date')));
  if(hi<0) return [];
  const hdr=reportHeaders(rows,hi).map(c=>c.toLowerCase());
  const ci=(...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex(h=>lo.some(n=>h.includes(n))); };
  const afi=(from,...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex((h,i)=>i>from&&lo.some(n=>h.includes(n))); };
  const afiExact=(from,...ns)=>{ const lo=ns.map(n=>n.toLowerCase()); return hdr.findIndex((h,i)=>i>from&&lo.includes(h.trim())); };

  const iDate=ci('order date');
  const iOid=ci('order id');
  const iIid=ci('order item id');
  const iSku=ci('sku name');
  const iCh=ci('channel');
  const iPay=ci('mode of payment');
  const iSt=ci('order status');
  const iGross=ci('gross units');
  const iRetU=ci('returned & cancelled units','returned &amp; cancelled units');
  const iNetU=ci('net units');
  const iOIV=ci('order item value');
  const iFSP=ci('final selling price');
  const iNetS=ci('estimated net sales');
  const iAccNet=ci('accounted net sales');
  // Breakup columns under accounted net sales
  const iGrossSale=afi(iAccNet,'gross sale value');
  const iSellerDisc=afi(iAccNet,'seller-funded discount');
  const iCustAddon=afi(iAccNet,'customer add-ons amount');
  const iTotalCustDisc=afi(iAccNet,'total customer discount');
  const iOfferIds=ci('offer id');
  const iExp=ci('total expenses');
  const iComm=afi(iExp,'commission fee');
  const iFixed=afi(iExp,'fixed fee');
  const iPickPack=afi(iExp,'pick and pack');
  const iFwdS=afi(iExp,'forward shipping');
  const iRevS=afi(iExp,'reverse shipping');
  const iAds=hdr.findIndex((header,index)=>index>iExp&&/\bads\b/i.test(header)&&!/\bgoogle\s+ads\b/i.test(header));
  const iGoogleAds=afi(iExp,'google ads');
  const iStorage=afi(iExp,'storage');
  const iGST=afi(iExp,'taxes (gst)');
  const iTCS=afi(iExp,'taxes (tcs)');
  const iTDS=afi(iExp,'taxes (tds)');
  const iAddonsR=afi(iExp,'customer add-ons amount recovery');
  const iBankS=ci('bank settlement');
  const iRTO=afi(iRetU,'rto');
  const iRVP=afi(iRetU,'rvp');
  const iCanc=afiExact(iRetU,'cancellations','cancelled units');

  // Transaction columns (for settlement tab)
  const iTxnAmt1=afi(iBankS,'transaction amount');
  const iTxnReason1=afi(iTxnAmt1,'reason');
  const iTxnStatus1=afi(iTxnReason1,'current status');
  const iTxnDate1=afi(iTxnStatus1,'payment date');
  const iTxnAccType1=afi(iTxnDate1,'account type');
  const iTxnNeft1=afi(iTxnAccType1,'neft id');

  const out=[];
  for(let i=hi+1;i<rows.length;i++){
    const r=rows[i];
    const orderId=safeStr(r[iOid]);
    if(!orderId||orderId==='0') continue;
    const skuName=safeStr(r[iSku]);
    if(!skuName) continue;
    const status=safeStr(r[iSt]).toUpperCase();
    const grossSaleVal = iGrossSale>=0 ? safe(r[iGrossSale]) : safe(r[iAccNet]);
    const sellerDisc   = iSellerDisc>=0 ? safe(r[iSellerDisc]) : 0;
    const custAddon    = iCustAddon>=0 ? safe(r[iCustAddon]) : 0;
    const totalCustDisc= iTotalCustDisc>=0 ? safe(r[iTotalCustDisc]) : 0;
    const offerIds     = iOfferIds>=0 ? safeStr(r[iOfferIds]) : '';
    out.push({
      date:        safeStr(r[iDate]),
      orderId,
      itemId:      safeStr(r[iIid]),
      sku:         skuName,
      channel:     safeStr(r[iCh]),
      payment:     safeStr(r[iPay]),
      status,
      grossUnits:  safe(r[iGross]),
      retUnits:    iRetU>=0?safe(r[iRetU]):0,
      rtoUnits:    iRTO>=0?safe(r[iRTO]):0,
      rvpUnits:    iRVP>=0?safe(r[iRVP]):0,
      cancelUnits: iCanc>=0?safe(r[iCanc]):0,
      netUnits:    safe(r[iNetU]),
      oiv:         safe(r[iOIV]),
      fsp:         safe(r[iFSP]),
      netSales:    safe(r[iNetS]),
      accNetSales: safe(r[iAccNet]),
      grossSaleVal, sellerDisc, custAddon, totalCustDisc, offerIds,
      expenses:    safe(r[iExp]),
      financialFieldsPresent:{
        grossSaleVal:iGrossSale>=0,
        sellerDisc:iSellerDisc>=0,
        totalCustDisc:iTotalCustDisc>=0,
        custAddon:iCustAddon>=0,
        orderItemValue:iOIV>=0,
        finalSellingPrice:iFSP>=0,
        accountedNetSales:iAccNet>=0,
        expenses:iExp>=0,
        commissionFee:iComm>=0,
        fixedFee:iFixed>=0,
        pickPack:iPickPack>=0,
        fwdShipping:iFwdS>=0,
        revShipping:iRevS>=0,
        ads:iAds>=0,
        googleAds:iGoogleAds>=0,
        storage:iStorage>=0,
        gst:iGST>=0,
        tcs:iTCS>=0,
        tds:iTDS>=0,
        addonsRecovery:iAddonsR>=0,
        bankSettlement:iBankS>=0,
        settlementTransaction1:iTxnAmt1>=0,
      },
      commissionFee: iComm>=0?safe(r[iComm]):0,
      fixedFee:    iFixed>=0?safe(r[iFixed]):0,
      pickPack:    iPickPack>=0?safe(r[iPickPack]):0,
      fwdShipping: iFwdS>=0?safe(r[iFwdS]):0,
      revShipping: iRevS>=0?safe(r[iRevS]):0,
      ads:         iAds>=0?safe(r[iAds]):0,
      googleAds:   iGoogleAds>=0?safe(r[iGoogleAds]):0,
      storage:     iStorage>=0?safe(r[iStorage]):0,
      addonsRecovery: iAddonsR>=0?safe(r[iAddonsR]):0,
      gst:         iGST>=0?safe(r[iGST]):0,
      tcs:         iTCS>=0?safe(r[iTCS]):0,
      tds:         iTDS>=0?safe(r[iTDS]):0,
      bankSettlement: safe(r[iBankS]),
      // Transaction 1
      txn1Amt:    iTxnAmt1>=0?safe(r[iTxnAmt1]):0,
      txn1Reason: iTxnReason1>=0?safeStr(r[iTxnReason1]):'',
      txn1Status: iTxnStatus1>=0?safeStr(r[iTxnStatus1]):'',
      txn1Date:   iTxnDate1>=0?safeStr(r[iTxnDate1]):'',
      txn1Type:   iTxnAccType1>=0?safeStr(r[iTxnAccType1]):'',
      txn1Neft:   iTxnNeft1>=0?safeStr(r[iTxnNeft1]):'',
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════
// INIT / COST SCREEN
// ═══════════════════════════════════════════════════════════
function initCosts(){
  S.skuRows.forEach(s=>{
    if(!S.costs[s.skuId]) S.costs[s.skuId]={...DEFAULT_COSTS};
  });
}

function updateHeaderMeta(){
  const sd=S.summary||{};
  if(sd.period){
    $('metaPeriod').textContent='📅 '+sd.period;
    $('metaGenerated').textContent='🗓 '+safeStr(sd.generated);
    show('reportMeta');
  }
  show('btnSaveSession'); show('btnExportAll'); show('btnAiSummary');
  if(S.reports.length&&$('dashScreen')?.style.display!=='none') show('btnAddReports');
  else hide('btnAddReports');
}

function showCostScreen(){
  hide('uploadScreen'); hide('dashScreen'); show('costScreen');
  buildCostTable();
}

function buildCostTable(tbodyId='costTableBody'){
  const tbody=$(tbodyId);
  if(!tbody) return;
  const dashboardTable=tbodyId==='costTableDashBody';
  const skuMetrics=dashboardTable
    ? new Map(computeSKU().map(row=>[row.skuId,row]))
    : null;
  tbody.innerHTML='';
  S.skuRows.forEach(s=>{
    const c=S.costs[s.skuId]||DEFAULT_COSTS;
    const avgFSP  = s.grossUnits>0 ? (s.oiv/s.grossUnits).toFixed(2) : 0;
    const avgNetS = s.netUnits>0   ? (s.accNetSales/s.netUnits).toFixed(2) : 0;
    const cogs    = c.product+c.packing+(c.other||0);
    const totalCogs=cogs*s.netUnits;
    const grossM  = parseFloat(avgNetS)>0 ? ((parseFloat(avgNetS)-cogs)/parseFloat(avgNetS)*100).toFixed(1) : 0;
    const mClass  = grossM>=30?'good':grossM>=15?'warn':'bad';
    const tr=document.createElement('tr');
    const skuCell=document.createElement('td');
    const skuLabel=document.createElement('strong');
    skuLabel.textContent=s.skuId;
    skuCell.appendChild(skuLabel);
    tr.appendChild(skuCell);
    const appendCell=(value,className='num')=>{
      const cell=document.createElement('td');
      cell.className=className;
      cell.textContent=value;
      tr.appendChild(cell);
    };
    const appendCostInput=(type,value,label)=>{
      const cell=document.createElement('td');
      const input=document.createElement('input');
      input.className='cost-input';
      input.type='number';
      input.min='0';
      input.step='0.01';
      input.value=String(value);
      input.dataset.sku=s.skuId;
      input.dataset.type=type;
      input.setAttribute('aria-label',`${label} for ${s.skuId}`);
      cell.appendChild(input);
      tr.appendChild(cell);
    };
    const appendCogsCell=(value,id)=>{
      const cell=document.createElement('td');
      const badge=document.createElement('span');
      badge.className='cogs-badge';
      badge.id=id;
      badge.textContent=fmt(value);
      cell.appendChild(badge);
      tr.appendChild(cell);
    };
    if(dashboardTable){
      appendCell(fmtN(s.netUnits));
      appendCell(`₹${avgFSP}`);
      appendCostInput('product',c.product,'Your product cost per unit');
      appendCostInput('packing',c.packing,'Your packing cost per unit');
      appendCostInput('other',c.other||0,'Your other cost per unit');
      appendCogsCell(cogs,`cogs_${tbodyId}_${s.skuId}`);
      appendCell(fmt(totalCogs));
      appendCell(fmt(s.bankSettlement));
      appendCell(fmt(s.pickPack));
      const metric=skuMetrics.get(s.skuId);
      const profitCell=document.createElement('td');
      profitCell.className=`num ${metric?.trueProfit>=0?'pos':'neg'}`;
      profitCell.textContent=fmt(metric?.trueProfit);
      tr.appendChild(profitCell);
    }else{
      appendCell(fmtN(s.grossUnits));
      appendCell(fmtN(s.netUnits));
      appendCell(`₹${avgFSP}`);
      appendCell(`₹${avgNetS}`);
      appendCostInput('product',c.product,'Your product cost per unit');
      appendCostInput('packing',c.packing,'Your packing cost per unit');
      appendCostInput('other',c.other||0,'Your other cost per unit');
      appendCogsCell(cogs,`cogs_${tbodyId}_${s.skuId}`);
      appendCell(fmt(s.pickPack));
      const marginCell=document.createElement('td');
      const marginBadge=document.createElement('span');
      marginBadge.className=`margin-preview ${mClass}`;
      marginBadge.id=`mgn_${tbodyId}_${s.skuId}`;
      marginBadge.textContent=`${grossM}%`;
      marginCell.appendChild(marginBadge);
      tr.appendChild(marginCell);
    }
    tbody.appendChild(tr);
  });
  tbody.querySelectorAll('.cost-input').forEach(inp=>{
    inp.addEventListener('input',()=>{
      const sku=inp.dataset.sku, type=inp.dataset.type;
      if(!S.costs[sku]) S.costs[sku]={...DEFAULT_COSTS};
      const amount=Number(inp.value);
      S.costs[sku][type]=Number.isFinite(amount)&&amount>=0?amount:0;
      if(amount<0) inp.value='0';
      const c=S.costs[sku];
      const cogs=c.product+c.packing+(c.other||0);
      // update cogs badge in this table
      const b=document.getElementById(`cogs_${tbodyId}_${sku}`);
      if(b) b.textContent='₹'+cogs.toFixed(2);
      // update margin preview — find avgNetS from sku row
      const sr=S.skuRows.find(x=>x.skuId===sku);
      if(sr){
        const avgNetS=sr.netUnits>0?(sr.accNetSales/sr.netUnits):0;
        const gm=avgNetS>0?((avgNetS-cogs)/avgNetS*100).toFixed(1):0;
        const mc=gm>=30?'good':gm>=15?'warn':'bad';
        const mg=document.getElementById(`mgn_${tbodyId}_${sku}`);
        if(mg){mg.textContent=gm+'%'; mg.className='margin-preview '+mc;}
      }
      scheduleSaveSession();
    });
  });
}

$('resetCosts')?.addEventListener('click',()=>{
  S.skuRows.forEach(s=>{ S.costs[s.skuId]={...DEFAULT_COSTS}; });
  buildCostTable();
  saveSession();
});

$('analyzBtn')?.addEventListener('click',()=>{
  readCostInputs('costTableBody');
  hide('costScreen'); show('dashScreen');
 updateHeaderMeta();
 buildDashboard();
 saveSession();
});

$('uploadNewBtn')?.addEventListener('click',()=>{
  hide('dashScreen'); show('uploadScreen');
  $('fileInput').value='';
  Object.keys(S.charts).forEach(destroyChart);
});

$('refreshDash')?.addEventListener('click',()=>{
  readCostInputs('costTableDashBody');
  Object.keys(S.charts).forEach(destroyChart);
  buildDashboard();
  saveSession();
  switchTab(S.activeTab);
});

function readCostInputs(tbodyId){
  document.querySelectorAll(`#${tbodyId} .cost-input`).forEach(inp=>{
    const sku=inp.dataset.sku;
    const type=inp.dataset.type;
    if(!S.costs[sku]) S.costs[sku]={...DEFAULT_COSTS};
    const amount=Number(inp.value);
    S.costs[sku][type]=Number.isFinite(amount)&&amount>=0?amount:0;
    if(amount<0) inp.value='0';
  });
}

// CSV import/export for costs
$('btnExportCostsCsv')?.addEventListener('click',()=>exportCostsCSV());
$('btnExportCostsCsv2')?.addEventListener('click',()=>exportCostsCSV());
$('btnImportCosts')?.addEventListener('click',()=>$('costsImportFile')?.click());
$('costsImportFile')?.addEventListener('change', e=>{
  importCostsCSV(e.target.files[0]);
  e.target.value='';
});

function csvCell(value){
  return `"${String(value??'').replace(/"/g,'""')}"`;
}

function parseCSVLine(line){
  const cells=[];
  let cell='', quoted=false;
  for(let i=0;i<line.length;i++){
    const char=line[i];
    if(char==='"'){
      if(quoted&&line[i+1]==='"'){ cell+='"'; i++; }
      else quoted=!quoted;
    }else if(char===','&&!quoted){
      cells.push(cell);
      cell='';
    }else{
      cell+=char;
    }
  }
  if(quoted) throw new Error('A CSV field has an unmatched quote.');
  cells.push(cell);
  return cells;
}

function exportCostsCSV(){
  const rows=['SKU,Product Cost,Packing Cost,Other Cost'];
  S.skuRows.forEach(s=>{
    const c=S.costs[s.skuId]||{};
    rows.push([s.skuId,c.product||0,c.packing||0,c.other||0].map(csvCell).join(','));
  });
  downloadText(rows.join('\r\n'),'cladus_costs.csv','text/csv');
}

function importCostsCSV(file){
  if(!file) return;
  const r=new FileReader();
  r.onload=ev=>{
    try{
      const lines=String(ev.target.result||'').split(/\r?\n/).filter(line=>line.trim());
      if(lines.length<2) throw new Error('The CSV does not contain any cost rows.');
      let imported=0, skipped=0;
      lines.slice(1).forEach(line=>{
        const [rawSku,...values]=parseCSVLine(line);
        const sku=rawSku?.trim();
        const amounts=values.slice(0,3).map(value=>Number(value.trim()));
        if(!sku||amounts.length!==3||amounts.some(value=>!Number.isFinite(value)||value<0)){
          skipped++;
          return;
        }
        S.costs[sku]={product:amounts[0],packing:amounts[1],other:amounts[2]};
        imported++;
      });
      if(!imported) throw new Error('No valid cost rows were found.');
      buildCostTable(); buildCostTable('costTableDashBody');
      saveSession();
      alert(`Imported ${imported} cost row(s).${skipped?` Skipped ${skipped} invalid row(s).`:''}`);
    }catch(error){
      alert(`Could not import costs: ${error.message}`);
    }
  };
  r.onerror=()=>alert('Unable to read the cost CSV file.');
  r.readAsText(file);
}

// ═══════════════════════════════════════════════════════════
// TAB NAVIGATION
// ═══════════════════════════════════════════════════════════
document.querySelectorAll('.tab-btn[data-tab]').forEach(btn=>{
  btn.addEventListener('click',()=>switchTab(btn.dataset.tab));
});

function switchTab(name){
  if(!$(`tab-${name}`)) return;
  S.activeTab=name;
  document.querySelectorAll('.tab-btn').forEach(b=>b.classList.remove('active'));
  const btn=document.querySelector(`.tab-btn[data-tab="${name}"]`);
  if(btn) btn.classList.add('active');
  document.querySelectorAll('.tab-content').forEach(tc=>tc.style.display='none');
  const tc=$('tab-'+name);
  if(tc) tc.style.display='';
  if(S.orders.length) scheduleSaveSession();
}

// ═══════════════════════════════════════════════════════════
// COMPUTED SKU METRICS
// ═══════════════════════════════════════════════════════════
function computeSKU(){
  const skuExpenseTotal=S.skuRows.reduce((total,row)=>total+safe(row.totalExpenses),0);
  const skuSettlementTotal=S.skuRows.reduce((total,row)=>total+safe(row.bankSettlement),0);
  const sharedExpense=safe(S.summary?.totalExpenses)-skuExpenseTotal;
  const settlementAdjustment=safe(S.summary?.bankSettlement)-skuSettlementTotal-sharedExpense;
  const totalAccountedSales=S.skuRows.reduce((total,row)=>total+safe(row.accNetSales),0);
  return S.skuRows.map(s=>{
    const c=S.costs[s.skuId]||DEFAULT_COSTS;
    const cogsUnit = c.product+c.packing+(c.other||0);
    const totalCogs = cogsUnit * s.netUnits;
    const sharedExpenseAllocation=totalAccountedSales>0
      ? sharedExpense*(s.accNetSales/totalAccountedSales) : 0;
    const settlementAdjustmentAllocation=totalAccountedSales>0
      ? settlementAdjustment*(s.accNetSales/totalAccountedSales) : 0;
    const trueProfit = s.bankSettlement - totalCogs + sharedExpenseAllocation + settlementAdjustmentAllocation;
    const margin = s.accNetSales>0 ? (trueProfit/s.accNetSales)*100 : 0;
    const returnRate = s.grossUnits>0 ? ((s.grossUnits-s.netUnits)/s.grossUnits)*100 : 0;
    const returnedUnits = s.grossUnits - s.netUnits;
    // Avg return cost per returned unit (reverse shipping / returned units)
    const avgRetCost = returnedUnits>0 ? Math.abs(s.revShipping)/returnedUnits : 0;
    // Seller discount from order data for this SKU
    const skuOrders = S.orders.filter(o=>o.sku===s.skuId);
    const totalSellerDisc = skuOrders.reduce((a,o)=>a+Math.abs(o.sellerDisc||0),0);
    const avgFSP = s.grossUnits>0 ? s.oiv/s.grossUnits : 0;
    const discRate = (avgFSP*s.netUnits)>0 ? (totalSellerDisc/(avgFSP*s.netUnits))*100 : 0;
    const totalTaxes = Math.abs(s.gst)+Math.abs(s.tcs)+Math.abs(s.tds);
    const feeRate = s.accNetSales>0
      ? (Math.abs(s.totalExpenses+sharedExpenseAllocation)/s.accNetSales)*100 : 0;
    return {
      ...s,
      totalExpenses:safe(s.totalExpenses)+sharedExpenseAllocation,
      cogsUnit, totalCogs, trueProfit, margin, returnRate,
      avgRetCost, totalSellerDisc, discRate, totalTaxes, feeRate,
      sharedExpenseAllocation, settlementAdjustmentAllocation,
      returnedUnits,
    };
  });
}

function orderTrueProfit(o){
  const c=S.costs[o.sku]||DEFAULT_COSTS;
  const cogs=(c.product+c.packing+(c.other||0))*safe(o.netUnits);
  return safe(o.bankSettlement)-cogs+safe(o.sharedExpenseAllocation)+safe(o.settlementAdjustment);
}

function calculateCogsBreakdown(skuRows){
  return skuRows.reduce((totals,row)=>{
    const units=safe(row.netUnits);
    const costs=S.costs[row.skuId]||DEFAULT_COSTS;
    totals.product+=costs.product*units;
    totals.packing+=costs.packing*units;
    totals.other+=(costs.other||0)*units;
    return totals;
  },{product:0,packing:0,other:0});
}

// ═══════════════════════════════════════════════════════════
// BUILD DASHBOARD (entry)
// ═══════════════════════════════════════════════════════════
function buildDashboard(){
  const sd=S.summary||{};
  const skuM=computeSKU();
  chartTooltipSkuMetrics=skuM;
  chartCalculationTooltipCache.clear();
  const totalCogs=skuM.reduce((a,m)=>a+m.totalCogs,0);
  const trueProfit=(sd.bankSettlement||0)-totalCogs;
  const trueMargin=sd.accountedNetSales?(trueProfit/sd.accountedNetSales)*100:0;
  const returnRate=sd.grossUnits?((sd.grossUnits-sd.netUnits)/sd.grossUnits)*100:0;

  buildOverview(sd,skuM,totalCogs,trueProfit,trueMargin,returnRate);
  buildWaterfall(sd,skuM,trueProfit);
  buildSKUTab(skuM);
  buildOrdersTab();
  buildReturnsTab(sd,skuM);
  buildDiscountsTab(sd,skuM);
  buildExpensesTab(sd,skuM);
  buildSettlementsTab();
  buildInsightsTab(sd,skuM,trueProfit,trueMargin,returnRate,totalCogs);
  buildEditCostsTab(skuM);
  attachChartCalculationHelp();
  show('btnCalculationGuide');
}

// ─── Chart helpers ─────────────────────────────────────────
const CHART_CALCULATION_NOTES=Object.freeze({
  revenueChart:'Compares report totals and calculated cost/profit: Gross Sales, absolute Returns, Accounted Net Sales, absolute Platform Expenses, absolute Seller Discount, total COGS, Bank Settlement, and True Profit. True Profit = Bank Settlement − total COGS. These are comparison bars, not a cumulative waterfall.',
  statusChart:'Counts order rows by their parsed status. Each order row contributes 1, regardless of its units. Percentages, if shown by the chart, are each status count ÷ all order rows.',
  dailyChart:'Groups orders by order date. Revenue = sum of Accounted Net Sales per date; Orders = number of rows; Delivered = rows whose status is DELIVERED; Returns = rows whose status contains RETURN. Revenue and order counts use separate axes.',
  channelChart:'Groups orders by sales channel and sums Accounted Net Sales for each channel. Missing channel values are grouped as “?”.',
  paymentChart:'Counts order rows by payment mode after uppercasing the mode. It is an order count, not a rupee total.',
  weeklyChart:'Groups dated order rows into calendar week labels. Revenue = sum of Accounted Net Sales; Orders = number of rows in each week. The two measures use separate axes.',
  waterfallChart:'Uses the uploaded summary amounts for each P&L line. True Net Profit = Bank Settlement − Total COGS. COGS is itemized as net units × product cost, packing cost, and other cost. It displays the selected line amounts; it does not cumulatively stack every bar.',
  deductionPieChart:'Shows absolute amounts for Returns, Reverse Shipping, Seller Discount, Ads, GST, TCS+TDS, Fixed Fee, and itemized product, packaging, and other COGS. Zero amounts are omitted. Each slice share = slice amount ÷ sum of displayed slices; categories are not the complete list of all possible deductions.',
  skuContribChart:'For each SKU, plots max(0, Accounted Net Sales). Negative SKU values are clipped to zero for this contribution chart. Slice share is based on the sum of the displayed non-negative SKU sales.',
  skuEarningsChart:'For each SKU: Bank Settlement is from the report; COGS = net units × (product + packing + other cost); True Profit = SKU settlement − COGS + allocated shared expenses + allocated settlement adjustment. Shared amounts are allocated by the SKU share of Accounted Net Sales.',
  skuReturnChart:'Return Rate % per SKU = (Gross Units − Net Units) ÷ Gross Units × 100. If Gross Units is zero, the rate is zero. This includes the report’s combined returned/cancelled unit difference.',
  skuMarginChart:'Margin % per SKU = SKU True Profit ÷ SKU Accounted Net Sales × 100. True Profit includes COGS and allocated shared amounts. If Accounted Net Sales is zero, the margin is zero.',
  skuReturnCostChart:'Average return cost per unit for each SKU = absolute reverse-shipping amount for that SKU ÷ (Gross Units − Net Units). If returned units are zero, the result is zero. This measure is shipping-only.',
  skuDiscountChart:'For each SKU, adds the absolute seller-funded discount from its order rows. A chart value is a rupee total, not a per-order average.',
  skuFeeRateChart:'Platform fee rate % per SKU = absolute SKU expenses including allocated shared expenses ÷ SKU Accounted Net Sales × 100. A zero sales denominator produces zero.',
  returnTypeChart:'Counts returned units by RTO, RVP, and Cancelled using the parsed unit columns. Each slice is units, not number of orders.',
  skuReturnUnitsChart:'For each SKU, stacks the parsed RTO units, RVP units, and cancellation units. These are unit counts from the report.',
  returnCostChart:'RTO loss = RTO units × ₹5 packing. RVP loss = negative RVP settlement (floored at zero) + RVP product cost for orders whose toggle is on + RVP units × ₹5 packing. Cancellation loss = cancellation units × ₹5. This chart includes all three totals.',
  dailyReturnChart:'Groups rows by order date. Returns/Cancels = sum of RTO + RVP + cancellation units for rows with any return/cancel units; Delivered = count of delivered rows with no return/cancel units.',
  discSkuChart:'For each SKU, sums the absolute seller discount recorded on its orders. Values are rupees.',
  discRateChart:'For each SKU: seller discount rate % = total absolute seller discount ÷ (average FSP × net units) × 100. The chart rounds the displayed rate to one decimal place; a zero denominator gives zero.',
  discDailyChart:'Groups order rows by date and sums the absolute seller discount amount. Values are daily rupee totals.',
  offerFreqChart:'Splits each row’s offer IDs by comma, trims each ID, ignores blank IDs and IDs shorter than 3 characters, then counts each remaining ID occurrence. Only the 15 most frequent are plotted.',
  expenseBreakChart:'Combines itemized Excel platform expenses with editable seller COGS. Product, packaging, and other COGS = SKU net units × each SKU’s unit cost. Platform reconciliation differences are shown separately; customer-paid estimates are excluded.',
  deliverySettlementChart:'Uses DELIVERED order rows with positive net units, grouped by order ID. Average selling price per unit = total Final Selling Price ÷ total delivered net units; Order Item Value is used only when Final Selling Price is unavailable. The per-order settlement gap = Order Item Value − Bank Settlement and includes all settlement deductions, not only delivery/shipping.',
  customerServiceFeeChart:'Illustrative customer-paid service-fee scenario: unique order IDs × the editable low/high fee per order. Defaults are ₹5 and ₹10. These fees are not read from the workbook and are excluded from seller expenses, settlement, and profit.',
  taxChart:'Shows the absolute GST, TCS, and TDS values from the uploaded summary. Slice share is each tax amount ÷ the sum of the three displayed tax amounts.',
  skuExpBurdenChart:'For each SKU: absolute expenses including allocated shared expenses ÷ Accounted Net Sales × 100. If sales are zero, the plotted fee rate is zero.',
  dailyExpenseChart:'Groups orders by date and sums platform expenses (including allocated shared expenses) plus order-level product, packaging, and other COGS. Return-specific packing loss is displayed separately on the Returns tab.',
  settleTimelineChart:'Groups order transaction 1 by NEFT/batch ID, sums its transaction amounts, then groups batch totals by settlement date. The line is cumulative total through each date; bars are each date’s batch total.',
  settleBatchChart:'Groups transaction 1 amounts by NEFT/batch ID, ranks batches by absolute total, and plots up to the 12 largest. Labels use batch date or the last 10 characters of the NEFT ID.',
  settleTypeChart:'Groups transaction 1 batches by transaction type and sums the absolute batch total for each type. Slice share is based on the displayed type totals.',
});

const CORE_CALCULATION_GUIDE=[
  ['Sales and settlement inputs','Gross sales, accounted net sales, fees, taxes, shipping, discounts, and bank settlement are read from the selected Flipkart report. The dashboard aggregates and labels those report values; it does not independently verify them against Flipkart.'],
  ['COGS and true profit','SKU COGS = net units × (your product cost + packing cost + other cost). The P&L waterfall and deduction ledger show these three COGS components separately; Packaging Cost is net units × your editable per-SKU packing cost and is already included in Total COGS. Dashboard True Net Profit = Bank Settlement − Total COGS. SKU-level profit additionally includes allocated shared expenses and settlement adjustments.'],
  ['Return losses','RTO loss = ₹5 packing × RTO units; item cost is not treated as lost because it returns to inventory. Cancellation loss = ₹5 × cancelled units. RVP loss = max(0, −RVP bank settlement) + product cost for RVP orders whose “Count Product Cost as Loss?” switch is enabled + ₹5 × RVP units.'],
  ['RVP product-loss controls','The master switch applies the product-cost-loss setting to every RVP order in the selected report view; each order can then be adjusted independently. RVP total loss = negative settlement loss + enabled product cost + ₹5 packing per RVP unit. The displayed amounts recalculate and are saved with the order settings.'],
  ['Resalable product toggle','When an order-level switch is off, that order’s product cost is excluded from RVP loss as resalable inventory; settlement and packing loss remain unchanged. The master switch sets the same choice across all RVP orders in the selected report view.'],
  ['Return averages and recovery','Average RVP reverse shipping per order = absolute report reverse-shipping total ÷ number of RVP order rows. Average return shipping per unit on the SKU chart = absolute SKU reverse shipping ÷ (gross units − net units). RVP recovery per successful unit = total RVP loss ÷ successful/net units. A zero denominator yields zero.'],
  ['Percentages and safeguards','A rate is numerator ÷ denominator × 100. Where a denominator is zero, the dashboard displays zero instead of dividing by zero. Chart totals may use absolute values, clipping, rounding, date grouping, or top-N filtering as described in each chart’s “ⓘ” hover note.'],
  ['Privacy and scope','Analysis runs in this browser from the workbook you choose. Chart hover notes explain the exact aggregation and exclusions used. A report value is not a guarantee of settlement or accounting advice; compare important results with the original Flipkart statement.'],
];

function attachChartCalculationHelp(){
  document.querySelectorAll('#dashScreen canvas[id]').forEach(canvas=>{
    const note=CHART_CALCULATION_NOTES[canvas.id];
    const header=canvas.closest('.chart-card')?.querySelector('.chart-header');
    if(!note||!header||header.querySelector('.chart-help')) return;
    const help=document.createElement('button');
    help.type='button';
    help.className='chart-help';
    help.setAttribute('aria-label',`Calculation details for ${header.querySelector('h3')?.textContent||'chart'}`);
    help.setAttribute('aria-expanded','false');
    help.textContent='i';
    const tooltip=document.createElement('span');
    tooltip.className='chart-help-tooltip';
    tooltip.setAttribute('role','tooltip');
    tooltip.textContent=note;
    help.append(tooltip);
    help.addEventListener('focus',()=>help.setAttribute('aria-expanded','true'));
    help.addEventListener('blur',()=>help.setAttribute('aria-expanded','false'));
    header.append(help);
  });
}

let chartTooltipSkuMetrics=[];
const chartCalculationTooltipCache=new Map();

function chartCalculationTooltip(context){
  const key=`${context.chart.canvas.id}:${context.datasetIndex}:${context.dataIndex}`;
  if(!chartCalculationTooltipCache.has(key)){
    chartCalculationTooltipCache.set(key,calculateChartTooltipLines(context));
  }
  return chartCalculationTooltipCache.get(key);
}

function chartOrderBreakdown(rows,{title,total,contribution,format=fmt,detail,countLabel='Excel order rows'}){
  const entries=rows.map((order,index)=>({
    order,
    value:Number(contribution(order))||0,
    id:safeStr(order.orderId)||`Excel row ${index+1}`,
  }));
  const shown=entries.slice(0,6);
  const lines=[`${title}: ${fmtN(entries.length)} ${countLabel}; total = ${format(total)}.`];
  shown.forEach(({order,value,id})=>{
    const description=detail?detail(order,value):format(value);
    lines.push(`${id} · ${order.sku||'SKU unavailable'} · ${description}`);
  });
  if(entries.length>shown.length){
    const remainder=entries.slice(shown.length).reduce((sum,entry)=>sum+entry.value,0);
    lines.push(`+ ${fmtN(entries.length-shown.length)} more order IDs · remaining subtotal = ${format(remainder)}.`);
  }
  if(!entries.length) lines.push('No matching order IDs in the Orders sheet.');
  return lines;
}

function chartSourceOrderBreakdown(sourceLabel,sourceAmount,rows,contribution,detail){
  const entries=rows.map(order=>({order,value:Number(contribution(order))||0}));
  const sourceTotal=Math.abs(Number(sourceAmount)||0);
  const orderTotal=entries.reduce((sum,entry)=>sum+Math.abs(entry.value),0);
  const reconciles=Math.abs(orderTotal-sourceTotal)<0.01;
  const lines=[`${sourceLabel} = ${fmt(sourceTotal)} (chart source).`];
  if(!entries.length){
    lines.push('No order-level IDs are available for this source value.');
    return lines;
  }
  lines.push(`Orders-sheet reference: ${fmtN(entries.length)} rows · Σ absolute values ${fmt(orderTotal)} · ${reconciles?'matches the chart source.':'does not reconcile to the source; IDs below are references, not source rows.'}`);
  entries.slice(0,6).forEach(({order,value})=>{
    lines.push(`${safeStr(order.orderId)} · ${order.sku||'SKU unavailable'} · ${detail?detail(order,value):fmt(value)}`);
  });
  if(entries.length>6){
    const remainder=entries.slice(6).reduce((sum,entry)=>sum+Math.abs(entry.value),0);
    lines.push(`+ ${fmtN(entries.length-6)} more order IDs · reference subtotal ${fmt(remainder)}.`);
  }
  return lines;
}

function chartSummaryMetric(summaryField,orderField){
  const sourceValue=safe(S.summary?.[summaryField]);
  const rows=orderField?S.orders.filter(order=>safe(order[orderField])!==0):[];
  return chartSourceOrderBreakdown(
    `Summary.${summaryField}`,
    sourceValue,
    rows,
    order=>safe(order[orderField]),
    order=>`${orderField} ${fmt(order[orderField])}`,
  );
}

function chartReturnUnitReferences(){
  const rows=S.orders.filter(order=>safe(order.rtoUnits)+safe(order.rvpUnits)+safe(order.cancelUnits)>0);
  const units=rows.reduce((sum,order)=>sum+safe(order.rtoUnits)+safe(order.rvpUnits)+safe(order.cancelUnits),0);
  const lines=[`Orders-sheet references: ${fmtN(rows.length)} return/cancel order rows · ${fmtN(units)} units. These units do not itemize the Summary-sheet return amount.`];
  rows.slice(0,6).forEach(order=>{
    lines.push(`${safeStr(order.orderId)} · ${order.sku} · RTO ${fmtN(order.rtoUnits)} + RVP ${fmtN(order.rvpUnits)} + cancel ${fmtN(order.cancelUnits)} units`);
  });
  if(rows.length>6) lines.push(`+ ${fmtN(rows.length-6)} more order IDs · included in unit count.`);
  return lines;
}

function calculateChartTooltipLines(context){
  const chartId=context.chart.canvas.id;
  const index=context.dataIndex;
  const datasetIndex=context.datasetIndex;
  const label=String(context.label??context.chart.data.labels?.[index]??'');
  const datasetLabel=context.chart.data.datasets?.[datasetIndex]?.label||'';
  const value=Number(context.raw??context.parsed?.y??context.parsed??0)||0;
  const amount=fmt(value);
  const count=fmtN(value);
  const note=(text)=>[text];
  const source=CHART_CALCULATION_NOTES[chartId]||'';
  const sd=S.summary||{};
  const skuRows=chartTooltipSkuMetrics;
  const sku=skuRows.find(row=>row.skuId===label);
  const ordersForSku=S.orders.filter(order=>order.sku===label);
  const ordersForDate=S.orders.filter(order=>(order.date||'').slice(5,10)===label);

  switch(chartId){
    case 'revenueChart': {
      const inputs={
        'Gross Sales':['grossSales','grossSaleVal'],
        'Net Sales':['accountedNetSales','accNetSales'],
        'Platform Exp.':['totalExpenses','expenses'],
        'Seller Disc.':['sellerDiscount','sellerDisc'],
        'Bank Settle.':['bankSettlement','bankSettlement'],
      };
      if(label==='Returns') return [`Summary.returnsCancelAmt = ${fmt(Math.abs(sd.returnsCancelAmt||0))} (chart source).`,...chartReturnUnitReferences()];
      if(inputs[label]) return chartSummaryMetric(...inputs[label]);
      if(label==='COGS'){
        const total=skuRows.reduce((sum,row)=>sum+row.totalCogs,0);
        return [`Σ SKU COGS = ${fmt(total)}.`,...skuRows.slice(0,6).map(row=>`${row.skuId} · ${fmtN(row.netUnits)} net units × ${fmt(row.cogsUnit)} unit cost = ${fmt(row.totalCogs)}.`),...(skuRows.length>6?[`+ ${fmtN(skuRows.length-6)} more SKUs.`]:[])];
      }
      if(label==='True Profit') return [`Summary.bankSettlement ${fmt(sd.bankSettlement)} − Σ SKU COGS ${fmt(skuRows.reduce((sum,row)=>sum+row.totalCogs,0))} = ${amount}.`];
      return note(`Uploaded report value = ${amount}.`);
    }
    case 'statusChart': {
      const matching=S.orders.filter(order=>order.status===label);
      return chartOrderBreakdown(matching,{
        title:`${label} status count`,
        total:matching.length,
        contribution:()=>1,
        format:fmtN,
        detail:()=>`1 order row · status ${label}`,
      });
    }
    case 'dailyChart': {
      const matching=ordersForDate;
      if(datasetLabel==='Revenue ₹'){
        const total=matching.reduce((sum,order)=>sum+safe(order.accNetSales),0);
        return chartOrderBreakdown(matching,{title:`${label} · Accounted Net Sales`,total,contribution:order=>safe(order.accNetSales),detail:order=>`Accounted Net Sales ${fmt(order.accNetSales)}`});
      }
      const selected=datasetLabel==='Orders'?matching:matching.filter(order=>datasetLabel==='Delivered'?order.status==='DELIVERED':order.status.includes('RETURN'));
      return chartOrderBreakdown(selected,{title:`${label} · ${datasetLabel}`,total:selected.length,contribution:()=>1,format:fmtN,detail:order=>`1 row · status ${order.status}`});
    }
    case 'channelChart': {
      const matching=S.orders.filter(order=>(order.channel||'?')===label);
      const total=matching.reduce((sum,order)=>sum+safe(order.accNetSales),0);
      return chartOrderBreakdown(matching,{title:`Channel ${label} · Accounted Net Sales`,total,contribution:order=>safe(order.accNetSales),detail:order=>`Accounted Net Sales ${fmt(order.accNetSales)}`});
    }
    case 'paymentChart': {
      const matching=S.orders.filter(order=>(order.payment||'?').toUpperCase()===label);
      return chartOrderBreakdown(matching,{title:`${label} payment count`,total:matching.length,contribution:()=>1,format:fmtN,detail:order=>`1 row · payment ${order.payment||'?'}`});
    }
    case 'weeklyChart': {
      const matching=S.orders.filter(order=>{
        const date=order.date&&order.date!=='0'?new Date(order.date):null;
        if(!date||isNaN(date)) return false;
        return `W${getWeekNum(date)} (${date.toLocaleDateString('en-IN',{month:'short',day:'numeric'})})`===label;
      });
      if(datasetLabel==='Orders') return chartOrderBreakdown(matching,{title:`${label} order count`,total:matching.length,contribution:()=>1,format:fmtN,detail:order=>`1 row · ${order.date}`});
      const total=matching.reduce((sum,order)=>sum+safe(order.accNetSales),0);
      return chartOrderBreakdown(matching,{title:`${label} · Accounted Net Sales`,total,contribution:order=>safe(order.accNetSales),detail:order=>`Accounted Net Sales ${fmt(order.accNetSales)}`});
    }
    case 'waterfallChart': {
      const inputs={
        'Gross Sales':['grossSales','grossSaleVal'],
        'Est. Net Sales':['netSales','netSales'],
        'Seller-Funded Disc.':['sellerDiscount','sellerDisc'],
        'Customer Add-ons':['customerAddons','custAddon'],
        'Accounted Net Sales':['accountedNetSales','accNetSales'],
        'Reverse Shipping':['reverseShipping','revShipping'],
        'Commission Fee':['commissionFee','commissionFee'],
        'Fixed Fee':['fixedFee','fixedFee'],
        'Ads Spend':['ads',null],
        GST:['gst','gst'],
        TCS:['tcs','tcs'],
        TDS:['tds','tds'],
        'Addons Recovery':['addonsRecovery','addonsRecovery'],
        'Bank Settlement':['bankSettlement','bankSettlement'],
      };
      if(label==='Returns & Cancels') return [`Summary.returnsCancelAmt = ${fmt(Math.abs(sd.returnsCancelAmt||0))} (chart source).`,...chartReturnUnitReferences()];
      if(inputs[label]) return chartSummaryMetric(...inputs[label]);
      if(['Product Cost','Packaging Cost','Other COGS'].includes(label)){
        const breakdown=calculateCogsBreakdown(skuRows);
        const costType={'Product Cost':'product','Packaging Cost':'packing','Other COGS':'other'}[label];
        const amount=breakdown[costType];
        const details=skuRows.slice(0,6).map(row=>{
          const unitCost=(S.costs[row.skuId]||DEFAULT_COSTS)[costType]||0;
          return `${row.skuId} · ${fmtN(row.netUnits)} net units × ${fmt(unitCost)} ${costType} cost = ${fmt(safe(row.netUnits)*unitCost)}.`;
        });
        return [`${label} = Σ SKU net units × per-SKU ${costType} cost = ${fmt(amount)}; chart plots −${fmt(amount)}.`,...details,...(skuRows.length>6?[`+ ${fmtN(skuRows.length-6)} more SKUs.`]:[])];
      }
      if(label==='True Net Profit') return [`Summary.bankSettlement ${fmt(sd.bankSettlement)} − Σ SKU COGS ${fmt(skuRows.reduce((sum,row)=>sum+row.totalCogs,0))} = ${amount}.`];
      return note(`Uploaded report value = ${amount}.`);
    }
    case 'deductionPieChart': {
      const inputs={
        'Rev.Ship':['reverseShipping','revShipping'],
        'Seller Disc':['sellerDiscount','sellerDisc'],
        GST:['gst','gst'],
        'Fixed Fee':['fixedFee','fixedFee'],
      };
      if(inputs[label]) return chartSummaryMetric(...inputs[label]);
      if(label==='Returns'){
        return [`Summary.returnsCancelAmt = ${fmt(Math.abs(sd.returnsCancelAmt||0))} (chart source).`,...chartReturnUnitReferences()];
      }
      if(label==='TCS+TDS'){
        const total=Math.abs(safe(sd.tcs)+safe(sd.tds));
        const rows=S.orders.filter(order=>safe(order.tcs)!==0||safe(order.tds)!==0);
        return chartSourceOrderBreakdown(
          'Summary.tcs + Summary.tds',
          total,
          rows,
          order=>Math.abs(safe(order.tcs))+Math.abs(safe(order.tds)),
          order=>`|TCS ${fmt(order.tcs)}| + |TDS ${fmt(order.tds)}|`,
        );
      }
      if(['Product Cost','Packaging Cost','Other COGS'].includes(label)){
        const breakdown=calculateCogsBreakdown(skuRows);
        const costType={'Product Cost':'product','Packaging Cost':'packing','Other COGS':'other'}[label];
        const amount=breakdown[costType];
        const details=skuRows.slice(0,6).map(row=>{
          const unitCost=(S.costs[row.skuId]||DEFAULT_COSTS)[costType]||0;
          return `${row.skuId} · ${fmtN(row.netUnits)} net units × ${fmt(unitCost)} ${costType} cost = ${fmt(safe(row.netUnits)*unitCost)}.`;
        });
        return [`${label} = Σ SKU net units × per-SKU ${costType} cost = ${fmt(amount)} (chart source).`,...details,...(skuRows.length>6?[`+ ${fmtN(skuRows.length-6)} more SKUs.`]:[])];
      }
      return note(`${label}: ${amount} (uploaded summary value).`);
    }
    case 'skuContribChart':
      return chartOrderBreakdown(ordersForSku,{
        title:`${label} · order-row Accounted Net Sales`,
        total:ordersForSku.reduce((sum,order)=>sum+safe(order.accNetSales),0),
        contribution:order=>safe(order.accNetSales),
        detail:order=>`Accounted Net Sales ${fmt(order.accNetSales)}`,
      }).concat(note(`SKU sheet Accounted Net Sales ${fmt(sku?.accNetSales||0)}; plotted value max(0, SKU sheet sales) = ${amount}.`));
    case 'skuEarningsChart': {
      if(!sku) return note(`SKU ${label}: plotted ${amount}.`);
      if(datasetLabel==='Bank Settlement') return note(`${label} · SKU-sheet Bank Settlement = ${fmt(sku.bankSettlement)}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>`${safeStr(order.orderId)} (${fmt(order.bankSettlement)})`).join('; ')}${ordersForSku.length>6?`; +${fmtN(ordersForSku.length-6)} more order rows`:''}.`);
      if(datasetLabel==='COGS (neg)') return note(`${label} · SKU-sheet net units ${fmtN(sku.netUnits)} × (product ${fmt(S.costs[label]?.product??DEFAULT_COSTS.product)} + packing ${fmt(S.costs[label]?.packing??DEFAULT_COSTS.packing)} + other ${fmt(S.costs[label]?.other??DEFAULT_COSTS.other)}) = COGS ${fmt(sku.totalCogs)}; plotted as −${fmt(sku.totalCogs)}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>safeStr(order.orderId)).join(', ')}${ordersForSku.length>6?`, +${fmtN(ordersForSku.length-6)} more`:''}.`);
      return note(`${label}: SKU-sheet settlement ${fmt(sku.bankSettlement)} − COGS ${fmt(sku.totalCogs)} + shared expense allocation ${fmt(sku.sharedExpenseAllocation)} + settlement adjustment ${fmt(sku.settlementAdjustmentAllocation)} = ${amount}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>safeStr(order.orderId)).join(', ')}${ordersForSku.length>6?`, +${fmtN(ordersForSku.length-6)} more`:''}.`);
    }
    case 'skuReturnChart':
      return sku?note(`${label} · SKU-sheet units: (${fmtN(sku.grossUnits)} gross − ${fmtN(sku.netUnits)} net) ÷ ${fmtN(sku.grossUnits)} × 100 = ${pct(sku.returnRate)}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>`${safeStr(order.orderId)} (RTO ${fmtN(order.rtoUnits)}, RVP ${fmtN(order.rvpUnits)}, cancel ${fmtN(order.cancelUnits)})`).join('; ')}${ordersForSku.length>6?`; +${fmtN(ordersForSku.length-6)} more order rows`:''}.`):note(`SKU return rate = ${amount}.`);
    case 'skuMarginChart':
      return sku?note(`${label} · SKU-sheet true profit ${fmt(sku.trueProfit)} ÷ Accounted Net Sales ${fmt(sku.accNetSales)} × 100 = ${pct(sku.margin)}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>safeStr(order.orderId)).join(', ')}${ordersForSku.length>6?`, +${fmtN(ordersForSku.length-6)} more order rows`:''}.`):note(`SKU margin = ${amount}.`);
    case 'skuReturnCostChart':
      return sku?note(`${label} · SKU-sheet absolute reverse shipping ${fmt(Math.abs(sku.revShipping))} ÷ returned units (${fmtN(sku.grossUnits)} gross − ${fmtN(sku.netUnits)} net = ${fmtN(sku.returnedUnits)}) = ${fmt(sku.avgRetCost)} per unit. Related order IDs: ${ordersForSku.slice(0,6).map(order=>`${safeStr(order.orderId)} (reverse ship ${fmt(order.revShipping)})`).join('; ')}${ordersForSku.length>6?`; +${fmtN(ordersForSku.length-6)} more order rows`:''}.`):note(`SKU average return shipping = ${amount}.`);
    case 'skuDiscountChart':
      return chartOrderBreakdown(ordersForSku,{title:`${label} · seller discount`,total:ordersForSku.reduce((sum,order)=>sum+Math.abs(order.sellerDisc||0),0),contribution:order=>Math.abs(order.sellerDisc||0),detail:order=>`absolute seller discount ${fmt(Math.abs(order.sellerDisc||0))}`});
    case 'skuFeeRateChart':
    case 'skuExpBurdenChart':
      return sku?[
        `${label}: |SKU expenses ${fmt(sku.totalExpenses)}| ÷ SKU accounted net sales ${fmt(sku.accNetSales)} × 100 = ${pct(sku.feeRate)}.`,
        `SKU ${label} is the aggregate source; related Orders-sheet rows (reference only):`,
        ...ordersForSku.slice(0,6).map(order=>`${safeStr(order.orderId)} · expenses ${fmt(order.expenses)} · accounted sales ${fmt(order.accNetSales)}`),
        ...(ordersForSku.length>6?[`+ ${fmtN(ordersForSku.length-6)} more order IDs.`]:[]),
      ]:note(`SKU expense rate = ${pct(value)}.`);
    case 'returnTypeChart': {
      const field={RTO:'rtoUnits',RVP:'rvpUnits',Cancelled:'cancelUnits'}[label];
      const units=Math.abs(safe(sd[field]));
      const matching=S.orders.filter(order=>safe(order[field])!==0);
      return chartOrderBreakdown(matching,{title:`${label} · ${field} in Orders sheet`,total:matching.reduce((sum,order)=>sum+safe(order[field]),0),contribution:order=>safe(order[field]),format:fmtN,detail:order=>`${fmtN(order[field])} units`})
        .concat(note(`Summary-sheet ${field} = ${fmtN(units)} units; chart uses this summary value.`));
    }
    case 'skuReturnUnitsChart': {
      const row=S.skuRows.find(item=>item.skuId===label);
      const field={RTO:'rtoUnits',RVP:'rvpUnits',Cancelled:'cancelUnits'}[datasetLabel];
      const matching=ordersForSku.filter(order=>safe(order[field])!==0);
      return chartOrderBreakdown(matching,{title:`${label} · ${datasetLabel} Orders-sheet units`,total:matching.reduce((sum,order)=>sum+safe(order[field]),0),contribution:order=>safe(order[field]),format:fmtN,detail:order=>`${fmtN(order[field])} ${datasetLabel} units`})
        .concat(note(`SKU-sheet ${field} = ${fmtN(safe(row?.[field]))} units; chart uses this SKU-sheet value.`));
    }
    case 'returnCostChart': {
      const typeByLabel={'RTO Loss':'RTO', 'RVP Loss':'RVP', 'Cancellation Loss':'CANCELLED'};
      const type=typeByLabel[label];
      const matching=S.orders.filter(order=>type==='RTO'?safe(order.rtoUnits)>0:type==='RVP'?safe(order.rvpUnits)>0:safe(order.cancelUnits)>0);
      const impacts=matching.map(order=>calculateReturnImpact(order,type));
      const settlement=impacts.reduce((sum,row)=>sum+row.settlementLoss,0);
      const product=impacts.reduce((sum,row)=>sum+row.productCogsLost,0);
      const packing=impacts.reduce((sum,row)=>sum+row.packingLoss,0);
      const lines=[`${label}: ${fmtN(matching.length)} matching orders; settlement ${fmt(settlement)} + product ${fmt(product)} + packing ${fmt(packing)} = ${fmt(settlement+product+packing)}.`];
      impacts.slice(0,6).forEach((impact,orderIndex)=>{
        const order=matching[orderIndex];
        lines.push(`${safeStr(order.orderId)} · ${order.sku} · settlement ${fmt(impact.settlementLoss)} + product ${fmt(impact.productCogsLost)} + packing ${fmt(impact.packingLoss)} = ${fmt(impact.totalLoss)}`);
      });
      if(matching.length>6) lines.push(`+ ${fmtN(matching.length-6)} more order IDs; included in total.`);
      return lines;
    }
    case 'dailyReturnChart': {
      const matching=ordersForDate;
      if(datasetLabel==='Delivered'){
        const delivered=matching.filter(order=>order.status==='DELIVERED'&&!(order.rtoUnits>0||order.rvpUnits>0||order.cancelUnits>0));
        return chartOrderBreakdown(delivered,{title:`${label} · delivered orders`,total:delivered.length,contribution:()=>1,format:fmtN,detail:order=>`1 delivered order row · ${order.status}`});
      }
      const returned=matching.filter(order=>safe(order.rtoUnits)+safe(order.rvpUnits)+safe(order.cancelUnits)>0);
      return chartOrderBreakdown(returned,{title:`${label} · return/cancel units`,total:returned.reduce((sum,order)=>sum+safe(order.rtoUnits)+safe(order.rvpUnits)+safe(order.cancelUnits),0),contribution:order=>safe(order.rtoUnits)+safe(order.rvpUnits)+safe(order.cancelUnits),format:fmtN,detail:order=>`RTO ${fmtN(order.rtoUnits)} + RVP ${fmtN(order.rvpUnits)} + cancel ${fmtN(order.cancelUnits)} units`});
    }
    case 'discSkuChart':
      return chartOrderBreakdown(ordersForSku,{title:`${label} · seller discount`,total:ordersForSku.reduce((sum,order)=>sum+Math.abs(order.sellerDisc||0),0),contribution:order=>Math.abs(order.sellerDisc||0),detail:order=>`absolute seller discount ${fmt(Math.abs(order.sellerDisc||0))}`});
    case 'discRateChart':
      return sku?note(`${label} · seller discount ${fmt(sku.totalSellerDisc)} ÷ (average FSP ${fmt(sku.grossUnits>0?sku.oiv/sku.grossUnits:0)} × ${fmtN(sku.netUnits)} net units) × 100 = ${pct(sku.discRate)}. Related order IDs: ${ordersForSku.slice(0,6).map(order=>`${safeStr(order.orderId)} (${fmt(Math.abs(order.sellerDisc||0))})`).join('; ')}${ordersForSku.length>6?`; +${fmtN(ordersForSku.length-6)} more order rows`:''}.`):note(`Seller discount rate = ${pct(value)}.`);
    case 'discDailyChart':
      return chartOrderBreakdown(ordersForDate,{title:`${label} · seller discounts`,total:ordersForDate.reduce((sum,order)=>sum+Math.abs(order.sellerDisc||safe(order.sellerDiscount)||0),0),contribution:order=>Math.abs(order.sellerDisc||safe(order.sellerDiscount)||0),detail:order=>`absolute seller discount ${fmt(Math.abs(order.sellerDisc||safe(order.sellerDiscount)||0))}`});
    case 'offerFreqChart': {
      const matching=S.orders.filter(order=>(order.offerIds||'').split(',').some(id=>id.trim()===label));
      return chartOrderBreakdown(matching,{title:`Offer ${label}`,total:value,contribution:order=>(order.offerIds||'').split(',').filter(id=>id.trim()===label).length,format:fmtN,detail:order=>`${(order.offerIds||'').split(',').filter(id=>id.trim()===label).length} occurrence(s) · IDs ${order.offerIds}`});
    }
    case 'expenseBreakChart': {
      const fields={
        'Commission Fee':'commissionFee','Fixed Fee':'fixedFee','Pick & Pack':'pickPack',
        'Forward Shipping':'fwdShipping','Reverse Shipping':'reverseShipping','Ads Spend':'ads',
        'Google Ads':'googleAds','Addons Recovery':'addonsRecovery',Storage:'storage',GST:'gst',TCS:'tcs',TDS:'tds',
      };
      const orderFields={
        'Commission Fee':'commissionFee','Fixed Fee':'fixedFee','Reverse Shipping':'revShipping',
        'Addons Recovery':'addonsRecovery',GST:'gst',TCS:'tcs',TDS:'tds',
      };
      const cogsType={
        'Product Cost (COGS)':'product',
        'Packaging Cost (COGS)':'packing',
        'Other COGS':'other',
      }[label];
      if(cogsType){
        const total=calculateCogsBreakdown(S.skuRows)[cogsType];
        const rows=S.skuRows.filter(row=>safe(row.netUnits)>0);
        const details=rows.slice(0,6).map(row=>{
          const unitCost=(S.costs[row.skuId]||DEFAULT_COSTS)[cogsType]||0;
          return `${row.skuId} · ${fmtN(row.netUnits)} net units × ${fmt(unitCost)}/unit = ${fmt(safe(row.netUnits)*unitCost)}.`;
        });
        return [
          `${label} = Σ SKU net units × per-SKU ${cogsType} cost = ${fmt(total)}.`,
          ...details,
          ...(rows.length>6?[`+ ${fmtN(rows.length-6)} more SKUs included in total.`]:[]),
        ];
      }
      if(label==='Other / Unitemized Platform Expense'||label==='Platform Expense Reconciliation'){
        return note(`${label} = reported Total Expenses minus the sum of parsed platform expense categories. See the reconciliation note and summary table.`);
      }
      return chartSummaryMetric(fields[label]||label,orderFields[label]||null);
    }
    case 'deliverySettlementChart': {
      const fieldByLabel={
        'Avg Selling Price / Unit':'unitSellingPrice',
        'Avg Order Item Value':'itemValue',
        'Avg Bank Settlement':'bankSettlement',
        'Avg Flipkart Deductions / Order':'settlementGap',
      };
      const field=fieldByLabel[label];
      const orders=context.chart.data.datasets?.[datasetIndex]?.calculationDeliveryOrders||[];
      if(!field) return note(`Average delivery analysis = ${amount}.`);
      if(field==='unitSellingPrice'){
        const sellingPrice=orders.reduce((sum,order)=>sum+safe(order.sellingPrice),0);
        const units=orders.reduce((sum,order)=>sum+safe(order.netUnits),0);
        const priceBasis=[...new Set(orders.map(order=>order.sellingPriceLabel))].join(' / ')||'selling value';
        const details=orders.slice(0,6).map(order=>
          `${order.orderId} · ${order.sku||'SKU unavailable'} · ${order.sellingPriceLabel} ${fmt(order.sellingPrice)} ÷ ${fmtN(order.netUnits)} delivered units = ${fmt(order.netUnits?order.sellingPrice/order.netUnits:0)}/unit.`
        );
        return [
          `Weighted average selling price = ${fmt(sellingPrice)} total ${priceBasis} ÷ ${fmtN(units)} delivered units = ${fmt(units?sellingPrice/units:0)} per unit.`,
          `${fmtN(orders.length)} delivered order IDs; all included in the weighted average.`,
          ...details,
          ...(orders.length>6?[`+ ${fmtN(orders.length-6)} more order IDs included in the total.`]:[]),
        ];
      }
      const total=orders.reduce((sum,order)=>sum+safe(order[field]),0);
      const average=orders.length?total/orders.length:0;
      return [
        `Average ${label.replace(/^Avg /,'').toLowerCase()} = ${fmt(total)} ÷ ${fmtN(orders.length)} delivered order IDs = ${fmt(average)} per order.`,
        ...chartOrderBreakdown(orders,{
          title:`${label} · individual order amounts`,
          total,
          contribution:order=>safe(order[field]),
          detail:order=>`Order Item Value ${fmt(order.itemValue)} − Bank Settlement ${fmt(order.bankSettlement)} = settlement gap ${fmt(order.settlementGap)}; workbook Forward Shipping ${fmt(order.forwardShipping)}.`,
          countLabel:'delivered order IDs',
        }),
      ];
    }
    case 'customerServiceFeeChart': {
      const orderCount=getCustomerServiceFeeOrderCount();
      const feePerOrder=index===0?S.customerServiceFeeMin:S.customerServiceFeeMax;
      return [
        `Estimate only: ${fmtN(orderCount)} unique order IDs × ${fmt(feePerOrder)} customer-paid fee/order = ${fmt(orderCount*feePerOrder)}.`,
        'This is an illustrative customer-side charge, not a fee amount extracted from the Excel file; it is excluded from seller expenses and profit.',
      ];
    }
    case 'taxChart': {
      const field={GST:'gst',TCS:'tcs',TDS:'tds'}[label];
      return chartSummaryMetric(field,field);
    }
    case 'dailyExpenseChart':
      return chartOrderBreakdown(ordersForDate,{title:`${label} · order expenses`,total:ordersForDate.reduce((sum,order)=>sum+Math.abs(safe(order.expenses)+safe(order.sharedExpenseAllocation)),0),contribution:order=>Math.abs(safe(order.expenses)+safe(order.sharedExpenseAllocation)),detail:order=>`|${fmt(order.expenses)} expenses + ${fmt(order.sharedExpenseAllocation)} shared allocation| = ${fmt(Math.abs(safe(order.expenses)+safe(order.sharedExpenseAllocation)))}`});
    case 'settleTimelineChart': {
      const dataset=context.chart.data.datasets?.[datasetIndex];
      const rows=dataset?.calculationRows?.[index]||[];
      const dateLabel=context.chart.data.labels?.[index]||label;
      const previous=Number(context.chart.data.datasets?.[0]?.data?.[index-1]||0);
      if(datasetLabel==='Daily Batch ₹'){
        return chartOrderBreakdown(rows,{title:`${dateLabel} · transaction rows`,total:value,contribution:order=>safe(order.txn1Amt),detail:order=>`batch ${order.txn1Neft} · transaction ${fmt(order.txn1Amt)}`});
      }
      const lines=[`${dateLabel}: previous cumulative ${fmt(previous)} + this date’s batch total ${fmt(Number(context.chart.data.datasets?.[1]?.data?.[index]||0))} = ${fmt(value)}.`];
      return lines.concat(chartOrderBreakdown(rows,{title:'Included Excel transactions',total:rows.reduce((sum,order)=>sum+safe(order.txn1Amt),0),contribution:order=>safe(order.txn1Amt),detail:order=>`batch ${order.txn1Neft} · transaction ${fmt(order.txn1Amt)}`}));
    }
    case 'settleBatchChart': {
      const batchId=context.chart.data.datasets?.[datasetIndex]?.calculationBatchIds?.[index];
      const rows=S.orders.filter(order=>order.txn1Neft===batchId);
      return chartOrderBreakdown(rows,{title:`Batch ${batchId}`,total:value,contribution:order=>safe(order.txn1Amt),detail:order=>`transaction ${fmt(order.txn1Amt)} · date ${order.txn1Date||'not dated'}`});
    }
    case 'settleTypeChart': {
      const batchIds=new Set(context.chart.data.datasets?.[datasetIndex]?.calculationBatchIds?.[index]||[]);
      const matching=S.orders.filter(order=>batchIds.has(order.txn1Neft));
      const lines=[`${label}: absolute totals of ${fmtN(batchIds.size)} batches = ${amount}.`];
      [...batchIds].slice(0,6).forEach(batchId=>{
        const batchRows=matching.filter(order=>order.txn1Neft===batchId);
        const batchTotal=batchRows.reduce((sum,order)=>sum+safe(order.txn1Amt),0);
        lines.push(`Batch ${batchId}: ${fmtN(batchRows.length)} order rows · Σ transactions ${fmt(batchTotal)} · counted as ${fmt(Math.abs(batchTotal))}.`);
      });
      if(batchIds.size>6) lines.push(`+ ${fmtN(batchIds.size-6)} more batch IDs.`);
      return lines.concat(chartOrderBreakdown(matching,{title:'Included transaction order rows',total:matching.reduce((sum,order)=>sum+Math.abs(safe(order.txn1Amt)),0),contribution:order=>Math.abs(safe(order.txn1Amt)),detail:order=>`batch ${order.txn1Neft} · |${fmt(order.txn1Amt)}|`}));
    }
    default:
      return note(`${datasetLabel||label}: ${amount}. ${source}`);
  }
}

function buildCalculationGuide(){
  const body=$('calculationGuideBody');
  if(!body||body.dataset.ready) return;
  const addSection=(heading,paragraphs)=>{
    const section=document.createElement('section');
    section.className='calculation-guide-section';
    const title=document.createElement('h4');
    title.textContent=heading;
    section.append(title);
    const list=document.createElement('ul');
    paragraphs.forEach(text=>{
      const item=document.createElement('li');
      item.textContent=text;
      list.append(item);
    });
    section.append(list);
    body.append(section);
  };
  addSection('Core calculations',CORE_CALCULATION_GUIDE.map(([heading,formula])=>`${heading}: ${formula}`));
  addSection('Chart-by-chart formulas',Object.entries(CHART_CALCULATION_NOTES).map(([id,note])=>{
    const chart=$(id);
    const title=chart?.closest('.chart-card')?.querySelector('h3')?.textContent||id;
    return `${title}: ${note}`;
  }));
  body.dataset.ready='true';
}

function closeCalculationGuide(){
  hide('calculationGuide');
  $('btnCalculationGuide')?.focus();
}

$('btnCalculationGuide')?.addEventListener('click',()=>{
  buildCalculationGuide();
  show('calculationGuide');
  $('closeCalculationGuide')?.focus();
});
$('closeCalculationGuide')?.addEventListener('click',closeCalculationGuide);
$('doneCalculationGuide')?.addEventListener('click',closeCalculationGuide);
$('calculationGuide')?.addEventListener('click',event=>{
  if(event.target===$('calculationGuide')) closeCalculationGuide();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('calculationGuide')?.style.display!=='none') closeCalculationGuide();
});

const darkAxis=()=>({ticks:{color:'#8890bb',font:{size:10}},grid:{color:'rgba(42,47,74,0.5)'}});
function hideChartHtmlTooltip(element){
  if(!element) return;
  if(element.matches(':hover')||element._chart?.canvas?.matches(':hover')) return;
  element.style.opacity='0';
  element.style.visibility='hidden';
}

function renderChartHtmlTooltip({chart,tooltip}){
  let element=$('chartDataTooltip');
  if(!element){
    element=document.createElement('div');
    element.id='chartDataTooltip';
    element.className='chart-data-tooltip';
    element.setAttribute('role','tooltip');
    element.addEventListener('mouseenter',()=>clearTimeout(element._hideTimer));
    element.addEventListener('mouseleave',()=>{
      clearTimeout(element._hideTimer);
      element._hideTimer=setTimeout(()=>hideChartHtmlTooltip(element),180);
    });
    document.body.append(element);
  }
  if(!tooltip||tooltip.opacity===0){
    clearTimeout(element._hideTimer);
    element._hideTimer=setTimeout(()=>hideChartHtmlTooltip(element),250);
    return;
  }

  clearTimeout(element._hideTimer);
  element._chart=chart;
  const appendLines=(className,lines)=>{
    lines.filter(Boolean).forEach(text=>{
      const line=document.createElement('div');
      line.className=className;
      line.textContent=text;
      element.append(line);
    });
  };
  element.replaceChildren();
  appendLines('chart-data-tooltip-title',tooltip.title||[]);
  (tooltip.body||[]).forEach(item=>appendLines('chart-data-tooltip-value',item.lines||[]));
  appendLines('chart-data-tooltip-detail',tooltip.footer||[]);

  const margin=12;
  const rect=chart.canvas.getBoundingClientRect();
  const width=Math.min(420,window.innerWidth-margin*2);
  const maxHeight=Math.min(480,window.innerHeight*0.6);
  element.style.width=`${width}px`;
  element.style.maxHeight=`${maxHeight}px`;
  element.style.visibility='visible';
  element.style.opacity='1';
  const bounds=element.getBoundingClientRect();
  let left=rect.left+tooltip.caretX+14;
  let top=rect.top+tooltip.caretY+14;
  if(left+bounds.width>window.innerWidth-margin) left=window.innerWidth-bounds.width-margin;
  if(top+bounds.height>window.innerHeight-margin) top=window.innerHeight-bounds.height-margin;
  element.style.left=`${Math.max(margin,left)}px`;
  element.style.top=`${Math.max(margin,top)}px`;
}

function chartOpts({legend=true,yPfx='',ySfx=''}={}){
  return {
    responsive:true, maintainAspectRatio:true,
    plugins:{
      legend:{ display:legend, labels:{color:'#8890bb',font:{size:10},boxWidth:10,padding:12} },
      tooltip:{
        enabled:false,
        external:renderChartHtmlTooltip,
        backgroundColor:'#13161f', borderColor:'#2a2f4a', borderWidth:1,
        titleColor:'#e4e8ff', bodyColor:'#8890bb',
        footerColor:'#e4e8ff',
        footerFont:{weight:'normal'},
        callbacks:{
          label:ctx=>{
            const value=ctx.parsed.y??ctx.parsed;
            const countAxis=ctx.dataset.yAxisID==='y2';
            const prefix=countAxis?'':yPfx;
            const suffix=countAxis?'':ySfx;
            return ` ${ctx.dataset.label?`${ctx.dataset.label}: `:''}${prefix}${value?.toLocaleString('en-IN',{maximumFractionDigits:2})}${suffix}`;
          },
          footer:items=>items.length?chartCalculationTooltip(items[0]):[],
        }
      }
    },
    scales:{ x:darkAxis(), y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>yPfx+v.toLocaleString('en-IN')+ySfx}} }
  };
}
function dnutOpts(pfx=''){
  return {
    responsive:true, maintainAspectRatio:true,
    plugins:{
      legend:{position:'right',labels:{color:'#8890bb',font:{size:10},boxWidth:10,padding:10}},
      tooltip:{
        enabled:false,
        external:renderChartHtmlTooltip,
        backgroundColor:'#13161f', borderColor:'#2a2f4a', borderWidth:1,
        titleColor:'#e4e8ff', bodyColor:'#8890bb',
        footerColor:'#e4e8ff',
        footerFont:{weight:'normal'},
        callbacks:{
          label:ctx=>` ${pfx}${ctx.parsed?.toLocaleString('en-IN',{maximumFractionDigits:2})}`,
          footer:items=>items.length?chartCalculationTooltip(items[0]):[],
        }
      }
    }
  };
}
function kpiHtml(kpis){
  return kpis.map(k=>`
    <div class="kpi-card" style="--kpi-color:${k.color}">
      <div class="kpi-label">${k.label}</div>
      <div class="kpi-value" style="color:${k.color}">${k.value}</div>
      <div class="kpi-sub">${k.sub||''}</div>
      <div class="kpi-icon">${k.icon||''}</div>
    </div>`).join('');
}
function statusBadge(st){
  const m={DELIVERED:'badge-green',RETURNED:'badge-red',CANCELLED:'badge-grey',
           RETURN_REQUESTED:'badge-yellow',RETURN_CANCELLED:'badge-blue',RETURN_CANCELLED:'badge-blue'};
  const cls=Object.entries(m).find(([k])=>st.includes(k))?.[1]||'badge-grey';
  return `<span class="badge ${cls}">${st.replace(/_/g,' ')}</span>`;
}

// ═══════════════════════════════════════════════════════════
// TAB: OVERVIEW
// ═══════════════════════════════════════════════════════════
function buildOverview(sd,skuM,totalCogs,trueProfit,trueMargin,returnRate){
  $('kpiGrid').innerHTML=kpiHtml([
    {label:'Gross Sales',         value:fmt(sd.grossSales),          sub:fmtN(sd.grossUnits)+' gross units',          icon:'💰',color:'#7c6fff'},
    {label:'Net Sales (Accounted)',value:fmt(sd.accountedNetSales),   sub:fmtN(sd.netUnits)+' delivered',             icon:'📦',color:'#00e0b0'},
    {label:'Seller Funded Disc.',  value:fmt(Math.abs(sd.sellerDiscount||0)), sub:'Your offer spend',                icon:'🏷️',color:'#ff5f6d'},
    {label:'Platform Expenses',    value:fmt(Math.abs(sd.totalExpenses||0)),  sub:'Fees + Taxes + Shipping',          icon:'💸',color:'#ff5f6d'},
    {label:'COGS (Your Cost)',      value:fmt(totalCogs),              sub:'Product + Packing + Other',               icon:'🏭',color:'#ffc849'},
    {label:'Bank Settlement',       value:fmt(sd.bankSettlement),     sub:'Projected payout',                        icon:'🏦',color:'#00e0b0'},
    {label:'Input Tax Credit',      value:fmt(sd.itc),                sub:'ITC claimable (GST+TCS+TDS)',             icon:'📋',color:'#b388ff'},
    {label:'True Net Profit',       value:fmt(trueProfit),            sub:'Settlement minus COGS',                   icon:trueProfit>=0?'📈':'📉',color:trueProfit>=0?'#00e0b0':'#ff5f6d'},
    {label:'Profit Margin',         value:pct(trueMargin),            sub:'Of accounted net sales',                  icon:'🎯',color:trueMargin>=20?'#00e0b0':trueMargin>=10?'#ffc849':'#ff5f6d'},
    {label:'Return Rate',           value:pct(returnRate),            sub:'RTO+RVP+Cancel of gross',                 icon:'🔄',color:returnRate>30?'#ff5f6d':'#ffc849'},
    {label:'Reverse Ship Cost',     value:fmt(Math.abs(sd.reverseShipping||0)), sub:'Return logistics',             icon:'🚚',color:'#fd79a8'},
    {label:'Ads Spend',             value:fmt(Math.abs(sd.ads||0)),   sub:'Platform advertising',                   icon:'📢',color:'#4fc3f7'},
  ]);

  // Revenue bar
  destroyChart('revenueChart');
  const rc=$('revenueChart').getContext('2d');
  S.charts['revenueChart']=new Chart(rc,{
    type:'bar',
    data:{
      labels:['Gross Sales','Returns','Net Sales','Platform Exp.','Seller Disc.','COGS','Bank Settle.','True Profit'],
      datasets:[{
        data:[sd.grossSales||0,Math.abs(sd.returnsCancelAmt||0),sd.accountedNetSales||0,
              Math.abs(sd.totalExpenses||0),Math.abs(sd.sellerDiscount||0),totalCogs,sd.bankSettlement||0,trueProfit],
        backgroundColor:['#7c6fff',α('#ff5f6d',0.7),'#00e0b0',α('#ff5f6d',0.8),α('#ffc849',0.8),α('#fd79a8',0.7),'#4fc3f7',trueProfit>=0?'#00e0b0':'#ff5f6d'],
        borderRadius:8,borderSkipped:false,
      }]
    },
    options:chartOpts({legend:false,yPfx:'₹'}),
  });

  // Status donut
  const stMap={};
  S.orders.forEach(o=>{ stMap[o.status]=(stMap[o.status]||0)+1; });
  destroyChart('statusChart');
  S.charts['statusChart']=new Chart($('statusChart').getContext('2d'),{
    type:'doughnut',data:{labels:Object.keys(stMap),datasets:[{data:Object.values(stMap),backgroundColor:PAL,hoverOffset:6}]},
    options:dnutOpts(),
  });

  // Daily trend
  const daily={};
  S.orders.forEach(o=>{
    const d=(o.date||'').slice(0,10); if(!d||d==='0') return;
    if(!daily[d]) daily[d]={orders:0,revenue:0,delivered:0,returns:0};
    daily[d].orders++;
    daily[d].revenue+=safe(o.accNetSales);
    if(o.status==='DELIVERED') daily[d].delivered++;
    if(o.status.includes('RETURN')) daily[d].returns++;
  });
  const days=Object.keys(daily).sort();
  destroyChart('dailyChart');
  S.charts['dailyChart']=new Chart($('dailyChart').getContext('2d'),{
    type:'line',
    data:{
      labels:days.map(d=>d.slice(5)),
      datasets:[
        {label:'Revenue ₹',data:days.map(d=>daily[d].revenue),borderColor:'#00e0b0',backgroundColor:α('#00e0b0',0.1),tension:0.4,fill:true,yAxisID:'y'},
        {label:'Orders',data:days.map(d=>daily[d].orders),borderColor:'#7c6fff',backgroundColor:α('#7c6fff',0.1),tension:0.4,fill:true,yAxisID:'y2'},
        {label:'Delivered',data:days.map(d=>daily[d].delivered),borderColor:'#ffc849',backgroundColor:'transparent',tension:0.4,borderDash:[5,4],yAxisID:'y2'},
        {label:'Returns',data:days.map(d=>daily[d].returns),borderColor:'#ff5f6d',backgroundColor:α('#ff5f6d',0.05),tension:0.4,yAxisID:'y2'},
      ]
    },
    options:{
      ...chartOpts({yPfx:'₹'}),
      scales:{
        x:darkAxis(),
        y:{...darkAxis(),position:'left',ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}},
        y2:{...darkAxis(),position:'right',grid:{display:false}},
      }
    }
  });

  // Channel
  const chanMap={};
  S.orders.forEach(o=>{ const c=o.channel||'?'; chanMap[c]=(chanMap[c]||0)+safe(o.accNetSales); });
  destroyChart('channelChart');
  S.charts['channelChart']=new Chart($('channelChart').getContext('2d'),{
    type:'doughnut',data:{labels:Object.keys(chanMap),datasets:[{data:Object.values(chanMap),backgroundColor:PAL,hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  // Payment
  const payMap={};
  S.orders.forEach(o=>{ const p=(o.payment||'?').toUpperCase(); payMap[p]=(payMap[p]||0)+1; });
  destroyChart('paymentChart');
  S.charts['paymentChart']=new Chart($('paymentChart').getContext('2d'),{
    type:'doughnut',data:{labels:Object.keys(payMap),datasets:[{data:Object.values(payMap),backgroundColor:PAL.slice(4),hoverOffset:6}]},
    options:dnutOpts(),
  });

  // Weekly bar
  const weekMap={};
  S.orders.forEach(o=>{
    const d=o.date&&o.date!=='0'?new Date(o.date):null; if(!d||isNaN(d)) return;
    const wk=`W${getWeekNum(d)} (${d.toLocaleDateString('en-IN',{month:'short',day:'numeric'})})`;
    if(!weekMap[wk]) weekMap[wk]={revenue:0,orders:0};
    weekMap[wk].revenue+=safe(o.accNetSales); weekMap[wk].orders++;
  });
  const wks=Object.keys(weekMap);
  destroyChart('weeklyChart');
  S.charts['weeklyChart']=new Chart($('weeklyChart').getContext('2d'),{
    type:'bar',
    data:{
      labels:wks,
      datasets:[
        {label:'Revenue ₹',data:wks.map(w=>weekMap[w].revenue),backgroundColor:α('#00e0b0',0.7),borderRadius:6,yAxisID:'y'},
        {label:'Orders',data:wks.map(w=>weekMap[w].orders),backgroundColor:α('#7c6fff',0.7),borderRadius:6,yAxisID:'y2'},
      ]
    },
    options:{
      ...chartOpts({yPfx:'₹'}),
      scales:{x:darkAxis(),y:{...darkAxis(),position:'left',ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}},y2:{...darkAxis(),position:'right',grid:{display:false}}}
    }
  });
}

function getWeekNum(d){
  const onejan=new Date(d.getFullYear(),0,1);
  return Math.ceil((((d-onejan)/86400000)+onejan.getDay()+1)/7);
}

// ═══════════════════════════════════════════════════════════
// TAB: P&L WATERFALL
// ═══════════════════════════════════════════════════════════
function buildWaterfall(sd,skuM,trueProfit){
  const cogsBreakdown=calculateCogsBreakdown(skuM);
  const items=[
    {label:'Gross Sales',          val:sd.grossSales||0,         type:'positive'},
    {label:'Returns & Cancels',    val:sd.returnsCancelAmt||0,    type:'deduction'},
    {label:'Est. Net Sales',       val:sd.netSales||0,            type:'neutral'},
    {label:'Seller-Funded Disc.',  val:sd.sellerDiscount||0,      type:'deduction'},
    {label:'Customer Add-ons',     val:sd.customerAddons||0,      type:'positive'},
    {label:'Accounted Net Sales',  val:sd.accountedNetSales||0,   type:'neutral'},
    {label:'Reverse Shipping',     val:sd.reverseShipping||0,     type:'deduction'},
    {label:'Commission Fee',       val:sd.commissionFee||0,       type:'deduction'},
    {label:'Fixed Fee',            val:sd.fixedFee||0,            type:'deduction'},
    {label:'Ads Spend',            val:sd.ads||0,                 type:'deduction'},
    {label:'GST',                  val:sd.gst||0,                 type:'deduction'},
    {label:'TCS',                  val:sd.tcs||0,                 type:'deduction'},
    {label:'TDS',                  val:sd.tds||0,                 type:'deduction'},
    {label:'Addons Recovery',      val:sd.addonsRecovery||0,      type:'deduction'},
    {label:'Bank Settlement',      val:sd.bankSettlement||0,      type:'neutral'},
    {label:'Product Cost',         val:-cogsBreakdown.product, type:'deduction'},
    {label:'Packaging Cost',       val:-cogsBreakdown.packing, type:'deduction'},
    {label:'Other COGS',           val:-cogsBreakdown.other, type:'deduction'},
    {label:'True Net Profit',      val:trueProfit,                type:trueProfit>=0?'positive':'deduction'},
  ];

  $('waterfallGrid').innerHTML=items.map(it=>`
    <div class="wf-item ${it.type}">
      <div class="wf-label">${it.label}</div>
      <div class="wf-value ${it.val>=0?'pos':'neg'}">${fmt(it.val)}</div>
    </div>`).join('');

  // Waterfall bar chart
  const gross=sd.grossSales||0;
  destroyChart('waterfallChart');
  S.charts['waterfallChart']=new Chart($('waterfallChart').getContext('2d'),{
    type:'bar',
    data:{
      labels:items.map(i=>i.label),
      datasets:[{
        data:items.map(i=>i.val),
        backgroundColor:items.map(i=>i.type==='positive'?α('#00e0b0',0.85):i.type==='deduction'?α('#ff5f6d',0.85):α('#7c6fff',0.75)),
        borderRadius:6,borderSkipped:false,
      }]
    },
    options:{...chartOpts({legend:false,yPfx:'₹'}),scales:{x:{...darkAxis(),ticks:{...darkAxis().ticks,maxRotation:45}},y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Deduction pie
  const deductions=[
    {name:'Returns',  val:Math.abs(sd.returnsCancelAmt||0)},
    {name:'Rev.Ship', val:Math.abs(sd.reverseShipping||0)},
    {name:'Seller Disc', val:Math.abs(sd.sellerDiscount||0)},
    {name:'Ads',      val:Math.abs(sd.ads||0)},
    {name:'GST',      val:Math.abs(sd.gst||0)},
    {name:'TCS+TDS',  val:Math.abs((sd.tcs||0)+(sd.tds||0))},
    {name:'Fixed Fee',val:Math.abs(sd.fixedFee||0)},
    {name:'Product Cost', val:cogsBreakdown.product},
    {name:'Packaging Cost', val:cogsBreakdown.packing},
    {name:'Other COGS', val:cogsBreakdown.other},
  ].filter(d=>d.val>0);
  destroyChart('deductionPieChart');
  S.charts['deductionPieChart']=new Chart($('deductionPieChart').getContext('2d'),{
    type:'doughnut',data:{labels:deductions.map(d=>d.name),datasets:[{data:deductions.map(d=>d.val),backgroundColor:PAL,hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  // SKU contribution
  destroyChart('skuContribChart');
  S.charts['skuContribChart']=new Chart($('skuContribChart').getContext('2d'),{
    type:'doughnut',
    data:{labels:skuM.map(s=>s.skuId),datasets:[{data:skuM.map(s=>Math.max(0,s.accNetSales)),backgroundColor:PAL,hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  // Deduction table
  const netSales=sd.accountedNetSales||1, grossSales=sd.grossSales||1;
  $('deductionBody').innerHTML=items.filter(i=>i.type==='deduction'||i.type==='positive').map(i=>`
    <tr>
      <td>${i.label}</td>
      <td class="num ${i.val>=0?'pos':'neg'}">${fmt(i.val)}</td>
      <td class="num">${pct(Math.abs(i.val)/grossSales*100)}</td>
      <td class="num">${pct(Math.abs(i.val)/netSales*100)}</td>
      <td>${i.type==='deduction'?'<span class="badge badge-red">Deduction</span>':'<span class="badge badge-green">Addition</span>'}</td>
    </tr>`).join('');
}

// ═══════════════════════════════════════════════════════════
// TAB: SKU DEEP-DIVE
// ═══════════════════════════════════════════════════════════
function buildSKUTab(skuM){
  const labels=skuM.map(s=>s.skuId);

  // Earnings stack
  destroyChart('skuEarningsChart');
  S.charts['skuEarningsChart']=new Chart($('skuEarningsChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[
      {label:'Bank Settlement',data:skuM.map(s=>s.bankSettlement),backgroundColor:α('#7c6fff',0.75),borderRadius:5},
      {label:'COGS (neg)',data:skuM.map(s=>-s.totalCogs),backgroundColor:α('#ffc849',0.75),borderRadius:5},
      {label:'True Profit',data:skuM.map(s=>s.trueProfit),backgroundColor:skuM.map(s=>s.trueProfit>=0?α('#00e0b0',0.9):α('#ff5f6d',0.9)),borderRadius:5},
    ]},
    options:{...chartOpts({yPfx:'₹'}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Return rate
  destroyChart('skuReturnChart');
  S.charts['skuReturnChart']=new Chart($('skuReturnChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'Return %',data:skuM.map(s=>+s.returnRate.toFixed(1)),backgroundColor:skuM.map(s=>s.returnRate>35?α('#ff5f6d',0.85):s.returnRate>15?α('#ffc849',0.85):α('#00e0b0',0.8)),borderRadius:5}]},
    options:{...chartOpts({ySfx:'%',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),max:100,ticks:{...darkAxis().ticks,callback:v=>v+'%'}}}},
  });

  // Margin
  destroyChart('skuMarginChart');
  S.charts['skuMarginChart']=new Chart($('skuMarginChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'Margin %',data:skuM.map(s=>+s.margin.toFixed(1)),backgroundColor:skuM.map(s=>s.margin>=25?α('#00e0b0',0.85):s.margin>=10?α('#ffc849',0.85):α('#ff5f6d',0.85)),borderRadius:5}]},
    options:{...chartOpts({ySfx:'%',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>v+'%'}}}},
  });

  // Avg return cost per unit
  destroyChart('skuReturnCostChart');
  S.charts['skuReturnCostChart']=new Chart($('skuReturnCostChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'Avg Return Cost/unit',data:skuM.map(s=>+s.avgRetCost.toFixed(2)),backgroundColor:α('#ff5f6d',0.75),borderRadius:5}]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v}}}},
  });

  // Seller discount
  destroyChart('skuDiscountChart');
  S.charts['skuDiscountChart']=new Chart($('skuDiscountChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'Total Seller Disc.',data:skuM.map(s=>+s.totalSellerDisc.toFixed(2)),backgroundColor:α('#ffc849',0.75),borderRadius:5}]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Fee rate
  destroyChart('skuFeeRateChart');
  S.charts['skuFeeRateChart']=new Chart($('skuFeeRateChart').getContext('2d'),{
    type:'bar',
    data:{labels,datasets:[{label:'Platform Fee %',data:skuM.map(s=>+s.feeRate.toFixed(1)),backgroundColor:α('#4fc3f7',0.75),borderRadius:5}]},
    options:{...chartOpts({ySfx:'%',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>v+'%'}}}},
  });

  // Table
  $('skuDetailBody').innerHTML=skuM.map(s=>{
    const mc=s.margin>=20?'pos':s.margin<0?'neg':'warn';
    const rc=s.returnRate>35?'neg':s.returnRate>15?'warn':'pos';
    return `<tr>
      <td><strong>${s.skuId}</strong></td>
      <td class="num">${fmtN(s.grossUnits)}</td>
      <td class="num neg">${fmtN(s.rtoUnits)}</td>
      <td class="num neg">${fmtN(s.rvpUnits)}</td>
      <td class="num warn">${fmtN(s.cancelUnits)}</td>
      <td class="num">${fmtN(s.netUnits)}</td>
      <td class="num ${rc}">${pct(s.returnRate)}</td>
      <td class="num">${fmt(s.oiv)}</td>
      <td class="num neg">${fmt(s.totalSellerDisc)}</td>
      <td class="num">${fmt(s.accNetSales)}</td>
      <td class="num neg">${fmt(Math.abs(s.revShipping))}</td>
      <td class="num neg">${fmt(s.avgRetCost)}</td>
      <td class="num neg">${fmt(Math.abs(s.fixedFee))}</td>
      <td class="num neg">${fmt(Math.abs(s.ads))}</td>
      <td class="num neg">${fmt(Math.abs(s.gst))}</td>
      <td class="num neg">${fmt(Math.abs(s.tcs)+Math.abs(s.tds))}</td>
      <td class="num neg">${fmt(Math.abs(s.totalExpenses))}</td>
      <td class="num neg">${fmt(s.totalCogs)}</td>
      <td class="num">${fmt(s.bankSettlement)}</td>
      <td class="num ${s.trueProfit>=0?'pos':'neg'}">${fmt(s.trueProfit)}</td>
      <td class="num ${mc}">${pct(s.margin)}</td>
      <td class="num ${s.trueProfit>=0?'pos':'neg'}">${s.netUnits>0?fmt(s.trueProfit/s.netUnits):'—'}</td>
      <td class="num pos">${fmt(s.itc)}</td>
    </tr>`;
  }).join('');

  const exportButton=$('btnExportSkuCsv');
  if(exportButton) exportButton.onclick=()=>exportTableCSV('skuDetailTable','sku_analysis.csv');
}

// ═══════════════════════════════════════════════════════════
// TAB: ORDERS
// ═══════════════════════════════════════════════════════════
function buildOrdersTab(){
  const statuses=[...new Set(S.orders.map(o=>o.status))].sort();
  const skus=[...new Set(S.orders.map(o=>o.sku))].sort();
  const channels=[...new Set(S.orders.map(o=>o.channel))].sort();
  const pays=[...new Set(S.orders.map(o=>o.payment))].sort();

  $('orderStatusFilter').innerHTML='<option value="">All Statuses</option>'+statuses.map(s=>`<option>${s}</option>`).join('');
  $('orderSkuFilter').innerHTML='<option value="">All SKUs</option>'+skus.map(s=>`<option>${s}</option>`).join('');
  $('orderChannelFilter').innerHTML='<option value="">All Channels</option>'+channels.map(c=>`<option>${c}</option>`).join('');
  $('orderPayFilter').innerHTML='<option value="">All Payments</option>'+pays.map(p=>`<option>${p}</option>`).join('');

  S.ordersFiltered=[...S.orders];
  S.ordersPage=1;
  renderOrdersPage();

  $('ordersBody').onclick=event=>{
    const row=event.target.closest('[data-order-index]')?.closest('tr[data-order-index]');
    if(row) showOrderDetail(Number(row.dataset.orderIndex));
  };
  $('ordersBody').onkeydown=event=>{
    if((event.key==='Enter'||event.key===' ')&&event.target.matches('tr[data-order-index]')){
      event.preventDefault();
      showOrderDetail(Number(event.target.dataset.orderIndex));
    }
  };

  ['orderSearch','orderStatusFilter','orderSkuFilter','orderChannelFilter','orderPayFilter'].forEach(id=>{
    $(id)?.removeEventListener('input',filterOrders);
    $(id)?.addEventListener('input',filterOrders);
  });

  const exportButton=$('btnExportOrdersCsv');
  if(exportButton) exportButton.onclick=()=>exportOrdersCSV();
}

function filterOrders(){
  const q=($('orderSearch')?.value||'').toLowerCase();
  const st=$('orderStatusFilter')?.value||'';
  const sk=$('orderSkuFilter')?.value||'';
  const ch=$('orderChannelFilter')?.value||'';
  const py=$('orderPayFilter')?.value||'';
  S.ordersFiltered=S.orders.filter(o=>{
    if(st&&o.status!==st) return false;
    if(sk&&o.sku!==sk) return false;
    if(ch&&o.channel!==ch) return false;
    if(py&&o.payment!==py) return false;
    if(q&&!o.orderId.toLowerCase().includes(q)&&!o.sku.toLowerCase().includes(q)&&!o.channel.toLowerCase().includes(q)) return false;
    return true;
  });
  S.ordersPage=1;
  renderOrdersPage();
}

function renderOrdersPage(){
  const {ordersPage:pg,ordersPageSize:sz,ordersFiltered:data}=S;
  const total=data.length, totalPg=Math.ceil(total/sz)||1;
  const slice=data.slice((pg-1)*sz,pg*sz);

  // Summary bar
  const totRev=data.reduce((a,o)=>a+safe(o.accNetSales),0);
  const totSettle=data.reduce((a,o)=>a+safe(o.bankSettlement),0);
  const totProfit=data.reduce((a,o)=>a+orderTrueProfit(o),0);
  const delivered=data.filter(o=>o.status==='DELIVERED').length;
  $('ordersSummaryBar').innerHTML=`
    <span>📦 <strong>${fmtN(total)}</strong> orders</span>
    <span>✅ <strong>${delivered}</strong> delivered</span>
    <span>Revenue: <strong>${fmt(totRev)}</strong></span>
    <span>Settlement: <strong>${fmt(totSettle)}</strong></span>
    <span>True Profit: <strong class="${totProfit>=0?'pos':'neg'}">${fmt(totProfit)}</strong></span>
    <span class="orders-detail-hint">Select an order row to inspect its full breakdown ↗</span>`;

  $('ordersBody').innerHTML=slice.map(o=>{
    const orderIndex=S.orders.indexOf(o);
    const tp=orderTrueProfit(o);
    const cogs=(S.costs[o.sku]||DEFAULT_COSTS);
    const cogsAmt=(cogs.product+cogs.packing+(cogs.other||0))*safe(o.netUnits);
    const expenses=Math.abs(safe(o.expenses)+safe(o.sharedExpenseAllocation));
    return `<tr class="order-detail-row" data-order-index="${orderIndex}" tabindex="0" aria-label="View financial breakdown for order ${safeStr(o.orderId)}" title="Click or press Enter to view this order's financial breakdown">
      <td><button class="order-view-button" type="button" data-order-index="${orderIndex}" aria-label="View order ${safeStr(o.orderId)} financial breakdown" title="View this order">👁</button></td>
      <td>${o.date}</td>
      <td style="font-size:10px;color:var(--text2)" title="${o.orderId}">${o.orderId.slice(-16)}</td>
      <td>${o.sku}</td>
      <td>${o.channel}</td>
      <td>${o.payment}</td>
      <td>${statusBadge(o.status)}</td>
      <td class="num">${fmtN(o.netUnits)}</td>
      <td class="num">${fmt(o.fsp)}</td>
      <td class="num neg">${Math.abs(o.sellerDisc||safe(o.sellerDiscount))>0?fmt(Math.abs(o.sellerDisc||safe(o.sellerDiscount))):'—'}</td>
      <td class="num">${fmt(o.accNetSales)}</td>
      <td class="num neg">${Math.abs(o.revShipping)>0?fmt(Math.abs(o.revShipping)):'—'}</td>
      <td class="num neg">${o.fixedFee>0?fmt(o.fixedFee):'—'}</td>
      <td class="num neg">${o.taxes>0?fmt(o.taxes):'—'}</td>
      <td class="num neg">${expenses>0?fmt(expenses):'—'}</td>
      <td class="num">${o.bankSettlement!==0?fmt(o.bankSettlement):'—'}</td>
      <td class="num neg">${cogsAmt>0?fmt(cogsAmt):'—'}</td>
      <td class="num ${tp>=0?'pos':'neg'}">${fmt(tp)}</td>
    </tr>`;
  }).join('');

  let pg_html=`<span class="page-info">${fmtN(total)} orders · Page ${pg}/${totalPg}</span>`;
  if(pg>1) pg_html+=`<button class="page-btn" onclick="goPage(${pg-1})">‹</button>`;
  const s2=Math.max(1,pg-2),e2=Math.min(totalPg,pg+2);
  for(let p=s2;p<=e2;p++) pg_html+=`<button class="page-btn ${p===pg?'active':''}" onclick="goPage(${p})">${p}</button>`;
  if(pg<totalPg) pg_html+=`<button class="page-btn" onclick="goPage(${pg+1})">›</button>`;
  $('ordersPagination').innerHTML=pg_html;
}

function showOrderDetail(orderIndex){
  const order=S.orders[orderIndex];
  if(!order) return;

  const costs=S.costs[order.sku]||DEFAULT_COSTS;
  const units=safe(order.netUnits);
  const productCost=costs.product*units;
  const packingCost=costs.packing*units;
  const otherCost=(costs.other||0)*units;
  const totalCogs=productCost+packingCost+otherCost;
  const trueProfit=orderTrueProfit(order);
  const returnTypes=[
    ['RTO',safe(order.rtoUnits)],
    ['RVP',safe(order.rvpUnits)],
    ['Cancellation',safe(order.cancelUnits)],
  ].filter(([,returnUnits])=>returnUnits>0);
  const returnImpacts=returnTypes.map(([type])=>calculateReturnImpact(order,type));
  const extraReturnCosts=returnImpacts.reduce((sum,impact)=>sum+impact.productCogsLost+impact.packingLoss,0);
  const fieldPresent=field=>order.financialFieldsPresent
    ? order.financialFieldsPresent[field]===true
    : safe(order[field])!==0;
  const expenseItems=[
    ['Commission fee','commissionFee'],
    ['Fixed fee','fixedFee'],
    ['Pick and pack fee','pickPack'],
    ['Forward shipping','fwdShipping'],
    ['Reverse shipping','revShipping'],
    ['Ads','ads'],
    ['Google Ads','googleAds'],
    ['Storage','storage'],
  ];
  const itemizedFees=expenseItems.reduce((sum,[,field])=>sum+(fieldPresent(field)?Math.abs(safe(order[field])):0),0);
  const taxItems=[['GST','gst'],['TCS','tcs'],['TDS','tds']];
  const taxTotal=taxItems.reduce((sum,[,field])=>sum+(fieldPresent(field)?Math.abs(safe(order[field])):0),0);
  const reportedTotalExpenses=fieldPresent('expenses')?Math.abs(safe(order.expenses)):null;
  const unitemizedExpense=reportedTotalExpenses===null?null:Math.max(0,reportedTotalExpenses-itemizedFees-taxTotal);
  const sellerDiscount=fieldPresent('sellerDisc')?order.sellerDisc:order.sellerDiscount;
  const body=$('orderDetailBody');
  const title=$('orderDetailTitle');
  title.textContent=`Order ${safeStr(order.orderId)}`;
  body.replaceChildren();

  const intro=document.createElement('div');
  intro.className='order-detail-meta';
  intro.textContent=`${order.date} · ${order.sku} · ${order.status} · ${fmtN(order.netUnits)} net units · ${order.channel||'Channel unavailable'} · ${order.payment||'Payment unavailable'}`;
  body.append(intro);

  const addSection=(heading,rows,sectionNote='')=>{
    const section=document.createElement('section');
    section.className='order-detail-section';
    const sectionTitle=document.createElement('h4');
    sectionTitle.textContent=heading;
    section.append(sectionTitle);
    const list=document.createElement('dl');
    list.className='order-detail-list';
    rows.forEach(({label,amount,description,emphasis=false})=>{
      const row=document.createElement('div');
      row.className=`order-detail-line${emphasis?' order-detail-total':''}`;
      const term=document.createElement('dt');
      term.textContent=label;
      const value=document.createElement('dd');
      value.textContent=amount;
      row.append(term,value);
      if(description){
        const detail=document.createElement('div');
        detail.className='order-detail-description';
        detail.textContent=description;
        row.append(detail);
      }
      list.append(row);
    });
    section.append(list);
    if(sectionNote){
      const note=document.createElement('p');
      note.className='order-detail-note';
      note.textContent=sectionNote;
      section.append(note);
    }
    body.append(section);
  };
  const sourceAmount=value=>fmt(value);
  const chargeAmount=value=>fmt(Math.abs(safe(value)));

  addSection('Sales and discounts',[
    {label:'Gross sale value',amount:fieldPresent('grossSaleVal')?sourceAmount(order.grossSaleVal):'Not itemized on this order row',description:`Excel order item value: ${fieldPresent('orderItemValue')?sourceAmount(order.oiv):'not available'}.`},
    {label:'Final selling price',amount:fieldPresent('finalSellingPrice')?sourceAmount(order.fsp):'Not recorded in this workbook',description:`${fmt(order.fsp)} × ${fmtN(units)} net units = ${fmt(order.fsp*units)}.`},
    {label:'Seller-funded discount',amount:chargeAmount(sellerDiscount),description:fieldPresent('sellerDisc')?'From the order row in the Excel report.':'Estimated from final selling price and accounted net sales because this order row has no seller-discount field.'},
    {label:'Total customer discount',amount:fieldPresent('totalCustDisc')?chargeAmount(order.totalCustDisc):'Not itemized on this order row'},
    {label:'Customer add-ons amount',amount:fieldPresent('custAddon')?sourceAmount(order.custAddon):'Not itemized on this order row'},
    {label:'Accounted net sales',amount:fieldPresent('accountedNetSales')?sourceAmount(order.accNetSales):'Not recorded in this workbook',emphasis:true},
  ]);

  addSection('Fees and deductions',[
    ...expenseItems.map(([label,field])=>({label,amount:fieldPresent(field)?chargeAmount(order[field]):'Not itemized on this order row'})),
    {label:'Other / not separately itemized',amount:unitemizedExpense===null?'Not available':fmt(unitemizedExpense),description:'Estimated as reported total expenses less the fee and tax components above.'},
    {label:'Total expenses on order row',amount:reportedTotalExpenses===null?'Not recorded in this workbook':chargeAmount(order.expenses),emphasis:true},
  ],'These are the Excel-reported deductions. They are already reflected in the settlement and are shown here for detail, not deducted from settlement a second time.');

  addSection('Taxes',[
    ...taxItems.map(([label,field])=>({label,amount:fieldPresent(field)?chargeAmount(order[field]):'Not itemized on this order row'})),
    {label:'Total taxes',amount:fmt(taxTotal),emphasis:true},
  ]);

  addSection('Recoveries and adjustments',[
    {label:'Customer add-ons amount recovery',amount:fieldPresent('addonsRecovery')?sourceAmount(order.addonsRecovery):'Not itemized on this order row',description:'Signed amount as reported in the Excel order row.'},
    {label:'Shared expense allocation',amount:sourceAmount(order.sharedExpenseAllocation),description:'Allocated from the report-level expense total based on this order’s share of accounted net sales.'},
    {label:'Settlement reconciliation adjustment',amount:sourceAmount(order.settlementAdjustment),description:'Allocated adjustment used to reconcile order settlements with the report summary.'},
  ]);

  addSection('Settlement received / recorded',[
    {label:'Bank settlement on order row',amount:fieldPresent('bankSettlement')?sourceAmount(order.bankSettlement):'Not recorded in this workbook',emphasis:true},
    {label:'Settlement transaction 1',amount:fieldPresent('settlementTransaction1')?sourceAmount(order.txn1Amt):'Not recorded in this workbook',description:[order.txn1Status,order.txn1Date,order.txn1Type,order.txn1Neft].filter(Boolean).join(' · ')||'No transaction details recorded.'},
  ],'Transaction 1 is the first settlement transaction column in the workbook and may be only one part of the order’s bank settlement.');

  addSection('Product costs and profit',[
    {label:`Product cost (${fmt(costs.product)} × ${fmtN(units)} units)`,amount:fmt(productCost)},
    {label:`Packing cost (${fmt(costs.packing)} × ${fmtN(units)} units)`,amount:fmt(packingCost)},
    {label:`Other unit cost (${fmt(costs.other||0)} × ${fmtN(units)} units)`,amount:fmt(otherCost)},
    {label:'Total COGS',amount:fmt(totalCogs),emphasis:true},
    {label:'Dashboard true profit',amount:fmt(trueProfit),description:`Settlement ${fmt(order.bankSettlement)} − COGS ${fmt(totalCogs)} + shared allocation ${fmt(order.sharedExpenseAllocation)} + reconciliation adjustment ${fmt(order.settlementAdjustment)}.`,emphasis:true},
    ...(returnTypes.length?[
      {label:'Additional return packing / lost product cost',amount:fmt(extraReturnCosts),description:returnTypes.map(([type,returnUnits],index)=>{
        const impact=returnImpacts[index];
        return `${type}: ${fmtN(returnUnits)} units · packing ${fmt(impact.packingLoss)}${impact.productCogsLost?` · product cost counted as lost ${fmt(impact.productCogsLost)}`:''}`;
      }).join('; ')},
      {label:'Profit after additional return costs',amount:fmt(trueProfit-extraReturnCosts),description:'Negative RVP settlement, if any, is already included in the bank settlement above and is not subtracted again.',emphasis:true},
    ]:[]),
  ]);

  $('orderDetailModal').style.display='flex';
  $('closeOrderDetail').focus();
}

function closeOrderDetail(){
  hide('orderDetailModal');
}

$('closeOrderDetail')?.addEventListener('click',closeOrderDetail);
$('doneOrderDetail')?.addEventListener('click',closeOrderDetail);
$('orderDetailModal')?.addEventListener('click',event=>{
  if(event.target===$('orderDetailModal')) closeOrderDetail();
});
document.addEventListener('keydown',event=>{
  if(event.key==='Escape'&&$('orderDetailModal')?.style.display!=='none') closeOrderDetail();
});
window.goPage=p=>{ S.ordersPage=p; renderOrdersPage(); };

// ═══════════════════════════════════════════════════════════
// TAB: RETURNS
// ═══════════════════════════════════════════════════════════
function calculateReturnImpact(order,type){
  const units=type==='RTO'?safe(order.rtoUnits):type==='RVP'?safe(order.rvpUnits):safe(order.cancelUnits);
  const costs=S.costs[order.sku]||DEFAULT_COSTS;
  const settlementLoss=type==='RVP'?Math.max(0,-safe(order.bankSettlement)):0;
  const productCostLost=type==='RVP'&&order.returnProductCostLost!==false;
  const productCogsLost=productCostLost?costs.product*units:0;
  const packingLoss=RETURN_PACKING_COST*units;
  return {
    units,
    settlementLoss,
    productCostLost,
    productCogsLost,
    packingLoss,
    totalLoss:settlementLoss+productCogsLost+packingLoss,
    originalSale:safe(order.fsp)>0?safe(order.fsp)*units:safe(order.oiv),
  };
}

function renderReturnTable(tbodyId,orders,type){
  const tbody=$(tbodyId);
  if(!tbody) return;
  tbody.innerHTML=orders.map((order,index)=>{
    const impact=calculateReturnImpact(order,type);
    const productCostCell=type==='RVP'
      ? `<label class="return-loss-control">
          <input type="checkbox" class="return-product-loss-toggle" data-order-index="${index}"
            aria-label="Count product cost as loss for this order" ${impact.productCostLost?'checked':''}>
          <span>${impact.productCostLost?'Lost '+fmt(impact.productCogsLost):'Not counted'}</span>
        </label>`
      : fmt(impact.productCogsLost);
    return `<tr>
      <td>${order.date}</td>
      <td style="font-size:10px;color:var(--text2)" title="${order.orderId}">${order.orderId.slice(-16)}</td>
      <td>${order.sku}</td>
      <td>${statusBadge(order.status)}</td>
      <td class="num">${fmtN(impact.units)}</td>
      <td class="num">${fmt(impact.originalSale)}</td>
      <td class="num neg">${fmt(impact.settlementLoss)}</td>
      ${type==='CANCELLED'
        ? `<td class="num neg">${fmt(impact.packingLoss)}</td><td class="num neg">${fmt(impact.totalLoss)}</td>`
        : `<td class="num neg">${productCostCell}</td><td class="num neg">${fmt(impact.packingLoss)}</td><td class="num neg">${fmt(impact.totalLoss)}</td>`}
    </tr>`;
  }).join('');
  if(type==='RVP'){
    tbody.querySelectorAll('.return-product-loss-toggle').forEach(toggle=>{
      toggle.addEventListener('change',()=>{
        const order=orders[Number(toggle.dataset.orderIndex)];
        if(!order) return;
        order.returnProductCostLost=toggle.checked;
        void saveSession();
        buildReturnsTab(S.summary||{},computeSKU());
      });
    });
  }
}

function buildReturnsTab(sd,skuM){
  chartCalculationTooltipCache.clear();
  const sectionNav=$('returnsSectionNav');
  if(sectionNav){
    sectionNav.onclick=event=>{
      const link=event.target.closest('button[data-returns-target]');
      if(!link) return;
      const target=$(link.dataset.returnsTarget);
      if(!target) return;
      document.querySelectorAll('.returns-section-link').forEach(button=>button.classList.toggle('active',button===link));
      target.scrollIntoView({behavior:'smooth',block:'start'});
    };
  }
  const rto=S.orders.filter(o=>safe(o.rtoUnits)>0);
  const rvp=S.orders.filter(o=>safe(o.rvpUnits)>0);
  const can=S.orders.filter(o=>safe(o.cancelUnits)>0);
  const rtoImpacts=rto.map(o=>calculateReturnImpact(o,'RTO'));
  const rvpImpacts=rvp.map(o=>calculateReturnImpact(o,'RVP'));
  const cancelImpacts=can.map(o=>calculateReturnImpact(o,'CANCELLED'));
  const rtoLoss=rtoImpacts.reduce((sum,row)=>sum+row.totalLoss,0);
  const rvpLoss=rvpImpacts.reduce((sum,row)=>sum+row.totalLoss,0);
  const rvpSettlementLoss=rvpImpacts.reduce((sum,row)=>sum+row.settlementLoss,0);
  const rvpProductCostLoss=rvpImpacts.reduce((sum,row)=>sum+row.productCogsLost,0);
  const rvpPackingLoss=rvpImpacts.reduce((sum,row)=>sum+row.packingLoss,0);
  const enabledRvpProductLossCount=rvpImpacts.filter(row=>row.productCostLost).length;
  const totalSettlementLoss=rvpSettlementLoss;
  const totalReturnUnits=rtoImpacts.reduce((sum,row)=>sum+row.units,0)
    +rvpImpacts.reduce((sum,row)=>sum+row.units,0);
  const totalReturnLoss=rtoLoss+rvpLoss;
  const avgRvpShippingPerOrder=rvp.length>0
    ? Math.abs(sd.reverseShipping||0)/rvp.length : 0;
  const successfulUnits=skuM.reduce((sum,s)=>sum+safe(s.netUnits),0);
  const rvpRecoveryPerSuccessfulUnit=successfulUnits>0?rvpLoss/successfulUnits:0;

  const masterProductLossToggle=$('rvpMasterProductLossToggle');
  if(masterProductLossToggle){
    masterProductLossToggle.checked=rvp.length>0&&enabledRvpProductLossCount===rvp.length;
    masterProductLossToggle.indeterminate=enabledRvpProductLossCount>0&&enabledRvpProductLossCount<rvp.length;
    masterProductLossToggle.disabled=rvp.length===0;
  }
  const masterSummary=$('rvpMasterSummary');
  if(masterSummary){
    masterSummary.textContent=`${enabledRvpProductLossCount}/${fmtN(rvp.length)} RVP orders count product loss · Settlement loss ${fmt(rvpSettlementLoss)} + product loss ${fmt(rvpProductCostLoss)} + packing loss (${fmt(RETURN_PACKING_COST)} × ${fmtN(rvpImpacts.reduce((sum,row)=>sum+row.units,0))} units = ${fmt(rvpPackingLoss)}) = Total RVP loss ${fmt(rvpLoss)}. Master switch applies to this report view; per-order switches can still be adjusted.`;
  }

  $('returnsKpi').innerHTML=kpiHtml([
    {label:'Total Returns & Cancels', value:fmtN(Math.abs(sd.returnsCancelUnits||0)), sub:fmt(Math.abs(sd.returnsCancelAmt||0)), icon:'🔄', color:'#ff5f6d'},
    {label:'RTO — Units / Loss',      value:`${fmtN(rtoImpacts.reduce((sum,row)=>sum+row.units,0))} / ${fmt(rtoLoss)}`, sub:'Returned to inventory; ₹5 packing per unit', icon:'📦', color:'#ff5f6d'},
    {label:'RVP — Units / Total Loss',value:`${fmtN(rvpImpacts.reduce((sum,row)=>sum+row.units,0))} / ${fmt(rvpLoss)}`, sub:`Settlement ${fmt(rvpSettlementLoss)} + product ${fmt(rvpProductCostLoss)} + packing ${fmt(rvpPackingLoss)}; updates with order toggles`, icon:'🔙', color:'#ffc849'},
    {label:'RVP Product Cost Loss',   value:fmt(rvpProductCostLoss),             sub:'Only orders with product loss enabled; resalable toggles exclude this cost', icon:'📦', color:'#ffc849'},
    {label:'Cancellations',           value:fmtN(cancelImpacts.reduce((sum,row)=>sum+row.units,0)), sub:`₹5 packing loss ${fmt(cancelImpacts.reduce((sum,row)=>sum+row.totalLoss,0))}`, icon:'❌', color:'#b388ff'},
    {label:'Reverse Ship Cost',       value:fmt(Math.abs(sd.reverseShipping||0)),     sub:'Platform deduction',                  icon:'🚚', color:'#fd79a8'},
    {label:'Avg RVP Shipping / Order',value:fmt(avgRvpShippingPerOrder),              sub:`Total reverse shipping ÷ ${fmtN(rvp.length)} RVP orders`, icon:'🚚', color:'#ff5f6d'},
    {label:'RVP Loss Recovery / Unit',value:fmt(rvpRecoveryPerSuccessfulUnit),        sub:`RVP loss ÷ ${fmtN(successfulUnits)} successful units; break-even recovery`, icon:'📈', color:'#ffc849'},
    {label:'RVP Settlement Loss',    value:fmt(totalSettlementLoss),                 sub:'Fixed negative settlement on RVP rows; product-loss toggles do not change settlement', icon:'💔', color:'#ff5f6d'},
    {label:'Total RTO + RVP Loss',    value:fmt(totalReturnLoss),                    sub:`Across ${fmtN(totalReturnUnits)} returned units`, icon:'📉', color:'#ff5f6d'},
    {label:'Return Rate',             value:pct(sd.grossUnits?((sd.grossUnits-sd.netUnits)/sd.grossUnits)*100:0), sub:'Of gross units', icon:'📊', color:'#ffc849'},
  ]);

  // Type donut
  destroyChart('returnTypeChart');
  S.charts['returnTypeChart']=new Chart($('returnTypeChart').getContext('2d'),{
    type:'doughnut',
    data:{labels:['RTO','RVP','Cancelled'],datasets:[{data:[Math.abs(sd.rtoUnits||0),Math.abs(sd.rvpUnits||0),Math.abs(sd.cancelUnits||0)],backgroundColor:['#ff5f6d','#ffc849','#7c6fff'],hoverOffset:6}]},
    options:dnutOpts(),
  });

  // SKU return units stacked
  destroyChart('skuReturnUnitsChart');
  S.charts['skuReturnUnitsChart']=new Chart($('skuReturnUnitsChart').getContext('2d'),{
    type:'bar',
    data:{labels:skuM.map(s=>s.skuId),datasets:[
      {label:'RTO',data:skuM.map(s=>s.rtoUnits),backgroundColor:α('#ff5f6d',0.8),borderRadius:4},
      {label:'RVP',data:skuM.map(s=>s.rvpUnits),backgroundColor:α('#ffc849',0.8),borderRadius:4},
      {label:'Cancelled',data:skuM.map(s=>s.cancelUnits),backgroundColor:α('#7c6fff',0.8),borderRadius:4},
    ]},
    options:chartOpts({}),
  });

  // Return cost vs gross sale donut
  destroyChart('returnCostChart');
  S.charts['returnCostChart']=new Chart($('returnCostChart').getContext('2d'),{
    type:'doughnut',
    data:{labels:['RTO Loss','RVP Loss','Cancellation Loss'],
      datasets:[{data:[rtoLoss,rvpLoss,cancelImpacts.reduce((sum,row)=>sum+row.totalLoss,0)],backgroundColor:['#4fc3f7','#ff5f6d','#ffc849'],hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  // Daily returns vs delivered
  const dRet={},dDel={};
  S.orders.forEach(o=>{
    const d=(o.date||'').slice(0,10); if(!d||d==='0') return;
    if(o.rtoUnits>0||o.rvpUnits>0||o.cancelUnits>0) dRet[d]=(dRet[d]||0)+safe(o.rtoUnits)+safe(o.rvpUnits)+safe(o.cancelUnits);
    else if(o.status==='DELIVERED') dDel[d]=(dDel[d]||0)+1;
  });
  const allDays=[...new Set([...Object.keys(dRet),...Object.keys(dDel)])].sort();
  destroyChart('dailyReturnChart');
  S.charts['dailyReturnChart']=new Chart($('dailyReturnChart').getContext('2d'),{
    type:'bar',
    data:{labels:allDays.map(d=>d.slice(5)),datasets:[
      {label:'Delivered',data:allDays.map(d=>dDel[d]||0),backgroundColor:α('#00e0b0',0.7),borderRadius:4},
      {label:'Returns/Cancels',data:allDays.map(d=>dRet[d]||0),backgroundColor:α('#ff5f6d',0.7),borderRadius:4},
    ]},
    options:chartOpts({}),
  });

  renderReturnTable('rtoBody',rto,'RTO');
  renderReturnTable('rvpBody',rvp,'RVP');
  renderReturnTable('cancelBody',can,'CANCELLED');

  if(masterProductLossToggle){
    masterProductLossToggle.onchange=()=>{
      const enabled=masterProductLossToggle.checked;
      rvp.forEach(order=>{order.returnProductCostLost=enabled;});
      void saveSession();
      buildReturnsTab(S.summary||{},computeSKU());
    };
  }

  const summaryExport=$('btnExportReturnsSummary');
  if(summaryExport) summaryExport.onclick=()=>exportReturnSummaryCalculations();
  const rtoExport=$('btnExportRtoCsv');
  if(rtoExport) rtoExport.onclick=()=>exportReturnCalculations('RTO');
  const rvpExport=$('btnExportRvpCsv');
  if(rvpExport) rvpExport.onclick=()=>exportReturnCalculations('RVP');
  const cancelExport=$('btnExportCancelCsv');
  if(cancelExport) cancelExport.onclick=()=>exportReturnCalculations('CANCELLED');
}

// ═══════════════════════════════════════════════════════════
// TAB: DISCOUNTS
// ═══════════════════════════════════════════════════════════
function buildDiscountsTab(sd,skuM){
  const discOrders=S.orders.filter(o=>Math.abs(o.sellerDisc||safe(o.sellerDiscount))>0||Math.abs(o.totalCustDisc||0)>0||(o.offerIds||'').length>0);
  const totalSellerDisc=Math.abs(sd.sellerDiscount||0);
  const totalCustAddon=sd.customerAddons||0;
  const avgDiscPerOrder=S.orders.length>0?totalSellerDisc/S.orders.filter(o=>o.netUnits>0).length:0;
  const discOrders2=S.orders.filter(o=>Math.abs(o.sellerDisc||safe(o.sellerDiscount))>0);
  const avgDiscPct=skuM.reduce((a,s)=>a+s.discRate,0)/(skuM.length||1);

  $('discountsKpi').innerHTML=kpiHtml([
    {label:'Total Seller Disc. Funded', value:fmt(totalSellerDisc), sub:'Your offer funding', icon:'🏷️', color:'#ffc849'},
    {label:'Discounted Orders',         value:fmtN(discOrders2.length), sub:'Orders with seller discount', icon:'🎟️', color:'#7c6fff'},
    {label:'Avg Disc / Discounted Order',value:fmt(avgDiscPerOrder), sub:'Avg spend per offer', icon:'💸', color:'#ffc849'},
    {label:'Avg Disc Rate',             value:pct(avgDiscPct), sub:'% of FSP funded by seller', icon:'📉', color:'#ff5f6d'},
    {label:'Customer Add-ons',          value:fmt(totalCustAddon), sub:'Customer paid extras', icon:'➕', color:'#00e0b0'},
  ]);

  // Discount by SKU
  const skuDisc={};
  skuM.forEach(s=>{ skuDisc[s.skuId]=s.totalSellerDisc; });
  destroyChart('discSkuChart');
  S.charts['discSkuChart']=new Chart($('discSkuChart').getContext('2d'),{
    type:'bar',
    data:{labels:Object.keys(skuDisc),datasets:[{label:'Seller Disc.',data:Object.values(skuDisc),backgroundColor:α('#ffc849',0.75),borderRadius:5}]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Disc rate by SKU
  destroyChart('discRateChart');
  S.charts['discRateChart']=new Chart($('discRateChart').getContext('2d'),{
    type:'bar',
    data:{labels:skuM.map(s=>s.skuId),datasets:[{label:'Disc %',data:skuM.map(s=>+s.discRate.toFixed(1)),backgroundColor:α('#ff5f6d',0.75),borderRadius:5}]},
    options:{...chartOpts({ySfx:'%',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>v+'%'}}}},
  });

  // Daily discount spend
  const dDisc={};
  S.orders.forEach(o=>{
    const d=(o.date||'').slice(0,10); if(!d||d==='0') return;
    dDisc[d]=(dDisc[d]||0)+Math.abs(o.sellerDisc||safe(o.sellerDiscount)||0);
  });
  const discDays=Object.keys(dDisc).sort();
  destroyChart('discDailyChart');
  S.charts['discDailyChart']=new Chart($('discDailyChart').getContext('2d'),{
    type:'line',
    data:{labels:discDays.map(d=>d.slice(5)),datasets:[{label:'Daily Discount ₹',data:discDays.map(d=>dDisc[d]),borderColor:'#ffc849',backgroundColor:α('#ffc849',0.1),tension:0.4,fill:true}]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v}}}},
  });

  // Offer frequency
  const offerMap={};
  S.orders.forEach(o=>{
    (o.offerIds||'').split(',').forEach(id=>{
      const t=id.trim(); if(!t||t.length<3) return;
      offerMap[t]=(offerMap[t]||0)+1;
    });
  });
  const topOffers=Object.entries(offerMap).sort((a,b)=>b[1]-a[1]).slice(0,15);
  destroyChart('offerFreqChart');
  S.charts['offerFreqChart']=new Chart($('offerFreqChart').getContext('2d'),{
    type:'bar',
    data:{labels:topOffers.map(o=>o[0]),datasets:[{label:'Order Count',data:topOffers.map(o=>o[1]),backgroundColor:α('#b388ff',0.8),borderRadius:5}]},
    options:{...chartOpts({legend:false}),scales:{x:{...darkAxis(),ticks:{...darkAxis().ticks,maxRotation:45}},y:darkAxis()}},
  });

  // Discount table
  S.discFiltered=S.orders.filter(o=>(o.offerIds||'').length>0||Math.abs(o.sellerDisc||safe(o.sellerDiscount))>0);
  S.discPage=1;
  renderDiscPage();
}

function renderDiscPage(){
  const pg=S.discPage, sz=50;
  const data=S.discFiltered, total=data.length, totalPg=Math.ceil(total/sz)||1;
  const slice=data.slice((pg-1)*sz,pg*sz);
  $('discountBody').innerHTML=slice.map(o=>{
    const disc=Math.abs(o.sellerDisc||safe(o.sellerDiscount)||0);
    const discPct=safe(o.fsp)>0?(disc/safe(o.fsp)*100).toFixed(1):0;
    return `<tr>
      <td>${o.date}</td>
      <td style="font-size:10px;color:var(--text2)">${o.orderId.slice(-16)}</td>
      <td>${o.sku}</td>
      <td class="num">${fmt(o.fsp)}</td>
      <td class="num neg">${disc>0?fmt(disc):'—'}</td>
      <td class="num pos">${safe(o.custAddon)>0?fmt(o.custAddon):'—'}</td>
      <td class="num neg">${safe(o.totalCustDisc)>0?fmt(o.totalCustDisc):'—'}</td>
      <td style="font-size:10px;max-width:200px;overflow:hidden;text-overflow:ellipsis">${(o.offerIds||'—').slice(0,50)}</td>
      <td class="num">${discPct}%</td>
      <td class="num">${fmt(o.accNetSales)}</td>
    </tr>`;
  }).join('');

  let ph=`<span class="page-info">${fmtN(total)} records · Page ${pg}/${totalPg}</span>`;
  if(pg>1) ph+=`<button class="page-btn" onclick="goDiscPage(${pg-1})">‹</button>`;
  for(let p=Math.max(1,pg-2);p<=Math.min(totalPg,pg+2);p++) ph+=`<button class="page-btn ${p===pg?'active':''}" onclick="goDiscPage(${p})">${p}</button>`;
  if(pg<totalPg) ph+=`<button class="page-btn" onclick="goDiscPage(${pg+1})">›</button>`;
  $('discountPagination').innerHTML=ph;
}
window.goDiscPage=p=>{ S.discPage=p; renderDiscPage(); };

// ═══════════════════════════════════════════════════════════
// TAB: EXPENSES
// ═══════════════════════════════════════════════════════════
function getDeliverySettlementGroups(){
  const grouped=new Map();
  S.orders.filter(order=>order.status==='DELIVERED'&&safe(order.netUnits)>0).forEach(order=>{
    const id=safeStr(order.orderId);
    if(!id) return;
    if(!grouped.has(id)){
      grouped.set(id,{orderId:id,skus:new Set(),sellingPriceLabels:new Set(),sellingPrice:0,itemValue:0,bankSettlement:0,forwardShipping:0,netUnits:0});
    }
    const group=grouped.get(id);
    if(order.sku) group.skus.add(order.sku);
    const hasFinalSellingPrice=order.financialFieldsPresent
      ? order.financialFieldsPresent.finalSellingPrice===true
      : safe(order.fsp)!==0;
    group.sellingPrice+=safe(hasFinalSellingPrice?order.fsp:order.oiv);
    group.sellingPriceLabels.add(hasFinalSellingPrice?'Final Selling Price':'Order Item Value fallback');
    group.itemValue+=safe(order.oiv);
    group.bankSettlement+=safe(order.bankSettlement);
    group.forwardShipping+=Math.abs(safe(order.fwdShipping));
    group.netUnits+=safe(order.netUnits);
  });
  return [...grouped.values()].map(order=>({
    ...order,
    sku:[...order.skus].join(', ')||'SKU unavailable',
    sellingPriceLabel:[...order.sellingPriceLabels].join(' / '),
    settlementGap:order.itemValue-order.bankSettlement,
  }));
}

function getCustomerServiceFeeOrderCount(){
  return new Set(S.orders.map(order=>safeStr(order.orderId)).filter(Boolean)).size;
}

function updateCustomerServiceFeeEstimate(){
  const minInput=$('customerServiceFeeMin');
  const maxInput=$('customerServiceFeeMax');
  const summary=$('customerServiceFeeSummary');
  const chart=S.charts.customerServiceFeeChart;
  const min=Number(minInput?.value);
  const max=Number(maxInput?.value);
  if(!Number.isFinite(min)||!Number.isFinite(max)||min<0||max<min){
    if(summary) summary.textContent='Enter valid non-negative estimates; the high estimate must be at least the low estimate.';
    return;
  }
  S.customerServiceFeeMin=min;
  S.customerServiceFeeMax=max;
  const orderCount=getCustomerServiceFeeOrderCount();
  const lowTotal=orderCount*min;
  const highTotal=orderCount*max;
  if(summary){
    summary.textContent=`${fmtN(orderCount)} unique order IDs × ${fmt(min)}–${fmt(max)} per order = estimated customer-paid total ${fmt(lowTotal)}–${fmt(highTotal)}. Scenario only; not seller revenue or expense.`;
  }
  if(chart){
    chart.data.labels=[`Low · ${fmt(min)}/order`,`High · ${fmt(max)}/order`];
    chart.data.datasets[0].data=[lowTotal,highTotal];
    chart.update();
    chartCalculationTooltipCache.clear();
  }
  scheduleSaveSession();
}

function buildExpensesTab(sd,skuM){
  const netSales=Math.abs(safe(sd.accountedNetSales));
  const grossSales=Math.abs(safe(sd.grossSales));
  const platformExpenses=Math.abs(safe(sd.totalExpenses));
  const cogs=calculateCogsBreakdown(skuM);
  const totalCogs=cogs.product+cogs.packing+cogs.other;
  const totalCosts=platformExpenses+totalCogs;
  const netUnits=skuM.reduce((sum,row)=>sum+safe(row.netUnits),0);
  const orderCount=new Set(S.orders.map(order=>safeStr(order.orderId)).filter(Boolean)).size;
  const deliveryOrders=getDeliverySettlementGroups();
  const deliveryOrderCount=deliveryOrders.length;
  const deliveryTotals=deliveryOrders.reduce((totals,order)=>{
    totals.sellingPrice+=order.sellingPrice;
    totals.itemValue+=order.itemValue;
    totals.bankSettlement+=order.bankSettlement;
    totals.settlementGap+=order.settlementGap;
    totals.forwardShipping+=order.forwardShipping;
    totals.netUnits+=order.netUnits;
    return totals;
  },{sellingPrice:0,itemValue:0,bankSettlement:0,settlementGap:0,forwardShipping:0,netUnits:0});
  const deliveryAverage=field=>deliveryOrderCount?deliveryTotals[field]/deliveryOrderCount:0;
  const averageSellingPrice=deliveryTotals.netUnits?deliveryTotals.sellingPrice/deliveryTotals.netUnits:0;

  const platformCats=[
    {name:'Commission Fee',   amt:Math.abs(sd.commissionFee||0)},
    {name:'Fixed Fee',        amt:Math.abs(sd.fixedFee||0)},
    {name:'Pick & Pack',      amt:Math.abs(sd.pickPack||0)},
    {name:'Forward Shipping', amt:Math.abs(sd.fwdShipping||0)},
    {name:'Reverse Shipping', amt:Math.abs(sd.reverseShipping||0)},
    {name:'Ads Spend',        amt:Math.abs(sd.ads||0)},
    {name:'Google Ads',       amt:Math.abs(sd.googleAds||0)},
    {name:'Addons Recovery',  amt:Math.abs(sd.addonsRecovery||0)},
    {name:'Storage',          amt:Math.abs(sd.storage||0)},
    {name:'Rewards & Other',  amt:Math.abs(sd.rewards||0)},
    {name:'GST',              amt:Math.abs(sd.gst||0)},
    {name:'TCS',              amt:Math.abs(sd.tcs||0)},
    {name:'TDS',              amt:Math.abs(sd.tds||0)},
  ].filter(c=>c.amt>0.01);
  const itemizedPlatformTotal=platformCats.reduce((sum,category)=>sum+category.amt,0);
  const platformReconciliation=platformExpenses-itemizedPlatformTotal;
  if(platformReconciliation>0.01){
    platformCats.push({name:'Other / Unitemized Platform Expense',amt:platformReconciliation});
  }else if(platformReconciliation< -0.01){
    platformCats.push({name:'Platform Expense Reconciliation',amt:platformReconciliation});
  }
  const cats=[
    ...platformCats,
    {name:'Product Cost (COGS)',amt:cogs.product},
    {name:'Packaging Cost (COGS)',amt:cogs.packing},
    {name:'Other COGS',amt:cogs.other},
  ];
  const chartCats=cats.filter(category=>category.amt>0.01);
  const reconciliationNote=$('expenseReconciliationNote');
  if(reconciliationNote){
    reconciliationNote.classList.toggle('warning',Math.abs(platformReconciliation)>0.01);
    reconciliationNote.textContent=Math.abs(platformReconciliation)<=0.01
      ?`Itemized Excel platform categories match the reported ${fmt(platformExpenses)} within ₹0.01. The table and chart add seller COGS separately; they do not change the profit calculation.`
      :platformReconciliation>0
        ?`Excel reports ${fmt(platformExpenses)} in platform expenses; ${fmt(platformReconciliation)} is not itemized in the parsed fee columns and is included as “Other / Unitemized Platform Expense”.`
        :`Parsed fee categories exceed Excel’s reported platform-expense total by ${fmt(Math.abs(platformReconciliation))}; a reconciliation credit is shown so the total still matches the report.`;
  }

  $('expensesKpi').innerHTML=kpiHtml([
    {label:'Total Platform Expenses', value:fmt(platformExpenses), sub:'Excel-reported platform fees & taxes', icon:'💸', color:'#ff5f6d'},
    {label:'Platform Expense % of Net Sales', value:pct(netSales?platformExpenses/netSales*100:0), sub:'Platform fees & taxes only', icon:'📊', color:'#ffc849'},
    {label:'Total COGS', value:fmt(totalCogs), sub:`Product ${fmt(cogs.product)} · packaging ${fmt(cogs.packing)} · other ${fmt(cogs.other)}`, icon:'📦', color:'#b388ff'},
    {label:'Packaging Cost', value:fmt(cogs.packing), sub:`${fmt(netUnits?cogs.packing/netUnits:0)}/net unit · ${fmtN(netUnits)} net units`, icon:'📦', color:'#4fc3f7'},
    {label:'Total Costs incl. COGS', value:fmt(totalCosts), sub:'Platform expenses + product, packaging & other COGS', icon:'🧾', color:'#ff5f6d'},
    {label:'Reverse Shipping',        value:fmt(Math.abs(sd.reverseShipping||0)), sub:'Return logistics cost', icon:'🚚', color:'#ff5f6d'},
    {label:'Total Taxes',             value:fmt(Math.abs((sd.gst||0)+(sd.tcs||0)+(sd.tds||0))), sub:'GST+TCS+TDS', icon:'🏛️', color:'#b388ff'},
    {label:'ITC (Claimable)',         value:fmt(sd.itc||0), sub:'Can claim back in filings', icon:'✅', color:'#00e0b0'},
    {label:'Ads Spend',               value:fmt(Math.abs(sd.ads||0)), sub:'Platform advertising', icon:'📢', color:'#4fc3f7'},
    {label:'Avg Selling Price / Unit',value:fmt(averageSellingPrice),sub:`Final Selling Price ${fmt(deliveryTotals.sellingPrice)} ÷ ${fmtN(deliveryTotals.netUnits)} delivered units`,icon:'🏷️',color:'#00e0b0'},
    {label:'Avg Flipkart Deductions / Order',value:fmt(deliveryAverage('settlementGap')),sub:'Order Item Value − settlement; may include non-delivery charges',icon:'🧾',color:'#ffc849'},
  ]);

  destroyChart('deliverySettlementChart');
  S.charts.deliverySettlementChart=new Chart($('deliverySettlementChart').getContext('2d'),{
    type:'bar',
    data:{
      labels:['Avg Selling Price / Unit','Avg Order Item Value','Avg Bank Settlement','Avg Flipkart Deductions / Order'],
      datasets:[{
        label:'Average amount',
        data:[averageSellingPrice,deliveryAverage('itemValue'),deliveryAverage('bankSettlement'),deliveryAverage('settlementGap')],
        calculationDeliveryOrders:deliveryOrders,
        backgroundColor:[α('#00e0b0',0.75),α('#7c6fff',0.75),α('#4fc3f7',0.8),α('#ffc849',0.8)],
        borderRadius:5,
      }],
    },
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:{...darkAxis(),ticks:{...darkAxis().ticks,maxRotation:25}},y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:value=>'₹'+value.toLocaleString('en-IN')}}}},
  });

  const serviceFeeMin=$('customerServiceFeeMin');
  const serviceFeeMax=$('customerServiceFeeMax');
  if(serviceFeeMin) serviceFeeMin.value=String(S.customerServiceFeeMin);
  if(serviceFeeMax) serviceFeeMax.value=String(S.customerServiceFeeMax);
  destroyChart('customerServiceFeeChart');
  const serviceFeeOrderCount=getCustomerServiceFeeOrderCount();
  S.charts.customerServiceFeeChart=new Chart($('customerServiceFeeChart').getContext('2d'),{
    type:'bar',
    data:{
      labels:[`Low · ${fmt(S.customerServiceFeeMin)}/order`,`High · ${fmt(S.customerServiceFeeMax)}/order`],
      datasets:[{
        label:'Estimated customer-paid service fees (₹)',
        data:[serviceFeeOrderCount*S.customerServiceFeeMin,serviceFeeOrderCount*S.customerServiceFeeMax],
        backgroundColor:[α('#4fc3f7',0.75),α('#b388ff',0.8)],
        borderRadius:6,
      }],
    },
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:value=>'₹'+value.toLocaleString('en-IN')}}}},
  });
  updateCustomerServiceFeeEstimate();
  [serviceFeeMin,serviceFeeMax].forEach(input=>{
    input?.removeEventListener('input',updateCustomerServiceFeeEstimate);
    input?.addEventListener('input',updateCustomerServiceFeeEstimate);
  });

  destroyChart('expenseBreakChart');
  S.charts['expenseBreakChart']=new Chart($('expenseBreakChart').getContext('2d'),{
    type:'doughnut',data:{labels:chartCats.map(c=>c.name),datasets:[{data:chartCats.map(c=>c.amt),backgroundColor:PAL,hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  destroyChart('taxChart');
  S.charts['taxChart']=new Chart($('taxChart').getContext('2d'),{
    type:'doughnut',
    data:{labels:['GST','TCS','TDS'],datasets:[{data:[Math.abs(sd.gst||0),Math.abs(sd.tcs||0),Math.abs(sd.tds||0)],backgroundColor:['#7c6fff','#ffc849','#00e0b0'],hoverOffset:6}]},
    options:dnutOpts('₹'),
  });

  // SKU expense burden
  destroyChart('skuExpBurdenChart');
  S.charts['skuExpBurdenChart']=new Chart($('skuExpBurdenChart').getContext('2d'),{
    type:'bar',
    data:{labels:skuM.map(s=>s.skuId),datasets:[{label:'Expense %',data:skuM.map(s=>+s.feeRate.toFixed(1)),backgroundColor:α('#ff5f6d',0.75),borderRadius:5}]},
    options:{...chartOpts({ySfx:'%',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>v+'%'}}}},
  });

  // Daily expense trend
  const dExp={};
  S.orders.forEach(o=>{
    const d=(o.date||'').slice(0,10); if(!d||d==='0') return;
    const cost=S.costs[o.sku]||DEFAULT_COSTS;
    const cogsPerOrder=(cost.product+cost.packing+(cost.other||0))*safe(o.netUnits);
    dExp[d]=(dExp[d]||0)+Math.abs(safe(o.expenses)+safe(o.sharedExpenseAllocation))+cogsPerOrder;
  });
  const expDays=Object.keys(dExp).sort();
  destroyChart('dailyExpenseChart');
  S.charts['dailyExpenseChart']=new Chart($('dailyExpenseChart').getContext('2d'),{
    type:'line',
    data:{labels:expDays.map(d=>d.slice(5)),datasets:[{label:'Daily Expenses ₹',data:expDays.map(d=>dExp[d]),borderColor:'#ff5f6d',backgroundColor:α('#ff5f6d',0.1),tension:0.4,fill:true}]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  const percentOf=(amount,total)=>total?pct(amount/total*100):pct(0);
  const averagePerOrder=amount=>orderCount?fmt(amount/orderCount):fmt(0);
  const categoryRows=cats.map(category=>`<tr>
    <td>${category.name}</td>
    <td class="num ${category.amt>=0?'neg':'pos'}">${fmt(category.amt)}</td>
    <td class="num">${percentOf(category.amt,totalCosts)}</td>
    <td class="num">${percentOf(category.amt,grossSales)}</td>
    <td class="num">${percentOf(category.amt,netSales)}</td>
    <td class="num">${averagePerOrder(category.amt)}</td>
  </tr>`).join('');
  $('expenseBody').innerHTML=categoryRows+`
  <tr class="expense-subtotal">
    <td>Platform Expenses Subtotal</td>
    <td class="num">${fmt(platformExpenses)}</td>
    <td class="num">${percentOf(platformExpenses,totalCosts)}</td>
    <td class="num">${percentOf(platformExpenses,grossSales)}</td>
    <td class="num">${percentOf(platformExpenses,netSales)}</td>
    <td class="num">${averagePerOrder(platformExpenses)}</td>
  </tr>
  <tr class="expense-subtotal">
    <td>COGS Subtotal</td>
    <td class="num">${fmt(totalCogs)}</td>
    <td class="num">${percentOf(totalCogs,totalCosts)}</td>
    <td class="num">${percentOf(totalCogs,grossSales)}</td>
    <td class="num">${percentOf(totalCogs,netSales)}</td>
    <td class="num">${averagePerOrder(totalCogs)}</td>
  </tr>
  <tr class="expense-total">
    <td>Total Costs incl. COGS</td>
    <td class="num neg">${fmt(totalCosts)}</td>
    <td class="num">${percentOf(totalCosts,totalCosts)}</td>
    <td class="num">${percentOf(totalCosts,grossSales)}</td>
    <td class="num">${percentOf(totalCosts,netSales)}</td>
    <td class="num">${averagePerOrder(totalCosts)}</td>
  </tr>`;
}

// ═══════════════════════════════════════════════════════════
// TAB: SETTLEMENTS
// ═══════════════════════════════════════════════════════════
function buildSettlementsTab(){
  const sd=S.summary||{};
  $('settleKpi').innerHTML=kpiHtml([
    {label:'Total Expected Settlement', value:fmt(sd.totalExpectedSettlement||sd.bankSettlement), sub:'Projected total', icon:'🏦', color:'#00e0b0'},
    {label:'Already Paid',              value:fmt(sd.alreadyPaid||sd.bankSettlement), sub:'In your bank account', icon:'✅', color:'#00e0b0'},
    {label:'Pending',                   value:fmt(sd.pendingSettlement||0), sub:'Yet to be settled', icon:'⏳', color:safe(sd.pendingSettlement)>0?'#ffc849':'#00e0b0'},
  ]);

  // Build settlement batch map from order transactions
  const batchMap={};
  S.orders.forEach(o=>{
    if(!o.txn1Neft||o.txn1Neft.length<3) return;
    const key=o.txn1Neft;
    if(!batchMap[key]) batchMap[key]={neft:key,date:o.txn1Date,type:o.txn1Type,status:o.txn1Status,orders:0,total:0,reason:o.txn1Reason};
    batchMap[key].orders++;
    batchMap[key].total+=safe(o.txn1Amt);
  });

  // Timeline: cumulative settled by date
  const dateAmt={};
  Object.values(batchMap).forEach(b=>{
    if(!b.date) return;
    dateAmt[b.date]=(dateAmt[b.date]||0)+b.total;
  });
  const settleDates=Object.keys(dateAmt).sort();
  let cumulative=0;
  const cumulData=settleDates.map(d=>{ cumulative+=dateAmt[d]; return cumulative; });

  destroyChart('settleTimelineChart');
  S.charts['settleTimelineChart']=new Chart($('settleTimelineChart').getContext('2d'),{
    type:'line',
    data:{labels:settleDates.map(d=>d.slice(5)),datasets:[
      {label:'Cumulative Settled ₹',data:cumulData,calculationRows:settleDates.map(date=>S.orders.filter(order=>order.txn1Date&&order.txn1Date<=date&&order.txn1Neft?.length>=3)),borderColor:'#00e0b0',backgroundColor:α('#00e0b0',0.1),tension:0.4,fill:true},
      {label:'Daily Batch ₹',data:settleDates.map(d=>dateAmt[d]),calculationRows:settleDates.map(date=>S.orders.filter(order=>order.txn1Date===date&&order.txn1Neft?.length>=3)),borderColor:'#7c6fff',backgroundColor:'transparent',tension:0.4,borderDash:[4,4],type:'bar'},
    ]},
    options:{...chartOpts({yPfx:'₹'}),scales:{x:darkAxis(),y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Batch chart
  const topBatches=Object.values(batchMap).sort((a,b)=>Math.abs(b.total)-Math.abs(a.total)).slice(0,12);
  destroyChart('settleBatchChart');
  S.charts['settleBatchChart']=new Chart($('settleBatchChart').getContext('2d'),{
    type:'bar',
    data:{labels:topBatches.map(b=>b.date||b.neft.slice(-10)),datasets:[{
      label:'Batch ₹',
      data:topBatches.map(b=>b.total),
      calculationBatchIds:topBatches.map(b=>b.neft),
      backgroundColor:α('#00e0b0',0.7),
      borderRadius:5,
    }]},
    options:{...chartOpts({yPfx:'₹',legend:false}),scales:{x:{...darkAxis(),ticks:{...darkAxis().ticks,maxRotation:45}},y:{...darkAxis(),ticks:{...darkAxis().ticks,callback:v=>'₹'+v.toLocaleString('en-IN')}}}},
  });

  // Type pie
  const typeMap={};
  Object.values(batchMap).forEach(b=>{ typeMap[b.type||'NA']=(typeMap[b.type||'NA']||0)+Math.abs(b.total); });
  destroyChart('settleTypeChart');
  S.charts['settleTypeChart']=new Chart($('settleTypeChart').getContext('2d'),{
    type:'doughnut',data:{labels:Object.keys(typeMap),datasets:[{
      data:Object.values(typeMap),
      calculationBatchIds:Object.keys(typeMap).map(type=>Object.values(batchMap).filter(batch=>(batch.type||'NA')===type).map(batch=>batch.neft)),
      backgroundColor:PAL,
      hoverOffset:6,
    }]},
    options:dnutOpts('₹'),
  });

  // Table
  $('settleBody').innerHTML=Object.values(batchMap).sort((a,b)=>new Date(b.date)-new Date(a.date)).map(b=>`<tr>
    <td style="font-size:11px">${b.neft}</td>
    <td>${b.date}</td>
    <td>${b.type}</td>
    <td class="num ${b.total>=0?'pos':'neg'}">${fmt(b.total)}</td>
    <td class="num">${fmtN(b.orders)}</td>
    <td>${b.status==='Completed'?'<span class="badge badge-green">Completed</span>':'<span class="badge badge-yellow">Pending</span>'}</td>
  </tr>`).join('');
}

// ═══════════════════════════════════════════════════════════
// TAB: AI INSIGHTS
// ═══════════════════════════════════════════════════════════
function buildInsightsTab(sd,skuM,trueProfit,trueMargin,returnRate,totalCogs){
  const runButton=$('btnRunInsights');
  if(runButton) runButton.onclick=()=>runInsights(sd,skuM,trueProfit,trueMargin,returnRate,totalCogs);
  runInsights(sd,skuM,trueProfit,trueMargin,returnRate,totalCogs);
}

function runInsights(sd,skuM,trueProfit,trueMargin,returnRate,totalCogs){
  const alerts=[], insights=[], recos=[], actions=[];

  // ── Critical alerts ────────────────────────────────────
  if(returnRate>30) alerts.push({type:'critical',icon:'🚨',title:`High Return Rate: ${pct(returnRate)}`,desc:`Your return rate of ${pct(returnRate)} is very high. Industry benchmark for fashion is 20-25%. You are losing revenue and paying reverse shipping on every return.`});
  if(trueMargin<10) alerts.push({type:'critical',icon:'⚠️',title:`Low True Profit Margin: ${pct(trueMargin)}`,desc:`After COGS deduction, margin is only ${pct(trueMargin)}. This is below the minimum 15% recommended for marketplace sustainability.`});
  if(Math.abs(sd.reverseShipping||0)>Math.abs(sd.ads||0)*2) alerts.push({type:'warning',icon:'🚚',title:'Reverse Shipping Exceeds Ads Cost',desc:`You are spending ${fmt(Math.abs(sd.reverseShipping||0))} on reverse logistics vs ${fmt(Math.abs(sd.ads||0))} on ads. Reducing returns would improve margins more than cutting ads.`});

  const highRetSkus=skuM.filter(s=>s.returnRate>35&&s.grossUnits>=5);
  if(highRetSkus.length) alerts.push({type:'warning',icon:'📦',title:`${highRetSkus.length} SKU(s) with >35% Return Rate`,desc:`SKUs: ${highRetSkus.map(s=>s.skuId+' ('+pct(s.returnRate)+')').join(', ')}. These are your highest-risk products.`});

  const negSkus=skuM.filter(s=>s.trueProfit<0&&s.netUnits>0);
  if(negSkus.length) alerts.push({type:'critical',icon:'❌',title:`${negSkus.length} SKU(s) Running at Loss`,desc:`Loss-making SKUs: ${negSkus.map(s=>s.skuId+' ('+fmt(s.trueProfit)+')').join(', ')}. Add COGS in the Costs tab to see accurate figures.`});

  if(trueProfit>0) alerts.push({type:'success',icon:'✅',title:`Business is Profitable: ${fmt(trueProfit)}`,desc:`True net profit this month is ${fmt(trueProfit)} at a ${pct(trueMargin)} margin. Expected settlement is ${fmt(sd.totalExpectedSettlement||sd.bankSettlement)}; ${fmt(sd.pendingSettlement||0)} remains pending.`});

  // ── Insight cards ──────────────────────────────────────
  const topSku=skuM.sort((a,b)=>b.trueProfit-a.trueProfit)[0];
  const worstSku=skuM[skuM.length-1];
  const mostRetSku=skuM.sort((a,b)=>b.returnRate-a.returnRate)[0];
  const totalSellerDisc=Math.abs(sd.sellerDiscount||0);
  const discPctOfRevenue=sd.accountedNetSales?totalSellerDisc/sd.accountedNetSales*100:0;

  insights.push({title:'🏆 Top Performing SKU',points:[
    `Best SKU: ${topSku?.skuId} — True Profit: ${fmt(topSku?.trueProfit)}`,
    `Margin: ${pct(topSku?.margin)}, Return Rate: ${pct(topSku?.returnRate)}`,
    `Scale this SKU. Consider higher ad spend here.`,
  ]});
  insights.push({title:'⚠️ Weakest SKU',points:[
    `Worst SKU: ${worstSku?.skuId} — True Profit: ${fmt(worstSku?.trueProfit)}`,
    `Return Rate: ${pct(worstSku?.returnRate)}, Margin: ${pct(worstSku?.margin)}`,
    `Review listing quality, pricing and images.`,
  ]});
  insights.push({title:'🔄 Return Impact',points:[
    `Total returned units: ${fmtN((sd.grossUnits||0)-(sd.netUnits||0))} out of ${fmtN(sd.grossUnits||0)} gross`,
    `Highest return SKU: ${mostRetSku?.skuId} at ${pct(mostRetSku?.returnRate)}`,
    `Average return cost per unit: ${fmt(Math.abs(sd.reverseShipping||0)/Math.max(1,(sd.grossUnits||0)-(sd.netUnits||0)))}`,
    `Each returned unit costs you COGS + Reverse Ship + Lost revenue`,
  ]});
  insights.push({title:'💰 Discount ROI Analysis',points:[
    `Total seller-funded discount: ${fmt(totalSellerDisc)}`,
    `Discount as % of revenue: ${pct(discPctOfRevenue)}`,
    `Ads spend: ${fmt(Math.abs(sd.ads||0))} (${pct(Math.abs(sd.ads||0)/((sd.accountedNetSales||1))*100)} of revenue)`,
    `Review if discount-driven orders have higher return rates`,
  ]});
  insights.push({title:'🏛️ Tax & ITC Opportunity',points:[
    `GST paid: ${fmt(Math.abs(sd.gst||0))} — claimable via ITC`,
    `TCS paid: ${fmt(Math.abs(sd.tcs||0))} — claimable in income tax`,
    `TDS paid: ${fmt(Math.abs(sd.tds||0))} — claimable in income tax`,
    `Total ITC available: ${fmt(sd.itc||0)} — file on time!`,
  ]});
  insights.push({title:'📊 Revenue Quality',points:[
    `Gross → Net conversion: ${pct((sd.netSales||0)/(sd.grossSales||1)*100)}`,
    `Seller discount reduces effective revenue by ${pct(discPctOfRevenue)}`,
    `Platform takes ${pct(Math.abs(sd.totalExpenses||0)/(sd.accountedNetSales||1)*100)} of your net sales`,
    `Your COGS represents ${pct(totalCogs/(sd.accountedNetSales||1)*100)} of net sales`,
  ]});

  // ── Recommendations ────────────────────────────────────
  recos.push({icon:'📉',title:'Reduce Return Rate',desc:`Focus on ${mostRetSku?.skuId}. Improve product images, size charts and descriptions. Target <20% return rate.`});
  recos.push({icon:'💸',title:'Optimise Seller Discounts',desc:`You're spending ${fmt(totalSellerDisc)} on discounts. A/B test which SKUs truly need discounts to convert.`});
  recos.push({icon:'📈',title:'Scale Top SKU',desc:`${topSku?.skuId} has the best economics. Increase inventory, run targeted ads, and consider variations.`});
  recos.push({icon:'🏛️',title:'File ITC Monthly',desc:`Don't miss ${fmt(sd.itc||0)} in claimable taxes. Ensure GST filings are done before due dates.`});
  recos.push({icon:'🎯',title:'Improve Conversion',desc:`${pct(returnRate)} of orders return. If you can reduce this by 5 percentage points, you save ₹${((sd.grossUnits||0)*0.05*(sd.reverseShipping||0)/Math.max(1,(sd.grossUnits||0)-(sd.netUnits||0))).toFixed(0)} in reverse logistics alone.`});

  // ── Actions ─────────────────────────────────────────────
  actions.push({text:'Review listing content for high-return SKUs',priority:'high'});
  actions.push({text:'File GST return to claim ₹'+fmt(Math.abs(sd.gst||0))+' ITC',priority:'high'});
  actions.push({text:'Audit seller-funded discount ROI per SKU',priority:'med'});
  actions.push({text:'Increase stock for '+topSku?.skuId,priority:'high'});
  actions.push({text:'Review pricing for loss-making SKUs',priority:'high'});
  actions.push({text:'Enable size charts / better images for RVP-heavy SKUs',priority:'med'});
  actions.push({text:'Set up weekly settlement reconciliation',priority:'med'});
  actions.push({text:'Export SKU analysis CSV and share with sourcing team',priority:'low'});

  // Render
  $('alertsSection').innerHTML=alerts.map(a=>`
    <div class="alert-card ${a.type}">
      <div class="alert-icon">${a.icon}</div>
      <div class="alert-content">
        <div class="alert-title">${a.title}</div>
        <div class="alert-desc">${a.desc}</div>
      </div>
    </div>`).join('');

  $('insightsGrid').innerHTML=insights.map(ins=>`
    <div class="insight-card">
      <h4>${ins.title}</h4>
      <ul class="insight-list">${ins.points.map(p=>`<li>${p}</li>`).join('')}</ul>
    </div>`).join('');

  const recosSection=$('recommendationsSection');
  recosSection.innerHTML=`<h3 style="font-size:16px;font-weight:700;margin-bottom:8px;">🎯 Strategic Recommendations</h3>
    <div class="reco-grid">${recos.map(r=>`
      <div class="reco-card">
        <div class="reco-icon">${r.icon}</div>
        <h5>${r.title}</h5>
        <p>${r.desc}</p>
      </div>`).join('')}</div>`;

  $('actionItems').innerHTML=`<ul class="action-list">${actions.map((a,i)=>{
    const done=S.actionsDone[i]||false;
    const pc=a.priority==='high'?'priority-high':a.priority==='med'?'priority-med':'priority-low';
    return `<li class="action-item" onclick="toggleAction(${i})">
      <input type="checkbox" ${done?'checked':''} id="act_${i}" onclick="event.stopPropagation();toggleAction(${i})" />
      <label id="lbl_act_${i}" class="${done?'done':''}" for="act_${i}">${a.text}</label>
      <span class="action-priority ${pc}">${a.priority.toUpperCase()}</span>
    </li>`;}).join('')}</ul>`;
}
window.toggleAction=i=>{
  S.actionsDone[i]=!S.actionsDone[i];
  const cb=document.getElementById('act_'+i), lb=document.getElementById('lbl_act_'+i);
  if(cb) cb.checked=S.actionsDone[i];
  if(lb) lb.className=S.actionsDone[i]?'done':'';
};

// ═══════════════════════════════════════════════════════════
// TAB: EDIT COSTS
// ═══════════════════════════════════════════════════════════
function buildEditCostsTab(skuM){
  buildCostTable('costTableDashBody');
}

// ═══════════════════════════════════════════════════════════
// EXPORTS
// ═══════════════════════════════════════════════════════════
function getOrdersForReturnType(type){
  const field=type==='RTO'?'rtoUnits':type==='RVP'?'rvpUnits':'cancelUnits';
  return S.orders.filter(order=>safe(order[field])>0);
}

function exportReturnCalculations(type){
  const orders=getOrdersForReturnType(type);
  const rows=[[
    'Date','Order ID','Order Item ID','SKU','Status','Return Type','Units',
    'Order Item Value','Original Sale Value','Bank Settlement','Settlement Loss',
    'Product Cost / Unit','Count Product Cost as Loss','Product Cost Loss',
    'Packing Cost / Unit','Packing Loss','Total Loss','Calculation',
  ]];
  orders.forEach(order=>{
    const impact=calculateReturnImpact(order,type);
    const productCost=(S.costs[order.sku]||DEFAULT_COSTS).product;
    const formula=type==='RVP'
      ?`MAX(0,-Bank Settlement) + IF(Product Cost as Loss, Product Cost/Unit * Units, 0) + ${RETURN_PACKING_COST} * Units`
      :`${RETURN_PACKING_COST} * Units`;
    rows.push([
      order.date,order.orderId,order.itemId,order.sku,order.status,type,impact.units,
      safe(order.oiv),impact.originalSale,safe(order.bankSettlement),impact.settlementLoss,
      productCost,impact.productCostLost?'Yes':'No',impact.productCogsLost,
      RETURN_PACKING_COST,impact.packingLoss,impact.totalLoss,formula,
    ]);
  });
  const filename=type==='CANCELLED'?'cancellation_loss_calculations.csv':`${type.toLowerCase()}_loss_calculations.csv`;
  downloadText(rows.map(row=>row.map(csvCell).join(',')).join('\n'),filename,'text/csv');
}

function exportReturnSummaryCalculations(){
  const types=[
    {label:'RTO',type:'RTO'},
    {label:'RVP',type:'RVP'},
    {label:'Cancellations',type:'CANCELLED'},
  ];
  const rows=[
    ['Report Period',safeStr(S.summary?.period)],
    [],
    ['Return Type','Order Rows','Units','Settlement Loss','Product Cost Loss','Orders Counting Product Loss','Packing Loss','Total Loss','Calculation'],
  ];
  types.forEach(({label,type})=>{
    const impacts=getOrdersForReturnType(type).map(order=>calculateReturnImpact(order,type));
    const units=impacts.reduce((sum,impact)=>sum+impact.units,0);
    const settlement=impacts.reduce((sum,impact)=>sum+impact.settlementLoss,0);
    const product=impacts.reduce((sum,impact)=>sum+impact.productCogsLost,0);
    const productOrders=impacts.filter(impact=>impact.productCostLost).length;
    const packing=impacts.reduce((sum,impact)=>sum+impact.packingLoss,0);
    const total=impacts.reduce((sum,impact)=>sum+impact.totalLoss,0);
    const formula=type==='RVP'
      ?'MAX(0,-Bank Settlement) + enabled product cost + ₹5 * RVP units'
      :'₹5 * returned/cancelled units';
    rows.push([label,impacts.length,units,settlement,product,productOrders,packing,total,formula]);
  });
  const rvpOrders=getOrdersForReturnType('RVP');
  const averageReverseShipping=rvpOrders.length?Math.abs(safe(S.summary?.reverseShipping))/rvpOrders.length:0;
  rows.push([]);
  rows.push(['Additional metric','Value','Calculation']);
  rows.push(['Average RVP reverse shipping per order',averageReverseShipping,`ABS(Summary reverse shipping ${safe(S.summary?.reverseShipping)}) / ${rvpOrders.length} RVP order rows`]);
  downloadText(rows.map(row=>row.map(csvCell).join(',')).join('\n'),'returns_summary_calculations.csv','text/csv');
}

function exportTableCSV(tableId, filename){
  const tbl=document.getElementById(tableId);
  if(!tbl) return;
  const rows=[...tbl.querySelectorAll('tr')];
  const csv=rows.map(r=>[...r.querySelectorAll('th,td')].map(c=>'"'+c.innerText.replace(/"/g,'""')+'"').join(',')).join('\n');
  downloadText(csv,filename,'text/csv');
}

function exportOrdersCSV(){
  const hdr=['Date','OrderID','SKU','Channel','Payment','Status','NetUnits','FSP','SellerDisc','AccNetSales','Expenses','RevShip','Taxes','Settlement','COGS','TrueProfit'];
  const rows=S.ordersFiltered.map(o=>{
    const c=S.costs[o.sku]||DEFAULT_COSTS;
    const cogs=(c.product+c.packing+(c.other||0))*safe(o.netUnits);
    const tp=orderTrueProfit(o);
    const expenses=Math.abs(safe(o.expenses)+safe(o.sharedExpenseAllocation));
    return [o.date,o.orderId,o.sku,o.channel,o.payment,o.status,o.netUnits,o.fsp,Math.abs(o.sellerDisc||safe(o.sellerDiscount)||0),o.accNetSales,expenses,Math.abs(o.revShipping),o.taxes||0,o.bankSettlement,cogs,tp].map(csvCell).join(',');
  });
  downloadText([hdr.join(','),...rows].join('\n'),'orders_export.csv','text/csv');
}

function downloadText(text, filename, mime){
  const a=document.createElement('a');
  a.href=URL.createObjectURL(new Blob([text],{type:mime}));
  a.download=filename; a.click();
  setTimeout(()=>URL.revokeObjectURL(a.href),1000);
}

// Export all handler
$('btnExportAll')?.addEventListener('click',()=>{
  exportTableCSV('skuDetailTable','sku_deep_dive.csv');
  setTimeout(()=>exportOrdersCSV(),500);
  setTimeout(()=>exportTableCSV('rtoTable','rto_returns.csv'),1000);
  setTimeout(()=>exportTableCSV('rvpTable','rvp_returns.csv'),1500);
  setTimeout(()=>exportTableCSV('cancelTable','cancellations.csv'),2000);
});

// AI Modal
$('btnAiSummary')?.addEventListener('click',()=>showAiModal());
$('closeAiModal')?.addEventListener('click',()=>hide('aiModal'));
$('btnCopyAi')?.addEventListener('click',()=>{ navigator.clipboard?.writeText($('aiModalBody')?.innerText); alert('Copied!'); });
$('btnDownloadAi')?.addEventListener('click',()=>downloadText($('aiModalBody')?.innerText||'','ai_summary.txt','text/plain'));

function showAiModal(){
  const sd=S.summary||{};
  const skuM=computeSKU();
  const totalCogs=skuM.reduce((a,m)=>a+m.totalCogs,0);
  const trueProfit=(sd.bankSettlement||0)-totalCogs;
  const trueMargin=sd.accountedNetSales?(trueProfit/sd.accountedNetSales)*100:0;
  const retRate=sd.grossUnits?((sd.grossUnits-sd.netUnits)/sd.grossUnits)*100:0;
  const topSku=skuM.sort((a,b)=>b.trueProfit-a.trueProfit)[0];

  $('aiModalBody').textContent=`CLADUS P&L AI SUMMARY
Report Period: ${sd.period||'Unknown'}
Generated: ${new Date().toLocaleString()}

═══════════════════════════════════════
EXECUTIVE SUMMARY
═══════════════════════════════════════
Gross Sales:            ${fmt(sd.grossSales)} (${fmtN(sd.grossUnits)} units)
Returns & Cancels:      ${fmt(Math.abs(sd.returnsCancelAmt||0))} (${fmtN(Math.abs(sd.returnsCancelUnits||0))} units)
Seller-Funded Discount: ${fmt(Math.abs(sd.sellerDiscount||0))}
Accounted Net Sales:    ${fmt(sd.accountedNetSales)}
Total Platform Expenses:${fmt(Math.abs(sd.totalExpenses||0))}
Your COGS:              ${fmt(totalCogs)}
Bank Settlement:        ${fmt(sd.bankSettlement)}
TRUE NET PROFIT:        ${fmt(trueProfit)}
TRUE MARGIN:            ${pct(trueMargin)}
Return Rate:            ${pct(retRate)}
ITC Claimable:          ${fmt(sd.itc||0)}

═══════════════════════════════════════
EXPENSE BREAKDOWN
═══════════════════════════════════════
Reverse Shipping: ${fmt(Math.abs(sd.reverseShipping||0))}
Commission Fee:   ${fmt(Math.abs(sd.commissionFee||0))}
Fixed Fee:        ${fmt(Math.abs(sd.fixedFee||0))}
Ads:              ${fmt(Math.abs(sd.ads||0))}
GST:              ${fmt(Math.abs(sd.gst||0))}
TCS:              ${fmt(Math.abs(sd.tcs||0))}
TDS:              ${fmt(Math.abs(sd.tds||0))}

═══════════════════════════════════════
SKU PERFORMANCE
═══════════════════════════════════════
${skuM.map(s=>`${s.skuId}: Net=${fmtN(s.netUnits)} Ret=${pct(s.returnRate)} Profit=${fmt(s.trueProfit)} Margin=${pct(s.margin)}`).join('\n')}

═══════════════════════════════════════
KEY RECOMMENDATIONS
═══════════════════════════════════════
1. Best SKU: ${topSku?.skuId} (${fmt(topSku?.trueProfit)} profit) — Scale this.
2. Return rate ${pct(retRate)} needs attention — focus on top-return SKUs.
3. Claim ${fmt(sd.itc||0)} ITC in your GST filing.
4. Seller discounts costing ${fmt(Math.abs(sd.sellerDiscount||0))} — review ROI.
5. Net profit ${trueProfit>=0?'positive ✅':'negative ❌ — review COGS and pricing.'}.`;

  show('aiModal');
}

import React, { useEffect, useRef, useState } from 'react';
import Admin from './Admin.jsx';
import { planGoal } from './plan.js';

const fmt = n => Math.round(n).toLocaleString('en-US');
const energy = i => Math.round(i.grams * i.kcalPer100g / 100);
const total = items => items.reduce((sum, i) => sum + energy(i), 0);
const today = (d = new Date()) => { return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
const nowTime = () => new Date().toTimeString().slice(0,5);
const sourceLabel = i => `${i.matched ? '本機庫 · ' : ''}${({manual:'手動資料',web:'網路資料',llm:'LLM 估算',label:'營養標示'})[i.source] || '待確認'}`;
// 本機食物庫的來源分類：匯入資料集看 sourceTitle（食藥署／國健署／品牌官方表），其餘依 source。
const foodGroup = f => { const t = f.sourceTitle || ''; return /食藥署|國健署/.exec(t)?.[0] || (/官方|營養標示表/.test(t) ? t.split(' ')[0].replace('台灣', '') : sourceLabel({ source: f.source })); };

async function compressPhoto(file) {
  if (!file || !file.type.startsWith('image/')) throw new Error('請選擇圖片。');
  if (file.size > 25 * 1024 * 1024) throw new Error('原始照片需小於 25 MB。');
  const url = URL.createObjectURL(file);
  try {
    const image = new Image(); image.src = url; await image.decode();
    const scale = Math.min(1, 1280 / Math.max(image.width, image.height));
    const canvas = document.createElement('canvas'); canvas.width = Math.round(image.width*scale); canvas.height = Math.round(image.height*scale);
    const ctx = canvas.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0,0,canvas.width,canvas.height); ctx.drawImage(image,0,0,canvas.width,canvas.height);
    const data = canvas.toDataURL('image/jpeg', .82);
    if (data.length > 3_000_000) throw new Error('照片壓縮後仍過大，請選較小的照片。');
    return data;
  } catch (error) { throw new Error(error.message.includes('過大') ? error.message : '無法讀取照片，請先轉成 JPG 或 PNG。'); }
  finally { URL.revokeObjectURL(url); }
}

const Flame = () => <svg className="flame" viewBox="0 0 16 19" width="15" height="18" aria-hidden="true"><defs><linearGradient id="flame-g" x1="0" y1="1" x2="0" y2="0"><stop offset="0" stopColor="#D2603A"/><stop offset=".55" stopColor="#E8875A"/><stop offset="1" stopColor="#EED7C4"/></linearGradient></defs><path fill="url(#flame-g)" d="M8 0C9 4 14 7 14 12.5A6 6 0 0 1 2 12.5C2 9.5 4 8 4.5 5.5C6 7 6.5 8.5 6.5 9.5C7.5 7 8.5 4 8 0Z"/><path className="flame-in" fill="#FBE3A0" d="M8 10C9.5 12 11 13 11 15A3 3 0 0 1 5 15C5 13.5 6.5 12.5 8 10Z"/></svg>;

function Camera({ onBack, onPhoto, onAlbum }) {
  const video = useRef(null); const stream = useRef(null); const [error,setError] = useState(''); const [ready,setReady] = useState(false);
  useEffect(() => {
    let alive = true;
    if (!navigator.mediaDevices?.getUserMedia) { setError('這個瀏覽器無法開啟相機，請改選照片。'); return; }
    navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false}).then(s => {
      if (!alive) { s.getTracks().forEach(t=>t.stop()); return; }
      stream.current=s; video.current.srcObject=s;
    }).catch(()=>setError('無法開啟相機，請允許相機權限，或從相簿選擇照片。'));
    return ()=>{alive=false;stream.current?.getTracks().forEach(t=>t.stop());};
  },[]);
  async function shoot() {
    const v=video.current;if(!v?.videoWidth)return;
    const c=document.createElement('canvas');c.width=v.videoWidth;c.height=v.videoHeight;c.getContext('2d').drawImage(v,0,0);
    const blob=await new Promise(resolve=>c.toBlob(resolve,'image/jpeg',.9));
    if(blob)onPhoto(blob);
  }
  return <div className="camera screen"><nav><button className="round" onClick={onBack}>✕</button><b>拍下這一餐</b><span/></nav>
    <div className="camera-view"><video ref={video} autoPlay playsInline muted onLoadedMetadata={()=>setReady(true)}/><div className="viewfinder"/>{error&&<p className="camera-error">{error}</p>}</div>
    <div className="shutter-row"><button onClick={onAlbum}>相簿</button><button className="shutter" aria-label="拍照" disabled={!ready} onClick={shoot}/><span/></div></div>;
}

export default function App() {
  const [screen,setScreen]=useState('home');
  const [status,setStatus]=useState(null); const [models,setModels]=useState([]);
  const [settings,setSettings]=useState({goal:1800,fallback:'web',model:''});
  const [day,setDay]=useState(today); const [meals,setMeals]=useState([]); const [week,setWeek]=useState([]); const [since,setSince]=useState(''); const [streak,setStreak]=useState(0);
  const [text,setText]=useState(''); const [photo,setPhoto]=useState('');
  const [draft,setDraft]=useState(null); const [detail,setDetail]=useState(null); const [steps,setSteps]=useState([]); const [estimating,setEstimating]=useState([]); const [relookups,setRelookups]=useState([]);
  const [busy,setBusy]=useState(false); const [jobId,setJobId]=useState(null); const [jobs,setJobs]=useState([]); const [jobsOpen,setJobsOpen]=useState(false); const [saving,setSaving]=useState(false); const [error,setError]=useState(''); const [toast,setToast]=useState('');
  const [foods,setFoods]=useState([]); const [query,setQuery]=useState(''); const [group,setGroup]=useState('全部'); const [picking,setPicking]=useState(false);
  const [providers,setProviders]=useState([]); const [claudeKey,setClaudeKey]=useState(null); // null：key 輸入框收起
  const [goalInput,setGoalInput]=useState('1800'); const [planForm,setPlanForm]=useState(null); const [planStep,setPlanStep]=useState(1);
  const [theme,setTheme]=useState(()=>{try{const v=localStorage.getItem('theme');return v==='light'||v==='dark'?v:'system';}catch{return 'system';}});
  const album=useRef(null); const threadEnd=useRef(null); const pane=useRef(null); const drag=useRef(null); const lastInput=useRef(null);
  const csrf=useRef(''); const active=status?.accounts.find(a=>a.client_id===status.activeId);
  const sum=meals.reduce((s,m)=>s+m.kcal,0); const remaining=settings.goal-sum;
  const filteredFoods=foods.filter(f=>(f.name+' '+f.aliases.join(' ')).toLowerCase().includes(query.toLowerCase())&&(group==='全部'||foodGroup(f)===group));
  const groups=Object.entries(foods.reduce((c,f)=>{const g=foodGroup(f);c[g]=(c[g]||0)+1;return c;},{})).sort((a,b)=>b[1]-a[1]);

  async function api(url, body, method) {
    const response=await fetch(url,{method:method || (body!==undefined?'POST':'GET'),
      headers:body!==undefined || method==='DELETE'?{'Content-Type':'application/json','X-CSRF-Token':csrf.current}:{},
      ...(body!==undefined?{body:JSON.stringify(body)}:{})});
    const data=await response.json();
    if(!response.ok)throw new Error(data.error || `要求失敗 (${response.status})`);
    return data;
  }
  const notify=message=>{setToast(message);};
  useEffect(()=>{if(!toast)return;const t=setTimeout(()=>setToast(''),3500);return()=>clearTimeout(t);},[toast]);
  async function loadJournal(date=day,keepWeek) {
    const data=await api('/api/journal?day='+date+'&today='+today());setMeals(data.meals);if(!keepWeek)setWeek(data.week);setSince(data.since||today());setStreak(data.streak);setSettings(data.settings);setGoalInput(String(data.settings.goal));
    return data;
  }
  async function loadAccount() {
    const state=await api('/api/status');csrf.current=state.csrf;setStatus(state);
    const a=state.accounts.find(x=>x.client_id===state.activeId);
    if(!state.remote)api('/api/providers').then(d=>setProviders(d.providers)).catch(()=>{});
    if(a?.signedIn&&a.planEnabled){const list=await api('/api/models');setModels(list.models);return list.models;}
    setModels([]);return [];
  }
  useEffect(()=>{
    const params=new URLSearchParams(location.search);if(params.has('login_error')){setError(params.get('login_error'));setScreen('settings');}
    window.history.replaceState({},'', '/');
    (async()=>{
      const state=await api('/api/status');csrf.current=state.csrf;setStatus(state);
      const data=await loadJournal();
      const list=await loadAccount();
      if(list.length&&!list.some(m=>m.slug===data.settings.model)){
        const next=await api('/api/settings',{model:list[0].slug});setSettings(next);
      }
    })().catch(e=>setError(e.message));
  },[]);
  // 外觀存在這台裝置；「跟隨系統」時隨系統深淺色切換。
  useEffect(()=>{
    try{localStorage.setItem('theme',theme);}catch{}
    const media=matchMedia('(prefers-color-scheme: dark)');
    const apply=()=>{const root=document.documentElement;root.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;
      document.querySelector('meta[name=theme-color]')?.setAttribute('content',getComputedStyle(root).getPropertyValue('--bg').trim());};
    apply();media.addEventListener('change',apply);return()=>media.removeEventListener('change',apply);
  },[theme]);
  useEffect(()=>{threadEnd.current?.scrollIntoView({behavior:'smooth'});},[steps,busy]);
  // 換日後重新載入，避免午夜後仍把新紀錄放在昨天。
  useEffect(()=>{let old=today();const go=d=>{setDay(d);loadJournal(d).catch(e=>setError(e.message));};const t=setInterval(()=>{const next=today();if(next!==old){if(day===old)go(next);old=next;}},30000);const wake=()=>{if(document.visibilityState!=='visible')return;if(day===today())refreshJobs();else{go(today());loadJobs().catch(()=>{});}};document.addEventListener('visibilitychange',wake);addEventListener('pageshow',wake);return()=>{clearInterval(t);document.removeEventListener('visibilitychange',wake);removeEventListener('pageshow',wake);};},[day]);
  async function chooseDay(value,keepWeek){setDay(value);try{await loadJournal(value,keepWeek);setScreen('home');}catch(e){setError(e.message);}}
  // Horizontal swipe that follows the finger. pick(dir) gets -1 (finger left) / 1 (finger right) and returns the action to run, or nothing to resist and spring back.
  function swipe(pick){
    const move=(x,ms)=>{const n=pane.current;if(!n)return;n.style.transition=ms?'transform '+ms+'ms cubic-bezier(.2,.8,.2,1)':'';n.style.transform=x?'translate3d('+x+'px,0,0)':'';};
    const still=matchMedia('(prefers-reduced-motion: reduce)').matches;
    return {ref:pane,onTouchCancel:()=>{if(drag.current?.lock){drag.current=null;move(0,250);}},
      onTouchStart:e=>{const t=e.touches[0];if(!drag.current?.busy)drag.current=e.touches.length>1||e.target.closest('.composer,input,textarea,select')?null:{x:t.clientX,y:t.clientY,t:e.timeStamp,dx:0,v:0};},
      onTouchMove:e=>{const s=drag.current,t=e.touches[0];if(!s||s.busy)return;const dx=t.clientX-s.x,dy=t.clientY-s.y;if(!s.lock){if(Math.hypot(dx,dy)<10)return;if(Math.abs(dx)<=Math.abs(dy)){drag.current=null;return;}s.lock=true;}s.v=(dx-s.dx)/Math.max(1,e.timeStamp-s.t);s.dx=dx;s.t=e.timeStamp;if(!still)move(pick(Math.sign(dx))?dx:dx/4);},
      onTouchEnd:()=>{const s=drag.current;if(!s?.lock)return;drag.current=null;const w=pane.current.offsetWidth,dir=Math.sign(s.dx),go=(Math.abs(s.dx)>w/4||s.v*dir>.5)&&pick(dir);if(!go)return move(0,250);if(still)return go();
        drag.current={busy:true};move(dir*w,250);setTimeout(()=>Promise.resolve(go()).finally(()=>requestAnimationFrame(()=>{move(-dir*w);pane.current?.offsetWidth;move(0,250);drag.current=null;})),250);}};
  }
  const shiftDay=n=>{const d=new Date(day+'T12:00:00');d.setDate(d.getDate()+n);const target=today(d);return ()=>chooseDay(target,week.some(h=>h.day===target));};
  async function selectPhoto(file){setError('');try{const data=await compressPhoto(file);setPhoto(data);setText('');setScreen('compose');}catch(e){setError(e.message);}}
  function goHome(){setBusy(false);setScreen('home');setError('');}
  function manualDraft(){setError('');setPhoto('');setText('');lastInput.current=null;setDraft({name:'',day,time:nowTime(),photo:'',items:[],note:'',warnings:[]});setSteps([]);setScreen('result');}
  // 辨識在伺服器背景執行：離開畫面只停止輪詢，不會取消；完成時伺服器直接記錄餐點，之後可再編輯。
  async function analyze(input={text,photo}) {
    if(!input.text.trim()&&!input.photo)return;
    if(needModel()){setScreen('settings');return;}
    lastInput.current=input;setPhoto(input.photo);setText(input.text);setError('');setSteps([]);setDraft(null);setJobId(null);setBusy(true);setScreen('result');
    try{const {id}=await api('/api/analyze',{...input,model:settings.model,fallback:settings.fallback});setJobId(id);}catch(e){setBusy(false);setError(e.message);}
  }
  async function loadJobs(){const data=await api('/api/jobs');setJobs(data.jobs);return data.jobs;}
  const dropJob=id=>api('/api/jobs/'+id,undefined,'DELETE').then(()=>setJobs(js=>js.filter(j=>j.id!==id)));
  function showJob(j){setSteps(s=>s.length===j.steps.length?s:j.steps);if(j.status==='running')return;setBusy(false);
    if(j.status==='error')setError(j.error||'分析未完成，請重試。');else showSaved(j);}
  // 完成的辨識已由伺服器存成餐點：載入當天日誌、移除辨識紀錄，打開這筆餐點。
  async function showSaved(j){try{const m=await api('/api/meals/'+j.mealId);setDay(m.day);await loadJournal(m.day);await dropJob(j.id).catch(()=>{});setText('');setPhoto('');setDetail(m);setScreen('detail');setError('');notify(`${j.kind==='relookup'?'已更新':'已自動記錄'}「${m.name}」 +${fmt(m.kcal)} kcal`);}catch(e){setError(e.message);}}
  async function openJob(id){try{const j=await api('/api/jobs/'+id);lastInput.current={text:j.text||'',photo:j.photo||''};setPhoto(j.photo||'');setText(j.text||'');setError('');setDraft(null);setSteps([]);setJobId(id);setBusy(true);setScreen('result');showJob(j);}catch(e){setError(e.message);}}
  async function retryJob(id){try{const j=await api('/api/jobs/'+id);await dropJob(id);analyze({text:j.text||'',photo:j.photo||''});}catch(e){setError(e.message);}}
  async function cancelJob(){try{await dropJob(jobId);setBusy(false);setJobId(null);setError('已取消辨識，尚未新增紀錄。');}catch(e){setError(e.message);}}
  // 結果畫面開著且辨識中才輪詢；用不含照片的清單，順便更新首頁狀態。
  useEffect(()=>{if(screen!=='result'||!busy||!jobId)return;let stop=false;
    const tick=()=>loadJobs().then(list=>{if(stop)return;const j=list.find(x=>x.id===jobId);if(!j)throw new Error('找不到這筆辨識，可能已被刪除。');showJob(j);}).catch(e=>{if(!stop){setBusy(false);setError(e.message);}});
    tick();const t=setInterval(tick,1500);return()=>{stop=true;clearInterval(t);};},[screen,busy,jobId]);
  const jobCount=status=>jobs.filter(j=>j.status===status).length; const jobsRunning=jobCount('running')>0;
  // 首頁更新辨識清單；有已自動記錄的辨識就重新載入日誌，讓新餐點出現。
  const refreshJobs=()=>loadJobs().then(list=>list.some(j=>j.status==='done')&&loadJournal()).catch(()=>{});
  useEffect(()=>{if(screen!=='home')return;refreshJobs();if(!jobsRunning)return;const t=setInterval(refreshJobs,5000);return()=>clearInterval(t);},[screen,jobsRunning,day]);
  function editItem(index,patch){setDraft(d=>({...d,items:d.items.map((i,k)=>k===index?{...i,...patch}:i)}));}
  // 對應到本機庫的項目改回辨識名稱；熱量需重新填寫，原對應項目保留為可選的相近項目。
  function notSame(index){const i=draft.items[index];const food={id:i.foodId,name:i.name,aliases:i.aliases,kcalPer100g:i.kcalPer100g,source:i.source,sourceUrl:i.sourceUrl,sourceTitle:i.sourceTitle,notes:i.notes};
    editItem(index,{name:i.recognizedName,aliases:[],kcalPer100g:0,source:'manual',sourceUrl:'',sourceTitle:'',notes:'',matched:false,foodId:'',recognizedName:'',cache:false,similar:[food]});
    notify('請填入這項的每100g熱量，或從食物庫選擇。');}
  function useSame(index,f){const i=draft.items[index];editItem(index,{...f,id:i.id,foodId:f.id,grams:i.grams,matched:true,cache:false,recognizedName:i.recognizedName||i.name,similar:[]});}
  // 單項「AI 估算」：名稱當成文字描述跑完整分析，拆成的多項（各自估份量）取代這一項。
  // 伺服器回報有可用的 AI 服務即可；舊版伺服器沒有 providersReady 時沿用 ChatGPT 登入＋模型檢查。
  function needModel(){if(status?.providersReady??(active?.signedIn&&active.planEnabled&&settings.model))return false;setError(status?.providersError||'尚無可用的 AI 服務：請先登入 ChatGPT 並選擇模型，或設定 Claude API key；也可以回首頁手動記錄。');return true;}
  async function estimate(item){if(needModel())return;
    setError('');setEstimating(s=>[...s,item.id]);
    try{const r=await api('/api/estimate',{name:item.name,model:settings.model,fallback:settings.fallback,id:item.id,grams:Number(item.grams)||100});
      setDraft(d=>d&&{...d,warnings:[...(d.warnings||[]),...r.warnings],items:d.items.flatMap(i=>i.id!==item.id?[i]:r.items)});}
    catch(e){setError(e.message);}finally{setEstimating(s=>s.filter(id=>id!==item.id));}}
  // 「以新名稱重新查詢」：先存下草稿（名稱才會保留），再交給背景工作重查這一項；完成後伺服器直接更新這筆餐點。
  async function relookup(item){if(needModel())return;setError('');setRelookups(r=>[...r,{itemId:item.id,name:item.name}]);
    try{const m=await saveDraft(draft);setDraft(d=>d&&{...d,id:m.id});const {id}=await api('/api/jobs/relookup',{mealId:m.id,itemId:item.id,name:item.name,model:settings.model,fallback:settings.fallback});
      setRelookups(r=>r.map(x=>x.itemId===item.id?{...x,id}:x));}
    catch(e){setError(e.message);setRelookups(r=>r.filter(x=>x.itemId!==item.id));}}
  // 結果畫面開著才輪詢重新查詢；離開只停止輪詢，工作照常在背景完成。
  useEffect(()=>{if(screen!=='result'||!relookups.some(r=>r.id))return;let stop=false;const end=r=>setRelookups(x=>x.filter(y=>y.id!==r.id));
    const tick=()=>loadJobs().then(list=>relookups.filter(r=>r.id).forEach(async r=>{const j=list.find(x=>x.id===r.id);if(stop||j?.status==='running')return;end(r);
      if(!j)return;if(j.status==='error')return setError(j.error||'重新查詢失敗，請重試。');
      try{const m=await api('/api/meals/'+j.mealId);const saved=m.items.find(i=>i.id===r.itemId);setDraft(d=>d?.id===m.id&&saved?{...d,warnings:[...(d.warnings||[]),...(j.result?.warnings||[])],items:d.items.map(i=>i.id===saved.id?saved:i)}:d);await dropJob(j.id).catch(()=>{});notify(`已更新「${r.name}」`);}catch(e){setError(e.message);}})).catch(()=>{});
    tick();const t=setInterval(tick,1500);return()=>{stop=true;clearInterval(t);};},[screen,relookups]);
  function addManual(){setDraft(d=>({...d,items:[...d.items,{id:crypto.randomUUID(),name:'',grams:100,kcalPer100g:0,source:'manual',aliases:[],notes:'',sourceUrl:'',sourceTitle:'',cache:false,matched:false}]}));}
  const saveDraft=d=>api('/api/meals',{...d,items:d.items.map(i=>({...i,grams:Number(i.grams),kcalPer100g:Number(i.kcalPer100g)}))});
  async function save(){if(saving)return;const zero=draft.items.filter(i=>!Number(i.kcalPer100g)).length;if(zero&&!window.confirm(`有 ${zero} 項熱量是 0，確定要存嗎？`))return;setSaving(true);setError('');try{
    const result=await saveDraft(draft);setDay(result.day);await loadJournal(result.day);setDraft(null);setText('');setPhoto('');setScreen('home');notify(`已記下「${result.name}」 +${fmt(result.kcal)} kcal`);
  }catch(e){setError(e.message);}finally{setSaving(false);}}
  async function openMeal(id){try{setDetail(await api('/api/meals/'+id));setScreen('detail');setError('');}catch(e){setError(e.message);}}
  async function removeMeal(){if(!window.confirm('刪除這筆餐點紀錄？'))return;try{await api('/api/meals/'+detail.id,undefined,'DELETE');setJobs(js=>js.filter(j=>!(j.status==='done'&&j.mealId===detail.id)));await loadJournal();setScreen('home');notify('已刪除紀錄');}catch(e){setError(e.message);}}
  async function openFoods(pick=false){setPicking(pick);setQuery('');setError('');try{setFoods((await api('/api/foods')).foods);setScreen('foods');}catch(e){setError(e.message);}}
  function pickFood(f){setDraft(d=>({...d,items:[...d.items,{...f,id:crypto.randomUUID(),foodId:f.id,grams:100,matched:true,cache:false}]}));setScreen('result');}
  // AI 服務鏈：先更新畫面，失敗就還原。key 只在送出時帶上，伺服器不會回傳。
  async function saveProviders(list,extra){const prev=providers;setProviders(list);
    try{const d=await api('/api/providers',{providers:list.map(({id,enabled,model})=>({id,enabled,model})),...extra});setProviders(d.providers);setStatus(s=>s&&{...s,providersReady:d.providers.some(p=>p.enabled&&p.ready)});notify('AI 服務已更新');return true;}
    catch(e){setProviders(prev);setError(e.message);return false;}}
  const editProvider=(id,patch)=>saveProviders(providers.map(p=>p.id===id?{...p,...patch}:p));
  const moveProvider=(i,d)=>{const list=[...providers];[list[i],list[i+d]]=[list[i+d],list[i]];saveProviders(list);};
  async function changeSetting(patch,message='設定已保存'){try{const next=await api('/api/settings',patch);setSettings(next);setGoalInput(String(next.goal));notify(message);return next;}catch(e){setError(e.message);}}
  // 減重目標：未編輯前顯示已存的 plan；表單保留輸入字串，全部是有效數字時才估算。
  // 已存 plan 且未編輯時顯示倒數摘要；startDate 讓剩餘天數從開始日倒數，不進表單。
  const {startDate:planStart,rate:_rate,...savedPlan}=settings.plan||{}; // rate：舊版每週速度欄位，已不使用
  const planInput=planForm||Object.fromEntries(Object.entries({sex:'f',activity:1.2,age:'',height:'',weight:'',target:'',...savedPlan}).map(([k,v])=>[k,String(v)]));
  const saved=!planForm&&settings.plan&&planGoal(settings.plan,settings.goal);
  const planPct=saved?.total?Math.round((saved.total-saved.days)/saved.total*100):0;
  const editPlan=patch=>setPlanForm({...planInput,...patch});
  const planNums=Object.fromEntries(Object.entries(planInput).map(([k,v])=>[k,k==='sex'?v:Number(v)]));
  const plan=Object.values(planNums).every(v=>typeof v==='string'||v>0)?planGoal(planNums,settings.goal):null;
  const bodyOk=Number.isInteger(planNums.age)&&[['age',10,100],['height',100,230],['weight',25,300],['target',25,300]].every(([k,lo,hi])=>planNums[k]>=lo&&planNums[k]<=hi); // 同 server validPlan 範圍
  function commitGoal(value){const t=String(value).trim(),v=Number(t);if(!/^\d+$/.test(t)||v<500||v>10000){setGoalInput(String(settings.goal));setError('每日目標需為 500～10000 的整數 kcal。');return;}setGoalInput(String(v));if(v!==settings.goal)changeSetting({goal:v});}
  async function switchAccount(client_id){try{await api('/api/account',{client_id});const list=await loadAccount();await changeSetting({model:list[0]?.slug || ''});}catch(e){setError(e.message);}}
  async function logout(){setSaving(true);try{const result=await api('/api/logout',{});await loadAccount();notify(result.warning||'已登出');}catch(e){setError(e.message);}finally{setSaving(false);}}
  function loginForm(clientId,label){return <form method="POST" action="/auth/chatgpt"><input type="hidden" name="csrf" value={csrf.current}/>{clientId&&<input type="hidden" name="client_id" value={clientId}/>}<button className="primary full" disabled={!status||busy||saving}>{label}</button></form>;}
  const back=(title,action=goHome)=><nav><button className="round" aria-label="返回" onClick={action}>‹</button><b>{title}</b><span/></nav>;
  const source=(i)=><span className={'source '+i.source}>{sourceLabel(i)}</span>;
  const sourceDetails=i=><>{i.sourceUrl&&<a className="source-link" href={i.sourceUrl} target="_blank" rel="noreferrer">↗ {i.sourceTitle||'查看營養資料來源'}</a>}{i.notes&&<p className="muted tiny">{i.notes}</p>}</>;

  return <div className="journal-app">
    <input hidden ref={album} type="file" accept="image/*" onChange={e=>{selectPhoto(e.target.files?.[0]);e.target.value='';}}/>
    {error&&<div className="error-banner" role="alert"><span>{error}</span><button aria-label="關閉提示" onClick={()=>setError('')}>×</button></div>}
    {screen==='home'&&<div className="screen home swipe" {...swipe(dir=>dir>0?day>since&&shiftDay(-1):day<today()?shiftDay(1):()=>{setScreen('settings');setError('');})}>
      <header><button onClick={()=>{const n=window.prompt('日誌名稱（顯示為「○○的飲食日誌」）',settings.name||'我');if(n!==null)changeSetting({name:n});}}><b>{settings.name||'我'}的飲食日誌</b></button><button className={'streak'+(streak?'':' off')} onClick={()=>notify(streak?`連續 ${streak} 天有記錄且未超過目標`:'今天記錄且不超標就能開始連勝')} aria-label={'連勝 '+streak+' 天'}><Flame/>{streak}</button><div className="header-actions">{status?.admin&&<button className="text-button" onClick={()=>{setScreen('admin');setError('');}}>管理</button>}<button className="text-button" onClick={()=>{setScreen('history');setError('');}}>飲食紀錄</button><button className="text-button" onClick={()=>{setScreen('settings');setError('');}}>設定</button></div></header>
      <div className="week-strip">{week.map(h=><button key={h.day} disabled={h.day>today()||h.day<since}onClick={()=>chooseDay(h.day,true)} aria-label={h.day+' 的紀錄'}><div className={'week-ring '+(h.day===day?'selected':'')}><i style={{height:Math.min(100,h.kcal/settings.goal*100)+'%',background:h.kcal>settings.goal?'var(--peach)':'var(--purple)'}}/></div><small>{h.day===today()?'今':'日一二三四五六'[new Date(h.day+'T12:00:00').getDay()]}</small></button>)}</div>
      <section className="summary"><div className="total"><strong>{fmt(sum)}</strong><span>kcal {day===today()?'今天':day.slice(5).replace('-','/')}</span></div><div className="progress"><i style={{width:Math.min(100,sum/settings.goal*100)+'%',background:remaining<0?'var(--peach)':'var(--purple)'}}/></div><div className="summary-labels"><span>目標 {fmt(settings.goal)}</span><span>{remaining>=0?'距離目標 '+fmt(remaining):'超過目標 '+fmt(-remaining)}</span></div></section>
      <div className="timeline scroll">
        {!!jobs.length&&<><button className="notice jobs-banner" onClick={()=>setJobsOpen(o=>!o)}>{[['running','筆辨識中'],['done','筆已自動記錄'],['error','筆失敗']].filter(([k])=>jobCount(k)).map(([k,t])=>jobCount(k)+' '+t).join('・')} {jobsOpen?'▴':'▾'}</button>
          {jobsOpen&&<div className="job-list">{jobs.map(j=>{const d=new Date(j.createdAt);return <div className="job-row" key={j.id}><time>{(today(d)===today()?'':today(d).slice(5).replace('-','/')+' ')+d.toTimeString().slice(0,5)}</time><span>{[j.hasPhoto&&'照片',j.text].filter(Boolean).join('・')}</span><small>{{running:j.kind==='relookup'?'查詢中':'辨識中',done:j.kind==='relookup'?'已更新':'已記錄',error:'失敗'}[j.status]}</small>
            {j.status==='error'?<>{j.kind!=='relookup'&&<button className="text-button" onClick={()=>retryJob(j.id)}>重試</button>}<button className="text-button danger" onClick={()=>dropJob(j.id).catch(e=>setError(e.message))}>刪除</button></>:<button className="text-button" onClick={()=>j.status==='done'?showSaved(j):openJob(j.id)}>查看</button>}</div>;})}</div>}</>}
        {!meals.length&&<div className="empty"><div className="empty-icon">＋</div><b>把今天的第一餐記下來</b><p>拍張照、選照片，或輸入吃了什麼。<br/>辨識完會自動記錄，之後可以再修改。</p><button className="outline" onClick={manualDraft}>手動記一餐</button></div>}
        {meals.map(m=><button className="meal-row" key={m.id} onClick={()=>openMeal(m.id)}><time>{m.time}</time><div className="timeline-line"><i/></div><div className="meal-card"><div><b>{m.name}</b><small>{m.items.length} 項 <span className={'source '+(m.items.some(i=>i.source==='llm')?'llm':'web')}>{m.items.some(i=>i.source==='llm')?'含估算':m.items.some(i=>i.source==='web')?'含網路資料':'本機資料'}</span></small></div><strong>{fmt(m.kcal)}</strong></div></button>)}
        {!!meals.length&&<button className="text-button add-manual" onClick={manualDraft}>＋ 手動記一餐</button>}
      </div>
      <form className="composer" onSubmit={e=>{e.preventDefault();analyze({text,photo:''});}}><button type="button" className="camera-button" aria-label="開啟相機" onClick={()=>setScreen('camera')}><span/></button><button type="button" className="album-button" onClick={()=>album.current.click()}>相簿</button><input aria-label="餐點描述" value={text} onChange={e=>setText(e.target.value)} placeholder="或輸入：一碗滷肉飯"/><button className="send-button" aria-label="分析文字" disabled={!text.trim()}>↑</button></form>
    </div>}
    {screen==='admin'&&<Admin api={api} onBack={goHome} onError={setError} source={source} sourceDetails={sourceDetails}/>}
    {screen==='camera'&&<Camera onBack={goHome} onPhoto={selectPhoto} onAlbum={()=>album.current.click()}/>}
    {screen==='compose'&&<div className="screen">{back('這一餐的照片')}<div className="scroll page-pad"><img className="photo-preview" src={photo} alt="準備分析的餐點"/><div className="card"><label>補充份量、品牌或做法<textarea value={text} onChange={e=>setText(e.target.value)} placeholder="例如：飯大約半碗、雞腿有去皮"/></label><p className="muted tiny">照片會壓縮後送至設定的 AI 服務（OpenAI 或 Anthropic）辨識。重量與隱藏油量仍需你確認。</p><button className="primary full" onClick={()=>analyze()}>辨識這一餐</button></div><button className="outline full" onClick={()=>album.current.click()}>換一張照片</button></div></div>}
    {screen==='result'&&<div className="screen">{back('記一餐')}<div className="scroll thread">
      {(photo||text)&&!draft?.id&&<div className="user-bubble">{photo?<img src={photo} alt="這餐照片"/>:<p>{text}</p>}</div>}
      {steps.map((s,i)=><div className="step-bubble" key={i}><small>✓ {s.label}</small><p>{s.message}</p></div>)}
      {busy&&<div className="working"><span className="dots">•••</span> 正在分析，可以先離開 {jobId&&<button className="text-button" onClick={cancelJob}>取消辨識</button>}</div>}
      {!busy&&!draft&&lastInput.current&&<button className="outline" onClick={()=>jobId?retryJob(jobId):analyze(lastInput.current)}>重試</button>}
      {draft&&<div className="result-card"><div className="result-title"><b>這樣對嗎？</b><strong>{fmt(total(draft.items))}<small> kcal</small></strong></div>
        {!draft.id&&!lastInput.current&&<p className="notice">知道熱量和份量時才在這裡記。不確定的話，請回首頁用輸入框描述或拍照，AI 會幫你拆項並估算。</p>}
        <label>餐點名稱<input aria-label="餐點名稱" value={draft.name} onChange={e=>setDraft(d=>({...d,name:e.target.value}))} placeholder={draft.items.length?'留空會用：'+draft.items.map(i=>i.name).filter(Boolean).join('、'):'例如：午餐便當（非必填）'}/></label>
        <div className="two-columns"><label>日期<input type="date" value={draft.day} onChange={e=>setDraft(d=>({...d,day:e.target.value}))}/></label><label>時間<input type="time" value={draft.time} onChange={e=>setDraft(d=>({...d,time:e.target.value}))}/></label></div>
        {draft.note&&<p className="notice">{draft.note}</p>}{draft.warnings?.map((w,i)=><p className="notice" key={i}>{w}</p>)}
        {draft.items.map((item,index)=><div className="draft-item" key={item.id}>
          <div className="food-name"><input aria-label={'食物名稱 '+(index+1)} value={item.name} onChange={e=>editItem(index,{name:e.target.value,cache:false,source:'manual',matched:false,foodId:'',sourceUrl:'',sourceTitle:'',aliases:[]})} placeholder="食物名稱"/><button className="remove" aria-label={'移除 '+item.name} onClick={()=>setDraft(d=>({...d,items:d.items.filter((_,i)=>i!==index)}))}>✕</button></div>
          {source(item)}<div className="food-numbers"><label>重量 g<input aria-label={'重量 '+(index+1)} type="number" inputMode="numeric" min="1" max="5000" step="1" value={item.grams} onChange={e=>editItem(index,{grams:e.target.value})}/></label><label>kcal / 100g<input aria-label={'每100g熱量 '+(index+1)} type="number" inputMode="decimal" min="0" max="1000" step="0.1" value={item.kcalPer100g} onChange={e=>editItem(index,{kcalPer100g:e.target.value,cache:false,source:'manual',matched:false,foodId:'',sourceUrl:'',sourceTitle:'',notes:'使用者手動調整熱量。'})}/></label><strong>{fmt(energy(item))}<small> kcal</small></strong></div>
          {!Number(item.kcalPer100g)&&item.name.trim()&&<button className="outline full" disabled={estimating.includes(item.id)} onClick={()=>estimate(item)}>{estimating.includes(item.id)?'估算中…':'AI 估算'}</button>}
          {item.name.trim()&&<button className="outline full" disabled={estimating.includes(item.id)||relookups.some(r=>r.itemId===item.id)} onClick={()=>relookup(item)}>{relookups.some(r=>r.itemId===item.id)?'查詢中…可以先離開':'以新名稱重新查詢'}</button>}
          {item.portionNote&&<p className="muted tiny">{item.portionNote}</p>}{sourceDetails(item)}
          {item.matched&&item.recognizedName&&item.recognizedName!==item.name&&<p className="match-note">辨識為「{item.recognizedName}」，判斷與本機庫「{item.name}」相同。確認後會記住這個名稱。<button className="text-button" onClick={()=>notSame(index)}>不是這個</button></p>}
          {!item.matched&&item.similar?.map(f=><p className="match-note" key={f.id}>食物庫有相近的「{f.name}」（{f.kcalPer100g} kcal/100g），判斷為不同。<button className="text-button" onClick={()=>useSame(index,f)}>其實是同一種</button></p>)}
        </div>)}
        <div className="button-row"><button className="outline" onClick={addManual}>＋ 手動加項</button><button className="outline" onClick={()=>openFoods(true)}>＋ 從食物庫選</button></div>
        <p className="muted tiny">份量與熱量皆可修改。照片辨識及 LLM 數字為估計值。</p><button className="primary full" disabled={saving||!draft.items.length} onClick={save}>{saving?'保存中…':draft.id?'保存修改':'對，記下來'}</button>
      </div>}<div ref={threadEnd}/></div></div>}
    {screen==='detail'&&detail&&<div className="screen">{back(detail.day+' · '+detail.time)}<div className="scroll page-pad"><h1>{detail.name}</h1><div className="detail-total">{fmt(detail.kcal)}<small> kcal</small></div>{detail.photo&&<img className="detail-photo" src={detail.photo} alt={detail.name}/>}
      <div className="card">{detail.items.map((i,k)=><div className="detail-item" key={k}><div><b>{i.name}</b>{source(i)}</div><p>{i.grams}g <strong>{fmt(energy(i))} kcal</strong></p>{sourceDetails(i)}</div>)}</div>
      <button className="primary full" onClick={()=>{setDraft({...detail,warnings:[],note:''});setPhoto('');setText('');setSteps([]);setScreen('result');}}>編輯這筆紀錄</button><button className="outline danger full" onClick={removeMeal}>刪除這筆紀錄</button></div></div>}
    {screen==='history'&&<div className="screen">{back('這一週')}<div className="scroll page-pad"><label>選擇日期<input type="date" value={day} min={since} max={today()} onChange={e=>chooseDay(e.target.value)}/></label><p className="muted">本週平均（含未記錄日）</p><div className="detail-total">{fmt(week.filter(h=>h.day<=today()&&h.day>=since).reduce((s,h,_,a)=>s+h.kcal/a.length,0))}<small> kcal</small></div><p className="muted tiny">未記錄不代表沒有進食。</p>{week.filter(h=>h.day<=today()&&h.day>=since).reverse().map(h=><button className="history-row" key={h.day} onClick={()=>chooseDay(h.day)}><i style={{background:h.kcal>settings.goal?'var(--peach)':'var(--purple)'}}/><span>{h.day.slice(5).replace('-','/')}　週{'日一二三四五六'[new Date(h.day+'T12:00:00').getDay()]}</span><small>{h.count?h.count+' 餐':'未記錄'}</small><strong>{fmt(h.kcal)}</strong></button>)}</div></div>}
    {screen==='settings'&&<div className="screen swipe" {...swipe(dir=>dir>0&&goHome)}>{back('設定')}<div className="scroll page-pad settings-grid">
      <section className="card"><h2>AI 服務</h2>{status?.remote?<p className="muted">{status.user&&<>Tailscale：{status.user}<br/></>}{(status.providersReady??active?.signedIn)?'使用電腦上設定的 AI 服務。':status.providersError||'電腦尚未設定 AI 服務，請在電腦上開啟 127.0.0.1 設定。'}</p>:<>{(providers.length?providers:[{id:'chatgpt',label:'ChatGPT',fallback:true}]).map((p,i)=>{const gpt=p.id==='chatgpt',on=gpt?active?.signedIn:!!p.keyHint;return <div className="provider" key={p.id}><div className="account-row"><label className="radio">{!p.fallback&&<input type="checkbox" checked={p.enabled} onChange={e=>editProvider(p.id,{enabled:e.target.checked})}/>}<span>{p.label} <span className="source">{gpt?(on?'已登入 '+(active.email||active.name||''):'未登入'):(on?'已設定 '+p.keyHint:'未設定')}</span></span></label>{!p.fallback&&<><button className="outline" aria-label={'上移 '+p.label} disabled={!i} onClick={()=>moveProvider(i,-1)}>↑</button><button className="outline" aria-label={'下移 '+p.label} disabled={i===providers.length-1} onClick={()=>moveProvider(i,1)}>↓</button></>}</div>
        {gpt?<>{status?.accounts.length>1&&status.accounts.map((a,index)=><div className="account-row" key={a.client_id}><p>{a.email||a.name||'ChatGPT 帳號'}<small>註冊 {index+1}{a.client_id===status.activeId?' · 使用中':''}</small></p>{a.signedIn?<button className="outline" disabled={a.client_id===status.activeId} onClick={()=>switchAccount(a.client_id)}>切換</button>:loginForm(a.client_id,'重新登入')}</div>)}
          {on?<>{!active.planEnabled&&<><p className="notice">尚未取得 ChatGPT plan 使用權，請重新授權。</p>{loginForm(active.client_id,'重新授權')}</>}{loginForm(null,'新增 ChatGPT 帳號')}<button className="text-button full danger" disabled={saving} onClick={()=>window.confirm('登出 ChatGPT？')&&logout()}>登出</button></>:loginForm(active?.client_id,'登入 ChatGPT')}
          <label>模型<select value={settings.model} onChange={e=>changeSetting({model:e.target.value})}><option value="">請選擇模型</option>{models.map(m=><option key={m.slug} value={m.slug}>{m.display_name||m.slug}</option>)}</select></label><small className="muted">照片需要支援影像輸入的模型，網路搜尋需帳號與模型支援。</small>{!p.fallback&&<p className="muted tiny">{p.shared?'ChatGPT 額度可供所有連線使用（CHATGPT_SHARED=1）':'ChatGPT 額度僅限本機帳號使用（依 OpenAI 條款，不可分享帳號）'}</p>}</>
        :<>{on&&p.keyAddedAt&&<small className="muted">新增於 {new Date(p.keyAddedAt).toLocaleDateString('zh-TW')}</small>}{!on||claudeKey!==null?<><label>{p.label} API key<input type="password" autoComplete="off" value={claudeKey||''} onChange={e=>setClaudeKey(e.target.value)}/></label><button className="outline full" disabled={!claudeKey?.trim()} onClick={()=>{const key=claudeKey.trim();setClaudeKey(null);saveProviders(providers,{claudeApiKey:key});}}>儲存 key</button></>
          :<div className="button-row"><button className="outline" onClick={()=>setClaudeKey('')}>更換 key</button><button className="outline danger" onClick={()=>window.confirm('刪除 Claude API key？')&&saveProviders(providers,{claudeApiKey:''})}>刪除 key</button></div>}
          {p.models?.length>0&&<label>模型<select value={p.model||''} onChange={e=>editProvider(p.id,{model:e.target.value})}>{p.models.map(m=><option key={m.slug} value={m.slug}>{m.display_name||m.slug}</option>)}</select></label>}</>}</div>;})}
        <p className="muted tiny">依序使用已啟用的服務；前一個額度用完、登入失效或連線失敗時自動改用下一個。登入資料與 API key 加密保存在這台電腦，只能在電腦上管理。Claude API 依用量計費。</p></>}</section>
      <section className="card"><h2>每日熱量目標</h2><div className="goal-control"><button className="round" onClick={()=>commitGoal(Math.max(500,(Number(goalInput)||settings.goal)-50))}>−</button><input aria-label="每日熱量目標" type="text" inputMode="numeric" value={goalInput} onChange={e=>setGoalInput(e.target.value)} onBlur={()=>commitGoal(goalInput)} onKeyDown={e=>{if(e.key==='Enter')e.currentTarget.blur();}}/><button className="round" onClick={()=>commitGoal(Math.min(10000,(Number(goalInput)||settings.goal)+50))}>+</button></div></section>
      <section className="card">{saved?<><h2>減重計劃</h2><div className="detail-total">{saved.days===0?(saved.total?'已到預計日期，請更新體重':'已達成目標'):saved.days===null?'—':saved.days}{saved.days>0&&<small> 天</small>}</div>
        {saved.total>0&&<><p>預計 {saved.date.replace(/-/g,'.')} 達成 · {planPct}% 已完成</p><div className="progress"><i style={{width:planPct+'%',background:'var(--purple)'}}/></div></>}
        {saved.days===null&&<p>以目前每日目標 {fmt(settings.goal)} kcal 不會減重</p>}{settings.plan.weight>settings.plan.target&&settings.goal<saved.floor&&<p className="notice">每日目標低於建議最低攝取 {fmt(saved.floor)} kcal，長期可能流失肌肉、代謝下降</p>}
        <p className="muted tiny">{settings.plan.weight} → {settings.plan.target} 公斤 · 每日 {fmt(settings.goal)} kcal</p><button className="outline full" onClick={()=>{setPlanForm(planInput);setPlanStep(1);}}>編輯計劃</button></>:<><h2>減重目標</h2>{planStep===1&&<><small className="muted">生理性別</small>{[['f','女'],['m','男']].map(([v,label])=><label className="radio" key={v}><input type="radio" name="sex" checked={planInput.sex===v} onChange={()=>editPlan({sex:v})}/>{label}</label>)}
        <div className="two-columns">{[['age','年齡'],['height','身高 cm'],['weight','目前體重 kg'],['target','目標體重 kg']].map(([k,label])=><label key={k}>{label}<input type="text" inputMode={k==='age'?'numeric':'decimal'} value={planInput[k]} onChange={e=>editPlan({[k]:e.target.value})}/></label>)}</div>
        <button className="primary full" disabled={!bodyOk} onClick={()=>setPlanStep(2)}>下一步</button></>}
        {planStep===2&&<><small className="muted">活動量</small>{[['1.2','久坐','辦公室工作、幾乎不運動；每天走不到 3,000 步（約 2 公里）'],['1.375','輕度活動','每週運動 1～3 天；或每天走 3,000～7,500 步（約 2～5 公里）'],['1.55','中度活動','每週運動 3～5 天、每次 30～60 分鐘；或每天走 7,500～10,000 步（約 5～7 公里）'],['1.725','高度活動','每週運動 6～7 天，或站立、勞力型工作；每天走 10,000 步以上（約 7 公里以上）']].map(([v,label,ex])=><label className="radio" key={v}><input type="radio" name="activity" checked={planInput.activity===v} onChange={()=>editPlan({activity:v})}/><span>{label}<br/><small className="tiny">{ex}</small></span></label>)}
        <button className="primary full" disabled={!plan} onClick={()=>setPlanStep(3)}>下一步</button>
        <button className="outline full" onClick={()=>setPlanStep(1)}>上一步</button></>}
        {planStep===3&&<>{plan&&<><p>{plan.days===0?'已達成目標':plan.days===null?`以目前每日目標 ${fmt(settings.goal)} kcal 不會減重`:`以目前每日目標 ${fmt(settings.goal)} kcal：每週約 ${plan.weekly} 公斤，預計 ${plan.days} 天後（${plan.date.replace(/-/g,'.')}）達成`}</p>
          <p className="muted tiny">基礎代謝 {fmt(plan.bmr)}、每日消耗約 {fmt(plan.tdee)} kcal</p>
          {plan.days!==0&&settings.goal<plan.floor&&<p className="notice">每日目標低於建議最低攝取 {fmt(plan.floor)} kcal，長期可能流失肌肉、代謝下降</p>}
          <p className="muted tiny">可以修改上方的「每日熱量目標」，預覽不同的達成日期。</p>
          <button className="primary full" onClick={()=>changeSetting({plan:{...planNums,startDate:planStart&&planNums.weight===settings.plan.weight?planStart:today()}},'減重計劃已儲存').then(ok=>ok&&setPlanForm(null))}>儲存計劃</button></>}
        <button className="outline full" onClick={()=>setPlanStep(2)}>上一步</button></>}{settings.plan&&<button className="text-button full" onClick={()=>setPlanForm(null)}>取消</button>}</>}
        <p className="muted tiny">依 Mifflin-St Jeor 公式與每公斤約 7,700 kcal 估算，實際因人而異；體重變化後請更新。僅供參考，有健康狀況請諮詢醫師或營養師。</p></section>
      <section className="card"><h2>本機庫找不到時</h2><label className="radio"><input type="radio" name="fallback" checked={settings.fallback==='web'} onChange={()=>changeSetting({fallback:'web'})}/>先查網路，找不到再由 LLM 估算</label><label className="radio"><input type="radio" name="fallback" checked={settings.fallback==='llm'} onChange={()=>changeSetting({fallback:'llm'})}/>直接由 LLM 估算</label><p className="muted tiny">網路資料附來源；估算值會保留標記。記錄時，網路資料與營養標示會自動存入食物庫；LLM 估算不會自動存入。</p></section>
      <section className="card"><h2>外觀</h2>{[['system','跟隨系統'],['light','淺色'],['dark','深色']].map(([value,label])=><label className="radio" key={value}><input type="radio" name="theme" checked={theme===value} onChange={()=>setTheme(value)}/>{label}</label>)}</section>
      <section className="card"><button className="settings-link" onClick={()=>openFoods()}>本機食物資料庫 <span>›</span></button><a className="settings-link" href="/api/export" download>匯出日誌與食物備份 <span>↓</span></a><p className="muted tiny">日誌保存於這台電腦的 SQLite。照片會送至設定的 AI 服務（OpenAI 或 Anthropic）分析，網路搜尋只使用食物名稱及描述。</p></section><p className="version">Meal Journal Local · v2.0.0</p>
    </div></div>}
    {screen==='foods'&&<div className="screen">{back('本機食物庫',()=>setScreen(picking?'result':'settings'))}<div className="scroll page-pad"><input className="search" aria-label="搜尋食物" placeholder="搜尋食物名稱或別名" value={query} onChange={e=>setQuery(e.target.value)}/>
      {foods.length>0&&<div className="chips">{[['全部',foods.length],...groups].map(([g,n])=><button key={g} className={'outline'+(group===g?' on':'')} aria-pressed={group===g} onClick={()=>setGroup(g)}>{g} {n}</button>)}</div>}
      {!foods.length&&<p className="notice">食物庫目前是空的。存餐點時，網路查到的資料與營養標示會自動加入。</p>}
      {filteredFoods.map(f=><div className="card food-library" key={f.id}><div><b>{f.name}</b>{source(f)}</div><p><strong>{f.kcalPer100g}</strong> kcal / 100g</p>{sourceDetails(f)}{picking&&<div className="button-row"><button className="primary" onClick={()=>pickFood(f)}>加入這餐</button></div>}</div>)}
    </div></div>}
    {toast&&<div className="toast" role="status">{toast}</div>}
  </div>;
}

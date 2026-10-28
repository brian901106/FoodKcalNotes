import React, { useEffect, useState } from 'react';

const fmt = n => Math.round(n).toLocaleString('en-US');
const energy = i => Math.round(i.grams * i.kcalPer100g / 100);
const when = iso => iso ? new Date(iso).toLocaleString('zh-TW', { hour12: false }) : '—';
const who = j => j.owner ? `你（${j.login || '本機'}）` : (j.login || '尚未記錄帳號（下次連線後顯示）');

// 管理員檢視：只在電腦本機顯示，唯讀瀏覽每一本日誌（你自己的與分享使用者的）。
export default function Admin({ api, onBack, onError, source, sourceDetails }) {
  const [journals, setJournals] = useState(null);
  const [current, setCurrent] = useState(null);
  const [meal, setMeal] = useState(null);
  const [tab, setTab] = useState('meals');
  const [query, setQuery] = useState('');

  const load = () => api('/api/admin/journals').then(d => setJournals(d.journals)).catch(e => onError(e.message));
  useEffect(() => { load(); }, []);
  async function open(id) { try { setCurrent(await api('/api/admin/journals/' + id + '?limit=300')); setTab('meals'); setQuery(''); } catch (e) { onError(e.message); } }
  async function openMeal(id) { try { setMeal(await api(`/api/admin/journals/${current.id}/meals/${id}`)); } catch (e) { onError(e.message); } }
  const nav = (title, action) => <nav><button className="round" aria-label="返回" onClick={action}>‹</button><b>{title}</b><button className="text-button" onClick={() => current ? open(current.id) : load()}>重新整理</button></nav>;

  if (meal) return <div className="screen">{nav(meal.day + ' · ' + meal.time, () => setMeal(null))}<div className="scroll page-pad">
    <p className="admin-owner">{who(current)} 的紀錄（唯讀）</p>
    <h1>{meal.name}</h1><div className="detail-total">{fmt(meal.kcal)}<small> kcal</small></div>
    {meal.photo && <img className="detail-photo" src={meal.photo} alt={meal.name} />}
    <div className="card">{meal.items.map((i, k) => <div className="detail-item" key={k}><div><b>{i.name}</b>{source(i)}</div>
      <p>{i.grams}g × {i.kcalPer100g} kcal/100g <strong>{fmt(energy(i))} kcal</strong></p>{i.portionNote && <p className="muted tiny">{i.portionNote}</p>}{sourceDetails(i)}</div>)}</div>
  </div></div>;

  if (current) {
    const q = query.trim().toLowerCase();
    const meals = current.meals.filter(m => !q || (m.name + ' ' + m.day + ' ' + m.items.map(i => i.name).join(' ')).toLowerCase().includes(q));
    const foods = current.foods.filter(f => !q || (f.name + ' ' + f.aliases.join(' ')).toLowerCase().includes(q));
    let lastDay = '';
    return <div className="screen">{nav(current.owner ? '你的日誌' : '分享使用者', () => setCurrent(null))}<div className="scroll page-pad">
      <p className="admin-owner">{who(current)}</p>
      <div className="admin-stats">
        <div><strong>{fmt(current.stats.meals)}</strong><small>餐點</small></div>
        <div><strong>{fmt(current.stats.foods)}</strong><small>食物庫</small></div>
        <div><strong>{fmt(current.stats.kcalTotal)}</strong><small>總 kcal</small></div>
        <div><strong>{fmt(current.stats.goal)}</strong><small>每日目標</small></div>
      </div>
      <div className="admin-tabs">
        <button className={tab === 'meals' ? 'selected' : ''} onClick={() => setTab('meals')}>餐點 {current.meals.length}{current.stats.meals > current.meals.length ? '+' : ''}</button>
        <button className={tab === 'foods' ? 'selected' : ''} onClick={() => setTab('foods')}>食物庫 {current.foods.length}</button>
      </div>
      <input className="search" placeholder={tab === 'meals' ? '搜尋餐點、食物或日期' : '搜尋食物名稱或同義名稱'} value={query} onChange={e => setQuery(e.target.value)} />
      {tab === 'meals' && <div className="admin-list">
        {!meals.length && <p className="muted">沒有餐點紀錄。</p>}
        {meals.map(m => { const head = m.day !== lastDay; lastDay = m.day; return <React.Fragment key={m.id}>
          {head && <h3 className="admin-day">{m.day}</h3>}
          <button className="history-row" onClick={() => openMeal(m.id)}><small>{m.time}</small><span>{m.name}<br /><small className="muted">{m.items.map(i => i.name).join('、')}{m.hasPhoto ? ' · 有照片' : ''}</small></span><strong>{fmt(m.kcal)}</strong></button>
        </React.Fragment>; })}
        {current.stats.meals > current.meals.length && <p className="muted tiny">只顯示最近 {current.meals.length} 筆。</p>}
      </div>}
      {tab === 'foods' && <div className="admin-list">
        {!foods.length && <p className="muted">食物庫是空的。</p>}
        {foods.map(f => <div className="detail-item" key={f.id}><div><b>{f.name}</b>{source(f)}</div>
          <p><span className="muted">{f.aliases.length ? '同義：' + f.aliases.join('、') : '沒有同義名稱'}</span><strong>{f.kcalPer100g} kcal/100g</strong></p>{sourceDetails(f)}</div>)}
      </div>}
    </div></div>;
  }

  return <div className="screen">{nav('管理員檢視', onBack)}<div className="scroll page-pad">
    <p className="muted tiny">只在這台電腦（127.0.0.1）可以開啟，唯讀。手機或分享使用者連線時看不到這個頁面。</p>
    {!journals && <p className="muted">讀取中…</p>}
    <div className="admin-grid">{journals?.map(j => <button className="card admin-card" key={j.id} onClick={() => open(j.id)}>
      <b>{who(j)}</b>
      <div className="admin-stats">
        <div><strong>{fmt(j.meals)}</strong><small>餐點</small></div>
        <div><strong>{fmt(j.foods)}</strong><small>食物庫</small></div>
        <div><strong>{fmt(j.kcalTotal)}</strong><small>總 kcal</small></div>
      </div>
      <small className="muted">{j.meals ? `${j.firstDay} ～ ${j.lastDay}` : '還沒有紀錄'} · 最後更新 {when(j.updatedAt)}</small>
    </button>)}</div>
  </div></div>;
}

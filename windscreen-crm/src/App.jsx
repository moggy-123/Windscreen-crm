import { useState, useEffect, useCallback } from "react";
import { pullFromCloud, pushToCloud, pushOne, deleteRecord, supabase, uploadPhoto, deletePhoto } from "./supabase";

const DB_KEY = "wscrm_data";

// Bump this every time a new version is shipped, so it's obvious from the app
// itself (Home screen footer + Settings) whether a deploy actually landed.
const BUILD_NUMBER = "B9 · 18 Jul 2026";

const STATUS_META = {
  Booked:        { color: "#2563EB", bg: "#EFF6FF" },
  Complete:      { color: "#059669", bg: "#ECFDF5" },
  Invoiced:      { color: "#7C3AED", bg: "#F5F3FF" },
  Paid:          { color: "#374151", bg: "#F9FAFB" },
};

const DAMAGE_TYPES    = ["Chip", "Crack", "Pit Fill"];
const JOB_TYPES       = ["Repair", "Replace"];
const PAYMENT_TYPES   = ["Private", "Insurance"];

function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }
function todayISO() { return new Date().toISOString().split("T")[0]; }

// Format ISO date (YYYY-MM-DD) → DD/MM/YYYY for display
function fmtDate(iso) {
  if (!iso) return "";
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

// Pricing is tiered: for each repair type (Chip/Crack/Pit Fill), a price for the 1st,
// 2nd, and 3rd-or-later repair of that type on the same vehicle/job. Trade customers can
// override any of these; anything they haven't set falls back to the Trade default.
// Private customers always use the separate Private default (no per-customer override).
function getDefaultPricing(data) {
  const table = data.settings?.find(s => s.id === "app")?.defaultPricing || {};
  const out = {};
  DAMAGE_TYPES.forEach(t => { out[t] = { 1: "", 2: "", 3: "", ...(table[t] || {}) }; });
  return out;
}
function getPrivatePricing(data) {
  const table = data.settings?.find(s => s.id === "app")?.privatePricing || {};
  const out = {};
  DAMAGE_TYPES.forEach(t => { out[t] = { 1: "", 2: "", 3: "", ...(table[t] || {}) }; });
  return out;
}
// The effective pricing table for a customer: Private customers use the Private default;
// Trade customers get their own prices layered over the Trade default.
function getRepairPricing(data, customer) {
  if (customer?.custType === "Private") return getPrivatePricing(data);
  const def = getDefaultPricing(data);
  const custom = (customer?.custType === "Trade" && customer.pricing) ? customer.pricing : {};
  const out = {};
  DAMAGE_TYPES.forEach(t => { out[t] = { ...def[t], ...(custom[t] || {}) }; });
  return out;
}
// Price for the Nth repair of a given type (1-indexed within that type, for that job/vehicle).
// 3rd-or-later repairs all use the "3" tier.
function priceForRepair(pricingTable, type, countForType) {
  const tiers = pricingTable[type] || {};
  const key = countForType >= 3 ? "3" : String(countForType || 1);
  const val = tiers[key] || tiers["3"] || tiers["2"] || tiers["1"];
  return parseFloat(val) || 0;
}
// Given a job's repairs array, work out the price for each repair (in order, counting
// per-type) and the total. Returns { lines: [{repair, count, price}], total }.
function calcRepairPricing(data, customer, repairs) {
  const table = getRepairPricing(data, customer);
  const counts = {};
  const lines = (repairs || []).map(r => {
    const type = r.type || "Chip";
    counts[type] = (counts[type] || 0) + 1;
    return { repair: r, count: counts[type], price: priceForRepair(table, type, counts[type]) };
  });
  const total = lines.reduce((s, l) => s + l.price, 0);
  return { lines, total };
}

function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) {
      const data = JSON.parse(raw);
      // Keep uploaded photos (have a url) AND pending photos (waiting to upload offline).
      // Only drop malformed entries that have neither.
      if (data.jobs) {
        data.jobs = data.jobs.map(j => {
          const strip = arr => (arr || []).filter(p => p && (p.url || p.pending)); // keep uploaded OR pending
          return { ...j, photosBefore: strip(j.photosBefore), photosAfter: strip(j.photosAfter) };
        });
      }
      return data;
    }
  } catch {}
  return { customers: [], vehicles: [], jobs: [], invoices: [], mileage: [], inspections: [], communications: [], settings: [], technicians: [] };
}

// One-time cleanup: remove the old duplicate lastsync copy
function clearStorageBloat() {
  try {
    localStorage.removeItem("wscrm_lastsync");
  } catch {}
}
function saveData(data) {
  const stamped = stampData(data);
  localStorage.setItem(DB_KEY, JSON.stringify(stamped));
  return pushToCloud(stamped).catch(() => {/* offline — will sync later */});
}

// Add/refresh an updatedAt timestamp so the newest edit wins when merging
function stampData(data) {
  const now = Date.now();
  const prev = loadData();
  const stamp = (arr, prevArr) => (arr || []).map(rec => {
    const old = (prevArr || []).find(p => p.id === rec.id);
    const oldComparable = old ? { ...old } : null;
    if (oldComparable) delete oldComparable.updatedAt;
    const recComparable = { ...rec };
    delete recComparable.updatedAt;
    const changed = !old || JSON.stringify(oldComparable) !== JSON.stringify(recComparable);
    return { ...rec, updatedAt: changed ? now : (old.updatedAt || now) };
  });
  return {
    ...data,
    customers: stamp(data.customers, prev.customers),
    vehicles:  stamp(data.vehicles,  prev.vehicles),
    jobs:      stamp(data.jobs,      prev.jobs),
    invoices:  stamp(data.invoices,  prev.invoices),
    inspections: stamp(data.inspections, prev.inspections),
    communications: stamp(data.communications, prev.communications),
    settings: stamp(data.settings, prev.settings),
  };
}

// Global flag so the realtime listener doesn't interfere mid-save
let SAVING_IN_PROGRESS = false;

// Save then reload, but wait for cloud push first (important on mobile)
async function saveAndReload(data) {
  showSavingOverlay();
  SAVING_IN_PROGRESS = true;
  const stamped = stampData(data);
  localStorage.setItem(DB_KEY, JSON.stringify(stamped));
  // Push only changed records, with a safety timeout so it never hangs forever
  try {
    await Promise.race([
      pushChangedOnly(stamped),
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout after 12s")), 12000)),
    ]);
  } catch (e) {
    hideSavingOverlay();
    SAVING_IN_PROGRESS = false;
    // Only warn if genuinely online — offline saves are normal and sync later
    const msg = e?.message || "";
    const isOffline = !navigator.onLine || msg.includes("Load failed") || msg.includes("timeout") || msg.includes("Failed to fetch") || msg.includes("NetworkError");
    if (!isOffline) alert("Sync problem: " + (msg || JSON.stringify(e)));
    window.location.reload();
    return;
  }
  SAVING_IN_PROGRESS = false;
  window.location.reload();
}

// Simple full-screen "Saving…" overlay to prevent double-taps during save
function showSavingOverlay() {
  if (document.getElementById("crm-saving-overlay")) return;
  const el = document.createElement("div");
  el.id = "crm-saving-overlay";
  el.style.cssText = "position:fixed;inset:0;background:rgba(30,58,95,.55);z-index:9999;display:flex;align-items:center;justify-content:center;";
  el.innerHTML = '<div style="background:#fff;border-radius:14px;padding:20px 28px;font-family:Inter,sans-serif;font-weight:700;color:#1E3A5F;font-size:15px;box-shadow:0 4px 20px rgba(0,0,0,.2);">💾 Saving…</div>';
  document.body.appendChild(el);
}
function hideSavingOverlay() {
  const el = document.getElementById("crm-saving-overlay");
  if (el) el.remove();
}

// Remove a record's signature so a deleted item isn't re-synced
function removeSig(id) {
  try {
    const sigs = JSON.parse(localStorage.getItem("wscrm_sigs") || "{}");
    delete sigs[id];
    localStorage.setItem("wscrm_sigs", JSON.stringify(sigs));
  } catch {}
}

// Check if an id was previously uploaded to the cloud (exists in signatures)
function wasUploaded(id) {
  try {
    const sigs = JSON.parse(localStorage.getItem("wscrm_sigs") || "{}");
    return Object.prototype.hasOwnProperty.call(sigs, id);
  } catch { return false; }
}

// Tombstones: remember deleted IDs so they can never be re-added by a merge
function addTombstone(id) {
  try {
    const t = JSON.parse(localStorage.getItem("wscrm_deleted") || "[]");
    if (!t.includes(id)) { t.push(id); localStorage.setItem("wscrm_deleted", JSON.stringify(t)); }
  } catch {}
}
function getTombstones() {
  try { return JSON.parse(localStorage.getItem("wscrm_deleted") || "[]"); } catch { return []; }
}

// Merge a cloud array with a local array for one table.
// - Present in both: newest updatedAt wins (protects an edit made while offline).
// - Local-only AND previously confirmed synced (wasUploaded): it was deleted on another
//   device — drop it here too, and tombstone it so it can't resurrect from a stale cache.
// - Local-only AND never uploaded before: genuinely new/offline-created — keep it.
function mergeRecords(cloudArr, localArr) {
  const deleted = getTombstones();
  const byId = {};
  (cloudArr || []).forEach(x => { if (!deleted.includes(x.id)) byId[x.id] = x; });
  // Safety guard: if the cloud came back empty (or near-empty) while we have a real
  // amount of local data, that's almost certainly a fetch glitch, not a genuine mass
  // deletion — never let that wipe local records. Just keep everything local as-is.
  const suspiciousEmpty = (cloudArr || []).length === 0 && (localArr || []).length >= 3;
  (localArr || []).forEach(x => {
    if (deleted.includes(x.id)) return;
    if (byId[x.id]) {
      const localTime = x.updatedAt || 0;
      const cloudTime = byId[x.id].updatedAt || 0;
      byId[x.id] = localTime >= cloudTime ? x : byId[x.id];
    } else if (wasUploaded(x.id) && !suspiciousEmpty) {
      addTombstone(x.id);
      removeSig(x.id);
    } else {
      byId[x.id] = x;
    }
  });
  return Object.values(byId);
}

// Compare against last-synced signatures and push only changed/new records
async function pushChangedOnly(data) {
  let sigs = {};
  try { sigs = JSON.parse(localStorage.getItem("wscrm_sigs") || "{}"); } catch {}

  const tables = [
    { name: "customers", key: "customers" },
    { name: "vehicles",  key: "vehicles"  },
    { name: "jobs",      key: "jobs"      },
    { name: "invoices",  key: "invoices"  },
    { name: "mileage",   key: "mileage"   },
    { name: "inspections", key: "inspections" },
    { name: "communications", key: "communications" },
    { name: "settings", key: "settings" },
  ];

  let failed = 0;
  let lastError = "";
  const newSigs = {};

  for (const t of tables) {
    const current = data[t.key] || [];
    for (const rec of current) {
      const photoRefs = arr => (arr || []).map(p => p.url || p.id);
      const clean = { ...rec, photosBefore: photoRefs(rec.photosBefore), photosAfter: photoRefs(rec.photosAfter) };
      const sig = JSON.stringify(clean);
      if (sigs[rec.id] !== sig) {
        try {
          await pushOne(t.name, rec);
          newSigs[rec.id] = sig; // only record signature AFTER a successful upload
        } catch (e) {
          failed++;
          lastError = (e?.message || JSON.stringify(e));
          // Keep the OLD signature (if any) so we retry next time; do NOT mark as uploaded
          if (sigs[rec.id]) newSigs[rec.id] = sigs[rec.id];
          console.warn("Sync skipped for", t.name, rec.id, e?.message);
        }
      } else {
        newSigs[rec.id] = sig; // unchanged and already uploaded
      }
    }
  }
  // Store only the compact signatures (tiny — no photo data)
  try { localStorage.setItem("wscrm_sigs", JSON.stringify(newSigs)); } catch {}

  if (failed > 0) {
    throw new Error(`${failed} record(s) failed to sync. Last error: ${lastError}`);
  }
}

// Export all data as a downloadable JSON backup file
function exportBackup() {
  const data = loadData();
  const stamp = new Date().toISOString().split("T")[0];
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `windscreen-crm-backup-${stamp}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Delete photos from jobs older than one year (keeps the job records)
function cleanupOldPhotos() {
  const data = loadData();
  const oneYearAgo = new Date();
  oneYearAgo.setFullYear(oneYearAgo.getFullYear() - 1);
  let cleaned = 0;
  const jobs = data.jobs.map(j => {
    if (j.date && new Date(j.date) < oneYearAgo) {
      const had = (j.photosBefore?.length || 0) + (j.photosAfter?.length || 0);
      if (had > 0) { cleaned += had; return { ...j, photosBefore: [], photosAfter: [] }; }
    }
    return j;
  });
  if (cleaned === 0) { alert("No photos older than a year to remove."); return; }
  if (!window.confirm(`Remove ${cleaned} photo(s) from jobs older than a year? Job records are kept.`)) return;
  saveData({ ...data, jobs });
  alert(`Removed ${cleaned} old photo(s).`);
}

// ── Icons ─────────────────────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = "currentColor" }) => {
  const paths = {
    dashboard: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
    customers: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
    jobs:      "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    invoices:  "M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z",
    plus:      "M12 4v16m8-8H4",
    back:      "M15 19l-7-7 7-7",
    edit:      "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    trash:     "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
    check:     "M5 13l4 4L19 7",
    calendar:  "M8 7V3m8 4V3m-9 8h10M5 21h14a2 2 0 002-2V7a2 2 0 00-2-2H5a2 2 0 00-2 2v12a2 2 0 002 2z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] || ""} />
    </svg>
  );
};

// ── Shared UI ─────────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META["Booked"];
  return (
    <span style={{ display:"inline-flex", alignItems:"center", padding:"2px 10px", borderRadius:99, fontSize:12, fontWeight:600, color:m.color, background:m.bg, border:`1px solid ${m.color}33` }}>
      {status}
    </span>
  );
}

function Field({ label, children, required }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:4, textTransform:"uppercase", letterSpacing:"0.05em" }}>
        {label}{required && <span style={{ color:"#EF4444" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle = { width:"100%", padding:"9px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontSize:15, background:"#FAFAFA", boxSizing:"border-box", outline:"none", fontFamily:"inherit", color:"#111827" };

function Input({ value, onChange, type="text", placeholder, required }) {
  return <input style={inputStyle} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} />;
}
function Select({ value, onChange, options, placeholder }) {
  return (
    <select style={{ ...inputStyle, appearance:"none", cursor:"pointer" }} value={value} onChange={e => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}
function Btn({ children, onClick, variant="primary", size="md", disabled, style: extra }) {
  const base = { display:"inline-flex", alignItems:"center", gap:6, borderRadius:8, fontWeight:600, cursor:disabled?"not-allowed":"pointer", border:"none", fontFamily:"inherit", transition:"opacity .15s" };
  const v = { primary:{background:"#1E3A5F",color:"#fff"}, amber:{background:"#F59E0B",color:"#fff"}, ghost:{background:"transparent",color:"#1E3A5F",border:"1.5px solid #1E3A5F"}, danger:{background:"#FEE2E2",color:"#DC2626"} };
  const p = size==="sm" ? { padding:"6px 12px", fontSize:13 } : { padding:"10px 18px", fontSize:14 };
  return <button className={size==="sm" ? "crm-btn-sm" : "crm-btn"} style={{ ...base, ...v[variant], ...p, opacity:disabled?.5:1, ...extra }} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Card({ children, onClick, style: extra }) {
  return <div onClick={onClick} style={{ background:"#fff", borderRadius:12, padding:"14px 16px", boxShadow:"0 1px 3px rgba(0,0,0,.07)", marginBottom:10, cursor:onClick?"pointer":"default", border:"1px solid #F3F4F6", ...extra }}>{children}</div>;
}
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:100, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div className="crm-shell" style={{ background:"#fff", borderRadius:"20px 20px 0 0", width:"100%", maxHeight:"90vh", display:"flex", flexDirection:"column" }}>
        <div style={{ padding:"20px 20px 0", flexShrink:0 }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:18 }}>
            <h3 style={{ margin:0, fontSize:18, fontWeight:700, color:"#111827" }}>{title}</h3>
            <button onClick={onClose} style={{ background:"#F3F4F6", border:"none", borderRadius:99, width:32, height:32, cursor:"pointer", fontSize:18, color:"#6B7280" }}>×</button>
          </div>
        </div>
        <div style={{ overflowY:"auto", padding:"0 20px 20px", flex:1 }}>
          {children}
        </div>
      </div>
    </div>
  );
}

// ── Dashboard ─────────────────────────────────────────────────────────────────
function Dashboard({ data, setView, notifStatus, requestNotifications }) {
  const todayStr = todayISO();
  const todayJobs = data.jobs
    .filter(j => j.date === todayStr)
    .sort((a, b) => {
      if (!a.jobTime && !b.jobTime) return 0;
      if (!a.jobTime) return 1;
      if (!b.jobTime) return -1;
      return a.jobTime.localeCompare(b.jobTime);
    });
  // "Open" = work still to carry out (Booked). Money owed is shown separately as Outstanding.
  const openJobs = data.jobs.filter(j => j.status === "Booked");
  const unpaidInvoices = data.invoices.filter(i => !i.paid);
  const unpaidTotal = unpaidInvoices.reduce((s,i) => s + (parseFloat(i.total)||0), 0);
  // Follow-ups due today or overdue
  const dueFollowUps = data.customers
    .filter(c => c.followUpDate && c.followUpDate <= todayStr)
    .sort((a,b) => a.followUpDate.localeCompare(b.followUpDate));

  const StatCard = ({ label, value, color, sub, onClick }) => (
    <div onClick={onClick} style={{ background:"#fff", borderRadius:12, padding:16, border:"1px solid #F3F4F6", boxShadow:"0 1px 3px rgba(0,0,0,.07)", flex:1, minWidth:100, cursor: onClick ? "pointer" : "default" }}>
      <div style={{ fontSize:26, fontWeight:800, color }}>{value}</div>
      <div style={{ fontSize:12, color:"#6B7280", fontWeight:600, marginTop:2 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:"#9CA3AF", marginTop:2 }}>{sub}</div>}
    </div>
  );

  // Follow-up actions
  async function clearFollowUp(custId) {
    const customers = data.customers.map(c => c.id === custId ? { ...c, followUpDate:"", followUpNote:"" } : c);
    await saveAndReload({ ...data, customers });
  }
  async function snoozeFollowUp(custId, days) {
    const base = new Date();
    base.setDate(base.getDate() + days);
    const newDate = `${base.getFullYear()}-${String(base.getMonth()+1).padStart(2,"0")}-${String(base.getDate()).padStart(2,"0")}`;
    const customers = data.customers.map(c => c.id === custId ? { ...c, followUpDate:newDate } : c);
    await saveAndReload({ ...data, customers });
  }
  async function snoozeToDate(custId, newDate) {
    if (!newDate) return;
    const customers = data.customers.map(c => c.id === custId ? { ...c, followUpDate:newDate } : c);
    await saveAndReload({ ...data, customers });
  }

  return (
    <div>
      {notifStatus === "default" && (
        <div onClick={requestNotifications} style={{ background:"#FFF7ED", border:"1px solid #FED7AA", borderRadius:10, padding:"10px 14px", marginBottom:16, cursor:"pointer", display:"flex", alignItems:"center", gap:10 }}>
          <span style={{ fontSize:20 }}>🔔</span>
          <div>
            <div style={{ fontSize:13, fontWeight:700, color:"#92400E" }}>Enable job alerts</div>
            <div style={{ fontSize:12, color:"#B45309" }}>Tap to get notified at 9am & 1hr before each job</div>
          </div>
        </div>
      )}
      {notifStatus === "denied" && (
        <div style={{ background:"#FEF2F2", border:"1px solid #FECACA", borderRadius:10, padding:"10px 14px", marginBottom:16 }}>
          <div style={{ fontSize:12, color:"#991B1B" }}>🔕 Notifications blocked — enable in phone Settings → Safari/Chrome → Notifications</div>
        </div>
      )}
      <div style={{ marginBottom:20 }}>
        <h2 style={{ margin:0, fontSize:22, fontWeight:800, color:"#1E3A5F" }}>Good day 👋</h2>
        <p style={{ margin:"4px 0 0", color:"#6B7280", fontSize:14 }}>{new Date().toLocaleDateString("en-GB",{weekday:"long",day:"numeric",month:"long"})}</p>
      </div>
      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <StatCard label="Today's Jobs" value={todayJobs.length} color="#1E3A5F" onClick={() => setView({ screen:"jobs", filter:"Today" })} />
        <StatCard label="Open Jobs" value={openJobs.length} color="#D97706" onClick={() => setView({ screen:"jobs", filter:"Open" })} />
        <StatCard label="Outstanding" value={`£${unpaidTotal.toFixed(0)}`} color="#059669" sub={`${unpaidInvoices.length} invoices`} onClick={() => setView({ screen:"invoices", filter:"Unpaid" })} />
      </div>
      {dueFollowUps.length > 0 && (
        <div style={{ marginBottom:20 }}>
          <h3 style={{ fontSize:14, fontWeight:700, color:"#374151", margin:"0 0 10px", textTransform:"uppercase", letterSpacing:"0.05em" }}>📞 Follow-ups Due</h3>
          {dueFollowUps.map(c => (
            <Card key={c.id}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
                <div onClick={() => setView({ screen:"customerDetail", id:c.id })} style={{ cursor:"pointer", flex:1 }}>
                  <div style={{ fontWeight:700, fontSize:15, color:"#1E3A5F" }}>{c.company || c.companyContact || "Customer"}</div>
                  {c.followUpNote && <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{c.followUpNote}</div>}
                  <div style={{ fontSize:12, color: c.followUpDate < todayStr ? "#DC2626" : "#D97706", fontWeight:600, marginTop:2 }}>
                    {c.followUpDate < todayStr ? "⚠️ Overdue · " : "Due today · "}{fmtDate(c.followUpDate)}
                  </div>
                </div>
                {c.phone && <a href={`tel:${c.phone}`} onClick={e => e.stopPropagation()} style={{ background:"#1E3A5F", color:"#fff", borderRadius:8, padding:"10px 14px", textDecoration:"none", fontSize:14, fontWeight:600, whiteSpace:"nowrap" }}>📞 Call</a>}
              </div>
              <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap", alignItems:"center" }}>
                <button onClick={() => clearFollowUp(c.id)} style={{ background:"#DCFCE7", color:"#15803D", border:"none", borderRadius:8, padding:"8px 14px", fontSize:13, fontWeight:700, cursor:"pointer" }}>✓ Done</button>
                <div style={{ display:"inline-flex", alignItems:"center", gap:6, background:"#F3F4F6", borderRadius:8, padding:"6px 10px" }}>
                  <span style={{ fontSize:13, fontWeight:600, color:"#374151" }}>📅 New date:</span>
                  <input type="date" defaultValue={c.followUpDate} onChange={e => snoozeToDate(c.id, e.target.value)}
                    style={{ border:"none", background:"transparent", fontSize:13, fontFamily:"inherit", color:"#1E3A5F", fontWeight:600 }} />
                </div>
              </div>
            </Card>
          ))}
        </div>
      )}
      <h3 style={{ fontSize:14, fontWeight:700, color:"#374151", margin:"0 0 10px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Today's Jobs</h3>
      {todayJobs.length === 0 && <Card><p style={{ margin:0, color:"#9CA3AF", fontSize:14, textAlign:"center" }}>No jobs scheduled today</p></Card>}
      {todayJobs.map(job => {
        const cust = data.customers.find(c => c.id === job.customerId);
        const veh  = data.vehicles.find(v => v.id === job.vehicleId);
        return (
          <Card key={job.id} onClick={() => setView({ screen:"jobDetail", id:job.id })}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                {job.jobTime && <div style={{ fontSize:13, fontWeight:700, color:"#F59E0B", marginBottom:2 }}>🕐 {job.jobTime}</div>}
                <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{cust?.company || cust?.companyContact || job.driverName || "No Company"}</div>
                {job.driverName && <div style={{ fontSize:13, color:"#374151", fontWeight:600 }}>Driver: {job.driverName}</div>}
                <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "No vehicle"}</div>
                <div style={{ fontSize:13, color:"#6B7280" }}>{job.jobType}</div>
                {job.locAddress1 && <div style={{ fontSize:12, color:"#9CA3AF", marginTop:2 }}>📍 {[job.locAddress1, job.locTown, job.locPostcode].filter(Boolean).join(", ")}</div>}
              </div>
              <StatusBadge status={job.status} />
            </div>
          </Card>
        );
      })}
      <div style={{ marginTop:16 }}>
        <Btn onClick={() => setView({ screen:"newJob" })} variant="amber" style={{ width:"100%", justifyContent:"center" }}>
          <Icon name="plus" size={16} /> New Job
        </Btn>
      </div>

      <div style={{ marginTop:20, display:"flex", gap:10 }}>
        <Btn onClick={() => setView({ screen:"reports" })} style={{ flex:1, justifyContent:"center" }}>📊 Reports</Btn>
        <Btn onClick={() => setView({ screen:"mileage" })} variant="ghost" style={{ flex:1, justifyContent:"center" }}>🚗 Mileage</Btn>
      </div>
      <div style={{ marginTop:10 }}>
        <Btn onClick={() => setView({ screen:"inspections" })} variant="ghost" style={{ width:"100%", justifyContent:"center" }}>🔍 Site Inspections</Btn>
      </div>
      <div style={{ marginTop:10 }}>
        <Btn onClick={() => setView({ screen:"settings" })} variant="ghost" style={{ width:"100%", justifyContent:"center" }}>⚙️ Settings</Btn>
      </div>

      <div style={{ marginTop:24, paddingTop:16, borderTop:"1px solid #E5E7EB" }}>
        <h3 style={{ fontSize:13, fontWeight:700, color:"#6B7280", margin:"0 0 10px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Tools</h3>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <Btn variant="ghost" onClick={exportBackup} style={{ width:"100%", justifyContent:"center" }}>💾 Download Backup</Btn>
          <Btn variant="ghost" onClick={cleanupOldPhotos} style={{ width:"100%", justifyContent:"center" }}>🗑️ Clear Photos Over 1 Year Old</Btn>
        </div>
      </div>
      <div style={{ textAlign:"center", marginTop:18, fontSize:11, color:"#D1D5DB" }}>{BUILD_NUMBER}</div>
    </div>
  );
}

// ── Customers List ────────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [hidePrivate, setHidePrivate] = useState(true);
  const filtered = data.customers.filter(c => {
    if (hidePrivate && c.custType === "Private") return false;
    return (
      c.company?.toLowerCase().includes(search.toLowerCase()) ||
      c.companyContact?.toLowerCase().includes(search.toLowerCase()) ||
      c.phone?.includes(search) ||
      c.postcode?.toLowerCase().includes(search.toLowerCase()) ||
      c.town?.toLowerCase().includes(search.toLowerCase())
    );
  }).sort((a,b) => (a.company || a.companyContact || "").localeCompare(b.company || b.companyContact || "", undefined, { sensitivity:"base" }));
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Customers</h2>
        <Btn size="sm" onClick={() => setShowForm(true)}><Icon name="plus" size={14} /> Add</Btn>
      </div>
      <input style={{ ...inputStyle, marginBottom:10 }} placeholder="Search name, phone, town, postcode…" value={search} onChange={e => setSearch(e.target.value)} />
      <button onClick={() => setHidePrivate(v => !v)}
        style={{ marginBottom:12, padding:"10px 16px", borderRadius:99, fontSize:14, fontWeight:600, cursor:"pointer", border:"none", background: hidePrivate ? "#1E3A5F" : "#F3F4F6", color: hidePrivate ? "#fff" : "#6B7280", fontFamily:"inherit" }}>
        {hidePrivate ? "✓ Hiding private (showing trade only)" : "Hide private customers"}
      </button>
      {filtered.length === 0 && <p style={{ color:"#9CA3AF", textAlign:"center", fontSize:14 }}>No customers found</p>}
      {filtered.map(c => (
        <Card key={c.id} onClick={() => setView({ screen:"customerDetail", id:c.id })}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
            <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{c.company || c.companyContact || "No name"}</div>
            {c.onStop && <span style={{ background:"#DC2626", color:"#fff", fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap", letterSpacing:"0.03em" }}>ON STOP</span>}
            {c.custType === "Private" && !c.onStop && <span style={{ background:"#E5E7EB", color:"#6B7280", fontSize:10, fontWeight:700, padding:"3px 8px", borderRadius:6, whiteSpace:"nowrap" }}>PRIVATE</span>}
          </div>
          {c.companyContact && <div style={{ fontSize:13, color:"#1E3A5F", fontWeight:600 }}>{c.companyContact}</div>}
          <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{c.phone}{c.town ? ` · ${c.town}` : ""}{c.postcode ? ` · ${c.postcode}` : ""}</div>
          {c.email && <div style={{ fontSize:12, color:"#9CA3AF" }}>{c.email}</div>}
          {c.termsSentAt && <div style={{ fontSize:11, color:"#059669", fontWeight:600, marginTop:3 }}>✅ Terms sent</div>}
        </Card>
      ))}
      {showForm && <CustomerForm data={data} onClose={() => setShowForm(false)} setView={setView} />}
    </div>
  );
}

// Editable grid: rows = repair types, columns = 1st/2nd/3rd-or-later repair on the same
// vehicle. `value` is a partial override table; `placeholderTable` shows what would be
// used if a cell is left blank (the default, or — inside Settings itself — a hardcoded hint).
function PricingGrid({ value, onChange, placeholderTable }) {
  const setCell = (type, tier, v) => onChange({ ...value, [type]: { ...(value[type]||{}), [tier]: v } });
  return (
    <div>
      <div style={{ display:"flex", fontSize:11, fontWeight:700, color:"#9CA3AF", textTransform:"uppercase", padding:"0 0 6px" }}>
        <div style={{ flex:1.3 }}></div>
        <div style={{ flex:1, textAlign:"center" }}>1st</div>
        <div style={{ flex:1, textAlign:"center" }}>2nd</div>
        <div style={{ flex:1, textAlign:"center" }}>3rd+</div>
      </div>
      {DAMAGE_TYPES.map(type => (
        <div key={type} style={{ display:"flex", alignItems:"center", gap:4, marginBottom:6 }}>
          <div style={{ flex:1.3, fontSize:13, fontWeight:600, color:"#374151" }}>{type}</div>
          {["1","2","3"].map(tier => (
            <div key={tier} style={{ flex:1, padding:"0 2px" }}>
              <input type="number" value={value[type]?.[tier] ?? ""} onChange={e => setCell(type, tier, e.target.value)}
                placeholder={placeholderTable?.[type]?.[tier] || "—"}
                style={{ width:"100%", padding:"7px 4px", borderRadius:6, border:"1.5px solid #E5E7EB", fontSize:13, textAlign:"center", boxSizing:"border-box", fontFamily:"inherit" }} />
            </div>
          ))}
        </div>
      ))}
    </div>
  );
}

// ── Customer Form ─────────────────────────────────────────────────────────────
function CustomerForm({ data, onClose, setView, editCustomer }) {
  const [company,        setCompany]        = useState(editCustomer?.company        || "");
  const [companyContact, setCompanyContact] = useState(editCustomer?.companyContact || "");
  const [phone,          setPhone]          = useState(editCustomer?.phone          || "");
  const [email,    setEmail]    = useState(editCustomer?.email    || "");
  const [address1, setAddress1] = useState(editCustomer?.address1 || "");
  const [address2, setAddress2] = useState(editCustomer?.address2 || "");
  const [town,     setTown]     = useState(editCustomer?.town     || "");
  const [county,   setCounty]   = useState(editCustomer?.county   || "");
  const [postcode, setPostcode] = useState(editCustomer?.postcode || "");
  const [notes,    setNotes]    = useState(editCustomer?.notes    || "");
  const [onStop,   setOnStop]   = useState(editCustomer?.onStop   || false);
  const [custType, setCustType] = useState(editCustomer?.custType || "Trade");
  const [pricing,  setPricing]  = useState(editCustomer?.pricing  || {});
  const [followUpDate, setFollowUpDate] = useState(editCustomer?.followUpDate || "");
  const [followUpNote, setFollowUpNote] = useState(editCustomer?.followUpNote || "");
  // Unified contacts list. One contact is flagged main:true. For existing customers
  // without a contacts list yet, seed it from their old single company-contact fields.
  const [contacts, setContacts] = useState(() => {
    if (editCustomer?.contacts?.length) return editCustomer.contacts;
    if (editCustomer) return [{ id: uid(), name: editCustomer.companyContact || "", role: "Main Contact", phone: editCustomer.phone || "", email: editCustomer.email || "", main: true }];
    return [{ id: uid(), name:"", role:"Main Contact", phone:"", email:"", main:true }];
  });
  const addContact    = () => setContacts(cs => [...cs, { id: uid(), name:"", role:"Director", phone:"", email:"", main: cs.length===0 }]);
  const updateContact = (id, field, value) => setContacts(cs => cs.map(c => c.id === id ? { ...c, [field]: value } : c));
  const removeContact = (id) => setContacts(cs => {
    const filtered = cs.filter(c => c.id !== id);
    // If we removed the main contact, make the first remaining one main
    if (!filtered.some(c => c.main) && filtered.length) filtered[0].main = true;
    return filtered;
  });
  const setMainContact = (id) => setContacts(cs => cs.map(c => ({ ...c, main: c.id === id })));

  // Inline vehicle (private customers, new only) — optional
  const [vehMake, setVehMake] = useState("");
  const [vehModel, setVehModel] = useState("");
  const [vehReg, setVehReg] = useState("");

  async function save() {
    if (!company) return;
    const customers = [...data.customers];
    // Keep the legacy single fields in sync with whoever is the main contact,
    // so customer cards, dropdowns and call buttons keep working.
    const main = contacts.find(c => c.main) || contacts[0] || {};
    const rec = { company, companyContact: main.name || companyContact, phone: main.phone || phone, email: main.email || email, address1, address2, town, county, postcode, notes, onStop, custType, pricing, followUpDate, followUpNote, contacts };
    let newData = { ...data };
    let savedCustomerId;
    if (editCustomer) {
      const idx = customers.findIndex(c => c.id === editCustomer.id);
      customers[idx] = { ...editCustomer, ...rec };
      savedCustomerId = editCustomer.id;
    } else {
      savedCustomerId = uid();
      customers.push({ id:savedCustomerId, ...rec, createdAt:todayISO() });
    }
    newData.customers = customers;
    // If an inline vehicle was entered (new private customer), add it too
    if (!editCustomer && (vehMake || vehModel || vehReg)) {
      const vehicles = [...(data.vehicles || []), { id: uid(), customerId: savedCustomerId, make: vehMake, model: vehModel, reg: vehReg, createdAt: todayISO() }];
      newData.vehicles = vehicles;
    }
    await saveAndReload(newData);
  }

  return (
    <Modal title={editCustomer ? "Edit Customer" : "New Customer"} onClose={onClose}>
      <div style={{ marginTop:8 }} />
      <Field label="Customer Type"><Select value={custType} onChange={setCustType} options={["Trade","Private"]} /></Field>
      <Field label={custType === "Private" ? "Customer Name" : "Company Name"} required>
        <Input value={company} onChange={setCompany} placeholder={custType === "Private" ? "John Smith" : "Acme Ltd"} />
      </Field>
      {custType === "Private" && (
        <>
          <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" /></Field>
          <Field label="Email"><Input value={email} onChange={setEmail} placeholder="jane@email.com" type="email" /></Field>
          {!editCustomer && (
            <div style={{ background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:10, padding:12, marginBottom:14 }}>
              <div style={{ fontSize:12, fontWeight:700, color:"#1E3A5F", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>Vehicle (optional)</div>
              <div style={{ marginBottom:6 }}><Input value={vehMake} onChange={setVehMake} placeholder="Make (e.g. Ford)" /></div>
              <div style={{ marginBottom:6 }}><Input value={vehModel} onChange={setVehModel} placeholder="Model (e.g. Focus)" /></div>
              <Input value={vehReg} onChange={setVehReg} placeholder="Reg (e.g. AB12 CDE)" />
            </div>
          )}
        </>
      )}
      {custType === "Trade" && (
        <div style={{ background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:10, padding:12, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#1E3A5F", marginBottom:2, textTransform:"uppercase", letterSpacing:"0.05em" }}>Repair Prices (£)</div>
          <div style={{ fontSize:12, color:"#9CA3AF", marginBottom:10 }}>Leave a cell blank to use the default price for that type/tier.</div>
          <PricingGrid value={pricing} onChange={setPricing} placeholderTable={getDefaultPricing(data)} />
        </div>
      )}
      {custType === "Trade" && (
        <div style={{ background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:10, padding:12, marginBottom:14 }}>
          <div style={{ fontSize:12, fontWeight:700, color:"#1E3A5F", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>Contacts</div>
          {contacts.map((ct, idx) => (
            <div key={ct.id} style={{ background:"#fff", border: ct.main ? "1.5px solid #F59E0B" : "1px solid #F3F4F6", borderRadius:8, padding:10, marginBottom:8 }}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6 }}>
                <button onClick={() => setMainContact(ct.id)} style={{ background: ct.main ? "#FEF3C7" : "#F3F4F6", color: ct.main ? "#92400E" : "#6B7280", border:"none", borderRadius:6, padding:"3px 10px", fontSize:11, fontWeight:700, cursor:"pointer" }}>
                  {ct.main ? "★ Main contact" : "☆ Set as main"}
                </button>
                {contacts.length > 1 && <button onClick={() => removeContact(ct.id)} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"3px 8px", fontSize:12, fontWeight:600, cursor:"pointer" }}>Remove</button>}
              </div>
              <div style={{ marginBottom:6 }}><Input value={ct.name} onChange={v => updateContact(ct.id, "name", v)} placeholder="Contact name" /></div>
              <div style={{ marginBottom:6 }}><Select value={ct.role} onChange={v => updateContact(ct.id, "role", v)} options={["Main Contact","Director","Owner","Manager","Salesman","Mechanic","Accounts","Other"]} /></div>
              <div style={{ marginBottom:6 }}><Input value={ct.phone} onChange={v => updateContact(ct.id, "phone", v)} placeholder="Phone" type="tel" /></div>
              <Input value={ct.email} onChange={v => updateContact(ct.id, "email", v)} placeholder="Email" type="email" />
            </div>
          ))}
          <Btn size="sm" variant="ghost" onClick={addContact} style={{ width:"100%", justifyContent:"center" }}>+ Add contact</Btn>
        </div>
      )}
      <Field label="Address Line 1"><Input value={address1} onChange={setAddress1} placeholder="12 High Street" /></Field>
      <Field label="Address Line 2"><Input value={address2} onChange={setAddress2} placeholder="Clifton" /></Field>
      <Field label="Town / City"><Input value={town} onChange={setTown} placeholder="Bristol" /></Field>
      <Field label="County"><Input value={county} onChange={setCounty} placeholder="Avon" /></Field>
      <Field label="Postcode"><Input value={postcode} onChange={setPostcode} placeholder="BS1 1AA" /></Field>
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>
      <div style={{ background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:10, padding:12, marginBottom:14 }}>
        <div style={{ fontSize:12, fontWeight:700, color:"#1E3A5F", marginBottom:8, textTransform:"uppercase", letterSpacing:"0.05em" }}>📞 Follow-up Reminder</div>
        <Field label="Call back on"><Input type="date" value={followUpDate} onChange={setFollowUpDate} /></Field>
        <Field label="About"><Input value={followUpNote} onChange={setFollowUpNote} placeholder="e.g. screen repair Monday" /></Field>
        {followUpDate && <button onClick={() => { setFollowUpDate(""); setFollowUpNote(""); }} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Clear reminder</button>}
      </div>
      <div style={{ marginBottom:14 }}>
        <label style={{ display:"flex", alignItems:"center", gap:10, cursor:"pointer", padding:"12px 14px", borderRadius:8, border:`1.5px solid ${onStop ? "#FCA5A5" : "#E5E7EB"}`, background: onStop ? "#FEF2F2" : "#fff" }}>
          <input type="checkbox" checked={onStop} onChange={e => setOnStop(e.target.checked)} style={{ width:18, height:18 }} />
          <span style={{ fontSize:14, fontWeight:600, color: onStop ? "#DC2626" : "#374151" }}>🛑 Put account on stop (non-payment)</span>
        </label>
      </div>
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!company}>Save Customer</Btn>
    </Modal>
  );
}

// ── Repair Terms message (Text / WhatsApp) ────────────────────────────────────
// ── Terms & Conditions ──────────────────────────────────────────────────────
const TERMS_SECTIONS = [
  { title: "1. General & Bookings", items: [
    { h: "Contract Formation", t: "A binding contract is formed when a booking is confirmed either verbally (during a phone call or in person) or in writing (via text message, email, or website booking)." },
    { h: "Mobile Service Area", t: "We reserve the right to cancel or reschedule bookings if your vehicle is located outside our designated operating radius." },
    { h: "Safe Working Environment", t: "You must provide a safe, off-road working space (such as a private driveway, workshop, or secure commercial yard) with adequate clearance around the vehicle. We reserve the right to cancel the appointment if heavy rain, extreme temperatures, or unsafe location conditions make a quality repair impossible." },
  ]},
  { title: "2. Windscreen Repair & The \"Spreading Crack\" Disclaimer", items: [
    { h: "Inherent Repair Risks", t: "You acknowledge that a stone chip repair involves applying localized mechanical pressure and heat to damaged, weakened glass. There is an inherent, unavoidable risk that the chip may spread into a larger, unrepairable crack during the standard repair process." },
    { h: "Limitation of Liability", t: "If the glass cracks or worsens during a professional repair attempt, the Company is not liable for the cost of a replacement windscreen, fleet downtime, or any alternative transport." },
    { h: "Failed Repair Fee Policy", t: "If a chip cracks further or fails during our technician's repair attempt, we will abort the process immediately and waive our repair fee for that specific glass unit." },
  ]},
  { title: "3. Visual and Aesthetic Outcomes", items: [
    { h: "Structural Integrity Only", t: "The primary, legal purpose of a resin repair is to restore the structural strength of the windscreen and prevent further cracking." },
    { h: "Aesthetic Appearance", t: "A repair will significantly improve the clarity of the glass, but it will not make the original chip invisible. A minor blemish, scar, or refraction spot will usually remain visible within the glass structure." },
    { h: "Repair Failure After Completion", t: "If a completed repair breaks down or begins to spread within 12 months of the repair date, our liability is strictly limited to a refund or credit of the original repair fee paid to us. This does not apply to damage caused by a new impact, or to further deterioration reported after the 12-month period." },
  ]},
  { title: "4. MOT Compliance, ADAS & Vision Zones", items: [
    { h: "The 10mm MOT Rule vs. 20mm Repair Standard", t: "Under UK British Standards (BS AU 242b), technicians are permitted to structurally repair chips up to 20mm in diameter within the driver's line of vision (Zone A). However, the DVSA MOT inspection rules state that any visible damage over 10mm in Zone A constitutes an MOT failure." },
    { h: "Customer Risk Acceptance", t: "If you request that we repair a chip in Zone A that measures between 11mm and 20mm, you accept that while the repair will restore structural integrity, the vehicle may still fail its MOT due to the size and location of the blemish. The Company accepts zero liability for MOT failures, re-test fees, or subsequent replacement costs under these circumstances." },
    { h: "Absolute Refusals", t: "If a chip in Zone A exceeds 20mm, or if it is located directly in front of a vital Advanced Driver Assistance Systems (ADAS) camera lens, we will refuse the repair entirely for safety and road-legality reasons." },
  ]},
  { title: "5. Payment Terms (Retail vs. Trade)", items: [
    { h: "No Insurance Billing", t: "The Company operates on a direct billing basis only. We do not deal directly with motor insurance providers, nor do we process third-party insurance claims on your behalf." },
    { h: "Retail Customers (Private Individuals)", t: "Payment is due in full immediately upon completion of the repair work. We accept payment via cash, debit/credit card, or instant bank transfer. The vehicle will not be handed back until valid payment has been confirmed." },
    { h: "Trade Customers (Commercial Accounts/Fleets)", t: "Payment is strictly due within 30 days from the date of the invoice. Invoices will be issued upon completion of the booked work or on an agreed monthly schedule. We reserve the right to charge interest and statutory compensation on late payments in accordance with the Late Payment of Commercial Debts (Interest) Act 1998 if invoices are not cleared within the 30-day term." },
  ]},
  { title: "6. Data Protection", items: [
    { h: "What We Collect", t: "To provide our repair service we collect and hold your name, address, phone number, email address, and vehicle details (registration, make, model), along with photos of the damage and a record of the work carried out." },
    { h: "Why We Hold It", t: "This information is used to carry out the booked repair, keep accurate job and payment records, and to contact you about bookings, follow-ups, or outstanding invoices. We do not use your details for marketing without your consent." },
    { h: "How It's Stored", t: "Your details are stored securely and are not sold or shared with third parties, except where required by law (for example, HMRC for tax purposes)." },
    { h: "Your Rights", t: "You can ask us at any time what information we hold about you, ask us to correct it, or ask us to delete it, subject to our own legal obligation to retain certain records (such as invoices) for tax purposes. To do so, contact us using the details above." },
  ]},
  { title: "7. Governing Law", items: [
    { h: "", t: "These Terms and Conditions are governed by and construed in accordance with the laws of England & Wales, and any disputes will be subject to the exclusive jurisdiction of these courts." },
  ]},
];

// Pure, synchronous — opens the formatted Terms & Conditions document. `mailtoLink` (if
// given) drives the "Open Mail App" button; leave it out for a plain view/print-only open.
function openTermsWindow(mailtoLink) {
  const logoUrl = window.location.origin + "/logo.png";
  const sections = TERMS_SECTIONS.map(sec => `
    <div style="margin-bottom:18px;">
      <div style="font-size:14px;font-weight:800;color:#1E3A5F;margin-bottom:8px;">${sec.title}</div>
      ${sec.items.map(it => `
        <div style="margin-bottom:8px;">
          ${it.h ? `<span style="font-weight:700;color:#111827;font-size:13px;">${it.h}: </span>` : ""}
          <span style="font-size:13px;color:#374151;line-height:1.5;">${it.t}</span>
        </div>`).join("")}
    </div>`).join("");

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Terms and Conditions</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:Arial,sans-serif; }
  @media print { .no-print { display:none !important; } body { background:#fff; } }
</style></head><body>
<div class="no-print" style="position:sticky;top:0;z-index:100;background:#1E3A5F;padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;">
  <div style="font-size:13px;color:#93C5FD;font-weight:600;width:100%;text-align:center;">Tap Save as PDF, then attach to an email</div>
  <button onclick="window.print()" style="background:#F59E0B;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">💾 Save as PDF</button>
  ${mailtoLink ? `<a href="${mailtoLink}" style="background:#fff;color:#1E3A5F;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;">✉️ Open Mail App</a>` : ""}
</div>
<div style="max-width:760px;margin:0 auto;padding:24px;background:#fff;">
  <div style="display:flex;align-items:center;gap:14px;border-bottom:3px solid #F59E0B;padding-bottom:14px;margin-bottom:18px;">
    <img src="${logoUrl}" style="width:56px;height:56px;object-fit:contain;" />
    <div>
      <div style="font-size:20px;font-weight:800;color:#1E3A5F;">Windscreen Repairs (Bristol)</div>
      <div style="font-size:12px;color:#6B7280;">3 Goosander Grove, Cheddar, BS27 3FY · 07946 222246</div>
      <div style="font-size:12px;color:#6B7280;">info@windscreenrepairsbristol.co.uk</div>
    </div>
  </div>
  <div style="font-size:17px;font-weight:800;color:#1E3A5F;margin-bottom:4px;">Terms and Conditions for Windscreen Repair Services</div>
  <div style="font-size:12px;color:#9CA3AF;margin-bottom:18px;">Please read these Terms and Conditions carefully. By booking a repair service with Windscreen Repairs Bristol ("the Company", "we", "us") verbally, over the phone, via text, or in writing, you ("the Customer", "you") agree to be bound by these terms.</div>
  ${sections}
</div>
</body></html>`;
  const blob = new Blob([html], { type: "text/html" });
  const url = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

function RepairTermsModal({ customer, data, onClose }) {
  const [price, setPrice] = useState(String(priceForRepair(getRepairPricing(data, customer), "Chip", 1) || ""));

  const message =
`The cost of the repair is £${price}. Please bear in mind it's not a cosmetic repair, the main purpose is to restore strength and integrity to the screen. There is also a slight chance during the repair that the screen can crack due to various conditions, we can NOT be held liable if a crack developed during or after the repair.

Please reply if you are happy for me to carry out the repair knowing the points above.

Full Terms and Conditions: https://www.windscreenrepairsbristol.co.uk/terms`;

  // Normalise UK number for WhatsApp (needs international format, no leading 0)
  const waNumber = (customer.phone || "").replace(/[^0-9]/g, "").replace(/^0/, "44");
  const smsLink = `sms:${customer.phone}${/iphone|ipad|mac/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(message)}`;
  const waLink  = `https://wa.me/${waNumber}?text=${encodeURIComponent(message)}`;

  function logSend(type) {
    const entry = { id: uid(), customerId: customer.id, contactId: "", contactName: "", type, direction: "out", note: message, timestamp: Date.now(), createdAt: todayISO() };
    const customers = data.customers.map(c => c.id === customer.id ? { ...c, termsSentAt: Date.now() } : c);
    saveAndReload({ ...data, customers, communications: [...(data.communications || []), entry] }).catch(() => {});
  }

  return (
    <Modal title="Send Repair Terms" onClose={onClose}>
      <Field label="Repair Price (£)"><Input type="number" value={price} onChange={setPrice} placeholder="40.00" /></Field>
      <div style={{ background:"#F9FAFB", borderRadius:8, padding:"12px 14px", marginBottom:16, fontSize:13, color:"#374151", whiteSpace:"pre-wrap", lineHeight:1.5, maxHeight:200, overflowY:"auto" }}>
        {message}
      </div>
      <div style={{ display:"flex", gap:8 }}>
        <a href={waLink} target="_blank" rel="noreferrer" style={{ textDecoration:"none", flex:1 }} onClick={() => logSend("WhatsApp")}>
          <Btn style={{ width:"100%", justifyContent:"center", background:"#25D366" }}>💬 WhatsApp</Btn>
        </a>
        <a href={smsLink} style={{ textDecoration:"none", flex:1 }} onClick={() => logSend("Text")}>
          <Btn variant="primary" style={{ width:"100%", justifyContent:"center" }}>✉️ Text</Btn>
        </a>
      </div>
      <p style={{ fontSize:11, color:"#9CA3AF", marginTop:10, textAlign:"center" }}>Opens your messaging app with the text ready to send</p>
    </Modal>
  );
}

// ── Damage Report (list of vehicles to send to a trade client) ────────────────
function DamageReportModal({ customer, vehicles, data, onClose }) {
  // A vehicle counts as "repaired" if it has any job that's Complete, Invoiced or Paid
  const isRepaired = (vehId) => (data?.jobs || []).some(j => j.vehicleId === vehId && ["Complete","Invoiced","Paid"].includes(j.status));
  const unrepairedVehicles = (vehicles || []).filter(v => !isRepaired(v.id));

  // Flatten into one item per individual damage (chip/crack/etc), grouped by vehicle
  const damageItems = [];
  unrepairedVehicles.forEach(v => {
    const jobs = (data?.jobs || []).filter(j => j.vehicleId === v.id && !["Complete","Invoiced","Paid"].includes(j.status));
    jobs.forEach(j => {
      const reps = j.repairs?.length ? j.repairs : (j.damageType ? [{ id: j.id, type: j.damageType, side: j.damageSide, position: j.damagePosition }] : []);
      reps.forEach((r, idx) => damageItems.push({ id: `${v.id}-${r.id || j.id + "-" + idx}`, vehicle: v, repair: r }));
    });
  });

  const [selected, setSelected] = useState(() => {
    const s = {}; damageItems.forEach(d => { s[d.id] = true; }); return s;
  });
  const [note, setNote] = useState("The following vehicles were found to have windscreen damage during our recent inspection. Please let us know which of the damage below you would like us to repair.");
  const toggle = (id) => setSelected(s => ({ ...s, [id]: !s[id] }));

  function generate() {
    const chosen = damageItems.filter(d => selected[d.id]);
    const vehicleCount = new Set(chosen.map(d => d.vehicle.id)).size;
    const logoUrl = window.location.origin + "/logo.png";
    const fmtD = new Date().toLocaleDateString("en-GB");
    const rows = chosen.map((d, i) => `
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:13px;color:#6B7280;">${i+1}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;"><b>${d.vehicle.reg || "—"}</b> · ${[d.vehicle.make, d.vehicle.model].filter(Boolean).join(" ") || "—"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;">${describeRepair(d.repair) || d.repair.type || "—"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;text-align:center;"><span style="display:inline-block;width:16px;height:16px;border:2px solid #374151;border-radius:3px;"></span></td>
      </tr>`).join("");

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Windscreen Damage Report</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:Arial,sans-serif; }
  @media print { .no-print { display:none !important; } body { background:#fff; } }
</style></head><body>
<div class="no-print" style="position:sticky;top:0;z-index:100;background:#1E3A5F;padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;">
  <div style="font-size:13px;color:#93C5FD;font-weight:600;width:100%;text-align:center;">Tap Save as PDF, then attach to an email</div>
  <button onclick="window.print()" style="background:#F59E0B;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">💾 Save as PDF</button>
</div>
<div style="max-width:700px;margin:0 auto;padding:24px;background:#fff;">
  <div style="display:flex;align-items:center;gap:14px;border-bottom:3px solid #F59E0B;padding-bottom:14px;margin-bottom:18px;">
    <img src="${logoUrl}" style="width:56px;height:56px;object-fit:contain;" />
    <div>
      <div style="font-size:20px;font-weight:800;color:#1E3A5F;">Windscreen Repairs (Bristol)</div>
      <div style="font-size:12px;color:#6B7280;">3 Goosander Grove, Cheddar, BS27 3FY · 07946 222246</div>
      <div style="font-size:12px;color:#6B7280;">info@windscreenrepairsbristol.co.uk</div>
    </div>
  </div>
  <div style="font-size:16px;font-weight:800;color:#1E3A5F;margin-bottom:4px;">Windscreen Damage Report</div>
  <div style="font-size:13px;color:#6B7280;margin-bottom:2px;">Prepared for: <b style="color:#111827;">${customer.company || customer.companyContact || ""}</b></div>
  <div style="font-size:13px;color:#6B7280;margin-bottom:14px;">Date: ${fmtD}</div>
  <div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:16px;">${note.replace(/</g,"&lt;")}</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;">
    <thead><tr style="background:#F9FAFB;">
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB;">#</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB;">Car</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB;">Damage</th>
      <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6B7280;text-transform:uppercase;border-bottom:1px solid #E5E7EB;">Please Repair</th>
    </tr></thead>
    <tbody>${rows || '<tr><td colspan="4" style="padding:14px;color:#9CA3AF;font-size:13px;">No damage selected</td></tr>'}</tbody>
  </table>
  <div style="font-size:12px;color:#9CA3AF;margin:20px 0 24px;">${vehicleCount} vehicle(s), ${chosen.length} damage item(s) listed · Windscreen Repairs (Bristol)</div>
  <div style="border-top:1px solid #E5E7EB;padding-top:16px;">
    <div style="font-size:12px;color:#6B7280;margin-bottom:14px;">Please tick above the damage you'd like us to repair, then complete below to authorise the work.</div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:4px;">
      <div style="flex:1;min-width:180px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Authorised by (name)</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
      <div style="flex:1;min-width:180px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Signature</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
      <div style="min-width:120px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Date</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }

  const count = Object.values(selected).filter(Boolean).length;

  return (
    <Modal title="Damage Report" onClose={onClose}>
      {damageItems.length === 0 ? (
        <p style={{ fontSize:14, color:"#9CA3AF" }}>{(vehicles||[]).length === 0 ? "This customer has no vehicles added." : "All of this customer's vehicles have already been repaired."}</p>
      ) : (
        <>
          <Field label="Covering note">
            <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
              style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontFamily:"inherit", fontSize:14, resize:"vertical", boxSizing:"border-box" }} />
          </Field>
          <div style={{ fontSize:12, fontWeight:700, color:"#6B7280", margin:"6px 0 8px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Select damage to include — each repair is listed separately</div>
          {unrepairedVehicles.map(v => {
            const items = damageItems.filter(d => d.vehicle.id === v.id);
            if (items.length === 0) return null;
            return (
              <div key={v.id} style={{ marginBottom:10 }}>
                <div style={{ fontWeight:700, fontSize:14, color:"#111827", marginBottom:4 }}>{v.reg || "No reg"} <span style={{ fontWeight:500, color:"#6B7280" }}>· {[v.make, v.model].filter(Boolean).join(" ") || "—"}</span></div>
                {items.map(d => (
                  <label key={d.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", border:"1px solid #F3F4F6", borderRadius:8, marginBottom:6, cursor:"pointer", background: selected[d.id] ? "#EFF6FF" : "#fff" }}>
                    <input type="checkbox" checked={!!selected[d.id]} onChange={() => toggle(d.id)} style={{ width:18, height:18 }} />
                    <div style={{ fontSize:13, color:"#374151" }}>{describeRepair(d.repair) || d.repair.type || "Repair"}</div>
                  </label>
                ))}
              </div>
            );
          })}
          <Btn onClick={generate} disabled={count===0} style={{ width:"100%", justifyContent:"center", marginTop:10 }}>
            📄 Generate PDF ({count})
          </Btn>
          <p style={{ fontSize:11, color:"#9CA3AF", marginTop:8, textAlign:"center" }}>Opens the report — tap "Save as PDF", then attach it to an email to your client.</p>
        </>
      )}
    </Modal>
  );
}

// ── Customer Detail ───────────────────────────────────────────────────────────
// ── Communications Log ──────────────────────────────────────────────────────
const COMM_ICONS = { Call: "📞", Text: "💬", WhatsApp: "💬", Email: "✉️", Note: "📝" };

function CommLogModal({ customer, contact, onSave, onClose, editEntry }) {
  const [type, setType]           = useState(editEntry?.type || "Call");
  const [direction, setDirection] = useState(editEntry?.direction || "out");
  const [note, setNote]           = useState(editEntry?.note || "");
  const [photos, setPhotos]       = useState(editEntry?.photos || []);

  const phone = contact?.phone || customer.phone;
  const email = contact?.email || customer.email;
  const waNumber = (phone || "").replace(/[^0-9]/g, "").replace(/^0/, "44");
  const telLink  = phone ? `tel:${phone}` : "";
  const smsLink  = phone ? `sms:${phone}${/iphone|ipad|mac/i.test(navigator.userAgent) ? "&" : "?"}body=${encodeURIComponent(note)}` : "";
  const waLink   = phone ? `https://wa.me/${waNumber}?text=${encodeURIComponent(note)}` : "";
  const mailLink = email ? `mailto:${email}${note ? `?body=${encodeURIComponent(note)}` : ""}` : "";

  function save() {
    onSave({
      id: editEntry?.id || uid(),
      customerId: customer.id,
      contactId: contact?.id || editEntry?.contactId || "",
      contactName: contact?.name || editEntry?.contactName || "",
      type, direction, note, photos,
      timestamp: editEntry?.timestamp || Date.now(),
      createdAt: editEntry?.createdAt || todayISO(),
    });
    onClose();
  }

  return (
    <Modal title={editEntry ? "Edit Log Entry" : (contact ? `Log / Message — ${contact.name || "Contact"}` : "Log Communication")} onClose={onClose}>
      {!phone && !email && <p style={{ fontSize:13, color:"#DC2626", margin:"0 0 12px" }}>No phone or email on file for {contact ? "this contact" : "this customer"} — you can still add a note.</p>}
      <Field label="Type"><Select value={type} onChange={setType} options={["Call","Text","WhatsApp","Email","Note"]} /></Field>
      <Field label="Direction">
        <div style={{ display:"flex", gap:8 }}>
          <button onClick={() => setDirection("out")} style={{ flex:1, padding:"9px", borderRadius:8, border: direction==="out" ? "2px solid #1E3A5F" : "1.5px solid #E5E7EB", background: direction==="out" ? "#EFF6FF" : "#fff", fontWeight:700, fontSize:13, cursor:"pointer", color:"#1E3A5F" }}>Outgoing</button>
          <button onClick={() => setDirection("in")} style={{ flex:1, padding:"9px", borderRadius:8, border: direction==="in" ? "2px solid #1E3A5F" : "1.5px solid #E5E7EB", background: direction==="in" ? "#EFF6FF" : "#fff", fontWeight:700, fontSize:13, cursor:"pointer", color:"#1E3A5F" }}>Incoming</button>
        </div>
      </Field>
      <Field label={type === "Call" || type === "Note" ? "Note" : "Message"}>
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={4}
          placeholder={type === "Call" ? "What was discussed…" : type === "Note" ? "Note…" : "Message content…"}
          style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontFamily:"inherit", fontSize:14, resize:"vertical", boxSizing:"border-box" }} />
      </Field>

      <PhotoUploader label={direction === "in" ? "Screenshot of message received" : "Attachment"} photos={photos} onChange={setPhotos} jobId={`comm-${customer.id}`} />

      {type === "Call" && telLink && (
        <a href={telLink} style={{ textDecoration:"none" }}><Btn variant="ghost" style={{ width:"100%", justifyContent:"center", marginBottom:12 }}>📞 Call Now</Btn></a>
      )}
      {type === "Text" && phone && (
        <div style={{ display:"flex", gap:8, marginBottom:12 }}>
          <a href={waLink} target="_blank" rel="noreferrer" style={{ textDecoration:"none", flex:1 }}><Btn style={{ width:"100%", justifyContent:"center", background:"#25D366" }}>💬 WhatsApp</Btn></a>
          <a href={smsLink} style={{ textDecoration:"none", flex:1 }}><Btn variant="ghost" style={{ width:"100%", justifyContent:"center" }}>Text (SMS)</Btn></a>
        </div>
      )}
      {type === "WhatsApp" && waLink && (
        <a href={waLink} target="_blank" rel="noreferrer" style={{ textDecoration:"none" }}><Btn style={{ width:"100%", justifyContent:"center", background:"#25D366", marginBottom:12 }}>💬 Open WhatsApp</Btn></a>
      )}
      {type === "Email" && mailLink && (
        <a href={mailLink} style={{ textDecoration:"none" }}><Btn variant="ghost" style={{ width:"100%", justifyContent:"center", marginBottom:12 }}>✉️ Open Email</Btn></a>
      )}
      <p style={{ fontSize:11, color:"#9CA3AF", margin:"0 0 12px", textAlign:"center" }}>{(type==="Call"||type==="Note") ? "" : "Opens your messaging/mail app with this ready to send. "}Tap Save to add it to the log.</p>

      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }}>💾 Save to Log</Btn>
    </Modal>
  );
}

function CustomerDetail({ data, id, setView }) {
  const customer = data.customers.find(c => c.id === id);
  const vehicles = data.vehicles.filter(v => v.customerId === id);
  const jobs     = data.jobs.filter(j => j.customerId === id).sort((a,b) => b.date.localeCompare(a.date));
  const [showEdit, setShowEdit]       = useState(false);
  const [showVehicle, setShowVehicle] = useState(false);
  const [showTerms, setShowTerms]     = useState(false);
  const [showDamageReport, setShowDamageReport] = useState(false);
  const [showCommLog, setShowCommLog] = useState(false);
  const [editingComm, setEditingComm] = useState(null);
  const [logContact, setLogContact]   = useState(null);
  const comms = data.communications ? data.communications.filter(c => c.customerId === id).sort((a,b) => (b.timestamp||0)-(a.timestamp||0)) : [];
  if (!customer) return <p>Not found</p>;

  const addrParts = [customer.address1, customer.address2, customer.town, customer.county, customer.postcode].filter(Boolean);

  async function deleteCustomer() {
    if (!window.confirm("Delete this customer?")) return;
    try {
      await deleteRecord("customers", id);
    } catch (e) {
      alert("Delete failed: " + (e?.message || JSON.stringify(e)));
      return;
    }
    addTombstone(id);
    removeSig(id);
    // Remove locally and save WITHOUT re-pushing everything
    const updated = { ...loadData(), customers: loadData().customers.filter(c => c.id !== id) };
    localStorage.setItem(DB_KEY, JSON.stringify(updated));
    window.location.reload();
  }

  async function saveComm(entry) {
    const existing = data.communications || [];
    const communications = existing.some(c => c.id === entry.id)
      ? existing.map(c => c.id === entry.id ? entry : c)
      : [...existing, entry];
    try {
      await saveAndReload({ ...data, communications });
    } catch (e) {
      alert("Save failed: " + (e?.message || e));
    }
  }
  // Fire-and-forget logging for quick send buttons (Call/Email/Terms) — doesn't block
  // or delay the tel:/mailto:/sms: hand-off, which has already happened by the time
  // saveAndReload's network push and eventual reload occur.
  function quickLog(type, note, extra = {}, markTermsSent = false) {
    const entry = { id: uid(), customerId: customer.id, contactId: "", contactName: "", type, direction: "out", note, timestamp: Date.now(), createdAt: todayISO(), ...extra };
    const communications = [...(data.communications || []), entry];
    const customers = markTermsSent ? data.customers.map(c => c.id === customer.id ? { ...c, termsSentAt: Date.now() } : c) : data.customers;
    saveAndReload({ ...data, communications, customers }).catch(() => {});
  }
  async function deleteComm(commId) {
    if (!window.confirm("Delete this log entry?")) return;
    try { await deleteRecord("communications", commId); } catch (e) { alert("Delete failed: " + (e?.message||e)); return; }
    addTombstone(commId);
    removeSig(commId);
    const d = loadData();
    localStorage.setItem(DB_KEY, JSON.stringify({ ...d, communications: (d.communications||[]).filter(c => c.id !== commId) }));
    window.location.reload();
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"customers" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      {customer.onStop && (
        <div style={{ background:"#DC2626", color:"#fff", borderRadius:10, padding:"12px 16px", marginBottom:14, fontWeight:700, fontSize:15, display:"flex", alignItems:"center", gap:8 }}>
          🛑 ACCOUNT ON STOP — do not carry out work until paid
        </div>
      )}
      {customer.followUpDate && (
        <div style={{ background:"#FFF7ED", border:"1px solid #FED7AA", borderRadius:10, padding:"12px 16px", marginBottom:14, fontSize:14, display:"flex", justifyContent:"space-between", alignItems:"center", gap:10 }}>
          <div>
            <span style={{ fontWeight:700, color:"#92400E" }}>📞 Follow up {fmtDate(customer.followUpDate)}</span>
            {customer.followUpNote && <span style={{ color:"#B45309" }}> — {customer.followUpNote}</span>}
          </div>
          <button onClick={async () => {
            const customers = data.customers.map(c => c.id === customer.id ? { ...c, followUpDate:"", followUpNote:"" } : c);
            await saveAndReload({ ...data, customers });
          }} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer", whiteSpace:"nowrap" }}>Delete</button>
        </div>
      )}
      <Card>
        <div style={{ fontWeight:800, fontSize:20, color:"#1E3A5F" }}>{customer.company || "No company name"}</div>
        {customer.companyContact && <div style={{ fontSize:14, color:"#374151", marginTop:4 }}>Contact: {customer.companyContact}</div>}
        <div style={{ fontSize:14, color:"#6B7280", marginTop:4 }}>{customer.phone}</div>
        {customer.email && <div style={{ fontSize:14, color:"#6B7280" }}>{customer.email}</div>}
        {addrParts.length > 0 && (
          <div style={{ fontSize:13, color:"#6B7280", marginTop:6, lineHeight:1.6 }}>
            {addrParts.map((p,i) => <span key={i}>{p}{i < addrParts.length-1 ? ", " : ""}</span>)}
          </div>
        )}
        {customer.notes && <div style={{ fontSize:13, color:"#9CA3AF", marginTop:6 }}>{customer.notes}</div>}
        <button onClick={async () => {
          const customers = data.customers.map(c => c.id === customer.id ? { ...c, termsSentAt: c.termsSentAt ? "" : Date.now() } : c);
          try { await saveAndReload({ ...data, customers }); } catch (e) { alert("Save failed: " + (e?.message||e)); }
        }} style={{ display:"flex", alignItems:"center", gap:8, marginTop:10, padding:"8px 12px", borderRadius:8, border: customer.termsSentAt ? "1.5px solid #A7F3D0" : "1.5px solid #E5E7EB", background: customer.termsSentAt ? "#ECFDF5" : "#F9FAFB", cursor:"pointer", width:"100%", textAlign:"left" }}>
          <span style={{ fontSize:16 }}>{customer.termsSentAt ? "✅" : "⬜"}</span>
          <span style={{ fontSize:13, fontWeight:600, color: customer.termsSentAt ? "#059669" : "#6B7280" }}>
            {customer.termsSentAt ? `Terms sent ${new Date(customer.termsSentAt).toLocaleDateString("en-GB")} — tap to unmark` : "Terms & Conditions not yet marked as sent — tap once sent"}
          </span>
        </button>
        <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
          {customer.phone && (
            <a href={`tel:${customer.phone}`} style={{ textDecoration:"none" }} onClick={() => quickLog("Call", "")}>
              <Btn size="sm" variant="primary">📞 Call</Btn>
            </a>
          )}
          {customer.email && (
            <a href={`mailto:${customer.email}`} style={{ textDecoration:"none" }} onClick={() => quickLog("Email", "")}>
              <Btn size="sm" variant="ghost">✉️ Email</Btn>
            </a>
          )}
          {customer.phone && customer.custType === "Private" && <Btn size="sm" variant="ghost" onClick={() => setShowTerms(true)}>💬 Send Terms</Btn>}
          {customer.custType === "Trade" && <Btn size="sm" variant="ghost" onClick={() => setShowDamageReport(true)}>📄 Damage Report</Btn>}
          {customer.custType === "Trade" && <Btn size="sm" variant="ghost" onClick={() => setView({ screen:"newInspection", prefillCustomerId:id })}>🔍 New Inspection</Btn>}
          <Btn size="sm" variant="ghost" onClick={() => { setEditingComm(null); setLogContact(null); setShowCommLog(true); }}>💬 Log / Message</Btn>
          {customer.email && customer.custType === "Trade" && (
            <Btn size="sm" variant="ghost" onClick={() => {
              openTermsWindow(`mailto:${customer.email}?subject=${encodeURIComponent("Terms and Conditions — Windscreen Repairs Bristol")}`);
              quickLog("Email", "Terms & Conditions sent (PDF)", {}, true);
            }}>📜 Download & Send T&Cs</Btn>
          )}
          <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)}><Icon name="edit" size={13} /> Edit</Btn>
          <Btn size="sm" variant="danger" onClick={deleteCustomer}><Icon name="trash" size={13} /> Delete</Btn>
        </div>
      </Card>
      {showTerms && <RepairTermsModal customer={customer} data={data} onClose={() => setShowTerms(false)} />}
      {showDamageReport && <DamageReportModal customer={customer} vehicles={vehicles} data={data} onClose={() => setShowDamageReport(false)} />}
      {showCommLog && <CommLogModal customer={customer} contact={logContact} editEntry={editingComm} onSave={saveComm} onClose={() => setShowCommLog(false)} />}


      {customer.custType === "Trade" && customer.contacts?.length > 0 && (
        <div style={{ marginTop:16 }}>
          <h3 style={{ margin:"0 0 8px", fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Contacts</h3>
          {[...customer.contacts].sort((a,b) => (b.main?1:0)-(a.main?1:0)).map(ct => (
            <Card key={ct.id}>
              <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                <div>
                  <div style={{ fontWeight:700, fontSize:15, color:"#1E3A5F" }}>{ct.name || "Unnamed"} {ct.main && <span style={{ fontSize:11, color:"#92400E", background:"#FEF3C7", padding:"2px 7px", borderRadius:6, fontWeight:700 }}>★ Main</span>}</div>
                  {ct.role && <div style={{ fontSize:12, color:"#6B7280", fontWeight:600 }}>{ct.role}</div>}
                  {ct.phone && <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{ct.phone}</div>}
                  {ct.email && <div style={{ fontSize:12, color:"#9CA3AF" }}>{ct.email}</div>}
                </div>
              </div>
              <div style={{ display:"flex", gap:8, marginTop:10, flexWrap:"wrap" }}>
                {ct.phone && <a href={`tel:${ct.phone}`} style={{ textDecoration:"none" }} onClick={() => quickLog("Call", "", { contactId: ct.id, contactName: ct.name })}><Btn size="sm" variant="primary">📞 Call</Btn></a>}
                {ct.email && <a href={`mailto:${ct.email}`} style={{ textDecoration:"none" }} onClick={() => quickLog("Email", "", { contactId: ct.id, contactName: ct.name })}><Btn size="sm" variant="ghost">✉️ Email</Btn></a>}
                <Btn size="sm" variant="ghost" onClick={() => { setEditingComm(null); setLogContact(ct); setShowCommLog(true); }}>💬 Log / Message</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      {comms.length > 0 && (
        <div style={{ marginTop:16, background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:12, padding:"14px 14px 4px" }}>
          <h3 style={{ margin:"0 0 10px", fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Communications Log ({comms.length})</h3>
          {comms.map(c => (
            <Card key={c.id}>
              <div onClick={() => {
                setEditingComm(c);
                setLogContact(c.contactId ? (customer.contacts||[]).find(ct => ct.id === c.contactId) || null : null);
                setShowCommLog(true);
              }} style={{ cursor:"pointer" }}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start", gap:8 }}>
                  <div style={{ fontWeight:700, fontSize:14, color:"#111827" }}>
                    {COMM_ICONS[c.type] || "📝"} {c.type} <span style={{ fontWeight:500, color:"#9CA3AF", fontSize:12 }}>· {c.direction === "in" ? "Incoming" : "Outgoing"}</span>
                  </div>
                  <div style={{ fontSize:12, color:"#9CA3AF", whiteSpace:"nowrap" }}>{new Date(c.timestamp || Date.now()).toLocaleString("en-GB", { day:"2-digit", month:"short", hour:"2-digit", minute:"2-digit" })}</div>
                </div>
                {c.contactName && <span style={{ display:"inline-block", marginTop:4, fontSize:11, fontWeight:700, color:"#1E3A5F", background:"#EFF6FF", padding:"2px 8px", borderRadius:6 }}>{c.contactName}</span>}
                {c.note && <div style={{ fontSize:13, color:"#6B7280", marginTop:4, whiteSpace:"pre-wrap" }}>{c.note}</div>}
                {c.photos?.length > 0 && (
                  <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:8 }}>
                    {c.photos.map(p => (
                      <img key={p.id} src={p.url || p.pending} alt="attachment" style={{ width:56, height:56, objectFit:"cover", borderRadius:6, border:"1.5px solid #E5E7EB" }} />
                    ))}
                  </div>
                )}
              </div>
              <div style={{ marginTop:8 }}>
                <Btn size="sm" variant="danger" onClick={() => deleteComm(c.id)}><Icon name="trash" size={12} /> Delete</Btn>
              </div>
            </Card>
          ))}
        </div>
      )}

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"16px 0 8px" }}>
        <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Vehicles</h3>
        <Btn size="sm" onClick={() => setShowVehicle(true)}><Icon name="plus" size={13} /> Add</Btn>
      </div>
      {vehicles.map(v => (
        <Card key={v.id}>
          <div onClick={() => setView({ screen:"vehicleDetail", id:v.id, customerId:id })} style={{ cursor:"pointer" }}>
            <div style={{ fontWeight:600, fontSize:14 }}>{v.make} {v.model}</div>
            <div style={{ fontSize:13, color:"#6B7280" }}>{v.reg}</div>
          </div>
          <div style={{ marginTop:8 }}>
            <Btn size="sm" onClick={() => setView({ screen:"newJob", prefill:{ customerId:id, vehicleId:v.id } })}><Icon name="plus" size={12} /> Add Job</Btn>
          </div>
        </Card>
      ))}
      {vehicles.length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>No vehicles added</p>}

      <h3 style={{ fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em", margin:"16px 0 8px" }}>Job History</h3>
      {jobs.map(j => (
        <Card key={j.id} onClick={() => setView({ screen:"jobDetail", id:j.id })}>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontWeight:600, fontSize:14 }}>{j.jobType}</div>
              <div style={{ fontSize:12, color:"#9CA3AF" }}>{fmtDate(j.date)}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
      {jobs.length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>No jobs yet</p>}

      {showEdit    && <CustomerForm data={data} onClose={() => setShowEdit(false)}    setView={setView} editCustomer={customer} />}
      {showVehicle && <VehicleForm  data={data} onClose={() => setShowVehicle(false)} customerId={id} />}
    </div>
  );
}

// ── Vehicle Form ──────────────────────────────────────────────────────────────
function VehicleForm({ data, customerId, onClose, editVehicle }) {
  const [make,  setMake]  = useState(editVehicle?.make  || "");
  const [model, setModel] = useState(editVehicle?.model || "");
  const [reg,   setReg]   = useState(editVehicle?.reg   || "");

  async function save() {
    if (!reg) return;
    const vehicles = [...data.vehicles];
    if (editVehicle) {
      const idx = vehicles.findIndex(v => v.id === editVehicle.id);
      vehicles[idx] = { ...editVehicle, make, model, reg: reg.toUpperCase() };
    } else {
      vehicles.push({ id:uid(), customerId, make, model, reg:reg.toUpperCase() });
    }
    await saveAndReload({ ...data, vehicles });
  }
  return (
    <Modal title={editVehicle ? "Edit Vehicle" : "Add Vehicle"} onClose={onClose}>
      <Field label="Registration" required><Input value={reg} onChange={setReg} placeholder="AB12 CDE" /></Field>
      <Field label="Make"><Input value={make} onChange={setMake} placeholder="Ford" /></Field>
      <Field label="Model"><Input value={model} onChange={setModel} placeholder="Focus" /></Field>
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!reg}>Save Vehicle</Btn>
    </Modal>
  );
}

// ── Vehicle Detail ────────────────────────────────────────────────────────────
function VehicleDetail({ data, id, customerId, setView }) {
  const vehicle = data.vehicles.find(v => v.id === id);
  const [showEdit, setShowEdit] = useState(false);
  if (!vehicle) return <p>Not found</p>;

  const customer = data.customers.find(c => c.id === vehicle.customerId);
  const jobs = data.jobs.filter(j => j.vehicleId === id).sort((a,b) => b.date.localeCompare(a.date));

  async function deleteVehicle() {
    if (!window.confirm("Delete this vehicle?")) return;
    try { await deleteRecord("vehicles", id); } catch (e) { alert("Delete failed: " + (e?.message||e)); return; }
    addTombstone(id);
    removeSig(id);
    const d = loadData();
    localStorage.setItem(DB_KEY, JSON.stringify({ ...d, vehicles: d.vehicles.filter(v => v.id !== id) }));
    window.location.reload();
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"customerDetail", id: customerId || vehicle.customerId })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <Card>
        <div style={{ fontWeight:800, fontSize:20, color:"#1E3A5F" }}>{vehicle.make} {vehicle.model}</div>
        <div style={{ fontSize:15, color:"#6B7280", marginTop:4 }}>{vehicle.reg}</div>
        {customer && <div style={{ fontSize:13, color:"#9CA3AF", marginTop:6 }}>Owner: {customer.company || customer.companyContact || "—"}</div>}
        <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
          <Btn size="sm" onClick={() => setView({ screen:"newJob", prefill:{ customerId: vehicle.customerId, vehicleId: vehicle.id } })}><Icon name="plus" size={13} /> Add Job</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)}><Icon name="edit" size={13} /> Edit</Btn>
          <Btn size="sm" variant="danger" onClick={deleteVehicle}><Icon name="trash" size={13} /> Delete</Btn>
        </div>
      </Card>

      <h3 style={{ fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em", margin:"16px 0 8px" }}>Job History</h3>
      {jobs.map(j => (
        <Card key={j.id} onClick={() => setView({ screen:"jobDetail", id:j.id })}>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <div>
              <div style={{ fontWeight:600, fontSize:14 }}>{j.jobType}</div>
              <div style={{ fontSize:12, color:"#9CA3AF" }}>{fmtDate(j.date)}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
      {jobs.length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>No jobs for this vehicle yet</p>}

      {showEdit && <VehicleForm data={data} onClose={() => setShowEdit(false)} editVehicle={vehicle} />}
    </div>
  );
}

// ── Site Inspections ─────────────────────────────────────────────────────────
function describeRepair(r) {
  return [r.type, r.side, r.position].filter(Boolean).join(" · ");
}

// Small popup for recording one vehicle found during a walkaround
function InspectionVehicleForm({ onSave, onClose, editVehicle }) {
  const [reg,    setReg]    = useState(editVehicle?.reg    || "");
  const [make,   setMake]   = useState(editVehicle?.make   || "");
  const [model,  setModel]  = useState(editVehicle?.model  || "");
  const [colour, setColour] = useState(editVehicle?.colour || "");
  const [repairs, setRepairs] = useState(() =>
    editVehicle?.repairs?.length ? editVehicle.repairs : [{ id: uid(), type: "Chip", side: "", position: "" }]
  );
  const updateRepair = (id, field, value) => setRepairs(rs => rs.map(r => r.id === id ? { ...r, [field]: value } : r));
  const addRepair = () => setRepairs(rs => [...rs, { id: uid(), type: "Chip", side: "", position: "" }]);
  const removeRepair = (id) => setRepairs(rs => rs.length > 1 ? rs.filter(r => r.id !== id) : rs);

  function save() {
    if (!reg) return;
    onSave({
      id: editVehicle?.id || uid(),
      reg: reg.toUpperCase(), make, model, colour,
      repairs: repairs.filter(r => r.type),
      bookedJobId: editVehicle?.bookedJobId || null,
      bookedVehicleId: editVehicle?.bookedVehicleId || null,
    });
    onClose();
  }

  return (
    <Modal title={editVehicle ? "Edit Vehicle" : "Add Vehicle"} onClose={onClose}>
      <Field label="Registration" required><Input value={reg} onChange={setReg} placeholder="AB12 CDE" /></Field>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}><Field label="Make"><Input value={make} onChange={setMake} placeholder="Ford" /></Field></div>
        <div style={{ flex:1 }}><Field label="Model"><Input value={model} onChange={setModel} placeholder="Focus" /></Field></div>
      </div>
      <Field label="Colour"><Input value={colour} onChange={setColour} placeholder="Silver" /></Field>

      <div style={{ marginBottom:14 }}>
        <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>Damage</label>
        {repairs.map((r, idx) => (
          <div key={r.id} style={{ background:"#F8FAFC", border:"1px solid #F3F4F6", borderRadius:10, padding:12, marginBottom:8 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#1E3A5F" }}>Damage {idx + 1}</span>
              {repairs.length > 1 && (
                <button onClick={() => removeRepair(r.id)} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"2px 8px", fontSize:12, fontWeight:600, cursor:"pointer" }}>Remove</button>
              )}
            </div>
            <div style={{ marginBottom:8 }}>
              <Select value={r.type} onChange={v => updateRepair(r.id, "type", v)} options={DAMAGE_TYPES} />
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>
                <Select value={r.side} onChange={v => updateRepair(r.id, "side", v)} options={["Drivers Side","Passenger Side","Middle"]} placeholder="Side…" />
              </div>
              <div style={{ flex:1 }}>
                <Select value={r.position} onChange={v => updateRepair(r.id, "position", v)} options={["Top Right","Top Left","Top Centre","Centre","Bottom Right","Bottom Left","Bottom Centre"]} placeholder="Position…" />
              </div>
            </div>
          </div>
        ))}
        <Btn size="sm" variant="ghost" onClick={addRepair} style={{ width:"100%", justifyContent:"center" }}>+ Add another chip/crack</Btn>
      </div>

      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!reg}>
        {editVehicle ? "Save Changes" : "Add to Inspection"}
      </Btn>
    </Modal>
  );
}

// New Inspection — builds the vehicle list locally while walking round, saves once at the end
function InspectionForm({ data, setView, prefillCustomerId }) {
  const [mode, setMode]             = useState("existing");
  const [customerId, setCustomerId] = useState(prefillCustomerId || "");
  const [custSearch, setCustSearch] = useState("");
  const [siteName, setSiteName]         = useState("");
  const [contactName, setContactName]   = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [address, setAddress]           = useState("");
  const [date, setDate]                 = useState(todayISO());
  const [notes, setNotes]               = useState("");
  const [vehicles, setVehicles]         = useState([]);
  const [showVehicleForm, setShowVehicleForm] = useState(false);
  const [editingVehicle, setEditingVehicle]   = useState(null);

  const sortedCusts = data.customers.filter(c => c.custType === "Trade").sort((a,b) => (a.company || a.companyContact || "").localeCompare(b.company || b.companyContact || "", undefined, { sensitivity:"base" }));
  const matches = custSearch.trim()
    ? sortedCusts.filter(c => (c.company||"").toLowerCase().includes(custSearch.toLowerCase()) || (c.companyContact||"").toLowerCase().includes(custSearch.toLowerCase()) || (c.town||"").toLowerCase().includes(custSearch.toLowerCase()))
    : sortedCusts;
  const selectedCust = data.customers.find(c => c.id === customerId);

  function addVehicle(v) { setVehicles(vs => [...vs, v]); }
  function updateVehicle(v) { setVehicles(vs => vs.map(x => x.id === v.id ? v : x)); }
  function removeVehicle(id) { if (!window.confirm("Remove this vehicle from the inspection?")) return; setVehicles(vs => vs.filter(x => x.id !== id)); }

  const canSave = mode === "existing" ? !!customerId : !!siteName.trim();

  async function save() {
    if (!canSave) return;
    const inspection = {
      id: uid(),
      customerId: mode === "existing" ? customerId : "",
      siteName: mode === "existing" ? "" : siteName,
      contactName: mode === "existing" ? "" : contactName,
      contactPhone: mode === "existing" ? "" : contactPhone,
      contactEmail: mode === "existing" ? "" : contactEmail,
      address: mode === "existing" ? "" : address,
      date, notes, vehicles,
      createdAt: todayISO(),
    };
    try {
      await saveAndReload({ ...data, inspections: [...(data.inspections||[]), inspection] });
    } catch (e) {
      alert("Save failed: " + (e?.message || e));
    }
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"inspections" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <h2 style={{ fontSize:18, fontWeight:800, color:"#1E3A5F", margin:"0 0 12px" }}>New Site Inspection</h2>

      <div style={{ display:"flex", gap:8, marginBottom:14 }}>
        <button onClick={() => setMode("existing")} style={{ flex:1, padding:"10px", borderRadius:8, border: mode==="existing" ? "2px solid #1E3A5F" : "1.5px solid #E5E7EB", background: mode==="existing" ? "#EFF6FF" : "#fff", fontWeight:700, fontSize:13, cursor:"pointer", color:"#1E3A5F" }}>Existing Customer</button>
        <button onClick={() => setMode("new")} style={{ flex:1, padding:"10px", borderRadius:8, border: mode==="new" ? "2px solid #1E3A5F" : "1.5px solid #E5E7EB", background: mode==="new" ? "#EFF6FF" : "#fff", fontWeight:700, fontSize:13, cursor:"pointer", color:"#1E3A5F" }}>New Site</button>
      </div>

      {mode === "existing" ? (
        <Field label="Customer" required>
          {customerId ? (
            <div style={{ display:"flex", alignItems:"center", gap:8, ...inputStyle, cursor:"default" }}>
              <span style={{ flex:1, fontWeight:600 }}>{selectedCust ? (selectedCust.company || selectedCust.companyContact || "Unnamed") : "Select customer…"}</span>
              <button onClick={() => setCustomerId("")} style={{ background:"#1E3A5F", color:"#fff", border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Change</button>
            </div>
          ) : (
            <div>
              <input autoFocus style={{ ...inputStyle, marginBottom:6 }} placeholder="Search customer…" value={custSearch} onChange={e => setCustSearch(e.target.value)} />
              <div style={{ maxHeight:220, overflowY:"auto", border:"1px solid #E5E7EB", borderRadius:8 }}>
                {matches.length === 0 && <div style={{ padding:12, fontSize:13, color:"#9CA3AF" }}>No customers found</div>}
                {matches.map(c => (
                  <div key={c.id} onClick={() => { setCustomerId(c.id); setCustSearch(""); }}
                    style={{ padding:"10px 12px", borderBottom:"1px solid #F3F4F6", cursor:"pointer", fontSize:14 }}>
                    <div style={{ fontWeight:600 }}>{c.company || c.companyContact || "Unnamed"}</div>
                    {(c.town || c.phone) && <div style={{ fontSize:12, color:"#9CA3AF" }}>{[c.town, c.phone].filter(Boolean).join(" · ")}</div>}
                  </div>
                ))}
              </div>
            </div>
          )}
        </Field>
      ) : (
        <>
          <Field label="Site / Company Name" required><Input value={siteName} onChange={setSiteName} placeholder="e.g. ABC Fleet Depot" /></Field>
          <Field label="Contact Name"><Input value={contactName} onChange={setContactName} placeholder="On-site contact" /></Field>
          <div style={{ display:"flex", gap:10 }}>
            <div style={{ flex:1 }}><Field label="Contact Phone"><Input value={contactPhone} onChange={setContactPhone} placeholder="07…" /></Field></div>
            <div style={{ flex:1 }}><Field label="Contact Email"><Input value={contactEmail} onChange={setContactEmail} placeholder="name@company.com" /></Field></div>
          </div>
          <Field label="Site Address"><Input value={address} onChange={setAddress} placeholder="Address / postcode" /></Field>
        </>
      )}

      <Field label="Inspection Date"><Input type="date" value={date} onChange={setDate} /></Field>
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"18px 0 8px" }}>
        <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Vehicles Found ({vehicles.length})</h3>
        <Btn size="sm" onClick={() => { setEditingVehicle(null); setShowVehicleForm(true); }}><Icon name="plus" size={13} /> Add</Btn>
      </div>
      {vehicles.length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>Walk around and tap "Add" for each damaged vehicle you find.</p>}
      {vehicles.map(v => (
        <Card key={v.id}>
          <div onClick={() => { setEditingVehicle(v); setShowVehicleForm(true); }} style={{ cursor:"pointer" }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#111827" }}>{v.reg}</div>
            <div style={{ fontSize:13, color:"#6B7280" }}>{[v.make, v.model, v.colour].filter(Boolean).join(" · ") || "—"}</div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:8 }}>
              {(v.repairs||[]).map(r => (
                <span key={r.id} style={{ fontSize:11, fontWeight:600, color:"#92400E", background:"#FEF3C7", padding:"3px 8px", borderRadius:6 }}>{describeRepair(r) || r.type}</span>
              ))}
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <Btn size="sm" variant="danger" onClick={() => removeVehicle(v.id)}><Icon name="trash" size={12} /> Remove</Btn>
          </div>
        </Card>
      ))}

      <Btn onClick={save} disabled={!canSave} style={{ width:"100%", justifyContent:"center", marginTop:18 }}>💾 Save Inspection</Btn>

      {showVehicleForm && (
        <InspectionVehicleForm
          editVehicle={editingVehicle}
          onSave={(v) => editingVehicle ? updateVehicle(v) : addVehicle(v)}
          onClose={() => setShowVehicleForm(false)}
        />
      )}
    </div>
  );
}

// List of saved inspections
function InspectionsList({ data, setView }) {
  const inspections = [...(data.inspections||[])].sort((a,b) => (b.date||"").localeCompare(a.date||""));
  const nameFor = (insp) => {
    if (insp.customerId) {
      const c = data.customers.find(c => c.id === insp.customerId);
      return c ? (c.company || c.companyContact || "Unnamed") : "Unnamed";
    }
    return insp.siteName || "Unnamed site";
  };
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:16 }}>
        <h2 style={{ fontSize:18, fontWeight:800, color:"#1E3A5F", margin:0 }}>Site Inspections</h2>
        <Btn size="sm" onClick={() => setView({ screen:"newInspection" })}><Icon name="plus" size={13} /> New</Btn>
      </div>
      {inspections.length === 0 && <Card><p style={{ margin:0, color:"#9CA3AF", fontSize:14, textAlign:"center" }}>No inspections yet</p></Card>}
      {inspections.map(insp => (
        <Card key={insp.id} onClick={() => setView({ screen:"inspectionDetail", id:insp.id })}>
          <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{nameFor(insp)}</div>
          <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{fmtDate(insp.date)} · {(insp.vehicles||[]).length} vehicle(s)</div>
        </Card>
      ))}
    </div>
  );
}

// Report modal — pure report generation, no booking. Send this whenever, as many times as you like.
function SendReportModal({ data, inspection, onClose }) {
  const [note, setNote] = useState("The following vehicles were found to have windscreen damage during our site inspection. Please let us know which you would like us to repair.");

  // Pure, synchronous — mirrors the existing (working) Damage Report/Job Card pattern.
  // Never combined with a save or reload, so mobile browsers never block the popup.
  function openReportWindow() {
    const cust = inspection.customerId ? data.customers.find(c => c.id === inspection.customerId) : null;
    const logoUrl = window.location.origin + "/logo.png";
    const fmtD = new Date().toLocaleDateString("en-GB");
    const toEmail = cust?.email || inspection.contactEmail || "";
    const subject = encodeURIComponent(`Windscreen Inspection Report — ${cust?.company || inspection.siteName || ""}`);
    const bodyText = encodeURIComponent(`Please find our site inspection report attached.\n\nWindscreen Repairs (Bristol)\n07946 222246\nwww.windscreenrepairsbristol.co.uk`);
    const mailtoLink = `mailto:${toEmail}?subject=${subject}&body=${bodyText}`;

    const rows = [];
    (inspection.vehicles||[]).forEach(v => {
      const reps = v.repairs?.length ? v.repairs : [{ type: "—" }];
      reps.forEach(r => {
        rows.push(`
      <tr>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:13px;color:#6B7280;">${rows.length+1}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:13px;color:#111827;"><b>${v.reg || "—"}</b> · ${[v.make, v.model].filter(Boolean).join(" ") || "—"}${v.colour ? " · " + v.colour : ""}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;font-size:12px;color:#6B7280;">${describeRepair(r) || r.type || "—"}</td>
        <td style="padding:10px 12px;border-bottom:1px solid #E5E7EB;text-align:center;"><span style="display:inline-block;width:16px;height:16px;border:2px solid #374151;border-radius:3px;"></span></td>
      </tr>`);
      });
    });
    const rowsHtml = rows.join("");

    const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site Inspection Report</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:Arial,sans-serif; }
  @media print { .no-print { display:none !important; } body { background:#fff; } }
</style></head><body>
<div class="no-print" style="position:sticky;top:0;z-index:100;background:#1E3A5F;padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;">
  <div style="font-size:13px;color:#93C5FD;font-weight:600;width:100%;text-align:center;">Tap Save as PDF, then attach to an email</div>
  <button onclick="window.print()" style="background:#F59E0B;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;">💾 Save as PDF</button>
  <a href="${mailtoLink}" style="background:#fff;color:#1E3A5F;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;">✉️ Open Mail App</a>
</div>
<div style="max-width:760px;margin:0 auto;padding:24px;background:#fff;">
  <div style="display:flex;align-items:center;gap:14px;border-bottom:3px solid #F59E0B;padding-bottom:14px;margin-bottom:18px;">
    <img src="${logoUrl}" style="width:56px;height:56px;object-fit:contain;" />
    <div>
      <div style="font-size:20px;font-weight:800;color:#1E3A5F;">Windscreen Repairs (Bristol)</div>
      <div style="font-size:12px;color:#6B7280;">3 Goosander Grove, Cheddar, BS27 3FY · 07946 222246</div>
      <div style="font-size:12px;color:#6B7280;">info@windscreenrepairsbristol.co.uk</div>
    </div>
  </div>
  <div style="font-size:16px;font-weight:800;color:#1E3A5F;margin-bottom:4px;">Site Inspection Report</div>
  <div style="font-size:13px;color:#6B7280;margin-bottom:2px;">Site: <b style="color:#111827;">${cust?.company || inspection.siteName || ""}</b></div>
  <div style="font-size:13px;color:#6B7280;margin-bottom:14px;">Inspection date: ${fmtDate(inspection.date)} · Report date: ${fmtD}</div>
  <div style="font-size:13px;color:#374151;line-height:1.5;margin-bottom:16px;">${note.replace(/</g,"&lt;")}</div>
  <table style="width:100%;border-collapse:collapse;border:1px solid #E5E7EB;">
    <thead><tr style="background:#F9FAFB;">
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;">#</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;">Car</th>
      <th style="padding:10px 12px;text-align:left;font-size:11px;color:#6B7280;text-transform:uppercase;">Damage</th>
      <th style="padding:10px 12px;text-align:center;font-size:11px;color:#6B7280;text-transform:uppercase;">Please Repair</th>
    </tr></thead>
    <tbody>${rowsHtml || '<tr><td colspan="4" style="padding:14px;color:#9CA3AF;font-size:13px;">No vehicles</td></tr>'}</tbody>
  </table>
  <div style="font-size:12px;color:#9CA3AF;margin:20px 0 24px;">${(inspection.vehicles||[]).length} vehicle(s), ${rows.length} damage item(s) inspected · Windscreen Repairs (Bristol)</div>
  <div style="border-top:1px solid #E5E7EB;padding-top:16px;">
    <div style="font-size:12px;color:#6B7280;margin-bottom:14px;">Please tick above the damage you'd like us to repair, then complete below to authorise the work.</div>
    <div style="display:flex;gap:24px;flex-wrap:wrap;margin-bottom:4px;">
      <div style="flex:1;min-width:180px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Authorised by (name)</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
      <div style="flex:1;min-width:180px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Signature</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
      <div style="min-width:120px;">
        <div style="font-size:11px;color:#9CA3AF;text-transform:uppercase;letter-spacing:.04em;margin-bottom:16px;">Date</div>
        <div style="border-bottom:1px solid #9CA3AF;height:6px;"></div>
      </div>
    </div>
  </div>
</div>
</body></html>`;
    const blob = new Blob([html], { type: "text/html" });
    const url = URL.createObjectURL(blob);
    window.open(url, "_blank");
  }

  return (
    <Modal title="Send Report" onClose={onClose}>
      <Field label="Covering note">
        <textarea value={note} onChange={e => setNote(e.target.value)} rows={3}
          style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontFamily:"inherit", fontSize:14, resize:"vertical", boxSizing:"border-box" }} />
      </Field>
      <p style={{ fontSize:13, color:"#6B7280", margin:"0 0 14px" }}>Every piece of damage found in this inspection is listed on its own line with a blank tick box for the customer to mark up and sign — nothing gets booked in yet.</p>
      <Btn onClick={openReportWindow} style={{ width:"100%", justifyContent:"center" }}>
        📄 View / Email Report
      </Btn>
      <p style={{ fontSize:11, color:"#9CA3AF", marginTop:8, textAlign:"center" }}>Opens in a new tab — tap "Save as PDF" then attach it to an email. You can send this as many times as you need.</p>
    </Modal>
  );
}

// Booking modal — once the customer has told you which vehicles to repair, use this to create the jobs
function BookVehiclesModal({ data, inspection, onClose }) {
  const [selected, setSelected] = useState(() => {
    const s = {}; (inspection.vehicles||[]).forEach(v => { s[v.id] = !v.bookedJobId; }); return s;
  });
  const toggle = (id) => setSelected(s => ({ ...s, [id]: !s[id] }));
  const count = Object.values(selected).filter(Boolean).length;

  // Saves records only — deliberately never opens a popup, so it's never blocked
  // and the page reload it triggers can't interfere with a report tab.
  async function bookSelected() {
    const chosen = (inspection.vehicles||[]).filter(v => selected[v.id]);
    if (chosen.length === 0) return;

    let customers = [...data.customers];
    let vehicles  = [...data.vehicles];
    let jobs      = [...data.jobs];
    let custId = inspection.customerId;

    // Create the customer record if this was a "new site" inspection with no existing customer yet
    if (!custId) {
      custId = uid();
      customers.push({
        id: custId,
        company: inspection.siteName || "",
        companyContact: inspection.contactName || "",
        phone: inspection.contactPhone || "",
        email: inspection.contactEmail || "",
        address1: inspection.address || "",
        custType: "Trade",
        contacts: [],
      });
    }

    const updatedInspVehicles = (inspection.vehicles||[]).map(v => ({ ...v }));

    chosen.forEach(v => {
      let vehRec = vehicles.find(x => x.customerId === custId && (x.reg||"").toUpperCase() === (v.reg||"").toUpperCase());
      if (!vehRec) {
        vehRec = { id: uid(), customerId: custId, make: v.make || "", model: v.model || "", reg: (v.reg||"").toUpperCase() };
        vehicles.push(vehRec);
      }
      const job = {
        id: uid(),
        customerId: custId,
        vehicleId: vehRec.id,
        driverName: inspection.contactName || "",
        date: todayISO(),
        jobType: "Repair",
        repairs: v.repairs || [],
        damageType: v.repairs?.[0]?.type || "",
        damageSide: v.repairs?.[0]?.side || "",
        damagePosition: v.repairs?.[0]?.position || "",
        status: "Booked",
        notes: [v.colour ? `Colour: ${v.colour}` : "", `Booked from site inspection${inspection.date ? " on " + fmtDate(inspection.date) : ""}.`].filter(Boolean).join(" — "),
        paymentType: "Private",
        photosBefore: [], photosAfter: [],
        createdAt: todayISO(),
      };
      jobs.push(job);

      const idx = updatedInspVehicles.findIndex(x => x.id === v.id);
      if (idx > -1) updatedInspVehicles[idx] = { ...updatedInspVehicles[idx], bookedJobId: job.id, bookedVehicleId: vehRec.id };
    });

    const inspections = data.inspections.map(i => i.id === inspection.id ? { ...i, customerId: custId, vehicles: updatedInspVehicles } : i);

    try {
      await saveAndReload({ ...data, customers, vehicles, jobs, inspections });
    } catch (e) {
      alert("Save failed: " + (e?.message || e));
    }
  }

  return (
    <Modal title="Book Vehicles In" onClose={onClose}>
      <div style={{ fontSize:12, fontWeight:700, color:"#6B7280", margin:"0 0 8px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Tick the vehicles the customer has confirmed</div>
      {(inspection.vehicles||[]).map(v => (
        <label key={v.id} style={{ display:"flex", alignItems:"center", gap:10, padding:"10px 12px", border:"1px solid #F3F4F6", borderRadius:8, marginBottom:6, cursor:"pointer", background: selected[v.id] ? "#EFF6FF" : "#fff" }}>
          <input type="checkbox" checked={!!selected[v.id]} onChange={() => toggle(v.id)} style={{ width:18, height:18 }} />
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:700, fontSize:14, color:"#111827" }}>{v.reg || "No reg"}</div>
            <div style={{ fontSize:13, color:"#6B7280" }}>{[v.make, v.model, v.colour].filter(Boolean).join(" · ") || "—"}</div>
            <div style={{ fontSize:12, color:"#9CA3AF" }}>{(v.repairs||[]).map(describeRepair).filter(Boolean).join("; ")}</div>
          </div>
          {v.bookedJobId && <span style={{ fontSize:10, fontWeight:700, color:"#059669", background:"#ECFDF5", padding:"3px 8px", borderRadius:6 }}>ALREADY BOOKED</span>}
        </label>
      ))}
      <Btn onClick={bookSelected} disabled={count===0} style={{ width:"100%", justifyContent:"center", marginTop:10 }}>
        ✅ Book {count} Vehicle{count===1?"":"s"} In
      </Btn>
      <p style={{ fontSize:11, color:"#9CA3AF", marginTop:8, textAlign:"center" }}>Creates a job for each ticked vehicle so you can schedule the repair.</p>
    </Modal>
  );
}

// Detail screen for one inspection — add more vehicles later, generate the report, book vehicles in
function InspectionDetail({ data, id, setView }) {
  const inspection = (data.inspections||[]).find(i => i.id === id);
  const [showVehicleForm, setShowVehicleForm] = useState(false);
  const [editingVehicle, setEditingVehicle]   = useState(null);
  const [showReport, setShowReport]           = useState(false);
  const [showBooking, setShowBooking]         = useState(false);
  if (!inspection) return <p>Not found</p>;

  const customer = inspection.customerId ? data.customers.find(c => c.id === inspection.customerId) : null;
  const displayName = customer ? (customer.company || customer.companyContact) : inspection.siteName;

  async function saveVehicleList(vehicles) {
    const inspections = data.inspections.map(i => i.id === id ? { ...i, vehicles } : i);
    try {
      await saveAndReload({ ...data, inspections });
    } catch (e) {
      alert("Save failed: " + (e?.message || e));
    }
  }
  function addVehicle(v) { saveVehicleList([...(inspection.vehicles||[]), v]); }
  function updateVehicle(v) { saveVehicleList((inspection.vehicles||[]).map(x => x.id === v.id ? v : x)); }
  function removeVehicle(vid) {
    if (!window.confirm("Remove this vehicle from the inspection?")) return;
    saveVehicleList((inspection.vehicles||[]).filter(x => x.id !== vid));
  }

  async function deleteInspection() {
    if (!window.confirm("Delete this inspection? This won't delete any jobs already booked from it.")) return;
    try { await deleteRecord("inspections", id); } catch (e) { alert("Delete failed: " + (e?.message||e)); return; }
    addTombstone(id);
    removeSig(id);
    const d = loadData();
    localStorage.setItem(DB_KEY, JSON.stringify({ ...d, inspections: (d.inspections||[]).filter(i => i.id !== id) }));
    window.location.reload();
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"inspections" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <Card>
        <div style={{ fontWeight:800, fontSize:20, color:"#1E3A5F" }}>{displayName || "Site Inspection"}</div>
        <div style={{ fontSize:13, color:"#6B7280", marginTop:4 }}>{fmtDate(inspection.date)}</div>
        {!customer && inspection.contactName && <div style={{ fontSize:13, color:"#6B7280", marginTop:4 }}>Contact: {inspection.contactName}</div>}
        {!customer && inspection.contactPhone && <div style={{ fontSize:13, color:"#6B7280" }}>{inspection.contactPhone}</div>}
        {!customer && inspection.contactEmail && <div style={{ fontSize:13, color:"#6B7280" }}>{inspection.contactEmail}</div>}
        {!customer && inspection.address && <div style={{ fontSize:13, color:"#6B7280" }}>{inspection.address}</div>}
        {inspection.notes && <div style={{ fontSize:13, color:"#9CA3AF", marginTop:6 }}>{inspection.notes}</div>}
        <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
          <Btn size="sm" onClick={() => setShowReport(true)} disabled={(inspection.vehicles||[]).length===0}>📄 Send Report</Btn>
          <Btn size="sm" variant="ghost" onClick={() => setShowBooking(true)} disabled={(inspection.vehicles||[]).length===0}>✅ Book Vehicles In</Btn>
          <Btn size="sm" variant="danger" onClick={deleteInspection}><Icon name="trash" size={13} /> Delete</Btn>
        </div>
      </Card>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"16px 0 8px" }}>
        <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Vehicles ({(inspection.vehicles||[]).length})</h3>
        <Btn size="sm" onClick={() => { setEditingVehicle(null); setShowVehicleForm(true); }}><Icon name="plus" size={13} /> Add</Btn>
      </div>
      {(inspection.vehicles||[]).length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>No vehicles added yet</p>}
      {(inspection.vehicles||[]).map(v => (
        <Card key={v.id}>
          <div onClick={() => { setEditingVehicle(v); setShowVehicleForm(true); }} style={{ cursor:"pointer" }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div>
                <div style={{ fontWeight:700, fontSize:14, color:"#111827" }}>{v.reg}</div>
                <div style={{ fontSize:13, color:"#6B7280" }}>{[v.make, v.model, v.colour].filter(Boolean).join(" · ") || "—"}</div>
              </div>
              {v.bookedJobId && <span style={{ fontSize:10, fontWeight:700, color:"#059669", background:"#ECFDF5", padding:"3px 8px", borderRadius:6 }}>BOOKED</span>}
            </div>
            <div style={{ display:"flex", gap:6, flexWrap:"wrap", marginTop:8 }}>
              {(v.repairs||[]).map(r => (
                <span key={r.id} style={{ fontSize:11, fontWeight:600, color:"#92400E", background:"#FEF3C7", padding:"3px 8px", borderRadius:6 }}>{describeRepair(r) || r.type}</span>
              ))}
            </div>
          </div>
          <div style={{ marginTop:8 }}>
            <Btn size="sm" variant="danger" onClick={() => removeVehicle(v.id)}><Icon name="trash" size={12} /> Remove</Btn>
          </div>
        </Card>
      ))}

      {showVehicleForm && (
        <InspectionVehicleForm
          editVehicle={editingVehicle}
          onSave={(v) => editingVehicle ? updateVehicle(v) : addVehicle(v)}
          onClose={() => setShowVehicleForm(false)}
        />
      )}
      {showReport && <SendReportModal data={data} inspection={inspection} onClose={() => setShowReport(false)} />}
      {showBooking && <BookVehiclesModal data={data} inspection={inspection} onClose={() => setShowBooking(false)} />}
    </div>
  );
}

// ── Jobs List ─────────────────────────────────────────────────────────────────
function JobsList({ data, setView, initialFilter }) {
  const [filter, setFilter] = useState(initialFilter || "Open");

  // Find which job ids have an invoice, and which are unpaid/overdue
  const invoiceByJob = {};
  (data.invoices || []).forEach(inv => { invoiceByJob[inv.jobId] = inv; });
  const oneMonthAgo = (() => { const d = new Date(); d.setMonth(d.getMonth()-1); return d.toISOString().split("T")[0]; })();
  const isUnpaid = (j) => { const inv = invoiceByJob[j.id]; return inv && !inv.paid; };
  const isOverdue = (j) => {
    const inv = invoiceByJob[j.id];
    if (!inv || inv.paid) return false;
    const dateRef = (j.date || inv.createdAt || "");
    return dateRef && dateRef < oneMonthAgo;
  };
  const anyOverdue = data.jobs.some(isOverdue);

  const filtered = data.jobs.filter(j => {
    if (filter==="Today")    return j.date === todayISO();
    if (filter==="Open")     return j.status === "Booked";        // still to do
    if (filter==="Unpaid")   return isUnpaid(j);                  // invoiced but not paid
    if (filter==="Complete") return ["Complete","Paid"].includes(j.status);
    return true;
  }).sort((a,b) => b.date.localeCompare(a.date));

  const pill = (active, red) => ({ padding:"12px 22px", borderRadius:99, fontSize:15, fontWeight:600, cursor:"pointer", border: red && !active ? "2px solid #DC2626" : "none", background:active?(red?"#DC2626":"#1E3A5F"):"#F3F4F6", color:active?"#fff":(red?"#DC2626":"#6B7280"), fontFamily:"inherit", whiteSpace:"nowrap" });

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Jobs</h2>
        <Btn size="sm" onClick={() => setView({ screen:"newJob" })}><Icon name="plus" size={14} /> New</Btn>
      </div>
      {anyOverdue && (
        <div style={{ background:"#DC2626", color:"#fff", borderRadius:10, padding:"10px 14px", marginBottom:12, fontSize:14, fontWeight:700 }}>
          ⚠️ You have unpaid invoices over 1 month overdue
        </div>
      )}
      <div style={{ display:"flex", gap:10, marginBottom:16, overflowX:"auto", paddingBottom:4 }}>
        {["Today","Open","Unpaid","Complete","All"].map(f => (
          <button key={f} style={pill(filter===f, f==="Unpaid" && anyOverdue)} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      {filtered.length === 0 && <p style={{ color:"#9CA3AF", textAlign:"center", fontSize:14 }}>No jobs found</p>}
      {filtered.map(job => {
        const cust = data.customers.find(c => c.id === job.customerId);
        const veh  = data.vehicles.find(v => v.id === job.vehicleId);
        return (
          <Card key={job.id} onClick={() => setView({ screen:"jobDetail", id:job.id })}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8, flexWrap:"wrap" }}>
                  <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{cust?.company || cust?.companyContact || job.driverName || "No Company"}</div>
                  {cust?.onStop && <span style={{ background:"#DC2626", color:"#fff", fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:6, letterSpacing:"0.03em" }}>ON STOP</span>}
                  {isOverdue(job) ? <span style={{ background:"#DC2626", color:"#fff", fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:6 }}>OVERDUE</span> : isUnpaid(job) ? <span style={{ background:"#FEF3C7", color:"#92400E", fontSize:10, fontWeight:700, padding:"2px 7px", borderRadius:6 }}>UNPAID</span> : null}
                </div>
                {job.driverName && cust?.company && <div style={{ fontSize:13, color:"#374151", fontWeight:600 }}>Driver: {job.driverName}</div>}
                <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "No vehicle"}</div>
                <div style={{ fontSize:13, color:"#6B7280" }}>{fmtDate(job.date)}{job.jobTime ? ` · ${job.jobTime}` : ""}</div>
                {job.locAddress1 && <div style={{ fontSize:12, color:"#9CA3AF", marginTop:2 }}>📍 {[job.locAddress1, job.locTown, job.locPostcode].filter(Boolean).join(", ")}</div>}
                {(job.photosBefore?.length > 0 || job.photosAfter?.length > 0) && <div style={{ fontSize:11, color:"#6B7280", marginTop:3 }}>📷 {(job.photosBefore?.length||0)} before · {(job.photosAfter?.length||0)} after</div>}
              </div>
              <StatusBadge status={job.status} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── Photo Uploader ────────────────────────────────────────────────────────────
function resizeImage(file, maxW = 800) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onload = ev => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, maxW / img.width);
        const canvas = document.createElement("canvas");
        canvas.width  = img.width  * scale;
        canvas.height = img.height * scale;
        canvas.getContext("2d").drawImage(img, 0, 0, canvas.width, canvas.height);
        resolve(canvas.toDataURL("image/jpeg", 0.6));
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });
}

function PhotoUploader({ label, photos = [], onChange, jobId }) {
  const [loading, setLoading] = useState(false);

  async function handleFiles(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setLoading(true);
    try {
      const newPhotos = [];
      for (const file of files) {
        const dataUrl = await resizeImage(file);
        const photoId = uid();
        // If clearly offline, save as pending immediately — no waiting, no risk of loss
        if (!navigator.onLine) {
          newPhotos.push({ id: photoId, pending: dataUrl, jobId: jobId || "unassigned" });
          continue;
        }
        // Otherwise try to upload to cloud storage immediately
        try {
          const { url, path } = await uploadPhoto(dataUrl, jobId || "unassigned");
          newPhotos.push({ id: photoId, url, path });
        } catch (err) {
          // No signal / upload failed — keep locally, mark pending for later upload
          newPhotos.push({ id: photoId, pending: dataUrl, jobId: jobId || "unassigned" });
        }
      }
      onChange([...photos, ...newPhotos]);
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  }

  async function remove(photo) {
    if (photo.path) { deletePhoto(photo.path).catch(() => {}); }
    onChange(photos.filter(p => p.id !== photo.id));
  }

  const photoSrc = p => p.url || p.pending; // show uploaded URL or local pending image

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</label>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:8 }}>
        {photos.map(p => (
          <div key={p.id} style={{ position:"relative", width:80, height:80 }}>
            <img src={photoSrc(p)} alt="job" style={{ width:80, height:80, objectFit:"cover", borderRadius:8, border:"1.5px solid #E5E7EB" }} />
            {p.pending && <div style={{ position:"absolute", bottom:2, left:2, background:"rgba(245,158,11,.9)", color:"#fff", fontSize:8, fontWeight:700, padding:"1px 4px", borderRadius:4 }}>PENDING</div>}
            <button onClick={() => remove(p)} style={{ position:"absolute", top:-6, right:-6, background:"#EF4444", border:"none", borderRadius:"50%", width:20, height:20, color:"#fff", fontSize:12, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>×</button>
          </div>
        ))}
        <label style={{ width:80, height:80, border:`2px dashed ${loading ? "#93C5FD" : "#D1D5DB"}`, borderRadius:8, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", cursor:"pointer", color: loading ? "#3B82F6" : "#9CA3AF", fontSize:11, fontWeight:600, gap:4, background: loading ? "#EFF6FF" : "transparent" }}>
          <span style={{ fontSize:24, lineHeight:1 }}>{loading ? "⏳" : "📷"}</span>
          {loading ? "Uploading…" : "Add"}
          <input type="file" accept="image/*" capture="environment" multiple onChange={handleFiles} style={{ display:"none" }} disabled={loading} />
        </label>
      </div>
    </div>
  );
}

// ── Photo Viewer ──────────────────────────────────────────────────────────────
function PhotoViewer({ label, photos = [] }) {
  const [lightbox, setLightbox] = useState(null);
  if (photos.length === 0) return null;
  const src = p => p.url || p.pending;
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>{label} ({photos.length})</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
        {photos.map(p => (
          <img key={p.id} src={src(p)} alt="job" onClick={() => setLightbox(src(p))}
            style={{ width:80, height:80, objectFit:"cover", borderRadius:8, border:"1.5px solid #E5E7EB", cursor:"pointer" }} />
        ))}
      </div>
      {lightbox && (
        <div onClick={() => setLightbox(null)} style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.9)", zIndex:300, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
          <img src={lightbox} alt="full" style={{ maxWidth:"100%", maxHeight:"100%", borderRadius:8 }} />
        </div>
      )}
    </div>
  );
}
function LocationPopup({ customerId, data, initial, onSave, onClose }) {
  const [addr1,     setAddr1]     = useState(initial?.locAddress1  || "");
  const [addr2,     setAddr2]     = useState(initial?.locAddress2  || "");
  const [town,      setTown]      = useState(initial?.locTown      || "");
  const [county,    setCounty]    = useState(initial?.locCounty    || "");
  const [postcode,  setPostcode]  = useState(initial?.locPostcode  || "");

  function useCustomer() {
    const cust = data.customers.find(c => c.id === customerId);
    if (!cust) return;
    setAddr1(cust.address1 || "");
    setAddr2(cust.address2 || "");
    setTown(cust.town || "");
    setCounty(cust.county || "");
    setPostcode(cust.postcode || "");
  }

  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.6)", zIndex:200, display:"flex", alignItems:"center", justifyContent:"center", padding:16 }}>
      <div style={{ background:"#fff", borderRadius:16, width:"100%", maxWidth:400, padding:20 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <h3 style={{ margin:0, fontSize:16, fontWeight:700, color:"#111827" }}>Job Location</h3>
          <button onClick={onClose} style={{ background:"#F3F4F6", border:"none", borderRadius:99, width:30, height:30, cursor:"pointer", fontSize:16, color:"#6B7280" }}>×</button>
        </div>
        {customerId && (
          <button onClick={useCustomer} style={{ width:"100%", marginBottom:14, fontSize:13, color:"#2563EB", background:"#EFF6FF", border:"1px solid #BFDBFE", borderRadius:8, padding:"8px 12px", cursor:"pointer", fontFamily:"inherit", fontWeight:600, textAlign:"left" }}>
            📍 Use customer's address
          </button>
        )}
        <Field label="Address Line 1"><Input value={addr1} onChange={setAddr1} placeholder="12 High Street" /></Field>
        <Field label="Address Line 2"><Input value={addr2} onChange={setAddr2} placeholder="Clifton" /></Field>
        <Field label="Town / City"><Input value={town} onChange={setTown} placeholder="Bristol" /></Field>
        <Field label="County"><Input value={county} onChange={setCounty} placeholder="Avon" /></Field>
        <Field label="Postcode"><Input value={postcode} onChange={setPostcode} placeholder="BS1 1AA" /></Field>
        <Btn onClick={() => onSave({ locAddress1:addr1, locAddress2:addr2, locTown:town, locCounty:county, locPostcode:postcode })} style={{ width:"100%", justifyContent:"center", marginTop:4 }}>
          Save Location
        </Btn>
      </div>
    </div>
  );
}

// ── Job Form ──────────────────────────────────────────────────────────────────
function JobForm({ data, onClose, editJob, prefill }) {
  const [customerId,    setCustomerId]    = useState(editJob?.customerId    || prefill?.customerId || "");
  const [custSearch,    setCustSearch]    = useState("");
  const [custDropOpen,  setCustDropOpen]  = useState(false);
  const [driverName,    setDriverName]    = useState(editJob?.driverName    || "");
  const [contactName,   setContactName]   = useState(editJob?.contactName   || "");
  const [vehicleId,     setVehicleId]     = useState(editJob?.vehicleId     || prefill?.vehicleId || "");
  const [date,          setDate]          = useState(editJob?.date          || todayISO());
  const [jobTime,       setJobTime]       = useState(editJob?.jobTime       || "");
  const [locAddress1,   setLocAddress1]   = useState(editJob?.locAddress1   || "");
  const [locAddress2,   setLocAddress2]   = useState(editJob?.locAddress2   || "");
  const [locTown,       setLocTown]       = useState(editJob?.locTown       || "");
  const [locCounty,     setLocCounty]     = useState(editJob?.locCounty     || "");
  const [locPostcode,   setLocPostcode]   = useState(editJob?.locPostcode   || "");
  const [showLocPopup,  setShowLocPopup]  = useState(false);
  const [jobType,       setJobType]       = useState(editJob?.jobType       || "Repair");
  const [damageType,    setDamageType]    = useState(editJob?.damageType    || "Chip");
  const [damageSide,    setDamageSide]    = useState(editJob?.damageSide    || "");
  const [damagePosition,setDamagePosition]= useState(editJob?.damagePosition|| "");
  // Repairs list — supports multiple repairs per windscreen. Falls back to the old
  // single damage fields for jobs created before this feature.
  const [repairs, setRepairs] = useState(() => {
    if (editJob?.repairs?.length) return editJob.repairs;
    if (editJob?.damageType) return [{ id: uid(), type: editJob.damageType, side: editJob.damageSide || "", position: editJob.damagePosition || "" }];
    return [{ id: uid(), type: "Chip", side: "", position: "" }];
  });
  const updateRepair = (id, field, value) => setRepairs(rs => rs.map(r => r.id === id ? { ...r, [field]: value } : r));
  const addRepair = () => setRepairs(rs => [...rs, { id: uid(), type: "Chip", side: "", position: "" }]);
  const removeRepair = (id) => setRepairs(rs => rs.length > 1 ? rs.filter(r => r.id !== id) : rs);
  const [adasRequired,  setAdasRequired]  = useState(editJob?.adasRequired  || false);
  const [status,        setStatus]        = useState(editJob?.status        || "Booked");
  const [technicianId,  setTechnicianId]  = useState(editJob?.technicianId  || "");
  const [notes,         setNotes]         = useState(editJob?.notes         || "");
  const [paymentType,   setPaymentType]   = useState(editJob?.paymentType   || "Private");
  const [insuranceCo,   setInsuranceCo]   = useState(editJob?.insuranceCo   || "");
  const [claimNo,       setClaimNo]       = useState(editJob?.claimNo       || "");
  const [photosBefore,  setPhotosBefore]  = useState(editJob?.photosBefore  || []);
  const [photosAfter,   setPhotosAfter]   = useState(editJob?.photosAfter   || []);

  const custVehicles = data.vehicles.filter(v => v.customerId === customerId);
  const locSummary = [locAddress1, locTown, locPostcode].filter(Boolean).join(", ");

  async function save() {
    if (!customerId) return;
    const jobs = [...data.jobs];
    const first = repairs[0] || {};
    const rec = { customerId, driverName, contactName, vehicleId, date, jobTime, locAddress1, locAddress2, locTown, locCounty, locPostcode, jobType, repairs, damageType: first.type || "", damageSide: first.side || "", damagePosition: first.position || "", adasRequired, status, technicianId, notes, paymentType, insuranceCo, claimNo, photosBefore, photosAfter };
    if (editJob) {
      const idx = jobs.findIndex(j => j.id === editJob.id);
      jobs[idx] = { ...editJob, ...rec };
    } else {
      jobs.push({ id:uid(), ...rec, createdAt:todayISO() });
    }
    try {
      await saveAndReload({ ...data, jobs });
    } catch(e) {
      alert("Storage full — try using fewer or smaller photos.");
      return;
    }
    onClose();
  }

  return (
    <>
    <Modal title={editJob ? "Edit Job" : "New Job"} onClose={onClose}>
      <Field label="Customer" required>
        {(() => {
          const selected = data.customers.find(c => c.id === customerId);
          const sortedCusts = [...data.customers].sort((a,b) => (a.company || a.companyContact || "").localeCompare(b.company || b.companyContact || "", undefined, { sensitivity:"base" }));
          const matches = custSearch.trim()
            ? sortedCusts.filter(c => (c.company || "").toLowerCase().includes(custSearch.toLowerCase()) || (c.companyContact || "").toLowerCase().includes(custSearch.toLowerCase()) || (c.phone || "").includes(custSearch) || (c.town || "").toLowerCase().includes(custSearch.toLowerCase()))
            : sortedCusts;
          if (customerId && !custDropOpen) {
            // Show the selected customer with a change button
            return (
              <div style={{ display:"flex", alignItems:"center", gap:8, ...inputStyle, cursor:"default" }}>
                <span style={{ flex:1, fontWeight:600 }}>{selected ? (selected.company || selected.companyContact || "Unnamed") : "Select customer…"}{selected?.onStop ? " 🛑" : ""}</span>
                <button onClick={() => { setCustDropOpen(true); setCustSearch(""); }} style={{ background:"#1E3A5F", color:"#fff", border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Change</button>
              </div>
            );
          }
          return (
            <div>
              <input autoFocus style={{ ...inputStyle, marginBottom:6 }} placeholder="Search customer by name, phone, town…" value={custSearch} onChange={e => setCustSearch(e.target.value)} />
              <div style={{ maxHeight:220, overflowY:"auto", border:"1px solid #E5E7EB", borderRadius:8 }}>
                {matches.length === 0 && <div style={{ padding:12, fontSize:13, color:"#9CA3AF" }}>No customers found</div>}
                {matches.map(c => (
                  <div key={c.id} onClick={() => { setCustomerId(c.id); setVehicleId(""); setCustDropOpen(false); setCustSearch(""); }}
                    style={{ padding:"10px 12px", borderBottom:"1px solid #F3F4F6", cursor:"pointer", fontSize:14, background: c.id===customerId ? "#EFF6FF" : "#fff" }}>
                    <div style={{ fontWeight:600 }}>{c.company || c.companyContact || "Unnamed"}{c.onStop ? " 🛑" : ""}</div>
                    {(c.town || c.phone) && <div style={{ fontSize:12, color:"#9CA3AF" }}>{[c.town, c.phone].filter(Boolean).join(" · ")}</div>}
                  </div>
                ))}
              </div>
            </div>
          );
        })()}
      </Field>
      {(() => {
        const cust = data.customers.find(c => c.id === customerId);
        return cust?.onStop ? (
          <div style={{ background:"#FEF2F2", border:"1.5px solid #FCA5A5", color:"#DC2626", borderRadius:8, padding:"10px 14px", marginBottom:14, fontWeight:600, fontSize:13 }}>
            🛑 This customer is ON STOP for non-payment. You can still book the job, but check before carrying out work.
          </div>
        ) : null;
      })()}
      {(() => {
        const selCust = data.customers.find(c => c.id === customerId);
        // Private customers are the driver themselves, so no separate driver field needed
        if (selCust?.custType === "Private") return null;
        const contacts = selCust?.contacts || [];
        return (
          <>
            {contacts.length > 0 && (
              <Field label="Company Contact (optional)">
                <select style={{ ...inputStyle, appearance:"none" }} value={contactName} onChange={e => setContactName(e.target.value)}>
                  <option value="">Select a contact…</option>
                  {contacts.map(ct => <option key={ct.id} value={ct.name}>{ct.name}{ct.role ? ` (${ct.role})` : ""}</option>)}
                </select>
              </Field>
            )}
            <Field label="Driver / Customer Name (optional)"><Input value={driverName} onChange={setDriverName} placeholder="Name of the driver or car owner" /></Field>
          </>
        );
      })()}
      {customerId && (
        <Field label="Vehicle">
          <select style={{ ...inputStyle, appearance:"none" }} value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">No vehicle / select…</option>
            {custVehicles.map(v => <option key={v.id} value={v.id}>{v.make} {v.model} · {v.reg}</option>)}
          </select>
        </Field>
      )}
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}><Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field></div>
        <div style={{ flex:1 }}><Field label="Time"><Input type="time" value={jobTime} onChange={setJobTime} /></Field></div>
      </div>
      <Field label="Job Location">
        <div onClick={() => setShowLocPopup(true)} style={{ ...inputStyle, cursor:"pointer", color: locSummary ? "#111827" : "#9CA3AF", display:"flex", alignItems:"center", gap:6 }}>
          📍 {locSummary || "Tap to enter address…"}
        </div>
      </Field>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}><Field label="Status"><Select value={status} onChange={setStatus} options={Object.keys(STATUS_META)} /></Field></div>
      </div>

      <div style={{ marginBottom:14 }}>
        <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>Repairs</label>
        {repairs.map((r, idx) => (
          <div key={r.id} style={{ background:"#F8FAFC", border:"1px solid #F3F4F6", borderRadius:10, padding:12, marginBottom:8 }}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:8 }}>
              <span style={{ fontSize:12, fontWeight:700, color:"#1E3A5F" }}>Repair {idx + 1}</span>
              {repairs.length > 1 && (
                <button onClick={() => removeRepair(r.id)} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"2px 8px", fontSize:12, fontWeight:600, cursor:"pointer" }}>Remove</button>
              )}
            </div>
            <div style={{ marginBottom:8 }}>
              <Select value={r.type} onChange={v => updateRepair(r.id, "type", v)} options={DAMAGE_TYPES} />
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <div style={{ flex:1 }}>
                <Select value={r.side} onChange={v => updateRepair(r.id, "side", v)} options={["Drivers Side","Passenger Side","Middle"]} placeholder="Side…" />
              </div>
              <div style={{ flex:1 }}>
                <Select value={r.position} onChange={v => updateRepair(r.id, "position", v)} options={["Top Right","Top Left","Top Centre","Centre","Bottom Right","Bottom Left","Bottom Centre"]} placeholder="Position…" />
              </div>
            </div>
          </div>
        ))}
        <Btn size="sm" variant="ghost" onClick={addRepair} style={{ width:"100%", justifyContent:"center" }}>+ Add repair</Btn>
      </div>
      <Field label="Payment Type"><Select value={paymentType} onChange={setPaymentType} options={PAYMENT_TYPES} /></Field>
      {paymentType==="Insurance" && (
        <>
          <Field label="Insurance Company"><Input value={insuranceCo} onChange={setInsuranceCo} placeholder="e.g. Admiral" /></Field>
          <Field label="Claim Number"><Input value={claimNo} onChange={setClaimNo} placeholder="Claim ref…" /></Field>
        </>
      )}
      {data.technicians.length > 0 && (
        <Field label="Technician">
          <select style={{ ...inputStyle, appearance:"none" }} value={technicianId} onChange={e => setTechnicianId(e.target.value)}>
            <option value="">Unassigned</option>
            {data.technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>
      {editJob ? (
        <>
          <PhotoUploader label="Before Photos" photos={photosBefore} onChange={setPhotosBefore} jobId={editJob.id} />
          <PhotoUploader label="After Photos"  photos={photosAfter}  onChange={setPhotosAfter}  jobId={editJob.id} />
        </>
      ) : (
        <div style={{ fontSize:12, color:"#9CA3AF", textAlign:"center", margin:"4px 0 12px" }}>📷 You can add before/after photos once the job is saved</div>
      )}
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!customerId}>Save Job</Btn>
    </Modal>
    {showLocPopup && (
      <LocationPopup
        customerId={customerId}
        data={data}
        initial={{ locAddress1, locAddress2, locTown, locCounty, locPostcode }}
        onSave={(loc) => { setLocAddress1(loc.locAddress1); setLocAddress2(loc.locAddress2); setLocTown(loc.locTown); setLocCounty(loc.locCounty); setLocPostcode(loc.locPostcode); setShowLocPopup(false); }}
        onClose={() => setShowLocPopup(false)}
      />
    )}
    </>
  );
}

// ── Job Card Email ────────────────────────────────────────────────────────────
function sendJobCard(job, customer, vehicle, invoice) {
  const company  = customer?.company        || "";
  const contact  = customer?.companyContact || "";
  const driver   = job.driverName           || "";
  const car      = vehicle ? `${vehicle.make} ${vehicle.model} · ${vehicle.reg}` : "";
  const location = [job.locAddress1, job.locAddress2, job.locTown, job.locPostcode].filter(Boolean).join(", ");
  const toEmail  = customer?.email          || "";
  const subject  = encodeURIComponent(`Job Report — ${company || driver} · ${car}`);
  const body     = encodeURIComponent(`Please find your job completion report attached.\n\nWindscreen Repairs (Bristol)\n07946 222246\nwww.windscreenrepairsbristol.co.uk`);
  const mailtoLink = `mailto:${toEmail}?subject=${subject}&body=${body}`;

  const photoSection = (photos, label) => {
    if (!photos || photos.length === 0) return "";
    return `
      <h3 style="color:#1E3A5F;font-size:15px;margin:20px 0 10px;border-bottom:2px solid #F3F4F6;padding-bottom:6px;">${label}</h3>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${photos.map(p => `<img src="${p.url || p.pending}" style="width:160px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #E5E7EB;" />`).join("")}
      </div>`;
  };

  const row = (label, value) => value ? `
    <tr>
      <td style="padding:7px 0;font-size:13px;color:#6B7280;width:40%;vertical-align:top;">${label}</td>
      <td style="padding:7px 0;font-size:13px;color:#111827;font-weight:600;">${value}</td>
    </tr>` : "";

  const fmtD = iso => { if (!iso) return ""; const [y,m,d] = iso.split("-"); return `${d}/${m}/${y}`; };

  const html = `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Job Report</title>
<style>
  body { margin:0; padding:0; background:#F8FAFC; font-family:Arial,sans-serif; }
  @media print {
    .no-print { display:none !important; }
    body { background:#fff; }
    .card { box-shadow:none !important; border-radius:0 !important; }
  }
</style>
</head>
<body>

<!-- Action Bar (hidden when printing) -->
<div class="no-print" style="position:sticky;top:0;z-index:100;background:#1E3A5F;padding:12px 16px;display:flex;gap:10px;align-items:center;justify-content:center;flex-wrap:wrap;">
  <div style="font-size:13px;color:#93C5FD;font-weight:600;width:100%;text-align:center;">Tap Save as PDF first, then attach to email</div>
  <button onclick="window.print()" style="background:#F59E0B;color:#fff;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;display:flex;align-items:center;gap:6px;">
    💾 Save as PDF
  </button>
  <a href="${mailtoLink}" style="background:#fff;color:#1E3A5F;border:none;border-radius:8px;padding:10px 20px;font-size:14px;font-weight:700;cursor:pointer;text-decoration:none;display:flex;align-items:center;gap:6px;">
    ✉️ Open Mail App
  </a>
</div>

<!-- Job Card -->
<div class="card" style="max-width:600px;margin:16px auto;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 8px rgba(0,0,0,.08);">
  <div style="background:#1E3A5F;padding:24px 28px;">
    <div style="font-size:20px;font-weight:800;color:#fff;">Windscreen Repairs (Bristol)</div>
    <div style="font-size:12px;color:#93C5FD;margin-top:4px;">3 Goosander Grove, Cheddar, BS27 3FY</div>
    <div style="font-size:12px;color:#93C5FD;">07946 222246 · info@windscreenrepairsbristol.co.uk</div>
    <div style="font-size:12px;color:#93C5FD;">www.windscreenrepairsbristol.co.uk</div>
  </div>
  <div style="background:#F59E0B;padding:12px 28px;">
    <div style="font-size:16px;font-weight:700;color:#fff;">Job Completion Report</div>
    <div style="font-size:12px;color:#FEF3C7;">${fmtD(job.date)}${job.jobTime ? " · " + job.jobTime : ""}</div>
  </div>
  <div style="padding:24px 28px;">
    <h3 style="color:#1E3A5F;font-size:15px;margin:0 0 10px;border-bottom:2px solid #F3F4F6;padding-bottom:6px;">Job Details</h3>
    <table style="width:100%;border-collapse:collapse;">
      ${row("Company", company)}
      ${row("Contact", contact)}
      ${row("Driver", driver)}
      ${row("Vehicle", car)}
      ${row("Location", location)}
      ${(job.repairs?.length ? job.repairs : [{type:job.damageType,side:job.damageSide,position:job.damagePosition}]).map((r,i) => row(job.repairs?.length>1?`Repair ${i+1}`:"Damage", [r.type, r.side, r.position].filter(Boolean).join(" · "))).join("")}
      ${row("Payment", job.paymentType)}
      ${job.paymentType === "Insurance" ? row("Insurance", [job.insuranceCo, job.claimNo].filter(Boolean).join(" · ")) : ""}
      ${row("Notes", job.notes)}
    </table>

    ${invoice ? `
    <div style="background:#F0FDF4;border:1px solid #BBF7D0;border-radius:8px;padding:14px 16px;margin:20px 0;display:flex;justify-content:space-between;align-items:center;">
      <div>
        <div style="font-size:13px;color:#065F46;font-weight:600;">Total${invoice.vat ? " (inc. 20% VAT)" : ""}</div>
        <div style="font-size:11px;color:#059669;">Labour: £${parseFloat(invoice.labour||0).toFixed(2)} · Parts: £${parseFloat(invoice.parts||0).toFixed(2)}</div>
        <div style="font-size:12px;color:${invoice.paid?"#059669":"#D97706"};font-weight:600;margin-top:4px;">${invoice.paid ? "✓ Paid" : "⏳ Payment Awaited"}</div>
      </div>
      <div style="font-size:28px;font-weight:800;color:#065F46;">£${parseFloat(invoice.total).toFixed(2)}</div>
    </div>` : ""}

    ${photoSection(job.photosBefore, "📷 Before")}
    ${photoSection(job.photosAfter,  "✅ After")}

    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #F3F4F6;text-align:center;font-size:12px;color:#9CA3AF;">
      Thank you for choosing Windscreen Repairs (Bristol)<br>
      <a href="https://www.windscreenrepairsbristol.co.uk" style="color:#1E3A5F;">www.windscreenrepairsbristol.co.uk</a>
    </div>
  </div>
</div>

<!-- How to attach instructions -->
<div class="no-print" style="max-width:600px;margin:0 auto 32px;padding:16px;background:#FFF7ED;border-radius:12px;border:1px solid #FED7AA;">
  <div style="font-size:13px;font-weight:700;color:#92400E;margin-bottom:8px;">📎 How to attach to email on iPhone:</div>
  <ol style="margin:0;padding-left:18px;font-size:12px;color:#B45309;line-height:1.8;">
    <li>Tap <strong>💾 Save as PDF</strong> above</li>
    <li>In the print preview, <strong>pinch outward</strong> on the page to convert to PDF</li>
    <li>Tap the <strong>Share icon</strong> → <strong>Save to Files</strong></li>
    <li>Tap <strong>✉️ Open Mail App</strong> above</li>
    <li>In Mail, tap the <strong>paperclip icon</strong> → find your saved PDF in Files</li>
  </ol>
</div>

</body></html>`;

  const blob = new Blob([html], { type:"text/html" });
  const url  = URL.createObjectURL(blob);
  window.open(url, "_blank");
}

// ── iCal Export ──────────────────────────────────────────────────────────────
function addToCalendar(job, customer, vehicle) {
  if (!job.date) { alert("Job has no date set."); return; }

  // Build start datetime
  const [y, m, d] = job.date.split("-").map(Number);
  const [h, min]  = job.jobTime ? job.jobTime.split(":").map(Number) : [9, 0];
  const start = new Date(y, m - 1, d, h, min, 0);
  const end   = new Date(start.getTime() + 60 * 60 * 1000); // 1hr duration

  function icsDate(dt) {
    const pad = n => String(n).padStart(2, "0");
    return `${dt.getFullYear()}${pad(dt.getMonth()+1)}${pad(dt.getDate())}T${pad(dt.getHours())}${pad(dt.getMinutes())}00`;
  }

  const company  = customer?.company  || "Unknown Company";
  const driver   = job.driverName     || "";
  const reg      = vehicle?.reg       || "";
  const car      = vehicle ? `${vehicle.make} ${vehicle.model} ${reg}`.trim() : "";
  const location = [job.locAddress1, job.locAddress2, job.locTown, job.locPostcode].filter(Boolean).join(", ");

  const title    = `Windscreen Repair — ${company}${driver ? ` (${driver})` : ""}${car ? ` · ${car}` : ""}`;
  const notes    = [
    driver   ? `Driver: ${driver}`   : "",
    car      ? `Vehicle: ${car}`     : "",
    location ? `Location: ${location}` : "",
    job.damageType ? `Damage: ${job.damageType}${job.damageSide ? ` · ${job.damageSide}` : ""}${job.damagePosition ? ` · ${job.damagePosition}` : ""}` : "",
    job.paymentType === "Insurance" && job.insuranceCo ? `Insurance: ${job.insuranceCo} · ${job.claimNo || ""}` : "",
    job.notes ? `Notes: ${job.notes}` : "",
  ].filter(Boolean).join("\\n");

  const ics = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Windscreen Repairs Bristol//CRM//EN",
    "BEGIN:VEVENT",
    `UID:${job.id}@windscreen-crm`,
    `DTSTAMP:${icsDate(new Date())}`,
    `DTSTART:${icsDate(start)}`,
    `DTEND:${icsDate(end)}`,
    `SUMMARY:${title}`,
    location ? `LOCATION:${location}` : "",
    notes    ? `DESCRIPTION:${notes}` : "",
    "END:VEVENT",
    "END:VCALENDAR",
  ].filter(Boolean).join("\r\n");

  const blob = new Blob([ics], { type: "text/calendar;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href     = url;
  a.download = `job-${job.date}-${company.replace(/\s+/g, "-")}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// ── Job Detail ────────────────────────────────────────────────────────────────
function JobDetail({ data, id, setView }) {
  const job = data.jobs.find(j => j.id === id);
  const [showEdit,    setShowEdit]    = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);
  const [showEditInvoice, setShowEditInvoice] = useState(false);
  if (!job) return <p>Not found</p>;

  const customer   = data.customers.find(c => c.id === job.customerId);
  const vehicle    = data.vehicles.find(v => v.id === job.vehicleId);
  const technician = data.technicians.find(t => t.id === job.technicianId);
  const invoice    = data.invoices.find(i => i.jobId === id);

  const nextStatuses = { "Booked":["Complete"], "Complete":[], "Invoiced":[], "Paid":[] };

  async function updateStatus(s) {
    await saveAndReload({ ...data, jobs: data.jobs.map(j => j.id===id ? {...j,status:s} : j) });
  }
  async function deleteJob() {
    if (!window.confirm("Delete this job?")) return;
    try { await deleteRecord("jobs", id); } catch (e) { alert("Delete failed: " + (e?.message||e)); return; }
    addTombstone(id);
    removeSig(id);
    const d = loadData();
    localStorage.setItem(DB_KEY, JSON.stringify({ ...d, jobs: d.jobs.filter(j => j.id !== id) }));
    window.location.reload();
  }

  const Row = ({ label, value }) => value ? (
    <div style={{ display:"flex", justifyContent:"space-between", padding:"8px 0", borderBottom:"1px solid #F3F4F6" }}>
      <span style={{ fontSize:13, color:"#6B7280", fontWeight:500 }}>{label}</span>
      <span style={{ fontSize:13, color:"#111827", fontWeight:600, textAlign:"right", maxWidth:"60%" }}>{value}</span>
    </div>
  ) : null;

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"jobs" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:12 }}>
        <h2 style={{ margin:0, fontSize:18, fontWeight:800, color:"#1E3A5F" }}>Job Detail</h2>
        <StatusBadge status={job.status} />
      </div>
      <Card>
        <Row label="Company"      value={customer?.company || null} />
        <Row label="Contact"      value={customer?.companyContact || null} />
        <Row label="Contact"      value={job.contactName || null} />
        <Row label="Driver"       value={job.driverName || null} />
        <Row label="Phone"        value={customer?.phone} />
        <Row label="Address"      value={[customer?.address1, customer?.town, customer?.postcode].filter(Boolean).join(", ")} />
        <Row label="Vehicle"      value={vehicle ? `${vehicle.make} ${vehicle.model} · ${vehicle.reg}` : null} />
        <Row label="Date"         value={fmtDate(job.date)} />
        <Row label="Time"         value={job.jobTime || null} />
        <Row label="Location"     value={[job.locAddress1, job.locAddress2, job.locTown, job.locCounty, job.locPostcode].filter(Boolean).join(", ") || null} />
        {(job.repairs?.length ? job.repairs : [{ id:"x", type:job.damageType, side:job.damageSide, position:job.damagePosition }]).map((r, i) => (
          <Row key={r.id || i} label={job.repairs?.length > 1 ? `Repair ${i+1}` : "Damage"} value={[r.type, r.side, r.position].filter(Boolean).join(" · ") || null} />
        ))}
        <Row label="Payment"      value={job.paymentType} />
        <Row label="Insurance Co" value={job.insuranceCo} />
        <Row label="Claim No."    value={job.claimNo} />
        <Row label="Technician"   value={technician?.name} />
        <Row label="Notes"        value={job.notes} />
      </Card>
      {(job.photosBefore?.length > 0 || job.photosAfter?.length > 0) && (
        <Card>
          <PhotoViewer label="Before Photos" photos={job.photosBefore} />
          <PhotoViewer label="After Photos"  photos={job.photosAfter}  />
        </Card>
      )}

      {nextStatuses[job.status]?.length > 0 && (
        <Btn variant="amber" onClick={() => updateStatus(nextStatuses[job.status][0])} style={{ width:"100%", justifyContent:"center", marginBottom:10 }}>
          <Icon name="check" size={15} /> Mark as {nextStatuses[job.status][0]}
        </Btn>
      )}
      {job.status==="Complete" && !invoice && (
        <Btn onClick={() => setShowInvoice(true)} style={{ width:"100%", justifyContent:"center", marginBottom:10 }}>
          Create Invoice
        </Btn>
      )}
      {invoice && (
        <Card style={{ background:"#F0FDF4", borderColor:"#BBF7D0" }}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontWeight:700, fontSize:14, color:"#065F46" }}>Invoice · £{invoice.total}</div>
              <div style={{ fontSize:12, color:"#059669" }}>{invoice.paid ? "✓ Paid" : "Awaiting payment"}</div>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <Btn size="sm" variant="ghost" onClick={() => setShowEditInvoice(true)}>Edit</Btn>
              {!invoice.paid && (
                <Btn size="sm" onClick={async () => {
                  const invoices = data.invoices.map(i => i.id===invoice.id ? {...i,paid:true,paidDate:todayISO()} : i);
                  const jobs = data.jobs.map(j => j.id===id ? {...j,status:"Paid"} : j);
                  await saveAndReload({ ...data, invoices, jobs });
                }}>Mark Paid</Btn>
              )}
              {invoice.paid && (
                <Btn size="sm" variant="ghost" onClick={async () => {
                  if (!window.confirm("Unmark this invoice as paid?")) return;
                  const invoices = data.invoices.map(i => i.id===invoice.id ? {...i,paid:false,paidDate:""} : i);
                  const jobs = data.jobs.map(j => j.id===id ? {...j,status:"Invoiced"} : j);
                  await saveAndReload({ ...data, invoices, jobs });
                }}>Unmark Paid</Btn>
              )}
            </div>
          </div>
        </Card>
      )}
      <div style={{ display:"flex", gap:8, marginTop:8, flexWrap:"wrap" }}>
        {customer?.phone && (
          <a href={`tel:${customer.phone}`} style={{ textDecoration:"none", flex:1 }}>
            <Btn size="sm" variant="primary" style={{ width:"100%", justifyContent:"center" }}>📞 Call</Btn>
          </a>
        )}
        {customer?.email && (
          <a href={`mailto:${customer.email}`} style={{ textDecoration:"none", flex:1 }}>
            <Btn size="sm" variant="ghost" style={{ width:"100%", justifyContent:"center" }}>✉️ Email</Btn>
          </a>
        )}
      </div>
      <div style={{ display:"flex", gap:8, marginTop:8 }}>
        <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)}    style={{ flex:1, justifyContent:"center" }}><Icon name="edit"  size={13}/> Edit</Btn>
        <Btn size="sm" variant="danger" onClick={deleteJob}                 style={{ flex:1, justifyContent:"center" }}><Icon name="trash" size={13}/> Delete</Btn>
      </div>
      <Btn variant="ghost" onClick={() => addToCalendar(job, customer, vehicle)} style={{ width:"100%", justifyContent:"center", marginTop:8 }}>
        📅 Add to iPhone Calendar
      </Btn>
      <Btn variant="amber" onClick={() => sendJobCard(job, customer, vehicle, invoice)} style={{ width:"100%", justifyContent:"center", marginTop:8 }}>
        📧 Email Job Card to Customer
      </Btn>
      {showEdit    && <JobForm     data={data} editJob={job} onClose={() => setShowEdit(false)}    />}
      {showInvoice && <InvoiceForm data={data} jobId={id}   onClose={() => setShowInvoice(false)} />}
      {showEditInvoice && invoice && <InvoiceForm data={data} jobId={id} editInvoice={invoice} onClose={() => setShowEditInvoice(false)} />}
    </div>
  );
}

// ── Invoice Form ──────────────────────────────────────────────────────────────
function InvoiceForm({ data, jobId, editInvoice, onClose }) {
  const job = data.jobs.find(j => j.id === jobId);
  const customer = data.customers.find(c => c.id === job?.customerId);
  const reps = job?.repairs?.length ? job.repairs : (job?.damageType ? [{ type: job.damageType, side: job.damageSide, position: job.damagePosition }] : []);
  // Auto-fill details from the job's repairs (for new invoices)
  const autoDetails = reps.map(r => `${r.type || "Repair"}${r.side ? " – " + r.side : ""}${r.position ? " " + r.position : ""}`).join("\n");
  const pricing = calcRepairPricing(data, customer, reps);
  const [details, setDetails] = useState(editInvoice?.details ?? autoDetails);
  const [labour, setLabour] = useState(editInvoice?.labour ?? (pricing.total ? pricing.total.toFixed(2) : ""));
  const [parts,  setParts]  = useState(editInvoice?.parts ?? "");
  const [vat,    setVat]    = useState(editInvoice?.vat ?? false);
  const subtotal = (parseFloat(labour)||0) + (parseFloat(parts)||0);
  const total    = vat ? subtotal * 1.2 : subtotal;

  async function save() {
    let invoices;
    if (editInvoice) {
      invoices = data.invoices.map(i => i.id === editInvoice.id ? { ...i, details, labour, parts, vat, total: total.toFixed(2) } : i);
      await saveAndReload({ ...data, invoices });
    } else {
      invoices = [...data.invoices, { id:uid(), jobId, details, labour, parts, vat, total:total.toFixed(2), paid:false, createdAt:todayISO() }];
      const jobs = data.jobs.map(j => j.id===jobId ? {...j,status:"Invoiced"} : j);
      await saveAndReload({ ...data, invoices, jobs });
    }
  }

  return (
    <Modal title={editInvoice ? "Edit Invoice" : "Create Invoice"} onClose={onClose}>
      <Field label="Details / Work Done">
        <textarea value={details} onChange={e => setDetails(e.target.value)} rows={3}
          style={{ width:"100%", padding:"10px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontFamily:"inherit", fontSize:14, resize:"vertical", boxSizing:"border-box" }}
          placeholder="e.g. Chip repair – Driver Side Top" />
      </Field>
      {pricing.lines.length > 0 && !editInvoice && (
        <div style={{ background:"#F8FAFC", border:"1px solid #E5E7EB", borderRadius:8, padding:"10px 12px", marginBottom:14 }}>
          <div style={{ fontSize:11, fontWeight:700, color:"#6B7280", textTransform:"uppercase", marginBottom:6 }}>Suggested Price (from {customer?.custType === "Trade" ? customer.company || "customer" : "default"} pricing)</div>
          {pricing.lines.map((l, idx) => (
            <div key={idx} style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:"#374151", marginBottom:2 }}>
              <span>{l.repair.type || "Repair"} ({l.count === 1 ? "1st" : l.count === 2 ? "2nd" : "3rd+"})</span>
              <span>£{l.price.toFixed(2)}</span>
            </div>
          ))}
          <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, fontWeight:700, color:"#1E3A5F", borderTop:"1px solid #E5E7EB", marginTop:4, paddingTop:4 }}>
            <span>Total</span><span>£{pricing.total.toFixed(2)}</span>
          </div>
        </div>
      )}
      <Field label="Labour (£)"><Input type="number" value={labour} onChange={setLabour} placeholder="0.00" /></Field>
      <Field label="Parts (£)"><Input type="number" value={parts} onChange={setParts} placeholder="0.00" /></Field>
      <Field label="VAT">
        <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:14, color:"#374151" }}>
          <input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} style={{ width:16, height:16 }} />
          Apply 20% VAT
        </label>
      </Field>
      <div style={{ background:"#F9FAFB", borderRadius:8, padding:"12px 14px", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:"#6B7280", marginBottom:4 }}><span>Subtotal</span><span>£{subtotal.toFixed(2)}</span></div>
        {vat && <div style={{ display:"flex", justifyContent:"space-between", fontSize:13, color:"#6B7280", marginBottom:4 }}><span>VAT (20%)</span><span>£{(subtotal*0.2).toFixed(2)}</span></div>}
        <div style={{ display:"flex", justifyContent:"space-between", fontSize:16, fontWeight:800, color:"#111827", borderTop:"1px solid #E5E7EB", paddingTop:8, marginTop:4 }}><span>Total</span><span>£{total.toFixed(2)}</span></div>
      </div>
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }}>Save Invoice</Btn>
    </Modal>
  );
}

// ── Invoices List ─────────────────────────────────────────────────────────────
function InvoicesList({ data, setView, initialFilter }) {
  const [filter, setFilter] = useState(initialFilter || "Unpaid");
  const oneMonthAgo = (() => { const d = new Date(); d.setMonth(d.getMonth()-1); return d.toISOString().split("T")[0]; })();
  const invOverdue = (inv, jobDate) => !inv.paid && ((jobDate || inv.createdAt || "") < oneMonthAgo) && (jobDate || inv.createdAt);
  const anyOverdue = data.invoices.some(inv => {
    const job = data.jobs.find(j => j.id === inv.jobId);
    return invOverdue(inv, job?.date);
  });
  const enriched = data.invoices.map(inv => {
    const job      = data.jobs.find(j => j.id === inv.jobId);
    const customer = job ? data.customers.find(c => c.id === job.customerId) : null;
    const vehicle  = job?.vehicleId ? data.vehicles.find(v => v.id === job.vehicleId) : null;
    return { ...inv, job, customer, vehicle, overdue: invOverdue(inv, job?.date) };
  }).filter(inv => {
    if (filter==="Unpaid") return !inv.paid;
    if (filter==="Paid")   return  inv.paid;
    return true;
  }).sort((a,b) => (b.job?.date||b.createdAt||"").localeCompare(a.job?.date||a.createdAt||""));

  const total = enriched.reduce((s,i) => s+(parseFloat(i.total)||0), 0);
  const pill  = (active, red) => ({ padding:"12px 22px", borderRadius:99, fontSize:15, fontWeight:600, cursor:"pointer", border: red && !active ? "2px solid #DC2626" : "none", background:active?(red?"#DC2626":"#1E3A5F"):"#F3F4F6", color:active?"#fff":(red?"#DC2626":"#6B7280"), fontFamily:"inherit", whiteSpace:"nowrap" });

  return (
    <div>
      <h2 style={{ margin:"0 0 14px", fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Invoices</h2>
      {anyOverdue && (
        <div style={{ background:"#DC2626", color:"#fff", borderRadius:10, padding:"10px 14px", marginBottom:12, fontSize:14, fontWeight:700 }}>
          ⚠️ You have unpaid invoices over 1 month overdue
        </div>
      )}
      <div style={{ display:"flex", gap:10, marginBottom:16, overflowX:"auto", paddingBottom:4 }}>
        {["Unpaid","Paid","All"].map(f => <button key={f} style={pill(filter===f, f==="Unpaid" && anyOverdue)} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      {enriched.length > 0 && (
        <Card style={{ background:"#EFF6FF", borderColor:"#BFDBFE" }}>
          <div style={{ display:"flex", justifyContent:"space-between" }}>
            <span style={{ fontSize:13, color:"#1D4ED8", fontWeight:600 }}>{filter==="Unpaid"?"Outstanding":filter==="Paid"?"Total Received":"Total"}</span>
            <span style={{ fontSize:18, fontWeight:800, color:"#1D4ED8" }}>£{total.toFixed(2)}</span>
          </div>
        </Card>
      )}
      {enriched.length === 0 && <p style={{ color:"#9CA3AF", textAlign:"center", fontSize:14 }}>No invoices found</p>}
      {enriched.map(inv => (
        <Card key={inv.id} onClick={() => inv.job && setView({ screen:"jobDetail", id:inv.job.id })}>
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
            <div>
              <div style={{ fontWeight:700, fontSize:15 }}>{inv.customer?.company||"Unknown"}</div>
              <div style={{ fontSize:12, color:"#9CA3AF" }}>{fmtDate(inv.job?.date || inv.createdAt)}{inv.job?.jobType ? " · " + inv.job.jobType : ""}</div>
              {inv.vehicle && <div style={{ fontSize:12, color:"#6B7280", marginTop:1 }}>🚗 {[inv.vehicle.make, inv.vehicle.model, inv.vehicle.reg].filter(Boolean).join(" · ")}</div>}
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontWeight:800, fontSize:16, color:inv.paid?"#059669":"#1E3A5F" }}>£{parseFloat(inv.total).toFixed(2)}</div>
              <div style={{ fontSize:11, color:inv.paid?"#059669":inv.overdue?"#DC2626":"#D97706", fontWeight:600 }}>{inv.paid?"Paid":inv.overdue?"OVERDUE":"Unpaid"}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ── Root App ──────────────────────────────────────────────────────────────────
// ── Notification & Sound System ───────────────────────────────────────────────
function playAlertSound() {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const times = [0, 0.2, 0.4];
    times.forEach(t => {
      const osc  = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.frequency.value = 880;
      osc.type = "sine";
      gain.gain.setValueAtTime(0, ctx.currentTime + t);
      gain.gain.linearRampToValueAtTime(0.4, ctx.currentTime + t + 0.05);
      gain.gain.linearRampToValueAtTime(0, ctx.currentTime + t + 0.18);
      osc.start(ctx.currentTime + t);
      osc.stop(ctx.currentTime + t + 0.2);
    });
  } catch(e) {}
}

function sendNotification(title, body) {
  playAlertSound();
  if ("Notification" in window && Notification.permission === "granted") {
    new Notification(title, { body, icon: "/logo.png", badge: "/logo.png" });
  }
}

function scheduleNotifications(data) {
  // Clear any existing scheduled timers stored on window
  if (window._crmTimers) window._crmTimers.forEach(clearTimeout);
  window._crmTimers = [];

  const now  = new Date();
  const today = now.toISOString().split("T")[0];
  const todayJobs = data.jobs.filter(j =>
    j.date === today && ["Booked"].includes(j.status)
  );

  // 9am daily summary
  const nineAm = new Date();
  nineAm.setHours(9, 0, 0, 0);
  const msTo9am = nineAm - now;
  if (msTo9am > 0 && todayJobs.length > 0) {
    window._crmTimers.push(setTimeout(() => {
      sendNotification(
        "📋 Windscreen Repairs Bristol",
        `You have ${todayJobs.length} job${todayJobs.length > 1 ? "s" : ""} booked today`
      );
    }, msTo9am));
  }

  // 1 hour before each job
  todayJobs.forEach(job => {
    if (!job.jobTime) return;
    const [h, m] = job.jobTime.split(":").map(Number);
    const jobDate = new Date();
    jobDate.setHours(h, m, 0, 0);
    const alertTime = new Date(jobDate - 60 * 60 * 1000); // 1hr before
    const msToAlert = alertTime - now;
    if (msToAlert > 0) {
      const cust = data.customers.find(c => c.id === job.customerId);
      const veh  = data.vehicles.find(v => v.id === job.vehicleId);
      const name = cust?.company || job.driverName || "Customer";
      const car  = veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "";
      window._crmTimers.push(setTimeout(() => {
        sendNotification(
          `🔧 Job in 1 hour — ${job.jobTime}`,
          `${name}${car ? ` · ${car}` : ""}${job.locAddress1 ? ` · ${job.locAddress1}` : ""}`
        );
      }, msToAlert));
    }
  });
}

// ── Calendar ──────────────────────────────────────────────────────────────────
function CalendarView({ data, setView, device }) {
  const [mode, setMode] = useState("month"); // "month" | "agenda" | "day"
  const [selectedDay, setSelectedDay] = useState(null);
  const [selectedDate, setSelectedDate] = useState(null);
  const today = new Date();
  const [cursor, setCursor] = useState(new Date(today.getFullYear(), today.getMonth(), 1));

  const monthNames = ["January","February","March","April","May","June","July","August","September","October","November","December"];
  const dayNames = ["Mon","Tue","Wed","Thu","Fri","Sat","Sun"];

  const jobsByDate = {};
  (data.jobs || []).forEach(j => {
    if (!j.date) return;
    (jobsByDate[j.date] = jobsByDate[j.date] || []).push(j);
  });
  Object.values(jobsByDate).forEach(arr => arr.sort((a,b) => (a.jobTime||"").localeCompare(b.jobTime||"")));

  const toISO = (y, m, d) => `${y}-${String(m+1).padStart(2,"0")}-${String(d).padStart(2,"0")}`;
  const todayISO = toISO(today.getFullYear(), today.getMonth(), today.getDate());

  function custName(j) {
    const c = data.customers.find(x => x.id === j.customerId);
    return j.driverName || c?.company || c?.companyContact || "Job";
  }

  function MonthGrid() {
    const year = cursor.getFullYear(), month = cursor.getMonth();
    const firstDay = new Date(year, month, 1);
    const startOffset = (firstDay.getDay() + 6) % 7;
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startOffset; i++) cells.push(null);
    for (let d = 1; d <= daysInMonth; d++) cells.push(d);
    const cellMinH = device === "phone" ? 52 : device === "tablet" ? 92 : 110;
    const maxEntries = device === "phone" ? 2 : 4;
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <Btn size="sm" variant="ghost" onClick={() => setCursor(new Date(year, month-1, 1))}>‹</Btn>
          <div style={{ fontWeight:800, fontSize:18, color:"#1E3A5F" }}>{monthNames[month]} {year}</div>
          <Btn size="sm" variant="ghost" onClick={() => setCursor(new Date(year, month+1, 1))}>›</Btn>
        </div>
        <div style={{ display:"grid", gridTemplateColumns:"repeat(7,1fr)", gap:5 }}>
          {dayNames.map(d => <div key={d} style={{ textAlign:"center", fontSize:12, fontWeight:700, color:"#9CA3AF", padding:"6px 0" }}>{device==="phone" ? d[0] : d}</div>)}
          {cells.map((d, i) => {
            if (d === null) return <div key={"e"+i} />;
            const iso = toISO(year, month, d);
            const dayJobs = jobsByDate[iso] || [];
            const isToday = iso === todayISO;
            return (
              <div key={iso} onClick={() => { setSelectedDate(iso); setMode("day"); }}
                style={{ minHeight:cellMinH, borderRadius:10, padding:device==="phone"?4:6, background: isToday ? "#EFF6FF" : "#fff", border: isToday ? "2px solid #2563EB" : "1px solid #F3F4F6", cursor:"pointer", display:"flex", flexDirection:"column" }}>
                <div style={{ fontSize:device==="phone"?13:15, fontWeight:700, color: isToday ? "#2563EB" : "#374151" }}>{d}</div>
                {device === "phone" ? (
                  // Compact: coloured dots on phone
                  dayJobs.length > 0 && (
                    <div style={{ display:"flex", flexWrap:"wrap", gap:2, marginTop:2 }}>
                      {dayJobs.slice(0,4).map(j => (
                        <div key={j.id} style={{ width:6, height:6, borderRadius:"50%", background:(STATUS_META[j.status]||STATUS_META.Booked).color }} />
                      ))}
                    </div>
                  )
                ) : (
                  // Roomy: job labels on tablet/desktop
                  <>
                    {dayJobs.slice(0,maxEntries).map(j => (
                      <div key={j.id} style={{ fontSize:9, fontWeight:600, color:"#fff", background:(STATUS_META[j.status]||STATUS_META.Booked).color, borderRadius:3, padding:"1px 3px", marginTop:2, overflow:"hidden", whiteSpace:"nowrap", textOverflow:"ellipsis" }}>
                        {j.jobTime ? j.jobTime + " " : ""}{custName(j)}
                      </div>
                    ))}
                    {dayJobs.length > maxEntries && <div style={{ fontSize:10, color:"#9CA3AF", marginTop:1 }}>+{dayJobs.length-maxEntries} more</div>}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </div>
    );
  }

  // ── Day view ──
  function DayView() {
    const d = selectedDate || todayISO;
    const dayJobs = jobsByDate[d] || [];
    const dt = new Date(d + "T00:00:00");
    const prevDay = () => { const x = new Date(dt); x.setDate(x.getDate()-1); setSelectedDate(toISO(x.getFullYear(), x.getMonth(), x.getDate())); };
    const nextDay = () => { const x = new Date(dt); x.setDate(x.getDate()+1); setSelectedDate(toISO(x.getFullYear(), x.getMonth(), x.getDate())); };
    const weekday = ["Sunday","Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"][dt.getDay()];
    return (
      <div>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
          <Btn size="sm" variant="ghost" onClick={prevDay}>‹</Btn>
          <div style={{ textAlign:"center" }}>
            <div style={{ fontWeight:800, fontSize:17, color:"#1E3A5F" }}>{weekday}</div>
            <div style={{ fontSize:13, color:"#6B7280" }}>{fmtDate(d)}</div>
          </div>
          <Btn size="sm" variant="ghost" onClick={nextDay}>›</Btn>
        </div>
        {dayJobs.length === 0 && <p style={{ fontSize:14, color:"#9CA3AF", textAlign:"center", marginTop:30 }}>No jobs on this day</p>}
        {dayJobs.map(j => (
          <Card key={j.id} onClick={() => setView({ screen:"jobDetail", id:j.id })}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
              <div>
                <div style={{ fontWeight:700, fontSize:16, color:"#1E3A5F" }}>{j.jobTime || "—"}</div>
                <div style={{ fontWeight:600, fontSize:14, marginTop:2 }}>{custName(j)}</div>
                <div style={{ fontSize:12, color:"#9CA3AF", marginTop:1 }}>{j.jobType}{j.damageType ? " · " + j.damageType : ""}</div>
                {(j.locTown || j.locAddress1) && <div style={{ fontSize:12, color:"#9CA3AF", marginTop:1 }}>📍 {[j.locAddress1, j.locTown].filter(Boolean).join(", ")}</div>}
              </div>
              <StatusBadge status={j.status} />
            </div>
          </Card>
        ))}
      </div>
    );
  }

  function Agenda() {
    const upcoming = Object.keys(jobsByDate).filter(d => d >= todayISO).sort();
    if (upcoming.length === 0) return <p style={{ fontSize:13, color:"#9CA3AF", textAlign:"center", marginTop:30 }}>No upcoming jobs scheduled</p>;
    return (
      <div>
        {upcoming.map(date => (
          <div key={date} style={{ marginBottom:16 }}>
            <div style={{ fontSize:13, fontWeight:700, color: date===todayISO ? "#2563EB" : "#374151", marginBottom:6 }}>
              {date===todayISO ? "Today · " : ""}{fmtDate(date)}
            </div>
            {jobsByDate[date].map(j => (
              <Card key={j.id} onClick={() => setView({ screen:"jobDetail", id:j.id })}>
                <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center" }}>
                  <div>
                    <div style={{ fontWeight:600, fontSize:14 }}>{j.jobTime ? j.jobTime + " · " : ""}{custName(j)}</div>
                    <div style={{ fontSize:12, color:"#9CA3AF" }}>{j.jobType}{j.damageType ? " · " + j.damageType : ""}</div>
                  </div>
                  <StatusBadge status={j.status} />
                </div>
              </Card>
            ))}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <div style={{ display:"flex", gap:8, marginBottom:16 }}>
        <Btn variant={mode==="month"?"primary":"ghost"} size="sm" onClick={() => setMode("month")} style={{ flex:1, justifyContent:"center" }}>Month</Btn>
        <Btn variant={mode==="day"?"primary":"ghost"} size="sm" onClick={() => { if (!selectedDate) setSelectedDate(todayISO); setMode("day"); }} style={{ flex:1, justifyContent:"center" }}>Day</Btn>
        <Btn variant={mode==="agenda"?"primary":"ghost"} size="sm" onClick={() => setMode("agenda")} style={{ flex:1, justifyContent:"center" }}>Agenda</Btn>
      </div>

      {mode === "month" && <MonthGrid />}
      {mode === "day" && <DayView />}
      {mode === "agenda" && <Agenda />}
    </div>
  );
}

// ── Responsive sizing ─────────────────────────────────────────────────────────
// One app that adapts: phone (chunkier touch targets), tablet & desktop (roomier).
function useDeviceType() {
  const get = () => {
    const w = typeof window !== "undefined" ? window.innerWidth : 520;
    if (w >= 1024) return "desktop";
    if (w >= 700)  return "tablet";
    return "phone";
  };
  const [device, setDevice] = useState(get);
  useEffect(() => {
    const onResize = () => setDevice(get());
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);
  return device;
}

// Global CSS tuned per device — bigger inputs/buttons on phone, wider layout on tablet/desktop
function ResponsiveStyles({ device }) {
  const css = {
    phone: `
      .crm-shell { max-width: 100%; }
      input, select, textarea { font-size: 16px !important; padding: 14px 14px !important; }
      .crm-btn { padding: 14px 20px !important; font-size: 16px !important; }
      .crm-btn-sm { padding: 10px 14px !important; font-size: 14px !important; }
    `,
    tablet: `
      .crm-shell { max-width: 720px; }
      input, select, textarea { font-size: 15px !important; padding: 12px 14px !important; }
    `,
    desktop: `
      .crm-shell { max-width: 880px; }
      input, select, textarea { font-size: 15px !important; padding: 11px 14px !important; }
    `,
  };
  return <style>{css[device] || ""}</style>;
}

// ── Reports ───────────────────────────────────────────────────────────────────
// ── Settings ─────────────────────────────────────────────────────────────────
function SettingsView({ data, setView }) {
  const [pricing, setPricing] = useState(getDefaultPricing(data));
  const [privatePricing, setPrivatePricing] = useState(getPrivatePricing(data));
  const tradeCustomers = (data.customers || []).filter(c => c.custType === "Trade").sort((a,b) => (a.company||"").localeCompare(b.company||"", undefined, { sensitivity:"base" }));
  const tradeEmails = tradeCustomers.map(c => c.email).filter(Boolean);

  async function save() {
    const existing = data.settings || [];
    const rec = { id: "app", defaultPricing: pricing, privatePricing, updatedAt: Date.now() };
    const settings = existing.some(s => s.id === "app") ? existing.map(s => s.id === "app" ? rec : s) : [...existing, rec];
    try {
      await saveAndReload({ ...data, settings });
    } catch (e) {
      alert("Save failed: " + (e?.message || e));
    }
  }

  function emailAllTrade() {
    const subject = encodeURIComponent("Terms and Conditions — Windscreen Repairs Bristol");
    const body = encodeURIComponent("Hi,\n\nPlease find attached our current Terms and Conditions for windscreen repair services.\n\nWindscreen Repairs (Bristol)\n07946 222246");
    window.location.href = `mailto:?bcc=${tradeEmails.join(",")}&subject=${subject}&body=${body}`;

    const emailedIds = tradeCustomers.filter(c => c.email).map(c => c.id);
    const customers = data.customers.map(c => emailedIds.includes(c.id) ? { ...c, termsSentAt: Date.now() } : c);
    const newEntries = emailedIds.map(cid => ({ id: uid(), customerId: cid, contactId: "", contactName: "", type: "Email", direction: "out", note: "Terms & Conditions sent (PDF, bulk)", timestamp: Date.now(), createdAt: todayISO() }));
    saveAndReload({ ...data, customers, communications: [...(data.communications || []), ...newEntries] }).catch(() => {});
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"dashboard" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <h2 style={{ fontSize:18, fontWeight:800, color:"#1E3A5F", margin:"0 0 12px" }}>Settings</h2>

      <div style={{ background:"#fff", border:"1px solid #F3F4F6", borderRadius:12, padding:16, marginBottom:16 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:14, fontWeight:700, color:"#374151" }}>Terms & Conditions</h3>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#6B7280" }}>View or print your current Terms and Conditions, or email them to every Trade customer with an email address on file ({tradeEmails.length} of {tradeCustomers.length}).</p>
        <Btn variant="ghost" onClick={() => openTermsWindow()} style={{ width:"100%", justifyContent:"center", marginBottom:8 }}>📜 View / Print Terms</Btn>
        <Btn onClick={emailAllTrade} disabled={tradeEmails.length===0} style={{ width:"100%", justifyContent:"center" }}>✉️ Email to All Trade Customers</Btn>
        <p style={{ fontSize:11, color:"#9CA3AF", margin:"8px 0 0", textAlign:"center" }}>Opens Mail with everyone BCC'd — save the PDF from "View / Print Terms" first and attach it before sending.</p>
      </div>

      <div style={{ background:"#fff", border:"1px solid #F3F4F6", borderRadius:12, padding:16, marginBottom:16 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:14, fontWeight:700, color:"#374151" }}>Private Customer Prices</h3>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#6B7280" }}>Used for every Private customer — picked up automatically when creating an invoice or sending repair terms. "3rd+" applies to every repair of that type from the 3rd one onwards on the same vehicle.</p>
        <PricingGrid value={privatePricing} onChange={setPrivatePricing} />
        <Btn onClick={save} style={{ width:"100%", justifyContent:"center", marginTop:10 }}>💾 Save</Btn>
      </div>

      <div style={{ background:"#fff", border:"1px solid #F3F4F6", borderRadius:12, padding:16, marginBottom:16 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:14, fontWeight:700, color:"#374151" }}>Trade Default Prices</h3>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#6B7280" }}>Used for any Trade customer without their own prices set below.</p>
        <PricingGrid value={pricing} onChange={setPricing} />
        <Btn onClick={save} style={{ width:"100%", justifyContent:"center", marginTop:10 }}>💾 Save</Btn>
      </div>

      <div style={{ background:"#fff", border:"1px solid #F3F4F6", borderRadius:12, padding:16 }}>
        <h3 style={{ margin:"0 0 4px", fontSize:14, fontWeight:700, color:"#374151" }}>Trade Customer Prices</h3>
        <p style={{ margin:"0 0 12px", fontSize:13, color:"#6B7280" }}>Set custom prices per Trade customer from their customer page (Edit → Repair Prices). Anyone showing "Default" is using the Trade Default prices above.</p>
        {tradeCustomers.length === 0 && <p style={{ fontSize:13, color:"#9CA3AF" }}>No Trade customers yet</p>}
        {tradeCustomers.map(c => {
          const hasCustom = c.pricing && Object.values(c.pricing).some(t => t && Object.values(t).some(v => v));
          return (
            <div key={c.id} onClick={() => setView({ screen:"customerDetail", id:c.id })}
              style={{ display:"flex", justifyContent:"space-between", alignItems:"center", padding:"9px 4px", borderBottom:"1px solid #F9FAFB", cursor:"pointer" }}>
              <span style={{ fontSize:14, color:"#111827" }}>{c.company || c.companyContact || "Unnamed"}</span>
              <span style={{ fontSize:13, fontWeight:700, color: hasCustom ? "#1E3A5F" : "#9CA3AF" }}>{hasCustom ? "Custom prices" : "Default"}</span>
            </div>
          );
        })}
      </div>
      <div style={{ textAlign:"center", marginTop:18, fontSize:11, color:"#D1D5DB" }}>{BUILD_NUMBER}</div>
    </div>
  );
}

function ReportsView({ data }) {
  const now = new Date();
  // Period mode: "rolling" (last 12 months), or a specific calendar/financial year
  const [period, setPeriod] = useState("rolling");

  // Build the list of selectable years from the data
  const allDates = [
    ...(data.invoices || []).map(i => i.createdAt),
    ...(data.jobs || []).map(j => j.date),
  ].filter(Boolean);
  const yearsPresent = Array.from(new Set(allDates.map(d => parseInt(d.slice(0,4))))).filter(Boolean);
  const thisYear = now.getFullYear();
  if (!yearsPresent.includes(thisYear)) yearsPresent.push(thisYear);
  yearsPresent.sort((a,b) => b - a);

  // Work out the 12 months to show based on the selected period
  let months = [];
  if (period === "rolling") {
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleDateString("en-GB",{month:"short"}) });
    }
  } else if (period === "all") {
    // From the earliest record's month to now
    const earliest = allDates.length ? allDates.reduce((a,b) => a < b ? a : b) : `${now.getFullYear()}-01`;
    const [ey, em] = earliest.slice(0,7).split("-").map(Number);
    let d = new Date(ey, em-1, 1);
    const end = new Date(now.getFullYear(), now.getMonth(), 1);
    while (d <= end) {
      months.push({ key: `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}`, label: d.toLocaleDateString("en-GB",{month:"short"}) + (d.getMonth()===0 ? " " + String(d.getFullYear()).slice(2) : "") });
      d = new Date(d.getFullYear(), d.getMonth()+1, 1);
    }
  } else if (period.startsWith("cal-")) {
    const y = parseInt(period.slice(4));
    for (let m = 0; m < 12; m++) {
      const d = new Date(y, m, 1);
      months.push({ key: `${y}-${String(m+1).padStart(2,"0")}`, label: d.toLocaleDateString("en-GB",{month:"short"}) });
    }
  } else if (period.startsWith("fin-")) {
    // Financial year April (start) to March (next year)
    const y = parseInt(period.slice(4));
    for (let m = 3; m < 12; m++) { // Apr..Dec of start year
      const d = new Date(y, m, 1);
      months.push({ key: `${y}-${String(m+1).padStart(2,"0")}`, label: d.toLocaleDateString("en-GB",{month:"short"}) });
    }
    for (let m = 0; m < 3; m++) { // Jan..Mar of next year
      const d = new Date(y+1, m, 1);
      months.push({ key: `${y+1}-${String(m+1).padStart(2,"0")}`, label: d.toLocaleDateString("en-GB",{month:"short"}) });
    }
  }

  const billed = {}, received = {}, jobCount = {};
  months.forEach(m => { billed[m.key]=0; received[m.key]=0; jobCount[m.key]=0; });

  (data.invoices || []).forEach(inv => {
    const amt = parseFloat(inv.total) || 0;
    // Bucket "billed" by the JOB date (when work was done), falling back to invoice date
    const job = (data.jobs || []).find(j => j.id === inv.jobId);
    const billedDate = job?.date || inv.createdAt;
    if (billedDate) { const k = billedDate.slice(0,7); if (k in billed) billed[k] += amt; }
    // "Received" stays bucketed by the date it was actually paid
    if (inv.paid && inv.paidDate) { const k = inv.paidDate.slice(0,7); if (k in received) received[k] += amt; }
  });
  (data.jobs || []).forEach(j => {
    if (j.date) { const k = j.date.slice(0,7); if (k in jobCount) jobCount[k] += 1; }
  });

  const outstanding = (data.invoices || []).filter(i => !i.paid).reduce((s,i) => s+(parseFloat(i.total)||0), 0);
  const receivedTotal = months.reduce((s,m) => s + received[m.key], 0);
  const billedTotal   = months.reduce((s,m) => s + billed[m.key], 0);

  const maxRev = Math.max(1, ...months.map(m => Math.max(billed[m.key], received[m.key])));
  const maxJobs = Math.max(1, ...months.map(m => jobCount[m.key]));

  const periodLabel = period === "rolling" ? "Last 12 months"
    : period === "all" ? "All time"
    : period.startsWith("cal-") ? `Year ${period.slice(4)}`
    : `FY ${period.slice(4)}/${(parseInt(period.slice(4))+1).toString().slice(2)}`;

  const Bar = ({ value, max, color }) => (
    <div style={{ flex:1, display:"flex", flexDirection:"column", justifyContent:"flex-end", alignItems:"center", height:120 }}>
      <div style={{ width:"70%", height:`${(value/max)*100}%`, background:color, borderRadius:"3px 3px 0 0", minHeight: value>0?2:0 }} />
    </div>
  );

  return (
    <div>
      <h2 style={{ margin:"0 0 12px", fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Reports</h2>

      {/* Period selector */}
      <div style={{ marginBottom:16 }}>
        <select value={period} onChange={e => setPeriod(e.target.value)}
          style={{ width:"100%", padding:"12px 14px", borderRadius:8, border:"1.5px solid #E5E7EB", fontSize:15, fontFamily:"inherit", background:"#fff", appearance:"none" }}>
          <option value="rolling">Last 12 months</option>
          <option value="all">All time</option>
          {yearsPresent.map(y => <option key={"cal"+y} value={`cal-${y}`}>Calendar year {y}</option>)}
          {yearsPresent.map(y => <option key={"fin"+y} value={`fin-${y}`}>Financial year {y}/{(y+1).toString().slice(2)} (Apr–Mar)</option>)}
        </select>
      </div>

      <div style={{ display:"flex", gap:10, marginBottom:20, flexWrap:"wrap" }}>
        <div style={{ flex:1, minWidth:100, background:"#EFF6FF", borderRadius:12, padding:14, border:"1px solid #BFDBFE" }}>
          <div style={{ fontSize:22, fontWeight:800, color:"#1D4ED8" }}>£{billedTotal.toFixed(0)}</div>
          <div style={{ fontSize:11, color:"#1D4ED8", fontWeight:600 }}>Billed</div>
        </div>
        <div style={{ flex:1, minWidth:100, background:"#FEF2F2", borderRadius:12, padding:14, border:"1px solid #FECACA" }}>
          <div style={{ fontSize:22, fontWeight:800, color:"#DC2626" }}>£{outstanding.toFixed(0)}</div>
          <div style={{ fontSize:11, color:"#DC2626", fontWeight:600 }}>Outstanding now</div>
        </div>
      </div>

      <div style={{ background:"#fff", borderRadius:12, padding:16, border:"1px solid #F3F4F6", marginBottom:16 }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:4 }}>
          <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151" }}>Revenue · {periodLabel}</h3>
          <span style={{ color:"#1D4ED8", fontWeight:600, fontSize:11 }}>■ Billed</span>
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3, marginTop:10 }}>
          {months.map(m => (
            <div key={m.key} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center" }}>
              <div style={{ fontSize:9, fontWeight:700, color:"#1D4ED8", marginBottom:2, whiteSpace:"nowrap" }}>
                {billed[m.key] > 0 ? (billed[m.key] >= 1000 ? `£${(billed[m.key]/1000).toFixed(1)}k` : `£${Math.round(billed[m.key])}`) : ""}
              </div>
              <Bar value={billed[m.key]} max={maxRev} color="#3B82F6" />
              <div style={{ fontSize:9, color:"#9CA3AF", marginTop:4 }}>{m.label}</div>
            </div>
          ))}
        </div>
      </div>

      <div style={{ background:"#fff", borderRadius:12, padding:16, border:"1px solid #F3F4F6", marginBottom:16 }}>
        <h3 style={{ margin:"0 0 10px", fontSize:14, fontWeight:700, color:"#374151" }}>Monthly Breakdown · {periodLabel}</h3>
        <div style={{ display:"flex", fontSize:11, fontWeight:700, color:"#9CA3AF", textTransform:"uppercase", padding:"0 4px 6px", borderBottom:"1px solid #F3F4F6" }}>
          <div style={{ flex:1.2 }}>Month</div>
          <div style={{ flex:1, textAlign:"right" }}>Billed</div>
          <div style={{ flex:1, textAlign:"right" }}>Received</div>
          <div style={{ flex:0.7, textAlign:"right" }}>Jobs</div>
        </div>
        {[...months].reverse().map(m => (
          <div key={m.key} style={{ display:"flex", fontSize:13, padding:"7px 4px", borderBottom:"1px solid #F9FAFB" }}>
            <div style={{ flex:1.2, fontWeight:600, color:"#111827" }}>{m.label}</div>
            <div style={{ flex:1, textAlign:"right", color:"#1D4ED8", fontWeight:600 }}>£{billed[m.key].toFixed(0)}</div>
            <div style={{ flex:1, textAlign:"right", color:"#059669" }}>£{received[m.key].toFixed(0)}</div>
            <div style={{ flex:0.7, textAlign:"right", color:"#6B7280" }}>{jobCount[m.key] || 0}</div>
          </div>
        ))}
      </div>

      <div style={{ background:"#fff", borderRadius:12, padding:16, border:"1px solid #F3F4F6" }}>
        <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
          <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151" }}>Jobs · {periodLabel}</h3>
          <span style={{ fontSize:13, fontWeight:800, color:"#F59E0B" }}>{months.reduce((s,m) => s + jobCount[m.key], 0)} total</span>
        </div>
        <div style={{ display:"flex", alignItems:"flex-end", gap:3 }}>
          {months.map(m => (
            <div key={m.key} style={{ flex:1, display:"flex", flexDirection:"column", alignItems:"center" }}>
              <div style={{ fontSize:10, fontWeight:700, color:"#6B7280", marginBottom:2 }}>{jobCount[m.key] || ""}</div>
              <div style={{ width:"60%", height:`${(jobCount[m.key]/maxJobs)*90}px`, background:"#F59E0B", borderRadius:"3px 3px 0 0", minHeight: jobCount[m.key]>0?2:0 }} />
              <div style={{ fontSize:9, color:"#9CA3AF", marginTop:4 }}>{m.label}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ── Mileage Log ───────────────────────────────────────────────────────────────
// Financial year (Apr–Mar) that a given YYYY-MM-DD date falls into; returns the start year
function finYearOf(dateStr) {
  const [y, m] = dateStr.split("-").map(Number);
  return m >= 4 ? y : y - 1;
}
function MileageView({ data, setView }) {
  const allEntries = [...(data.mileage || [])].sort((a,b) => b.date.localeCompare(a.date));
  const [date, setDate] = useState(todayISO());
  const [miles, setMiles] = useState("");
  const [note, setNote] = useState("");
  const [yearFilter, setYearFilter] = useState("all");

  async function add() {
    const m = parseFloat(miles);
    if (!m || m <= 0) return;
    const mileage = [...(data.mileage || []), { id: uid(), date, miles: m, note, createdAt: todayISO() }];
    setMiles(""); setNote("");
    await saveAndReload({ ...data, mileage });
  }
  async function remove(id) {
    if (!window.confirm("Delete this mileage entry? This cannot be undone.")) return;
    try { await deleteRecord("mileage", id); } catch (e) { alert("Delete failed: " + (e?.message || JSON.stringify(e))); return; }
    addTombstone(id);
    const mileage = (data.mileage || []).filter(e => e.id !== id);
    await saveAndReload({ ...data, mileage });
  }

  // Totals by financial year
  const byFinYear = {};
  allEntries.forEach(e => { const fy = finYearOf(e.date); byFinYear[fy] = (byFinYear[fy] || 0) + e.miles; });
  const finYears = Object.keys(byFinYear).map(Number).sort((a,b) => b - a);
  const currentFY = finYearOf(todayISO());

  // Entries shown depend on the selected year
  const entries = yearFilter === "all" ? allEntries : allEntries.filter(e => finYearOf(e.date) === Number(yearFilter));

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"dashboard" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <h2 style={{ margin:"0 0 16px", fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Mileage Log</h2>

      <div style={{ display:"flex", gap:10, marginBottom:18, flexWrap:"wrap" }}>
        {finYears.length === 0 && <div style={{ fontSize:14, color:"#9CA3AF" }}>No mileage logged yet.</div>}
        {finYears.map(fy => (
          <div key={fy} style={{ flex:1, minWidth:120, background: fy===currentFY ? "#EFF6FF" : "#F9FAFB", borderRadius:12, padding:14, border: fy===currentFY ? "1px solid #BFDBFE" : "1px solid #F3F4F6" }}>
            <div style={{ fontSize:22, fontWeight:800, color:"#1E3A5F" }}>{byFinYear[fy].toLocaleString()}</div>
            <div style={{ fontSize:11, color:"#6B7280", fontWeight:600 }}>miles · FY {fy}/{(fy+1).toString().slice(2)}{fy===currentFY ? " (current)" : ""}</div>
          </div>
        ))}
      </div>

      <Card>
        <div style={{ fontSize:13, fontWeight:700, color:"#1E3A5F", marginBottom:10 }}>Add Mileage</div>
        <Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field>
        <Field label="Miles"><Input type="number" value={miles} onChange={setMiles} placeholder="e.g. 24" /></Field>
        <Field label="Note (optional)"><Input value={note} onChange={setNote} placeholder="e.g. Bristol to Cheddar – job" /></Field>
        <Btn onClick={add} style={{ width:"100%", justifyContent:"center" }} disabled={!miles}>Add</Btn>
      </Card>
      <p style={{ fontSize:12, color:"#9CA3AF", margin:"8px 2px 0" }}>Tip: to record last year's mileage, just set the date to a day in that year.</p>

      <div style={{ marginTop:16 }}>
        {allEntries.length > 0 && (
          <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10 }}>
            <h3 style={{ fontSize:14, fontWeight:700, color:"#374151", margin:0, textTransform:"uppercase", letterSpacing:"0.05em" }}>History</h3>
            <select value={yearFilter} onChange={e => setYearFilter(e.target.value)}
              style={{ padding:"8px 12px", borderRadius:8, border:"1.5px solid #E5E7EB", fontSize:14, fontFamily:"inherit", background:"#fff" }}>
              <option value="all">All years</option>
              {finYears.map(fy => <option key={fy} value={fy}>FY {fy}/{(fy+1).toString().slice(2)}</option>)}
            </select>
          </div>
        )}
        {yearFilter !== "all" && (
          <div style={{ fontSize:13, fontWeight:700, color:"#1E3A5F", marginBottom:10 }}>
            {byFinYear[Number(yearFilter)]?.toLocaleString() || 0} miles total · FY {yearFilter}/{(Number(yearFilter)+1).toString().slice(2)}
          </div>
        )}
        {entries.map(e => (
          <Card key={e.id}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", gap:8 }}>
              <div>
                <div style={{ fontWeight:700, fontSize:15, color:"#1E3A5F" }}>{e.miles.toLocaleString()} miles</div>
                <div style={{ fontSize:12, color:"#6B7280" }}>{fmtDate(e.date)}{e.note ? " · " + e.note : ""}</div>
              </div>
              <button onClick={() => remove(e.id)} style={{ background:"#FEE2E2", color:"#DC2626", border:"none", borderRadius:6, padding:"6px 12px", fontSize:13, fontWeight:600, cursor:"pointer" }}>Delete</button>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

export default function App() {
  const [data, setData]             = useState(() => { clearStorageBloat(); return loadData(); });
  const [view, setViewState]        = useState({ screen:"dashboard" });
  const [tab,  setTab]              = useState("dashboard");
  const device = useDeviceType();
  const [notifStatus, setNotifStatus] = useState(
    "Notification" in window ? Notification.permission : "unsupported"
  );
  const [syncStatus, setSyncStatus] = useState("syncing"); // syncing | synced | offline

  // On first load, pull from cloud and merge with local
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const cloud = await pullFromCloud();
        if (cancelled) return;
        const local = loadData();
        // Merge by id: whichever copy (cloud or local) has the newer updatedAt wins,
        // and anything previously synced but now missing from the cloud is treated as deleted.
        const merge = mergeRecords;
        const merged = {
          customers:   merge(cloud.customers,   local.customers || []),
          vehicles:    merge(cloud.vehicles,    local.vehicles || []),
          jobs:        merge(cloud.jobs,        local.jobs || []),
          invoices:    merge(cloud.invoices,    local.invoices || []),
          inspections: merge(cloud.inspections, local.inspections || []),
          communications: merge(cloud.communications, local.communications || []),
          settings: merge(cloud.settings, local.settings || []),
          technicians: local.technicians || [],
        };
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        setData(merged);
        // Push the merged result (including any local-newer records) back up
        pushToCloud(merged).catch(() => {});
        setSyncStatus("synced");
      } catch (e) {
        if (!cancelled) setSyncStatus("offline");
      }
    })();
    return () => { cancelled = true; };
  }, []);

  // Live updates: when any device changes data, refresh from cloud automatically
  useEffect(() => {
    const channel = supabase
      .channel("crm-changes")
      .on("postgres_changes", { event: "*", schema: "public" }, async (payload) => {
        if (SAVING_IN_PROGRESS) return; // don't interfere with an active save
        try {
          // If this is a DELETE event, tombstone that exact id so it's removed everywhere
          if (payload?.eventType === "DELETE" && payload?.old?.id) {
            addTombstone(payload.old.id);
          }
          const cloud = await pullFromCloud();
          const local = loadData();
          // Cloud is authoritative for anything it has. Local-only records are kept only
          // if genuinely new (never uploaded) — see mergeRecords for the full logic.
          const merge = mergeRecords;
          const merged = {
            customers: merge(cloud.customers, local.customers || []),
            vehicles:  merge(cloud.vehicles,  local.vehicles || []),
            jobs:      merge(cloud.jobs,      local.jobs || []),
            invoices:  merge(cloud.invoices,  local.invoices || []),
            mileage:   merge(cloud.mileage,   local.mileage || []),
            inspections: merge(cloud.inspections, local.inspections || []),
            communications: merge(cloud.communications, local.communications || []),
          settings: merge(cloud.settings, local.settings || []),
            technicians: local.technicians || [],
          };
          localStorage.setItem(DB_KEY, JSON.stringify(merged));
          setData(merged);
        } catch {}
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  // Background photo uploader: finds photos saved offline (pending) and uploads
  // them to storage when a connection is available, then swaps in the cloud URL.
  useEffect(() => {
    const uploadPending = async () => {
      if (SAVING_IN_PROGRESS) return;
      const d = loadData();
      let changed = false;
      for (const job of d.jobs || []) {
        for (const key of ["photosBefore", "photosAfter"]) {
          const arr = job[key] || [];
          for (let i = 0; i < arr.length; i++) {
            const p = arr[i];
            if (p && p.pending && !p.url) {
              try {
                const { url, path } = await uploadPhoto(p.pending, job.id);
                arr[i] = { id: p.id, url, path };
                changed = true;
              } catch {
                // still no signal — leave as pending, try again next time
              }
            }
          }
        }
      }
      if (changed) {
        localStorage.setItem(DB_KEY, JSON.stringify(d));
        setData(d);
        pushChangedOnly(d).catch(() => {});
      }
    };
    uploadPending(); // run on load
    const interval = setInterval(uploadPending, 30000); // and every 30s
    return () => clearInterval(interval);
  }, []);

  // When the connection comes back, immediately push any pending (offline-created) records
  useEffect(() => {
    const onBackOnline = () => {
      const d = loadData();
      pushChangedOnly(d).catch(() => {});
    };
    window.addEventListener("online", onBackOnline);
    return () => window.removeEventListener("online", onBackOnline);
  }, []);

  // Polling fallback: every 20s, re-check the cloud and drop anything deleted elsewhere.
  // This catches deletes that realtime doesn't reliably broadcast.
  useEffect(() => {
    const interval = setInterval(async () => {
      if (SAVING_IN_PROGRESS) return;
      try {
        const cloud = await pullFromCloud();
        const local = loadData();
        const merge = mergeRecords;
        const merged = {
          customers: merge(cloud.customers, local.customers || []),
          vehicles:  merge(cloud.vehicles,  local.vehicles || []),
          jobs:      merge(cloud.jobs,      local.jobs || []),
          invoices:  merge(cloud.invoices,  local.invoices || []),
          mileage:   merge(cloud.mileage,   local.mileage || []),
          inspections: merge(cloud.inspections, local.inspections || []),
          communications: merge(cloud.communications, local.communications || []),
          settings: merge(cloud.settings, local.settings || []),
          technicians: local.technicians || [],
        };
        const after = merged.customers.length + merged.jobs.length + merged.vehicles.length + merged.invoices.length + merged.inspections.length + merged.communications.length + merged.settings.length;
        localStorage.setItem(DB_KEY, JSON.stringify(merged));
        // Push any local records that haven't been uploaded yet (e.g. created offline)
        pushChangedOnly(merged).catch(() => {});
        // Only re-render if something actually changed, to avoid disrupting typing
        setData(prev => {
          const prevCount = (prev.customers?.length||0)+(prev.jobs?.length||0)+(prev.vehicles?.length||0)+(prev.invoices?.length||0)+(prev.inspections?.length||0)+(prev.communications?.length||0)+(prev.settings?.length||0);
          if (prevCount !== after) return merged;
          return prev;
        });
      } catch {}
    }, 20000);
    return () => clearInterval(interval);
  }, []);

  const setView = useCallback((v) => {
    setViewState(v);
    if (["dashboard","customers","jobs","invoices","calendar"].includes(v.screen)) setTab(v.screen);
    setData(loadData());
  }, []);

  useEffect(() => { setData(loadData()); }, [tab]);

  // Schedule notifications whenever data changes
  useEffect(() => {
    if (notifStatus === "granted") scheduleNotifications(data);
  }, [data, notifStatus]);

  // Re-schedule at midnight for the new day
  useEffect(() => {
    const now = new Date();
    const midnight = new Date();
    midnight.setHours(24, 0, 0, 0);
    const msToMidnight = midnight - now;
    const t = setTimeout(() => {
      const fresh = loadData();
      setData(fresh);
    }, msToMidnight);
    return () => clearTimeout(t);
  }, []);

  async function requestNotifications() {
    if (!("Notification" in window)) return;
    const result = await Notification.requestPermission();
    setNotifStatus(result);
    if (result === "granted") {
      scheduleNotifications(data);
      sendNotification("✅ Notifications enabled", "You'll get alerts for today's jobs");
    }
  }

  const tabs = [
    { id:"dashboard", icon:"dashboard", label:"Home" },
    { id:"jobs",      icon:"jobs",      label:"Jobs" },
    { id:"calendar",  icon:"calendar",  label:"Calendar" },
    { id:"customers", icon:"customers", label:"Customers" },
    { id:"invoices",  icon:"invoices",  label:"Invoices" },
  ];

  return (
    <div className="crm-shell" style={{ fontFamily:"'Inter',system-ui,sans-serif", background:"#F8FAFC", minHeight:"100vh", margin:"0 auto" }}>
      <ResponsiveStyles device={device} />
      {/* Header */}
      <div style={{ background:"#1E3A5F", padding: device==="phone" ? "14px 18px" : "12px 18px", position:"sticky", top:0, zIndex:50, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:12 }}>
          {!["dashboard","customers","jobs","invoices","calendar"].includes(view.screen) && (
            <button onClick={() => setView({ screen:tab })} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:8, padding:"8px 12px", color:"#fff", cursor:"pointer", fontSize:22 }}>‹</button>
          )}
          <img src="/logo.png" alt="Logo" style={{ height:44, width:44, objectFit:"contain", borderRadius:8, background:"#fff", padding:2 }} />
          <div>
            <div style={{ fontSize: device==="phone" ? 17 : 16, fontWeight:800, color:"#fff", letterSpacing:"-0.02em", lineHeight:1.2 }}>Windscreen Repairs Bristol</div>
            <div style={{ fontSize:11, color:"#93C5FD", fontWeight:500, letterSpacing:"0.06em", textTransform:"uppercase" }}>Job Management</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {notifStatus !== "unsupported" && (
            <button onClick={notifStatus === "granted" ? undefined : requestNotifications}
              title={notifStatus === "granted" ? "Notifications on" : "Tap to enable alerts"}
              style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:8, padding:"8px 11px", cursor: notifStatus === "granted" ? "default" : "pointer", fontSize:20, lineHeight:1 }}>
              {notifStatus === "granted" ? "🔔" : "🔕"}
            </button>
          )}
          <div style={{ width:10, height:10, borderRadius:"50%",
            background: syncStatus === "synced" ? "#22C55E" : syncStatus === "syncing" ? "#F59E0B" : "#9CA3AF",
            boxShadow: syncStatus === "synced" ? "0 0 6px #22C55E" : "none" }}
            title={syncStatus === "synced" ? "Synced to cloud" : syncStatus === "syncing" ? "Syncing…" : "Offline — saved locally"} />
        </div>
      </div>

      {/* Content */}
      <div style={{ padding:"16px 16px 110px" }}>
        {view.screen==="dashboard"      && <Dashboard      data={data} setView={setView} notifStatus={notifStatus} requestNotifications={requestNotifications} />}
        {view.screen==="customers"      && <CustomersList  data={data} setView={setView} />}
        {view.screen==="customerDetail" && <CustomerDetail data={data} id={view.id} setView={setView} />}
        {view.screen==="vehicleDetail"  && <VehicleDetail  data={data} id={view.id} customerId={view.customerId} setView={setView} />}
        {view.screen==="jobs"           && <JobsList       data={data} setView={setView} initialFilter={view.filter} />}
        {view.screen==="calendar"       && <CalendarView   data={data} setView={setView} device={device} />}
        {view.screen==="reports"        && <ReportsView    data={data} />}
        {view.screen==="settings"       && <SettingsView   data={data} setView={setView} />}
        {view.screen==="mileage"        && <MileageView    data={data} setView={setView} />}
        {view.screen==="jobDetail"      && <JobDetail      data={data} id={view.id} setView={setView} />}
        {view.screen==="newJob"         && <JobsList       data={data} setView={setView} />}
        {view.screen==="invoices"       && <InvoicesList   data={data} setView={setView} initialFilter={view.filter} />}
        {view.screen==="inspections"       && <InspectionsList data={data} setView={setView} />}
        {view.screen==="newInspection"     && <InspectionForm  data={data} setView={setView} prefillCustomerId={view.prefillCustomerId} />}
        {view.screen==="inspectionDetail"  && <InspectionDetail data={data} id={view.id} setView={setView} />}
      </div>

      {view.screen==="newJob" && <JobForm data={data} prefill={view.prefill} onClose={() => setView({ screen:"jobs" })} />}

      {/* Bottom Nav */}
      <div className="crm-shell" style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", background:"#fff", borderTop:"1px solid #E5E7EB", display:"flex", zIndex:50 }}>
        {tabs.map(t => {
          const active = tab===t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setView({ screen:t.id }); }}
              style={{ flex:1, padding: device==="phone" ? "14px 0 18px" : "12px 0 14px", background:"transparent", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:4 }}>
              <Icon name={t.icon} size={device==="phone" ? 26 : 22} color={active?"#1E3A5F":"#9CA3AF"} />
              <span style={{ fontSize: device==="phone" ? 12 : 11, fontWeight:600, color:active?"#1E3A5F":"#9CA3AF", letterSpacing:"0.04em" }}>{t.label}</span>
              {active && <div style={{ width:18, height:2.5, borderRadius:99, background:"#F59E0B", marginTop:2 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

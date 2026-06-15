import { useState, useEffect, useCallback } from "react";
import { pullFromCloud, pushToCloud, pushOne, deleteRecord, supabase } from "./supabase";

const DB_KEY = "wscrm_data";

const STATUS_META = {
  Booked:        { color: "#2563EB", bg: "#EFF6FF" },
  "In Progress": { color: "#D97706", bg: "#FFFBEB" },
  Complete:      { color: "#059669", bg: "#ECFDF5" },
  Invoiced:      { color: "#7C3AED", bg: "#F5F3FF" },
  Paid:          { color: "#374151", bg: "#F9FAFB" },
};

const DAMAGE_TYPES    = ["Chip", "Crack", "Shatter", "Scratch", "Other"];
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

function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { customers: [], vehicles: [], jobs: [], invoices: [], technicians: [] };
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
      new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 12000)),
    ]);
  } catch (e) {
    // Saved locally even if cloud was slow/offline — will sync later. Continue.
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

// Compare against last-synced snapshot and push only changed/new records
async function pushChangedOnly(data) {
  let lastSynced = {};
  try { lastSynced = JSON.parse(localStorage.getItem("wscrm_lastsync") || "{}"); } catch {}

  const tables = [
    { name: "customers", key: "customers" },
    { name: "vehicles",  key: "vehicles"  },
    { name: "jobs",      key: "jobs"      },
    { name: "invoices",  key: "invoices"  },
  ];

  for (const t of tables) {
    const current = data[t.key] || [];
    const prev = lastSynced[t.key] || [];
    const prevById = {};
    prev.forEach(r => { prevById[r.id] = r; });

    for (const rec of current) {
      const old = prevById[rec.id];
      // Push only if new or changed
      if (!old || JSON.stringify(old) !== JSON.stringify(rec)) {
        try {
          await pushOne(t.name, rec);
        } catch (e) {
          // Skip this record if it fails (e.g. too big) but keep going with the rest
          console.warn("Sync skipped for", t.name, rec.id, e?.message);
        }
      }
    }
  }
  // Record this as the last successful sync
  localStorage.setItem("wscrm_lastsync", JSON.stringify(data));
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
  return <button style={{ ...base, ...v[variant], ...p, opacity:disabled?.5:1, ...extra }} onClick={onClick} disabled={disabled}>{children}</button>;
}
function Card({ children, onClick, style: extra }) {
  return <div onClick={onClick} style={{ background:"#fff", borderRadius:12, padding:"14px 16px", boxShadow:"0 1px 3px rgba(0,0,0,.07)", marginBottom:10, cursor:onClick?"pointer":"default", border:"1px solid #F3F4F6", ...extra }}>{children}</div>;
}
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position:"fixed", inset:0, background:"rgba(0,0,0,.45)", zIndex:100, display:"flex", alignItems:"flex-end", justifyContent:"center" }}>
      <div style={{ background:"#fff", borderRadius:"20px 20px 0 0", width:"100%", maxWidth:520, maxHeight:"90vh", display:"flex", flexDirection:"column" }}>
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
  const openJobs = data.jobs.filter(j => !["Paid","Complete"].includes(j.status));
  const unpaidInvoices = data.invoices.filter(i => !i.paid);
  const unpaidTotal = unpaidInvoices.reduce((s,i) => s + (parseFloat(i.total)||0), 0);

  const StatCard = ({ label, value, color, sub }) => (
    <div style={{ background:"#fff", borderRadius:12, padding:16, border:"1px solid #F3F4F6", boxShadow:"0 1px 3px rgba(0,0,0,.07)", flex:1, minWidth:100 }}>
      <div style={{ fontSize:26, fontWeight:800, color }}>{value}</div>
      <div style={{ fontSize:12, color:"#6B7280", fontWeight:600, marginTop:2 }}>{label}</div>
      {sub && <div style={{ fontSize:11, color:"#9CA3AF", marginTop:2 }}>{sub}</div>}
    </div>
  );

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
        <StatCard label="Today's Jobs" value={todayJobs.length} color="#1E3A5F" />
        <StatCard label="Open Jobs" value={openJobs.length} color="#D97706" />
        <StatCard label="Outstanding" value={`£${unpaidTotal.toFixed(0)}`} color="#059669" sub={`${unpaidInvoices.length} invoices`} />
      </div>
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

      <div style={{ marginTop:24, paddingTop:16, borderTop:"1px solid #E5E7EB" }}>
        <h3 style={{ fontSize:13, fontWeight:700, color:"#6B7280", margin:"0 0 10px", textTransform:"uppercase", letterSpacing:"0.05em" }}>Tools</h3>
        <div style={{ display:"flex", flexDirection:"column", gap:8 }}>
          <Btn variant="ghost" onClick={exportBackup} style={{ width:"100%", justifyContent:"center" }}>💾 Download Backup</Btn>
          <Btn variant="ghost" onClick={cleanupOldPhotos} style={{ width:"100%", justifyContent:"center" }}>🗑️ Clear Photos Over 1 Year Old</Btn>
        </div>
      </div>
    </div>
  );
}

// ── Customers List ────────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);
  const filtered = data.customers.filter(c =>
    c.company?.toLowerCase().includes(search.toLowerCase()) ||
    c.companyContact?.toLowerCase().includes(search.toLowerCase()) ||
    c.phone?.includes(search) ||
    c.postcode?.toLowerCase().includes(search.toLowerCase()) ||
    c.town?.toLowerCase().includes(search.toLowerCase())
  );
  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Customers</h2>
        <Btn size="sm" onClick={() => setShowForm(true)}><Icon name="plus" size={14} /> Add</Btn>
      </div>
      <input style={{ ...inputStyle, marginBottom:12 }} placeholder="Search name, phone, town, postcode…" value={search} onChange={e => setSearch(e.target.value)} />
      {filtered.length === 0 && <p style={{ color:"#9CA3AF", textAlign:"center", fontSize:14 }}>No customers found</p>}
      {filtered.map(c => (
        <Card key={c.id} onClick={() => setView({ screen:"customerDetail", id:c.id })}>
          <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{c.company || c.companyContact || "No name"}</div>
          {c.companyContact && <div style={{ fontSize:13, color:"#1E3A5F", fontWeight:600 }}>{c.companyContact}</div>}
          <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{c.phone}{c.town ? ` · ${c.town}` : ""}{c.postcode ? ` · ${c.postcode}` : ""}</div>
          {c.email && <div style={{ fontSize:12, color:"#9CA3AF" }}>{c.email}</div>}
        </Card>
      ))}
      {showForm && <CustomerForm data={data} onClose={() => setShowForm(false)} setView={setView} />}
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

  async function save() {
    if (!company) return;
    const customers = [...data.customers];
    const rec = { company, companyContact, phone, email, address1, address2, town, county, postcode, notes };
    if (editCustomer) {
      const idx = customers.findIndex(c => c.id === editCustomer.id);
      customers[idx] = { ...editCustomer, ...rec };
    } else {
      customers.push({ id:uid(), ...rec, createdAt:todayISO() });
    }
    await saveAndReload({ ...data, customers });
  }

  return (
    <Modal title={editCustomer ? "Edit Customer" : "New Customer"} onClose={onClose}>
      <div style={{ marginTop:8 }} />
      <Field label="Company Name" required><Input value={company} onChange={setCompany} placeholder="Acme Ltd" /></Field>
      <Field label="Company Contact"><Input value={companyContact} onChange={setCompanyContact} placeholder="Contact name at company" /></Field>
      <Field label="Phone"><Input value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" /></Field>
      <Field label="Email"><Input value={email} onChange={setEmail} placeholder="jane@email.com" type="email" /></Field>
      <Field label="Address Line 1"><Input value={address1} onChange={setAddress1} placeholder="12 High Street" /></Field>
      <Field label="Address Line 2"><Input value={address2} onChange={setAddress2} placeholder="Clifton" /></Field>
      <Field label="Town / City"><Input value={town} onChange={setTown} placeholder="Bristol" /></Field>
      <Field label="County"><Input value={county} onChange={setCounty} placeholder="Avon" /></Field>
      <Field label="Postcode"><Input value={postcode} onChange={setPostcode} placeholder="BS1 1AA" /></Field>
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!company}>Save Customer</Btn>
    </Modal>
  );
}

// ── Customer Detail ───────────────────────────────────────────────────────────
function CustomerDetail({ data, id, setView }) {
  const customer = data.customers.find(c => c.id === id);
  const vehicles = data.vehicles.filter(v => v.customerId === id);
  const jobs     = data.jobs.filter(j => j.customerId === id).sort((a,b) => b.date.localeCompare(a.date));
  const [showEdit, setShowEdit]       = useState(false);
  const [showVehicle, setShowVehicle] = useState(false);
  if (!customer) return <p>Not found</p>;

  const addrParts = [customer.address1, customer.address2, customer.town, customer.county, customer.postcode].filter(Boolean);

  async function deleteCustomer() {
    if (!window.confirm("Delete this customer?")) return;
    await saveAndReload({ ...data, customers: data.customers.filter(c => c.id !== id) });
    deleteRecord("customers", id).catch(() => {});
    setView({ screen:"customers" });
  }

  return (
    <div>
      <div style={{ marginBottom:16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen:"customers" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
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
        <div style={{ display:"flex", gap:8, marginTop:12, flexWrap:"wrap" }}>
          {customer.phone && (
            <a href={`tel:${customer.phone}`} style={{ textDecoration:"none" }}>
              <Btn size="sm" variant="primary">📞 Call</Btn>
            </a>
          )}
          {customer.email && (
            <a href={`mailto:${customer.email}`} style={{ textDecoration:"none" }}>
              <Btn size="sm" variant="ghost">✉️ Email</Btn>
            </a>
          )}
          <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)}><Icon name="edit" size={13} /> Edit</Btn>
          <Btn size="sm" variant="danger" onClick={deleteCustomer}><Icon name="trash" size={13} /> Delete</Btn>
        </div>
      </Card>

      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", margin:"16px 0 8px" }}>
        <h3 style={{ margin:0, fontSize:14, fontWeight:700, color:"#374151", textTransform:"uppercase", letterSpacing:"0.05em" }}>Vehicles</h3>
        <Btn size="sm" onClick={() => setShowVehicle(true)}><Icon name="plus" size={13} /> Add</Btn>
      </div>
      {vehicles.map(v => (
        <Card key={v.id}>
          <div style={{ fontWeight:600, fontSize:14 }}>{v.make} {v.model}</div>
          <div style={{ fontSize:13, color:"#6B7280" }}>{v.reg}</div>
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
function VehicleForm({ data, customerId, onClose }) {
  const [make,  setMake]  = useState("");
  const [model, setModel] = useState("");
  const [reg,   setReg]   = useState("");

  async function save() {
    if (!reg) return;
    const vehicles = [...data.vehicles, { id:uid(), customerId, make, model, reg:reg.toUpperCase() }];
    await saveAndReload({ ...data, vehicles });
  }
  return (
    <Modal title="Add Vehicle" onClose={onClose}>
      <Field label="Registration" required><Input value={reg} onChange={setReg} placeholder="AB12 CDE" /></Field>
      <Field label="Make"><Input value={make} onChange={setMake} placeholder="Ford" /></Field>
      <Field label="Model"><Input value={model} onChange={setModel} placeholder="Focus" /></Field>
      <Btn onClick={save} style={{ width:"100%", justifyContent:"center" }} disabled={!reg}>Save Vehicle</Btn>
    </Modal>
  );
}

// ── Jobs List ─────────────────────────────────────────────────────────────────
function JobsList({ data, setView }) {
  const [filter, setFilter] = useState("Open");
  const filtered = data.jobs.filter(j => {
    if (filter==="Today")    return j.date === todayISO();
    if (filter==="Open")     return !["Paid"].includes(j.status);
    if (filter==="Complete") return ["Complete","Paid"].includes(j.status);
    return true;
  }).sort((a,b) => b.date.localeCompare(a.date));

  const pill = (active) => ({ padding:"6px 14px", borderRadius:99, fontSize:13, fontWeight:600, cursor:"pointer", border:"none", background:active?"#1E3A5F":"#F3F4F6", color:active?"#fff":"#6B7280", fontFamily:"inherit" });

  return (
    <div>
      <div style={{ display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:14 }}>
        <h2 style={{ margin:0, fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Jobs</h2>
        <Btn size="sm" onClick={() => setView({ screen:"newJob" })}><Icon name="plus" size={14} /> New</Btn>
      </div>
      <div style={{ display:"flex", gap:6, marginBottom:14, overflowX:"auto", paddingBottom:4 }}>
        {["Today","Open","Complete","All"].map(f => <button key={f} style={pill(filter===f)} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      {filtered.length === 0 && <p style={{ color:"#9CA3AF", textAlign:"center", fontSize:14 }}>No jobs found</p>}
      {filtered.map(job => {
        const cust = data.customers.find(c => c.id === job.customerId);
        const veh  = data.vehicles.find(v => v.id === job.vehicleId);
        return (
          <Card key={job.id} onClick={() => setView({ screen:"jobDetail", id:job.id })}>
            <div style={{ display:"flex", justifyContent:"space-between", alignItems:"flex-start" }}>
              <div style={{ flex:1, minWidth:0 }}>
                <div style={{ fontWeight:700, fontSize:15, color:"#111827" }}>{cust?.company || cust?.companyContact || job.driverName || "No Company"}</div>
                {job.driverName && cust?.company && <div style={{ fontSize:13, color:"#374151", fontWeight:600 }}>Driver: {job.driverName}</div>}
                <div style={{ fontSize:13, color:"#6B7280", marginTop:2 }}>{veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "No vehicle"}</div>
                <div style={{ fontSize:13, color:"#6B7280" }}>{job.jobType} · {fmtDate(job.date)}{job.jobTime ? ` · ${job.jobTime}` : ""}</div>
                {job.locAddress1 && <div style={{ fontSize:12, color:"#9CA3AF", marginTop:2 }}>📍 {[job.locAddress1, job.locTown, job.locPostcode].filter(Boolean).join(", ")}</div>}
                {(job.photosBefore?.length > 0 || job.photosAfter?.length > 0) && <div style={{ fontSize:11, color:"#6B7280", marginTop:3 }}>📷 {(job.photosBefore?.length||0)} before · {(job.photosAfter?.length||0)} after</div>}
                {job.adasRequired && <span style={{ fontSize:11, background:"#FEF3C7", color:"#92400E", padding:"1px 7px", borderRadius:99, fontWeight:600 }}>ADAS</span>}
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

function PhotoUploader({ label, photos = [], onChange }) {
  const [loading, setLoading] = useState(false);

  async function handleFiles(e) {
    const files = Array.from(e.target.files);
    if (!files.length) return;
    setLoading(true);
    try {
      const newPhotos = await Promise.all(files.map(async file => ({
        id: uid(),
        data: await resizeImage(file),
        name: file.name,
        ts: new Date().toISOString()
      })));
      onChange([...photos, ...newPhotos]);
    } finally {
      setLoading(false);
      e.target.value = "";
    }
  }

  function remove(id) {
    onChange(photos.filter(p => p.id !== id));
  }

  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display:"block", fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>{label}</label>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8, marginBottom:8 }}>
        {photos.map(p => (
          <div key={p.id} style={{ position:"relative", width:80, height:80 }}>
            <img src={p.data} alt="job" style={{ width:80, height:80, objectFit:"cover", borderRadius:8, border:"1.5px solid #E5E7EB" }} />
            <button onClick={() => remove(p.id)} style={{ position:"absolute", top:-6, right:-6, background:"#EF4444", border:"none", borderRadius:"50%", width:20, height:20, color:"#fff", fontSize:12, cursor:"pointer", display:"flex", alignItems:"center", justifyContent:"center", lineHeight:1 }}>×</button>
          </div>
        ))}
        <label style={{ width:80, height:80, border:`2px dashed ${loading ? "#93C5FD" : "#D1D5DB"}`, borderRadius:8, display:"flex", flexDirection:"column", alignItems:"center", justifyContent:"center", cursor:"pointer", color: loading ? "#3B82F6" : "#9CA3AF", fontSize:11, fontWeight:600, gap:4, background: loading ? "#EFF6FF" : "transparent" }}>
          <span style={{ fontSize:24, lineHeight:1 }}>{loading ? "⏳" : "📷"}</span>
          {loading ? "Loading…" : "Add"}
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
  return (
    <div style={{ marginBottom:14 }}>
      <div style={{ fontSize:12, fontWeight:600, color:"#6B7280", marginBottom:6, textTransform:"uppercase", letterSpacing:"0.05em" }}>{label} ({photos.length})</div>
      <div style={{ display:"flex", flexWrap:"wrap", gap:8 }}>
        {photos.map(p => (
          <img key={p.id} src={p.data} alt="job" onClick={() => setLightbox(p.data)}
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
function JobForm({ data, onClose, editJob }) {
  const [customerId,    setCustomerId]    = useState(editJob?.customerId    || "");
  const [driverName,    setDriverName]    = useState(editJob?.driverName    || "");
  const [vehicleId,     setVehicleId]     = useState(editJob?.vehicleId     || "");
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
    const rec = { customerId, driverName, vehicleId, date, jobTime, locAddress1, locAddress2, locTown, locCounty, locPostcode, jobType, damageType, damageSide, damagePosition, adasRequired, status, technicianId, notes, paymentType, insuranceCo, claimNo, photosBefore, photosAfter };
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
        <select style={{ ...inputStyle, appearance:"none" }} value={customerId} onChange={e => { setCustomerId(e.target.value); setVehicleId(""); }}>
          <option value="">Select customer…</option>
          {data.customers.map(c => <option key={c.id} value={c.id}>{c.company || c.companyContact || 'Unnamed'}</option>)}
        </select>
      </Field>
      <Field label="Driver / Customer Name"><Input value={driverName} onChange={setDriverName} placeholder="Name of the driver or car owner" /></Field>
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
        <div style={{ flex:1 }}><Field label="Job Type"><Select value={jobType} onChange={setJobType} options={JOB_TYPES} /></Field></div>
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}><Field label="Damage Type"><Select value={damageType} onChange={setDamageType} options={DAMAGE_TYPES} /></Field></div>
        <div style={{ flex:1 }}><Field label="Status"><Select value={status} onChange={setStatus} options={Object.keys(STATUS_META)} /></Field></div>
      </div>
      <div style={{ display:"flex", gap:10 }}>
        <div style={{ flex:1 }}>
          <Field label="Damage Side">
            <Select value={damageSide} onChange={setDamageSide} options={["Driver Side","Passenger Side"]} placeholder="Select…" />
          </Field>
        </div>
        <div style={{ flex:1 }}>
          <Field label="Damage Position">
            <Select value={damagePosition} onChange={setDamagePosition} options={["Top","Bottom","Left","Right"]} placeholder="Select…" />
          </Field>
        </div>
      </div>
      <Field label="ADAS Calibration">
        <label style={{ display:"flex", alignItems:"center", gap:8, cursor:"pointer", fontSize:14, color:"#374151" }}>
          <input type="checkbox" checked={adasRequired} onChange={e => setAdasRequired(e.target.checked)} style={{ width:16, height:16 }} />
          Required
        </label>
      </Field>
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
      <PhotoUploader label="Before Photos" photos={photosBefore} onChange={setPhotosBefore} />
      <PhotoUploader label="After Photos"  photos={photosAfter}  onChange={setPhotosAfter}  />
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
        ${photos.map(p => `<img src="${p.data}" style="width:160px;height:120px;object-fit:cover;border-radius:8px;border:1px solid #E5E7EB;" />`).join("")}
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
      ${row("Job Type", job.jobType)}
      ${row("Damage", job.damageType)}
      ${row("Position", [job.damageSide, job.damagePosition].filter(Boolean).join(" · "))}
      ${job.adasRequired ? row("ADAS", "Required & Completed") : ""}
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

  const title    = `${job.jobType} — ${company}${driver ? ` (${driver})` : ""}${car ? ` · ${car}` : ""}`;
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
  if (!job) return <p>Not found</p>;

  const customer   = data.customers.find(c => c.id === job.customerId);
  const vehicle    = data.vehicles.find(v => v.id === job.vehicleId);
  const technician = data.technicians.find(t => t.id === job.technicianId);
  const invoice    = data.invoices.find(i => i.jobId === id);

  const nextStatuses = { "Booked":["In Progress"], "In Progress":["Complete"], "Complete":["Invoiced"], "Invoiced":["Paid"], "Paid":[] };

  async function updateStatus(s) {
    await saveAndReload({ ...data, jobs: data.jobs.map(j => j.id===id ? {...j,status:s} : j) });
  }
  async function deleteJob() {
    if (!window.confirm("Delete this job?")) return;
    await saveAndReload({ ...data, jobs: data.jobs.filter(j => j.id!==id) });
    deleteRecord("jobs", id).catch(() => {});
    setView({ screen:"jobs" });
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
        <Row label="Driver"       value={job.driverName || null} />
        <Row label="Phone"        value={customer?.phone} />
        <Row label="Address"      value={[customer?.address1, customer?.town, customer?.postcode].filter(Boolean).join(", ")} />
        <Row label="Vehicle"      value={vehicle ? `${vehicle.make} ${vehicle.model} · ${vehicle.reg}` : null} />
        <Row label="Date"         value={fmtDate(job.date)} />
        <Row label="Time"         value={job.jobTime || null} />
        <Row label="Location"     value={[job.locAddress1, job.locAddress2, job.locTown, job.locCounty, job.locPostcode].filter(Boolean).join(", ") || null} />
        <Row label="Job Type"     value={job.jobType} />
        <Row label="Damage"       value={job.damageType} />
        <Row label="Damage Side"  value={job.damageSide || null} />
        <Row label="Damage Pos."  value={job.damagePosition || null} />
        <Row label="ADAS"         value={job.adasRequired ? "Required" : null} />
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
            {!invoice.paid && (
              <Btn size="sm" variant="ghost" onClick={async () => {
                const invoices = data.invoices.map(i => i.id===invoice.id ? {...i,paid:true,paidDate:todayISO()} : i);
                const jobs = data.jobs.map(j => j.id===id ? {...j,status:"Paid"} : j);
                await saveAndReload({ ...data, invoices, jobs });
              }}>Mark Paid</Btn>
            )}
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
    </div>
  );
}

// ── Invoice Form ──────────────────────────────────────────────────────────────
function InvoiceForm({ data, jobId, onClose }) {
  const [labour, setLabour] = useState("");
  const [parts,  setParts]  = useState("");
  const [vat,    setVat]    = useState(true);
  const subtotal = (parseFloat(labour)||0) + (parseFloat(parts)||0);
  const total    = vat ? subtotal * 1.2 : subtotal;

  async function save() {
    const invoices = [...data.invoices, { id:uid(), jobId, labour, parts, vat, total:total.toFixed(2), paid:false, createdAt:todayISO() }];
    const jobs     = data.jobs.map(j => j.id===jobId ? {...j,status:"Invoiced"} : j);
    await saveAndReload({ ...data, invoices, jobs });
  }

  return (
    <Modal title="Create Invoice" onClose={onClose}>
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
function InvoicesList({ data, setView }) {
  const [filter, setFilter] = useState("Unpaid");
  const enriched = data.invoices.map(inv => {
    const job      = data.jobs.find(j => j.id === inv.jobId);
    const customer = job ? data.customers.find(c => c.id === job.customerId) : null;
    return { ...inv, job, customer };
  }).filter(inv => {
    if (filter==="Unpaid") return !inv.paid;
    if (filter==="Paid")   return  inv.paid;
    return true;
  }).sort((a,b) => b.createdAt?.localeCompare(a.createdAt));

  const total = enriched.reduce((s,i) => s+(parseFloat(i.total)||0), 0);
  const pill  = (active) => ({ padding:"6px 14px", borderRadius:99, fontSize:13, fontWeight:600, cursor:"pointer", border:"none", background:active?"#1E3A5F":"#F3F4F6", color:active?"#fff":"#6B7280", fontFamily:"inherit" });

  return (
    <div>
      <h2 style={{ margin:"0 0 14px", fontSize:20, fontWeight:800, color:"#1E3A5F" }}>Invoices</h2>
      <div style={{ display:"flex", gap:6, marginBottom:14 }}>
        {["Unpaid","Paid","All"].map(f => <button key={f} style={pill(filter===f)} onClick={() => setFilter(f)}>{f}</button>)}
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
              <div style={{ fontSize:12, color:"#9CA3AF" }}>{fmtDate(inv.createdAt)} · {inv.job?.jobType}</div>
            </div>
            <div style={{ textAlign:"right" }}>
              <div style={{ fontWeight:800, fontSize:16, color:inv.paid?"#059669":"#1E3A5F" }}>£{parseFloat(inv.total).toFixed(2)}</div>
              <div style={{ fontSize:11, color:inv.paid?"#059669":"#D97706", fontWeight:600 }}>{inv.paid?"Paid":"Unpaid"}</div>
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
    j.date === today && ["Booked", "In Progress"].includes(j.status)
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

export default function App() {
  const [data, setData]             = useState(loadData);
  const [view, setViewState]        = useState({ screen:"dashboard" });
  const [tab,  setTab]              = useState("dashboard");
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
        // Merge by id: whichever copy (cloud or local) has the newer updatedAt wins.
        // This protects local edits made while the cloud still had the old version.
        const merge = (cloudArr, localArr) => {
          const byId = {};
          (cloudArr || []).forEach(x => { byId[x.id] = x; });
          (localArr || []).forEach(x => {
            const existing = byId[x.id];
            if (!existing) { byId[x.id] = x; return; }
            const localTime = x.updatedAt || 0;
            const cloudTime = existing.updatedAt || 0;
            byId[x.id] = localTime >= cloudTime ? x : existing;
          });
          return Object.values(byId);
        };
        const merged = {
          customers:   merge(cloud.customers,   local.customers || []),
          vehicles:    merge(cloud.vehicles,    local.vehicles || []),
          jobs:        merge(cloud.jobs,        local.jobs || []),
          invoices:    merge(cloud.invoices,    local.invoices || []),
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
      .on("postgres_changes", { event: "*", schema: "public" }, async () => {
        if (SAVING_IN_PROGRESS) return; // don't interfere with an active save
        try {
          const cloud = await pullFromCloud();
          const local = loadData();
          // Merge newest-wins (same logic as initial load)
          const merge = (cloudArr, localArr) => {
            const byId = {};
            (cloudArr || []).forEach(x => { byId[x.id] = x; });
            (localArr || []).forEach(x => {
              const ex = byId[x.id];
              if (!ex) { byId[x.id] = x; return; }
              byId[x.id] = (x.updatedAt || 0) >= (ex.updatedAt || 0) ? x : ex;
            });
            return Object.values(byId);
          };
          const merged = {
            customers: merge(cloud.customers, local.customers || []),
            vehicles:  merge(cloud.vehicles,  local.vehicles || []),
            jobs:      merge(cloud.jobs,      local.jobs || []),
            invoices:  merge(cloud.invoices,  local.invoices || []),
            technicians: local.technicians || [],
          };
          localStorage.setItem(DB_KEY, JSON.stringify(merged));
          localStorage.setItem("wscrm_lastsync", JSON.stringify(merged));
          setData(merged);
        } catch {}
      })
      .subscribe();
    return () => { supabase.removeChannel(channel); };
  }, []);

  const setView = useCallback((v) => {
    setViewState(v);
    if (["dashboard","customers","jobs","invoices"].includes(v.screen)) setTab(v.screen);
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
    { id:"customers", icon:"customers", label:"Customers" },
    { id:"invoices",  icon:"invoices",  label:"Invoices" },
  ];

  return (
    <div style={{ fontFamily:"'Inter',system-ui,sans-serif", background:"#F8FAFC", minHeight:"100vh", maxWidth:520, margin:"0 auto" }}>
      {/* Header */}
      <div style={{ background:"#1E3A5F", padding:"10px 16px", position:"sticky", top:0, zIndex:50, display:"flex", alignItems:"center", justifyContent:"space-between" }}>
        <div style={{ display:"flex", alignItems:"center", gap:10 }}>
          {!["dashboard","customers","jobs","invoices"].includes(view.screen) && (
            <button onClick={() => setView({ screen:tab })} style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:8, padding:"4px 8px", color:"#fff", cursor:"pointer", fontSize:18 }}>‹</button>
          )}
          <img src="/logo.png" alt="Logo" style={{ height:36, width:36, objectFit:"contain", borderRadius:6, background:"#fff", padding:2 }} />
          <div>
            <div style={{ fontSize:15, fontWeight:800, color:"#fff", letterSpacing:"-0.02em", lineHeight:1.2 }}>Windscreen Repairs Bristol</div>
            <div style={{ fontSize:10, color:"#93C5FD", fontWeight:500, letterSpacing:"0.06em", textTransform:"uppercase" }}>Job Management</div>
          </div>
        </div>
        <div style={{ display:"flex", alignItems:"center", gap:8 }}>
          {notifStatus !== "unsupported" && (
            <button onClick={notifStatus === "granted" ? undefined : requestNotifications}
              title={notifStatus === "granted" ? "Notifications on" : "Tap to enable alerts"}
              style={{ background:"rgba(255,255,255,.15)", border:"none", borderRadius:8, padding:"6px 8px", cursor: notifStatus === "granted" ? "default" : "pointer", fontSize:16, lineHeight:1 }}>
              {notifStatus === "granted" ? "🔔" : "🔕"}
            </button>
          )}
          <div style={{ width:8, height:8, borderRadius:"50%",
            background: syncStatus === "synced" ? "#22C55E" : syncStatus === "syncing" ? "#F59E0B" : "#9CA3AF",
            boxShadow: syncStatus === "synced" ? "0 0 6px #22C55E" : "none" }}
            title={syncStatus === "synced" ? "Synced to cloud" : syncStatus === "syncing" ? "Syncing…" : "Offline — saved locally"} />
        </div>
      </div>

      {/* Content */}
      <div style={{ padding:"16px 16px 90px" }}>
        {view.screen==="dashboard"      && <Dashboard      data={data} setView={setView} notifStatus={notifStatus} requestNotifications={requestNotifications} />}
        {view.screen==="customers"      && <CustomersList  data={data} setView={setView} />}
        {view.screen==="customerDetail" && <CustomerDetail data={data} id={view.id} setView={setView} />}
        {view.screen==="jobs"           && <JobsList       data={data} setView={setView} />}
        {view.screen==="jobDetail"      && <JobDetail      data={data} id={view.id} setView={setView} />}
        {view.screen==="newJob"         && <JobsList       data={data} setView={setView} />}
        {view.screen==="invoices"       && <InvoicesList   data={data} setView={setView} />}
      </div>

      {view.screen==="newJob" && <JobForm data={data} onClose={() => setView({ screen:"jobs" })} />}

      {/* Bottom Nav */}
      <div style={{ position:"fixed", bottom:0, left:"50%", transform:"translateX(-50%)", width:"100%", maxWidth:520, background:"#fff", borderTop:"1px solid #E5E7EB", display:"flex", zIndex:50 }}>
        {tabs.map(t => {
          const active = tab===t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setView({ screen:t.id }); }}
              style={{ flex:1, padding:"10px 0 12px", background:"transparent", border:"none", cursor:"pointer", display:"flex", flexDirection:"column", alignItems:"center", gap:3 }}>
              <Icon name={t.icon} size={20} color={active?"#1E3A5F":"#9CA3AF"} />
              <span style={{ fontSize:10, fontWeight:600, color:active?"#1E3A5F":"#9CA3AF", letterSpacing:"0.04em" }}>{t.label}</span>
              {active && <div style={{ width:16, height:2, borderRadius:99, background:"#F59E0B", marginTop:1 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

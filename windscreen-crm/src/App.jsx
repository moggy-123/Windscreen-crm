
import { useState, useEffect, useCallback } from "react";

// ── Palette & Design Tokens ──────────────────────────────────────────────────
// Deep navy + amber accent: professional, visible in bright outdoor light,
// evokes safety glass / automotive. Signature: status pill with colour-coded
// glass-chip icon as the one memorable element.

const DB_KEY = "wscrm_data";

const STATUS_META = {
  Booked:      { color: "#2563EB", bg: "#EFF6FF", label: "Booked" },
  "In Progress": { color: "#D97706", bg: "#FFFBEB", label: "In Progress" },
  Complete:    { color: "#059669", bg: "#ECFDF5", label: "Complete" },
  Invoiced:    { color: "#7C3AED", bg: "#F5F3FF", label: "Invoiced" },
  Paid:        { color: "#374151", bg: "#F9FAFB", label: "Paid" },
};

const DAMAGE_TYPES = ["Chip", "Crack", "Shatter", "Scratch", "Other"];
const GLASS_POSITIONS = ["Windscreen", "Side Window", "Rear Window", "Sunroof"];
const JOB_TYPES = ["Repair", "Replace"];
const PAYMENT_TYPES = ["Private", "Insurance"];

function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}

function today() {
  return new Date().toISOString().split("T")[0];
}

function loadData() {
  try {
    const raw = localStorage.getItem(DB_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { customers: [], vehicles: [], jobs: [], invoices: [], technicians: [] };
}

function saveData(data) {
  localStorage.setItem(DB_KEY, JSON.stringify(data));
}

// ── Icons (inline SVG) ───────────────────────────────────────────────────────
const Icon = ({ name, size = 18, color = "currentColor" }) => {
  const paths = {
    dashboard: "M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6",
    customers: "M17 20h5v-2a3 3 0 00-5.356-1.857M17 20H7m10 0v-2c0-.656-.126-1.283-.356-1.857M7 20H2v-2a3 3 0 015.356-1.857M7 20v-2c0-.656.126-1.283.356-1.857m0 0a5.002 5.002 0 019.288 0M15 7a3 3 0 11-6 0 3 3 0 016 0z",
    jobs: "M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2",
    invoices: "M9 14l6-6m-5.5.5h.01m4.99 5h.01M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16l3.5-2 3.5 2 3.5-2 3.5 2z",
    vehicles: "M19 9l-7 7-7-7",
    plus: "M12 4v16m8-8H4",
    back: "M15 19l-7-7 7-7",
    edit: "M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z",
    trash: "M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16",
    car: "M8 17h8M8 17l-1-5h10l-1 5M8 17H6l-2-5V9a1 1 0 011-1h14a1 1 0 011 1v3l-2 5h-2M8 12h8",
    check: "M5 13l4 4L19 7",
    warn: "M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z",
  };
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d={paths[name] || ""} />
    </svg>
  );
};

// ── Status Badge ─────────────────────────────────────────────────────────────
function StatusBadge({ status }) {
  const m = STATUS_META[status] || STATUS_META["Booked"];
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", gap: 4,
      padding: "2px 10px", borderRadius: 99, fontSize: 12, fontWeight: 600,
      color: m.color, background: m.bg, border: `1px solid ${m.color}33`,
    }}>
      {status}
    </span>
  );
}

// ── Form Fields ──────────────────────────────────────────────────────────────
function Field({ label, children, required }) {
  return (
    <div style={{ marginBottom: 14 }}>
      <label style={{ display: "block", fontSize: 12, fontWeight: 600, color: "#6B7280", marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>
        {label}{required && <span style={{ color: "#EF4444" }}> *</span>}
      </label>
      {children}
    </div>
  );
}

const inputStyle = {
  width: "100%", padding: "9px 12px", borderRadius: 8, border: "1.5px solid #E5E7EB",
  fontSize: 15, background: "#FAFAFA", boxSizing: "border-box", outline: "none",
  fontFamily: "inherit", color: "#111827",
};

function Input({ value, onChange, type = "text", placeholder, required }) {
  return <input style={inputStyle} type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} required={required} />;
}

function Select({ value, onChange, options, placeholder }) {
  return (
    <select style={{ ...inputStyle, appearance: "none", cursor: "pointer" }} value={value} onChange={e => onChange(e.target.value)}>
      {placeholder && <option value="">{placeholder}</option>}
      {options.map(o => <option key={o} value={o}>{o}</option>)}
    </select>
  );
}

// ── Button ───────────────────────────────────────────────────────────────────
function Btn({ children, onClick, variant = "primary", size = "md", disabled, style: extra }) {
  const base = { display: "inline-flex", alignItems: "center", gap: 6, borderRadius: 8, fontWeight: 600, cursor: disabled ? "not-allowed" : "pointer", border: "none", fontFamily: "inherit", transition: "opacity .15s" };
  const variants = {
    primary:  { background: "#1E3A5F", color: "#fff", padding: size === "sm" ? "6px 12px" : "10px 18px", fontSize: size === "sm" ? 13 : 14 },
    amber:    { background: "#F59E0B", color: "#fff", padding: size === "sm" ? "6px 12px" : "10px 18px", fontSize: size === "sm" ? 13 : 14 },
    ghost:    { background: "transparent", color: "#1E3A5F", padding: size === "sm" ? "6px 12px" : "10px 18px", fontSize: size === "sm" ? 13 : 14, border: "1.5px solid #1E3A5F" },
    danger:   { background: "#FEE2E2", color: "#DC2626", padding: size === "sm" ? "6px 12px" : "10px 18px", fontSize: size === "sm" ? 13 : 14 },
  };
  return <button style={{ ...base, ...variants[variant], opacity: disabled ? .5 : 1, ...extra }} onClick={onClick} disabled={disabled}>{children}</button>;
}

// ── Card ─────────────────────────────────────────────────────────────────────
function Card({ children, onClick, style: extra }) {
  return (
    <div onClick={onClick} style={{
      background: "#fff", borderRadius: 12, padding: "14px 16px",
      boxShadow: "0 1px 3px rgba(0,0,0,.07)", marginBottom: 10,
      cursor: onClick ? "pointer" : "default", border: "1px solid #F3F4F6",
      transition: "box-shadow .15s", ...extra,
    }}>{children}</div>
  );
}

// ── Modal ────────────────────────────────────────────────────────────────────
function Modal({ title, onClose, children }) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,.45)", zIndex: 100, display: "flex", alignItems: "flex-end", justifyContent: "center" }}>
      <div style={{ background: "#fff", borderRadius: "20px 20px 0 0", width: "100%", maxWidth: 520, maxHeight: "90vh", overflowY: "auto", padding: "20px 20px 32px" }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 18 }}>
          <h3 style={{ margin: 0, fontSize: 18, fontWeight: 700, color: "#111827" }}>{title}</h3>
          <button onClick={onClose} style={{ background: "#F3F4F6", border: "none", borderRadius: 99, width: 32, height: 32, cursor: "pointer", fontSize: 18, color: "#6B7280" }}>×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// SCREENS
// ═══════════════════════════════════════════════════════════════════════════

// ── Dashboard ────────────────────────────────────────────────────────────────
function Dashboard({ data, setView }) {
  const todayStr = today();
  const todayJobs = data.jobs.filter(j => j.date === todayStr);
  const openJobs = data.jobs.filter(j => !["Paid", "Complete"].includes(j.status));
  const unpaidInvoices = data.invoices.filter(i => !i.paid);
  const unpaidTotal = unpaidInvoices.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);

  const statCard = (label, value, color, sub) => (
    <div style={{ background: "#fff", borderRadius: 12, padding: "16px", border: "1px solid #F3F4F6", boxShadow: "0 1px 3px rgba(0,0,0,.07)", flex: 1, minWidth: 120 }}>
      <div style={{ fontSize: 26, fontWeight: 800, color, fontVariantNumeric: "tabular-nums" }}>{value}</div>
      <div style={{ fontSize: 12, color: "#6B7280", fontWeight: 600, marginTop: 2 }}>{label}</div>
      {sub && <div style={{ fontSize: 11, color: "#9CA3AF", marginTop: 2 }}>{sub}</div>}
    </div>
  );

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <h2 style={{ margin: 0, fontSize: 22, fontWeight: 800, color: "#1E3A5F" }}>Good day 👋</h2>
        <p style={{ margin: "4px 0 0", color: "#6B7280", fontSize: 14 }}>{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long" })}</p>
      </div>

      <div style={{ display: "flex", gap: 10, marginBottom: 20, flexWrap: "wrap" }}>
        {statCard("Today's Jobs", todayJobs.length, "#1E3A5F")}
        {statCard("Open Jobs", openJobs.length, "#D97706")}
        {statCard("Outstanding", `£${unpaidTotal.toFixed(0)}`, "#059669", `${unpaidInvoices.length} invoices`)}
      </div>

      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#374151", margin: "0 0 10px", textTransform: "uppercase", letterSpacing: "0.05em" }}>Today's Jobs</h3>
      {todayJobs.length === 0 && (
        <Card><p style={{ margin: 0, color: "#9CA3AF", fontSize: 14, textAlign: "center" }}>No jobs scheduled today</p></Card>
      )}
      {todayJobs.map(job => {
        const cust = data.customers.find(c => c.id === job.customerId);
        const veh = data.vehicles.find(v => v.id === job.vehicleId);
        return (
          <Card key={job.id} onClick={() => setView({ screen: "jobDetail", id: job.id })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{cust?.name || "Unknown"}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "No vehicle"}</div>
                <div style={{ fontSize: 13, color: "#6B7280" }}>{job.glassPosition} · {job.jobType}</div>
              </div>
              <StatusBadge status={job.status} />
            </div>
          </Card>
        );
      })}

      <div style={{ marginTop: 16 }}>
        <Btn onClick={() => setView({ screen: "newJob" })} variant="amber" style={{ width: "100%", justifyContent: "center" }}>
          <Icon name="plus" size={16} /> New Job
        </Btn>
      </div>
    </div>
  );
}

// ── Customers List ───────────────────────────────────────────────────────────
function CustomersList({ data, setView }) {
  const [search, setSearch] = useState("");
  const [showForm, setShowForm] = useState(false);

  const filtered = data.customers.filter(c =>
    c.name.toLowerCase().includes(search.toLowerCase()) ||
    c.phone.includes(search) ||
    c.postcode?.toLowerCase().includes(search.toLowerCase())
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#1E3A5F" }}>Customers</h2>
        <Btn size="sm" onClick={() => setShowForm(true)}><Icon name="plus" size={14} /> Add</Btn>
      </div>
      <input style={{ ...inputStyle, marginBottom: 12 }} placeholder="Search name, phone, postcode…" value={search} onChange={e => setSearch(e.target.value)} />
      {filtered.length === 0 && <p style={{ color: "#9CA3AF", textAlign: "center", fontSize: 14 }}>No customers found</p>}
      {filtered.map(c => (
        <Card key={c.id} onClick={() => setView({ screen: "customerDetail", id: c.id })}>
          <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{c.name}</div>
          <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{c.phone} {c.postcode && `· ${c.postcode}`}</div>
          {c.email && <div style={{ fontSize: 12, color: "#9CA3AF" }}>{c.email}</div>}
        </Card>
      ))}
      {showForm && <CustomerForm data={data} onClose={() => setShowForm(false)} setView={setView} />}
    </div>
  );
}

// ── Customer Form ─────────────────────────────────────────────────────────────
function CustomerForm({ data, onClose, setView, editCustomer }) {
  const [name, setName] = useState(editCustomer?.name || "");
  const [phone, setPhone] = useState(editCustomer?.phone || "");
  const [email, setEmail] = useState(editCustomer?.email || "");
  const [postcode, setPostcode] = useState(editCustomer?.postcode || "");
  const [notes, setNotes] = useState(editCustomer?.notes || "");

  function save() {
    if (!name || !phone) return;
    const customers = [...data.customers];
    if (editCustomer) {
      const idx = customers.findIndex(c => c.id === editCustomer.id);
      customers[idx] = { ...editCustomer, name, phone, email, postcode, notes };
    } else {
      customers.push({ id: uid(), name, phone, email, postcode, notes, createdAt: today() });
    }
    saveData({ ...data, customers });
    window.location.reload();
  }

  return (
    <Modal title={editCustomer ? "Edit Customer" : "New Customer"} onClose={onClose}>
      <Field label="Full Name" required><Input value={name} onChange={setName} placeholder="Jane Smith" /></Field>
      <Field label="Phone" required><Input value={phone} onChange={setPhone} placeholder="07700 900000" type="tel" /></Field>
      <Field label="Email"><Input value={email} onChange={setEmail} placeholder="jane@email.com" type="email" /></Field>
      <Field label="Postcode"><Input value={postcode} onChange={setPostcode} placeholder="SW1A 1AA" /></Field>
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>
      <Btn onClick={save} style={{ width: "100%", justifyContent: "center" }} disabled={!name || !phone}>Save Customer</Btn>
    </Modal>
  );
}

// ── Customer Detail ───────────────────────────────────────────────────────────
function CustomerDetail({ data, id, setView }) {
  const customer = data.customers.find(c => c.id === id);
  const vehicles = data.vehicles.filter(v => v.customerId === id);
  const jobs = data.jobs.filter(j => j.customerId === id).sort((a, b) => b.date.localeCompare(a.date));
  const [showEdit, setShowEdit] = useState(false);
  const [showVehicle, setShowVehicle] = useState(false);

  if (!customer) return <p>Not found</p>;

  function deleteCustomer() {
    if (!window.confirm("Delete this customer?")) return;
    const updated = { ...data, customers: data.customers.filter(c => c.id !== id) };
    saveData(updated);
    setView({ screen: "customers" });
    window.location.reload();
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16, alignItems: "center" }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen: "customers" })}><Icon name="back" size={14} /> Back</Btn>
      </div>
      <Card>
        <div style={{ fontWeight: 800, fontSize: 20, color: "#1E3A5F" }}>{customer.name}</div>
        <div style={{ fontSize: 14, color: "#6B7280", marginTop: 4 }}>{customer.phone}</div>
        {customer.email && <div style={{ fontSize: 14, color: "#6B7280" }}>{customer.email}</div>}
        {customer.postcode && <div style={{ fontSize: 14, color: "#6B7280" }}>{customer.postcode}</div>}
        {customer.notes && <div style={{ fontSize: 13, color: "#9CA3AF", marginTop: 6 }}>{customer.notes}</div>}
        <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
          <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)}><Icon name="edit" size={13} /> Edit</Btn>
          <Btn size="sm" variant="danger" onClick={deleteCustomer}><Icon name="trash" size={13} /> Delete</Btn>
        </div>
      </Card>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", margin: "16px 0 8px" }}>
        <h3 style={{ margin: 0, fontSize: 14, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em" }}>Vehicles</h3>
        <Btn size="sm" onClick={() => setShowVehicle(true)}><Icon name="plus" size={13} /> Add</Btn>
      </div>
      {vehicles.map(v => (
        <Card key={v.id}>
          <div style={{ fontWeight: 600, fontSize: 14, color: "#111827" }}>{v.make} {v.model} {v.year && `(${v.year})`}</div>
          <div style={{ fontSize: 13, color: "#6B7280" }}>{v.reg}</div>
        </Card>
      ))}
      {vehicles.length === 0 && <p style={{ fontSize: 13, color: "#9CA3AF" }}>No vehicles added</p>}

      <h3 style={{ fontSize: 14, fontWeight: 700, color: "#374151", textTransform: "uppercase", letterSpacing: "0.05em", margin: "16px 0 8px" }}>Job History</h3>
      {jobs.map(j => (
        <Card key={j.id} onClick={() => setView({ screen: "jobDetail", id: j.id })}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <div>
              <div style={{ fontWeight: 600, fontSize: 14 }}>{j.glassPosition} · {j.jobType}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF" }}>{j.date}</div>
            </div>
            <StatusBadge status={j.status} />
          </div>
        </Card>
      ))}
      {jobs.length === 0 && <p style={{ fontSize: 13, color: "#9CA3AF" }}>No jobs yet</p>}

      {showEdit && <CustomerForm data={data} onClose={() => setShowEdit(false)} setView={setView} editCustomer={customer} />}
      {showVehicle && <VehicleForm data={data} customerId={id} onClose={() => setShowVehicle(false)} />}
    </div>
  );
}

// ── Vehicle Form ──────────────────────────────────────────────────────────────
function VehicleForm({ data, customerId, onClose }) {
  const [make, setMake] = useState("");
  const [model, setModel] = useState("");
  const [year, setYear] = useState("");
  const [reg, setReg] = useState("");
  const [vin, setVin] = useState("");

  function save() {
    if (!reg) return;
    const vehicles = [...data.vehicles, { id: uid(), customerId, make, model, year, reg: reg.toUpperCase(), vin }];
    saveData({ ...data, vehicles });
    window.location.reload();
  }

  return (
    <Modal title="Add Vehicle" onClose={onClose}>
      <Field label="Registration" required><Input value={reg} onChange={setReg} placeholder="AB12 CDE" /></Field>
      <Field label="Make"><Input value={make} onChange={setMake} placeholder="Ford" /></Field>
      <Field label="Model"><Input value={model} onChange={setModel} placeholder="Focus" /></Field>
      <Field label="Year"><Input value={year} onChange={setYear} placeholder="2019" type="number" /></Field>
      <Field label="VIN"><Input value={vin} onChange={setVin} placeholder="Optional" /></Field>
      <Btn onClick={save} style={{ width: "100%", justifyContent: "center" }} disabled={!reg}>Save Vehicle</Btn>
    </Modal>
  );
}

// ── Jobs List ────────────────────────────────────────────────────────────────
function JobsList({ data, setView }) {
  const [filter, setFilter] = useState("Open");

  const filtered = data.jobs.filter(j => {
    if (filter === "Today") return j.date === today();
    if (filter === "Open") return !["Paid"].includes(j.status);
    if (filter === "Complete") return ["Complete", "Paid"].includes(j.status);
    return true;
  }).sort((a, b) => b.date.localeCompare(a.date));

  const pillStyle = (active) => ({
    padding: "6px 14px", borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
    background: active ? "#1E3A5F" : "#F3F4F6", color: active ? "#fff" : "#6B7280", fontFamily: "inherit",
  });

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 }}>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, color: "#1E3A5F" }}>Jobs</h2>
        <Btn size="sm" onClick={() => setView({ screen: "newJob" })}><Icon name="plus" size={14} /> New</Btn>
      </div>
      <div style={{ display: "flex", gap: 6, marginBottom: 14, overflowX: "auto", paddingBottom: 4 }}>
        {["Today", "Open", "Complete", "All"].map(f => (
          <button key={f} style={pillStyle(filter === f)} onClick={() => setFilter(f)}>{f}</button>
        ))}
      </div>
      {filtered.length === 0 && <p style={{ color: "#9CA3AF", textAlign: "center", fontSize: 14 }}>No jobs found</p>}
      {filtered.map(job => {
        const cust = data.customers.find(c => c.id === job.customerId);
        const veh = data.vehicles.find(v => v.id === job.vehicleId);
        return (
          <Card key={job.id} onClick={() => setView({ screen: "jobDetail", id: job.id })}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 700, fontSize: 15, color: "#111827" }}>{cust?.name || "Unknown Customer"}</div>
                <div style={{ fontSize: 13, color: "#6B7280", marginTop: 2 }}>{veh ? `${veh.make} ${veh.model} · ${veh.reg}` : "No vehicle"}</div>
                <div style={{ fontSize: 13, color: "#6B7280" }}>{job.glassPosition} · {job.jobType} · {job.date}</div>
                {job.adasRequired && <span style={{ fontSize: 11, background: "#FEF3C7", color: "#92400E", padding: "1px 7px", borderRadius: 99, fontWeight: 600 }}>ADAS</span>}
              </div>
              <StatusBadge status={job.status} />
            </div>
          </Card>
        );
      })}
    </div>
  );
}

// ── New / Edit Job Form ───────────────────────────────────────────────────────
function JobForm({ data, onClose, editJob, setView }) {
  const [customerId, setCustomerId] = useState(editJob?.customerId || "");
  const [vehicleId, setVehicleId] = useState(editJob?.vehicleId || "");
  const [date, setDate] = useState(editJob?.date || today());
  const [jobType, setJobType] = useState(editJob?.jobType || "Repair");
  const [glassPosition, setGlassPosition] = useState(editJob?.glassPosition || "Windscreen");
  const [damageType, setDamageType] = useState(editJob?.damageType || "Chip");
  const [adasRequired, setAdasRequired] = useState(editJob?.adasRequired || false);
  const [status, setStatus] = useState(editJob?.status || "Booked");
  const [technicianId, setTechnicianId] = useState(editJob?.technicianId || "");
  const [notes, setNotes] = useState(editJob?.notes || "");
  const [paymentType, setPaymentType] = useState(editJob?.paymentType || "Private");
  const [insuranceCo, setInsuranceCo] = useState(editJob?.insuranceCo || "");
  const [claimNo, setClaimNo] = useState(editJob?.claimNo || "");

  const custVehicles = data.vehicles.filter(v => v.customerId === customerId);

  function save() {
    if (!customerId) return;
    const jobs = [...data.jobs];
    const jobData = { customerId, vehicleId, date, jobType, glassPosition, damageType, adasRequired, status, technicianId, notes, paymentType, insuranceCo, claimNo };
    if (editJob) {
      const idx = jobs.findIndex(j => j.id === editJob.id);
      jobs[idx] = { ...editJob, ...jobData };
    } else {
      jobs.push({ id: uid(), ...jobData, createdAt: today() });
    }
    saveData({ ...data, jobs });
    onClose();
    window.location.reload();
  }

  return (
    <Modal title={editJob ? "Edit Job" : "New Job"} onClose={onClose}>
      <Field label="Customer" required>
        <select style={{ ...inputStyle, appearance: "none" }} value={customerId} onChange={e => { setCustomerId(e.target.value); setVehicleId(""); }}>
          <option value="">Select customer…</option>
          {data.customers.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
      </Field>
      {customerId && (
        <Field label="Vehicle">
          <select style={{ ...inputStyle, appearance: "none" }} value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">No vehicle / select…</option>
            {custVehicles.map(v => <option key={v.id} value={v.id}>{v.make} {v.model} · {v.reg}</option>)}
          </select>
        </Field>
      )}
      <Field label="Date"><Input type="date" value={date} onChange={setDate} /></Field>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Job Type"><Select value={jobType} onChange={setJobType} options={JOB_TYPES} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Glass Position"><Select value={glassPosition} onChange={setGlassPosition} options={GLASS_POSITIONS} /></Field></div>
      </div>
      <div style={{ display: "flex", gap: 10 }}>
        <div style={{ flex: 1 }}><Field label="Damage Type"><Select value={damageType} onChange={setDamageType} options={DAMAGE_TYPES} /></Field></div>
        <div style={{ flex: 1 }}><Field label="Status"><Select value={status} onChange={setStatus} options={Object.keys(STATUS_META)} /></Field></div>
      </div>
      <Field label="ADAS Calibration">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, color: "#374151" }}>
          <input type="checkbox" checked={adasRequired} onChange={e => setAdasRequired(e.target.checked)} style={{ width: 16, height: 16 }} />
          Required
        </label>
      </Field>
      <Field label="Payment Type"><Select value={paymentType} onChange={setPaymentType} options={PAYMENT_TYPES} /></Field>
      {paymentType === "Insurance" && (
        <>
          <Field label="Insurance Company"><Input value={insuranceCo} onChange={setInsuranceCo} placeholder="e.g. Admiral" /></Field>
          <Field label="Claim Number"><Input value={claimNo} onChange={setClaimNo} placeholder="Claim ref…" /></Field>
        </>
      )}
      {data.technicians.length > 0 && (
        <Field label="Technician">
          <select style={{ ...inputStyle, appearance: "none" }} value={technicianId} onChange={e => setTechnicianId(e.target.value)}>
            <option value="">Unassigned</option>
            {data.technicians.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </select>
        </Field>
      )}
      <Field label="Notes"><Input value={notes} onChange={setNotes} placeholder="Any notes…" /></Field>
      <Btn onClick={save} style={{ width: "100%", justifyContent: "center" }} disabled={!customerId}>Save Job</Btn>
    </Modal>
  );
}

// ── Job Detail ────────────────────────────────────────────────────────────────
function JobDetail({ data, id, setView }) {
  const job = data.jobs.find(j => j.id === id);
  const [showEdit, setShowEdit] = useState(false);
  const [showInvoice, setShowInvoice] = useState(false);

  if (!job) return <p>Not found</p>;

  const customer = data.customers.find(c => c.id === job.customerId);
  const vehicle = data.vehicles.find(v => v.id === job.vehicleId);
  const technician = data.technicians.find(t => t.id === job.technicianId);
  const invoice = data.invoices.find(i => i.jobId === id);

  function updateStatus(newStatus) {
    const jobs = data.jobs.map(j => j.id === id ? { ...j, status: newStatus } : j);
    saveData({ ...data, jobs });
    window.location.reload();
  }

  function deleteJob() {
    if (!window.confirm("Delete this job?")) return;
    saveData({ ...data, jobs: data.jobs.filter(j => j.id !== id) });
    setView({ screen: "jobs" });
    window.location.reload();
  }

  const nextStatuses = {
    "Booked": ["In Progress"],
    "In Progress": ["Complete"],
    "Complete": ["Invoiced"],
    "Invoiced": ["Paid"],
    "Paid": [],
  };

  const Row = ({ label, value }) => value ? (
    <div style={{ display: "flex", justifyContent: "space-between", padding: "8px 0", borderBottom: "1px solid #F3F4F6" }}>
      <span style={{ fontSize: 13, color: "#6B7280", fontWeight: 500 }}>{label}</span>
      <span style={{ fontSize: 13, color: "#111827", fontWeight: 600, textAlign: "right", maxWidth: "60%" }}>{value}</span>
    </div>
  ) : null;

  return (
    <div>
      <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
        <Btn variant="ghost" size="sm" onClick={() => setView({ screen: "jobs" })}><Icon name="back" size={14} /> Back</Btn>
      </div>

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 18, fontWeight: 800, color: "#1E3A5F" }}>Job Detail</h2>
        <StatusBadge status={job.status} />
      </div>

      <Card>
        <Row label="Customer" value={customer?.name} />
        <Row label="Phone" value={customer?.phone} />
        <Row label="Vehicle" value={vehicle ? `${vehicle.make} ${vehicle.model} · ${vehicle.reg}` : null} />
        <Row label="Date" value={job.date} />
        <Row label="Job Type" value={job.jobType} />
        <Row label="Glass Position" value={job.glassPosition} />
        <Row label="Damage Type" value={job.damageType} />
        <Row label="ADAS" value={job.adasRequired ? "Required" : null} />
        <Row label="Payment" value={job.paymentType} />
        <Row label="Insurance Co." value={job.insuranceCo} />
        <Row label="Claim No." value={job.claimNo} />
        <Row label="Technician" value={technician?.name} />
        <Row label="Notes" value={job.notes} />
      </Card>

      {nextStatuses[job.status]?.length > 0 && (
        <Btn variant="amber" onClick={() => updateStatus(nextStatuses[job.status][0])} style={{ width: "100%", justifyContent: "center", marginBottom: 10 }}>
          <Icon name="check" size={15} /> Mark as {nextStatuses[job.status][0]}
        </Btn>
      )}

      {job.status === "Complete" && !invoice && (
        <Btn onClick={() => setShowInvoice(true)} style={{ width: "100%", justifyContent: "center", marginBottom: 10 }}>
          <Icon name="invoices" size={15} /> Create Invoice
        </Btn>
      )}

      {invoice && (
        <Card style={{ background: "#F0FDF4", borderColor: "#BBF7D0" }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 14, color: "#065F46" }}>Invoice · £{invoice.total}</div>
              <div style={{ fontSize: 12, color: "#059669" }}>{invoice.paid ? "✓ Paid" : "Awaiting payment"}</div>
            </div>
            {!invoice.paid && (
              <Btn size="sm" variant="ghost" onClick={() => {
                const invoices = data.invoices.map(i => i.id === invoice.id ? { ...i, paid: true, paidDate: today() } : i);
                const jobs = data.jobs.map(j => j.id === id ? { ...j, status: "Paid" } : j);
                saveData({ ...data, invoices, jobs });
                window.location.reload();
              }}>Mark Paid</Btn>
            )}
          </div>
        </Card>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <Btn size="sm" variant="ghost" onClick={() => setShowEdit(true)} style={{ flex: 1, justifyContent: "center" }}><Icon name="edit" size={13} /> Edit</Btn>
        <Btn size="sm" variant="danger" onClick={deleteJob} style={{ flex: 1, justifyContent: "center" }}><Icon name="trash" size={13} /> Delete</Btn>
      </div>

      {showEdit && <JobForm data={data} editJob={job} onClose={() => setShowEdit(false)} setView={setView} />}
      {showInvoice && <InvoiceForm data={data} jobId={id} onClose={() => setShowInvoice(false)} />}
    </div>
  );
}

// ── Invoice Form ──────────────────────────────────────────────────────────────
function InvoiceForm({ data, jobId, onClose }) {
  const [labour, setLabour] = useState("");
  const [parts, setParts] = useState("");
  const [vat, setVat] = useState(true);

  const subtotal = (parseFloat(labour) || 0) + (parseFloat(parts) || 0);
  const total = vat ? subtotal * 1.2 : subtotal;

  function save() {
    const invoices = [...data.invoices, { id: uid(), jobId, labour, parts, vat, total: total.toFixed(2), paid: false, createdAt: today() }];
    const jobs = data.jobs.map(j => j.id === jobId ? { ...j, status: "Invoiced" } : j);
    saveData({ ...data, invoices, jobs });
    window.location.reload();
  }

  return (
    <Modal title="Create Invoice" onClose={onClose}>
      <Field label="Labour (£)"><Input type="number" value={labour} onChange={setLabour} placeholder="0.00" /></Field>
      <Field label="Parts (£)"><Input type="number" value={parts} onChange={setParts} placeholder="0.00" /></Field>
      <Field label="VAT">
        <label style={{ display: "flex", alignItems: "center", gap: 8, cursor: "pointer", fontSize: 14, color: "#374151" }}>
          <input type="checkbox" checked={vat} onChange={e => setVat(e.target.checked)} style={{ width: 16, height: 16 }} />
          Apply 20% VAT
        </label>
      </Field>
      <div style={{ background: "#F9FAFB", borderRadius: 8, padding: "12px 14px", marginBottom: 16 }}>
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B7280", marginBottom: 4 }}>
          <span>Subtotal</span><span>£{subtotal.toFixed(2)}</span>
        </div>
        {vat && <div style={{ display: "flex", justifyContent: "space-between", fontSize: 13, color: "#6B7280", marginBottom: 4 }}>
          <span>VAT (20%)</span><span>£{(subtotal * 0.2).toFixed(2)}</span>
        </div>}
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 16, fontWeight: 800, color: "#111827", borderTop: "1px solid #E5E7EB", paddingTop: 8, marginTop: 4 }}>
          <span>Total</span><span>£{total.toFixed(2)}</span>
        </div>
      </div>
      <Btn onClick={save} style={{ width: "100%", justifyContent: "center" }}>Save Invoice</Btn>
    </Modal>
  );
}

// ── Invoices List ─────────────────────────────────────────────────────────────
function InvoicesList({ data, setView }) {
  const [filter, setFilter] = useState("Unpaid");

  const enriched = data.invoices.map(inv => {
    const job = data.jobs.find(j => j.id === inv.jobId);
    const customer = job ? data.customers.find(c => c.id === job.customerId) : null;
    return { ...inv, job, customer };
  }).filter(inv => {
    if (filter === "Unpaid") return !inv.paid;
    if (filter === "Paid") return inv.paid;
    return true;
  }).sort((a, b) => b.createdAt?.localeCompare(a.createdAt));

  const total = enriched.reduce((s, i) => s + (parseFloat(i.total) || 0), 0);

  const pillStyle = (active) => ({
    padding: "6px 14px", borderRadius: 99, fontSize: 13, fontWeight: 600, cursor: "pointer", border: "none",
    background: active ? "#1E3A5F" : "#F3F4F6", color: active ? "#fff" : "#6B7280", fontFamily: "inherit",
  });

  return (
    <div>
      <h2 style={{ margin: "0 0 14px", fontSize: 20, fontWeight: 800, color: "#1E3A5F" }}>Invoices</h2>
      <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
        {["Unpaid", "Paid", "All"].map(f => <button key={f} style={pillStyle(filter === f)} onClick={() => setFilter(f)}>{f}</button>)}
      </div>
      {enriched.length > 0 && (
        <Card style={{ background: "#EFF6FF", borderColor: "#BFDBFE" }}>
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <span style={{ fontSize: 13, color: "#1D4ED8", fontWeight: 600 }}>{filter === "All" ? "Total" : filter === "Unpaid" ? "Outstanding" : "Total Received"}</span>
            <span style={{ fontSize: 18, fontWeight: 800, color: "#1D4ED8" }}>£{total.toFixed(2)}</span>
          </div>
        </Card>
      )}
      {enriched.length === 0 && <p style={{ color: "#9CA3AF", textAlign: "center", fontSize: 14 }}>No invoices found</p>}
      {enriched.map(inv => (
        <Card key={inv.id} onClick={() => inv.job && setView({ screen: "jobDetail", id: inv.job.id })}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
            <div>
              <div style={{ fontWeight: 700, fontSize: 15 }}>{inv.customer?.name || "Unknown"}</div>
              <div style={{ fontSize: 12, color: "#9CA3AF" }}>{inv.createdAt} · {inv.job?.glassPosition} {inv.job?.jobType}</div>
            </div>
            <div style={{ textAlign: "right" }}>
              <div style={{ fontWeight: 800, fontSize: 16, color: inv.paid ? "#059669" : "#1E3A5F" }}>£{parseFloat(inv.total).toFixed(2)}</div>
              <div style={{ fontSize: 11, color: inv.paid ? "#059669" : "#D97706", fontWeight: 600 }}>{inv.paid ? "Paid" : "Unpaid"}</div>
            </div>
          </div>
        </Card>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// ROOT APP
// ═══════════════════════════════════════════════════════════════════════════

export default function App() {
  const [data, setData] = useState(loadData);
  const [view, setViewState] = useState({ screen: "dashboard" });
  const [tab, setTab] = useState("dashboard");

  // Reload data from localStorage on view changes
  const setView = useCallback((v) => {
    setViewState(v);
    if (["dashboard", "customers", "jobs", "invoices"].includes(v.screen)) setTab(v.screen);
    setData(loadData());
  }, []);

  // Refresh data when tab changes
  useEffect(() => { setData(loadData()); }, [tab]);

  const tabs = [
    { id: "dashboard", icon: "dashboard", label: "Home" },
    { id: "jobs",      icon: "jobs",      label: "Jobs" },
    { id: "customers", icon: "customers", label: "Customers" },
    { id: "invoices",  icon: "invoices",  label: "Invoices" },
  ];

  return (
    <div style={{ fontFamily: "'Inter', system-ui, sans-serif", background: "#F8FAFC", minHeight: "100vh", maxWidth: 520, margin: "0 auto", position: "relative" }}>
      {/* Header */}
      <div style={{ background: "#1E3A5F", padding: "14px 20px 12px", position: "sticky", top: 0, zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          {!["dashboard","customers","jobs","invoices"].includes(view.screen) && (
            <button onClick={() => setView({ screen: tab })} style={{ background: "rgba(255,255,255,.15)", border: "none", borderRadius: 8, padding: "4px 8px", color: "#fff", cursor: "pointer", fontSize: 18 }}>‹</button>
          )}
          <div>
            <div style={{ fontSize: 16, fontWeight: 800, color: "#fff", letterSpacing: "-0.02em" }}>GlassPro CRM</div>
            <div style={{ fontSize: 10, color: "#93C5FD", fontWeight: 500, letterSpacing: "0.08em", textTransform: "uppercase" }}>Windscreen Repair</div>
          </div>
        </div>
        <div style={{ width: 8, height: 8, borderRadius: "50%", background: "#22C55E", boxShadow: "0 0 6px #22C55E" }} title="Data saved locally" />
      </div>

      {/* Content */}
      <div style={{ padding: "16px 16px 90px" }}>
        {view.screen === "dashboard"      && <Dashboard data={data} setView={setView} />}
        {view.screen === "customers"      && <CustomersList data={data} setView={setView} />}
        {view.screen === "customerDetail" && <CustomerDetail data={data} id={view.id} setView={setView} />}
        {view.screen === "jobs"           && <JobsList data={data} setView={setView} />}
        {view.screen === "jobDetail"      && <JobDetail data={data} id={view.id} setView={setView} />}
        {view.screen === "newJob"         && (() => { return <JobsList data={data} setView={setView} />; })()}
        {view.screen === "invoices"       && <InvoicesList data={data} setView={setView} />}
      </div>

      {/* New Job modal triggered from newJob screen */}
      {view.screen === "newJob" && <JobForm data={data} onClose={() => setView({ screen: "jobs" })} setView={setView} />}

      {/* Bottom Nav */}
      <div style={{ position: "fixed", bottom: 0, left: "50%", transform: "translateX(-50%)", width: "100%", maxWidth: 520, background: "#fff", borderTop: "1px solid #E5E7EB", display: "flex", zIndex: 50 }}>
        {tabs.map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => { setTab(t.id); setView({ screen: t.id }); }}
              style={{ flex: 1, padding: "10px 0 12px", background: "transparent", border: "none", cursor: "pointer", display: "flex", flexDirection: "column", alignItems: "center", gap: 3 }}>
              <Icon name={t.icon} size={20} color={active ? "#1E3A5F" : "#9CA3AF"} />
              <span style={{ fontSize: 10, fontWeight: 600, color: active ? "#1E3A5F" : "#9CA3AF", letterSpacing: "0.04em" }}>{t.label}</span>
              {active && <div style={{ width: 16, height: 2, borderRadius: 99, background: "#F59E0B", marginTop: 1 }} />}
            </button>
          );
        })}
      </div>
    </div>
  );
}

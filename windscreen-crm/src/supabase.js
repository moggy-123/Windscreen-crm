import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ubnwpghiozmydkczklek.supabase.co";
const SUPABASE_KEY = "sb_publishable_kmHWMBjAz8jb8AvkDH0rUA_b4TWa0wc";

// persistSession + autoRefreshToken are essential here — this app reloads the whole
// page on every save, so the login must survive a reload rather than logging out.
export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
  auth: { persistSession: true, autoRefreshToken: true, storageKey: "wscrm_auth" },
});

// ── Auth ─────────────────────────────────────────────────────────────────────
export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) throw error;
}
export async function signOut() {
  await supabase.auth.signOut();
}
export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session;
}
export function onAuthChange(callback) {
  const { data } = supabase.auth.onAuthStateChange((_event, session) => callback(session));
  return () => data.subscription.unsubscribe();
}

// ── Field mapping: app (camelCase) <-> db (snake_case) ──────────────────────

const customerToDb = c => ({
  id: c.id, company: c.company, company_contact: c.companyContact,
  phone: c.phone, email: c.email, address1: c.address1, address2: c.address2,
  town: c.town, county: c.county, postcode: c.postcode, notes: c.notes,
  on_stop: !!c.onStop,
  cust_type: c.custType || "Trade",
  pricing: c.pricing || {},
  terms_sent_at: c.termsSentAt || null,
  terms_sent_version: c.termsSentVersion || "",
  offer_sent_at: c.offerSentAt || null,
  inspection_offer_sent_at: c.inspectionOfferSentAt || null,
  follow_up_date: c.followUpDate || null,
  follow_up_note: c.followUpNote || "",
  contacts: c.contacts || [],
  updated_at: c.updatedAt || Date.now(),
  created_at: c.createdAt || new Date().toISOString(),
});
const customerFromDb = r => ({
  id: r.id, company: r.company, companyContact: r.company_contact,
  phone: r.phone, email: r.email, address1: r.address1, address2: r.address2,
  town: r.town, county: r.county, postcode: r.postcode, notes: r.notes,
  onStop: r.on_stop,
  custType: r.cust_type || "Trade",
  pricing: r.pricing || {},
  termsSentAt: r.terms_sent_at || null,
  termsSentVersion: r.terms_sent_version || "",
  offerSentAt: r.offer_sent_at || null,
  inspectionOfferSentAt: r.inspection_offer_sent_at || null,
  followUpDate: r.follow_up_date || "",
  followUpNote: r.follow_up_note || "",
  contacts: r.contacts || [],
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const vehicleToDb = v => ({
  id: v.id, customer_id: v.customerId, make: v.make, model: v.model, reg: v.reg,
  updated_at: v.updatedAt || Date.now(), created_at: v.createdAt ? new Date(v.createdAt).toISOString() : new Date().toISOString(),
});
const vehicleFromDb = r => ({
  id: r.id, customerId: r.customer_id, make: r.make, model: r.model, reg: r.reg,
  updatedAt: r.updated_at, createdAt: r.created_at ? new Date(r.created_at).getTime() : 0,
});

const jobToDb = j => ({
  id: j.id, customer_id: j.customerId, driver_name: j.driverName, contact_name: j.contactName || null, vehicle_id: j.vehicleId || null,
  date: j.date, job_time: j.jobTime, loc_address1: j.locAddress1, loc_address2: j.locAddress2,
  loc_town: j.locTown, loc_county: j.locCounty, loc_postcode: j.locPostcode,
  job_type: j.jobType, damage_type: j.damageType, damage_side: j.damageSide,
  damage_position: j.damagePosition, adas_required: !!j.adasRequired, status: j.status,
  technician_id: j.technicianId || null, notes: j.notes, payment_type: j.paymentType, no_charge: !!j.noCharge,
  insurance_co: j.insuranceCo, claim_no: j.claimNo,
  repairs: j.repairs || [],
  photos_before: j.photosBefore || [], photos_after: j.photosAfter || [],
  updated_at: j.updatedAt || Date.now(),
  created_at: j.createdAt || new Date().toISOString(),
});
const jobFromDb = r => ({
  id: r.id, customerId: r.customer_id, driverName: r.driver_name, contactName: r.contact_name, vehicleId: r.vehicle_id,
  date: r.date, jobTime: r.job_time, locAddress1: r.loc_address1, locAddress2: r.loc_address2,
  locTown: r.loc_town, locCounty: r.loc_county, locPostcode: r.loc_postcode,
  jobType: r.job_type, damageType: r.damage_type, damageSide: r.damage_side,
  damagePosition: r.damage_position, adasRequired: r.adas_required, status: r.status,
  technicianId: r.technician_id, notes: r.notes, paymentType: r.payment_type, noCharge: !!r.no_charge,
  insuranceCo: r.insurance_co, claimNo: r.claim_no,
  repairs: r.repairs || [],
  photosBefore: r.photos_before || [], photosAfter: r.photos_after || [],
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const invoiceToDb = i => ({
  id: i.id, job_id: i.jobId, details: i.details || "", labour: i.labour, parts: i.parts, vat: !!i.vat,
  total: i.total, paid: !!i.paid, paid_date: i.paidDate, sage_invoice_no: i.sageInvoiceNo || "",
  line_items: i.lineItems || [],
  updated_at: i.updatedAt || Date.now(),
  created_at: i.createdAt || new Date().toISOString(),
});
const invoiceFromDb = r => ({
  id: r.id, jobId: r.job_id, details: r.details, labour: r.labour, parts: r.parts, vat: r.vat,
  total: r.total, paid: r.paid, paidDate: r.paid_date, sageInvoiceNo: r.sage_invoice_no || "",
  lineItems: r.line_items || [],
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const mileageToDb = m => ({
  id: m.id, date: m.date, miles: m.miles, note: m.note || "",
  updated_at: m.updatedAt || Date.now(),
  created_at: m.createdAt || new Date().toISOString(),
});
const mileageFromDb = r => ({
  id: r.id, date: r.date, miles: r.miles, note: r.note,
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const inspectionToDb = insp => ({
  id: insp.id, customer_id: insp.customerId || null,
  site_name: insp.siteName || "", contact_name: insp.contactName || "",
  contact_email: insp.contactEmail || "", contact_phone: insp.contactPhone || "",
  address: insp.address || "", date: insp.date || null, notes: insp.notes || "",
  vehicles: insp.vehicles || [],
  updated_at: insp.updatedAt || Date.now(),
  created_at: insp.createdAt || new Date().toISOString(),
});
const inspectionFromDb = r => ({
  id: r.id, customerId: r.customer_id, siteName: r.site_name, contactName: r.contact_name,
  contactEmail: r.contact_email, contactPhone: r.contact_phone, address: r.address,
  date: r.date, notes: r.notes, vehicles: r.vehicles || [],
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const commToDb = c => ({
  id: c.id, customer_id: c.customerId || null,
  contact_id: c.contactId || null, contact_name: c.contactName || "",
  type: c.type || "Note", direction: c.direction || "out", note: c.note || "",
  photos: c.photos || [],
  timestamp: c.timestamp || Date.now(), created_at: c.createdAt || new Date().toISOString(),
  updated_at: c.updatedAt || Date.now(),
});
const commFromDb = r => ({
  id: r.id, customerId: r.customer_id, contactId: r.contact_id, contactName: r.contact_name,
  type: r.type, direction: r.direction,
  note: r.note, photos: r.photos || [], timestamp: r.timestamp, createdAt: r.created_at, updatedAt: r.updated_at,
});

const settingToDb = s => ({
  id: s.id, default_pricing: s.defaultPricing || {}, private_pricing: s.privatePricing || {}, updated_at: s.updatedAt || Date.now(),
});
const settingFromDb = r => ({ id: r.id, defaultPricing: r.default_pricing || {}, privatePricing: r.private_pricing || {}, updatedAt: r.updated_at });

const timeOffToDb = t => ({
  id: t.id, start_date: t.startDate, end_date: t.endDate, reason: t.reason || "",
  start_time: t.startTime || null, end_time: t.endTime || null,
  updated_at: t.updatedAt || Date.now(),
  created_at: t.createdAt || new Date().toISOString(),
});
const timeOffFromDb = r => ({
  id: r.id, startDate: r.start_date, endDate: r.end_date, reason: r.reason,
  startTime: r.start_time || "", endTime: r.end_time || "",
  updatedAt: r.updated_at, createdAt: r.created_at,
});

const leadToDb = l => ({
  id: l.id, business_name: l.businessName || "", contact_name: l.contactName || "",
  phone: l.phone || "", email: l.email || "", address: l.address || "",
  visit_date: l.visitDate || null, outcome: l.outcome || "Interested", notes: l.notes || "",
  converted_customer_id: l.convertedCustomerId || null,
  updated_at: l.updatedAt || Date.now(),
  created_at: l.createdAt || new Date().toISOString(),
});
const leadFromDb = r => ({
  id: r.id, businessName: r.business_name, contactName: r.contact_name,
  phone: r.phone, email: r.email, address: r.address,
  visitDate: r.visit_date, outcome: r.outcome || "Interested", notes: r.notes,
  convertedCustomerId: r.converted_customer_id || null,
  updatedAt: r.updated_at, createdAt: r.created_at,
});

// ── Pull all data from Supabase ─────────────────────────────────────────────
export async function pullFromCloud() {
  const [c, v, j, i] = await Promise.all([
    supabase.from("customers").select("*"),
    supabase.from("vehicles").select("*"),
    supabase.from("jobs").select("*"),
    supabase.from("invoices").select("*"),
  ]);
  if (c.error || v.error || j.error || i.error) {
    throw new Error("Pull failed");
  }
  // Mileage pulled separately so a missing table (before SQL is run) doesn't break the app
  let mileage = [];
  try {
    const m = await supabase.from("mileage").select("*");
    if (!m.error) mileage = (m.data || []).map(mileageFromDb);
  } catch {}
  // Inspections pulled separately so a missing table (before SQL is run) doesn't break the app
  let inspections = [];
  try {
    const ins = await supabase.from("inspections").select("*");
    if (!ins.error) inspections = (ins.data || []).map(inspectionFromDb);
  } catch {}
  let communications = [];
  try {
    const cm = await supabase.from("communications").select("*");
    if (!cm.error) communications = (cm.data || []).map(commFromDb);
  } catch {}
  let settings = [];
  try {
    const st = await supabase.from("settings").select("*");
    if (!st.error) settings = (st.data || []).map(settingFromDb);
  } catch {}
  let timeOff = [];
  try {
    const to = await supabase.from("time_off").select("*");
    if (!to.error) timeOff = (to.data || []).map(timeOffFromDb);
  } catch {}
  let leads = [];
  try {
    const ld = await supabase.from("leads").select("*");
    if (!ld.error) leads = (ld.data || []).map(leadFromDb);
  } catch {}
  return {
    customers:   (c.data || []).map(customerFromDb),
    vehicles:    (v.data || []).map(vehicleFromDb),
    jobs:        (j.data || []).map(jobFromDb),
    invoices:    (i.data || []).map(invoiceFromDb),
    mileage,
    inspections,
    communications,
    settings,
    timeOff,
    leads,
    technicians: [],
  };
}

// ── Push entire local dataset to Supabase (upsert) ──────────────────────────
// Uploads each table's rows in small chunks, one chunk at a time, so large
// photo payloads never exceed the statement timeout on slow mobile connections.
export async function pushToCloud(data) {
  const tables = [
    { name: "customers", rows: (data.customers || []).map(customerToDb) },
    { name: "vehicles",  rows: (data.vehicles  || []).map(vehicleToDb)  },
    { name: "jobs",      rows: (data.jobs      || []).map(jobToDb)      },
    { name: "invoices",  rows: (data.invoices  || []).map(invoiceToDb)  },
    { name: "mileage",   rows: (data.mileage   || []).map(mileageToDb)  },
    { name: "inspections", rows: (data.inspections || []).map(inspectionToDb) },
    { name: "communications", rows: (data.communications || []).map(commToDb) },
    { name: "settings", rows: (data.settings || []).map(settingToDb) },
    { name: "time_off", rows: (data.timeOff || []).map(timeOffToDb) },
    { name: "leads", rows: (data.leads || []).map(leadToDb) },
  ];

  for (const t of tables) {
    // Upload one row at a time — keeps each request tiny even with photos
    for (const row of t.rows) {
      const { error } = await supabase.from(t.name).upsert(row);
      if (error) {
        const msg = error.message || error.details || error.hint || JSON.stringify(error);
        throw new Error(msg);
      }
    }
  }
}

// Push only ONE record (used for single saves — fast, avoids re-uploading everything)
export async function pushOne(table, record) {
  const map = { customers: customerToDb, vehicles: vehicleToDb, jobs: jobToDb, invoices: invoiceToDb, mileage: mileageToDb, inspections: inspectionToDb, communications: commToDb, settings: settingToDb, time_off: timeOffToDb, leads: leadToDb };
  const { error } = await supabase.from(table).upsert(map[table](record));
  if (error) {
    const msg = error.message || error.details || error.hint || JSON.stringify(error);
    throw new Error(msg);
  }
}

// ── Push a single record ────────────────────────────────────────────────────
export async function upsertRecord(table, record) {
  const map = { customers: customerToDb, vehicles: vehicleToDb, jobs: jobToDb, invoices: invoiceToDb, mileage: mileageToDb, inspections: inspectionToDb, communications: commToDb, settings: settingToDb, time_off: timeOffToDb, leads: leadToDb };
  const { error } = await supabase.from(table).upsert(map[table](record));
  if (error) throw error;
}

export async function deleteRecord(table, id) {
  const { error } = await supabase.from(table).delete().eq("id", id);
  if (error) throw error;
}

export async function isOnline() {
  try {
    const { error } = await supabase.from("customers").select("id").limit(1);
    return !error;
  } catch {
    return false;
  }
}

// ── Photo Storage ────────────────────────────────────────────────────────────
const PHOTO_BUCKET = "job-photos";

// Upload a base64 data URL to Supabase Storage, return the public URL
export async function uploadPhoto(dataUrl, jobId) {
  // Convert data URL to a Blob
  const res = await fetch(dataUrl);
  const blob = await res.blob();
  const filename = `${jobId}/${Date.now()}-${Math.random().toString(36).slice(2,8)}.jpg`;

  // Guard against weak-signal hangs: if the upload takes too long, treat it as failed
  // so the photo stays PENDING and is retried later, rather than being silently lost.
  const uploadPromise = supabase.storage.from(PHOTO_BUCKET).upload(filename, blob, {
    contentType: "image/jpeg",
    upsert: false,
  });
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error("Upload timed out (weak signal)")), 20000));

  const { error } = await Promise.race([uploadPromise, timeout]);
  if (error) throw error;

  // Verify the file is actually present in storage before declaring success.
  // On flaky connections an upload can appear to complete without landing.
  const { data: listed, error: listErr } = await supabase.storage.from(PHOTO_BUCKET).list(jobId, { search: filename.split("/").pop() });
  if (listErr) throw listErr;
  if (!listed || listed.length === 0) throw new Error("Upload not confirmed — will retry");

  const { data } = supabase.storage.from(PHOTO_BUCKET).getPublicUrl(filename);
  return { url: data.publicUrl, path: filename };
}

// Delete a photo from storage by its path
export async function deletePhoto(path) {
  if (!path) return;
  await supabase.storage.from(PHOTO_BUCKET).remove([path]);
}

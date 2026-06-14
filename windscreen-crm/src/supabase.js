import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL = "https://ubnwpghiozmydkczklek.supabase.co";
const SUPABASE_KEY = "sb_publishable_kmHWMBjAz8jb8AvkDH0rUA_b4TWa0wc";

export const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// ── Field mapping: app (camelCase) <-> db (snake_case) ──────────────────────

const customerToDb = c => ({
  id: c.id, company: c.company, company_contact: c.companyContact,
  phone: c.phone, email: c.email, address1: c.address1, address2: c.address2,
  town: c.town, county: c.county, postcode: c.postcode, notes: c.notes,
  created_at: c.createdAt || new Date().toISOString(),
});
const customerFromDb = r => ({
  id: r.id, company: r.company, companyContact: r.company_contact,
  phone: r.phone, email: r.email, address1: r.address1, address2: r.address2,
  town: r.town, county: r.county, postcode: r.postcode, notes: r.notes,
  createdAt: r.created_at,
});

const vehicleToDb = v => ({
  id: v.id, customer_id: v.customerId, make: v.make, model: v.model, reg: v.reg,
});
const vehicleFromDb = r => ({
  id: r.id, customerId: r.customer_id, make: r.make, model: r.model, reg: r.reg,
});

const jobToDb = j => ({
  id: j.id, customer_id: j.customerId, driver_name: j.driverName, vehicle_id: j.vehicleId || null,
  date: j.date, job_time: j.jobTime, loc_address1: j.locAddress1, loc_address2: j.locAddress2,
  loc_town: j.locTown, loc_county: j.locCounty, loc_postcode: j.locPostcode,
  job_type: j.jobType, damage_type: j.damageType, damage_side: j.damageSide,
  damage_position: j.damagePosition, adas_required: !!j.adasRequired, status: j.status,
  technician_id: j.technicianId || null, notes: j.notes, payment_type: j.paymentType,
  insurance_co: j.insuranceCo, claim_no: j.claimNo,
  photos_before: j.photosBefore || [], photos_after: j.photosAfter || [],
  created_at: j.createdAt || new Date().toISOString(),
});
const jobFromDb = r => ({
  id: r.id, customerId: r.customer_id, driverName: r.driver_name, vehicleId: r.vehicle_id,
  date: r.date, jobTime: r.job_time, locAddress1: r.loc_address1, locAddress2: r.loc_address2,
  locTown: r.loc_town, locCounty: r.loc_county, locPostcode: r.loc_postcode,
  jobType: r.job_type, damageType: r.damage_type, damageSide: r.damage_side,
  damagePosition: r.damage_position, adasRequired: r.adas_required, status: r.status,
  technicianId: r.technician_id, notes: r.notes, paymentType: r.payment_type,
  insuranceCo: r.insurance_co, claimNo: r.claim_no,
  photosBefore: r.photos_before || [], photosAfter: r.photos_after || [],
  createdAt: r.created_at,
});

const invoiceToDb = i => ({
  id: i.id, job_id: i.jobId, labour: i.labour, parts: i.parts, vat: !!i.vat,
  total: i.total, paid: !!i.paid, paid_date: i.paidDate,
  created_at: i.createdAt || new Date().toISOString(),
});
const invoiceFromDb = r => ({
  id: r.id, jobId: r.job_id, labour: r.labour, parts: r.parts, vat: r.vat,
  total: r.total, paid: r.paid, paidDate: r.paid_date, createdAt: r.created_at,
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
  return {
    customers:   (c.data || []).map(customerFromDb),
    vehicles:    (v.data || []).map(vehicleFromDb),
    jobs:        (j.data || []).map(jobFromDb),
    invoices:    (i.data || []).map(invoiceFromDb),
    technicians: [],
  };
}

// ── Push entire local dataset to Supabase (upsert) ──────────────────────────
export async function pushToCloud(data) {
  const ops = [];
  if (data.customers?.length) ops.push(supabase.from("customers").upsert(data.customers.map(customerToDb)));
  if (data.vehicles?.length)  ops.push(supabase.from("vehicles").upsert(data.vehicles.map(vehicleToDb)));
  if (data.jobs?.length)      ops.push(supabase.from("jobs").upsert(data.jobs.map(jobToDb)));
  if (data.invoices?.length)  ops.push(supabase.from("invoices").upsert(data.invoices.map(invoiceToDb)));
  const results = await Promise.all(ops);
  const err = results.find(r => r.error);
  if (err) throw err.error;
}

// ── Push a single record ────────────────────────────────────────────────────
export async function upsertRecord(table, record) {
  const map = { customers: customerToDb, vehicles: vehicleToDb, jobs: jobToDb, invoices: invoiceToDb };
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

// Edge Function : send-payroll-reminders
// Envoie un mail de rappel aux employes qui n'ont pas complete leur pointage
// X jours ouvrables avant la fin du cycle de paie en cours.
//
// Declenchement : pg_cron quotidien (08:00 America/Toronto)
// Provider mail : Resend (RESEND_API_KEY a stocker dans Supabase Secrets)
//
// Body POST optionnel :
//   { "dryRun": true }         → simule sans envoyer
//   { "testEmail": "x@y.com" } → envoi unique de test a cette adresse

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.7';

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!;
const SERVICE_ROLE = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
const RESEND_KEY   = Deno.env.get('RESEND_API_KEY') || '';

const sb = createClient(SUPABASE_URL, SERVICE_ROLE, { auth: { persistSession: false } });

// ─── Helpers dates ouvrables ──────────────────────────────────────
const TZ = 'America/Toronto';
function nowInTZ(): Date {
  // Pseudo : on prend l'heure UTC et on l'utilise telle quelle.
  // Pour l'instant on assume serveur en UTC ; la conversion pour log est OK.
  return new Date();
}
function isWeekend(d: Date) { const w = d.getDay(); return w === 0 || w === 6; }
function addDays(d: Date, n: number) { const x = new Date(d.getTime()); x.setUTCDate(x.getUTCDate() + n); return x; }
function isoDay(d: Date) { return d.toISOString().substring(0, 10); }
function countBusinessDays(from: Date, to: Date) {
  let n = 0; let d = new Date(from.getTime()); d.setUTCHours(0,0,0,0);
  const end = new Date(to.getTime()); end.setUTCHours(0,0,0,0);
  while (d <= end) { if (!isWeekend(d)) n++; d = addDays(d, 1); }
  return n;
}
function businessDaysBetween(from: Date, to: Date): Date[] {
  const out: Date[] = []; let d = new Date(from.getTime()); d.setUTCHours(0,0,0,0);
  const end = new Date(to.getTime()); end.setUTCHours(0,0,0,0);
  while (d <= end) { if (!isWeekend(d)) out.push(new Date(d.getTime())); d = addDays(d, 1); }
  return out;
}
function currentPayCycle(startStr: string, len: number) {
  const anchor = new Date(startStr + 'T00:00:00Z');
  const today = new Date(); today.setUTCHours(0,0,0,0);
  const diff = Math.floor((today.getTime() - anchor.getTime()) / 86400000);
  const cycles = Math.floor(diff / len);
  const start = addDays(anchor, cycles * len);
  const end = addDays(start, len - 1);
  return { start, end };
}

// ─── Lecture config rh_config ─────────────────────────────────────
async function readConfig() {
  const { data, error } = await sb.from('rh_config').select('cle,valeur');
  if (error) throw error;
  const m: Record<string,string> = {};
  for (const r of (data || [])) m[r.cle] = r.valeur;
  return {
    enabled:    m.alerts_enabled === 'true',
    daysBefore: parseInt(m.alerts_days_before) || 3,
    hour:       m.alerts_hour || '08:00',
    threshold:  parseFloat(m.alerts_threshold) || 0,
    exclude:    (m.alerts_exclude || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
    fromAddr:   m.alerts_from || 'RH <onboarding@resend.dev>',
    ccAddr:     m.alerts_cc || '',
    subject:    m.alerts_subject || 'Rappel : pointage à compléter avant le {{date_fin}}',
    body:       m.alerts_body || 'Bonjour {{prenom}},\n\nVotre pointage est incomplet.\n\nCordialement,\nRH',
    cycleStart: m.paie_cycle_start || '',
    cycleDays:  parseInt(m.paie_cycle_jours) || 14
  };
}

// ─── Resend ───────────────────────────────────────────────────────
async function sendViaResend(to: string, cc: string, from: string, subject: string, html: string, text: string) {
  if (!RESEND_KEY) throw new Error('RESEND_API_KEY non configurée');
  const body: Record<string, unknown> = { from, to, subject, text, html };
  if (cc) body.cc = cc;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { 'Authorization': 'Bearer ' + RESEND_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Resend ' + r.status + ': ' + (j.message || JSON.stringify(j)));
  return j.id as string;
}

function fmtFR(d: Date) {
  return String(d.getUTCDate()).padStart(2,'0') + '/' +
         String(d.getUTCMonth()+1).padStart(2,'0') + '/' +
         d.getUTCFullYear();
}
function fill(tpl: string, vars: Record<string,string>) {
  return tpl.replace(/\{\{(\w+)\}\}/g, (_, k) => vars[k] ?? `{{${k}}}`);
}

// ─── Main ─────────────────────────────────────────────────────────
Deno.serve(async (req) => {
  // CORS basique
  const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS'
  };
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });

  let payload: { dryRun?: boolean; testEmail?: string } = {};
  try { payload = await req.json(); } catch {}
  const dryRun = !!payload.dryRun;
  const testEmail = payload.testEmail || '';

  try {
    const cfg = await readConfig();

    // Mode test : envoi unique a testEmail
    if (testEmail) {
      const vars = {
        prenom: 'Test', nom: 'Utilisateur',
        date_fin: fmtFR(new Date()), jours_restants: '2',
        h_manquantes: '14', jours_sans_pointage: '2'
      };
      const sub = '[TEST] ' + fill(cfg.subject, vars);
      const body = fill(cfg.body, vars);
      const html = body.replace(/\n/g,'<br>');
      const id = await sendViaResend(testEmail, '', cfg.fromAddr, sub, html, body);
      return new Response(JSON.stringify({ ok:true, mode:'test', to:testEmail, id }), {
        headers: { ...corsHeaders, 'Content-Type':'application/json' }
      });
    }

    // Mode normal : check enabled + cycle window
    if (!cfg.enabled) {
      return new Response(JSON.stringify({ ok:true, skipped:'disabled' }), { headers: { ...corsHeaders, 'Content-Type':'application/json' } });
    }
    if (!cfg.cycleStart) {
      return new Response(JSON.stringify({ ok:false, error:'paie_cycle_start manquant' }), { status:400, headers: { ...corsHeaders, 'Content-Type':'application/json' } });
    }

    const cycle = currentPayCycle(cfg.cycleStart, cfg.cycleDays);
    const today = new Date(); today.setUTCHours(0,0,0,0);
    const bizDaysUntilEnd = countBusinessDays(today, cycle.end) - 1;
    const inWindow = (today <= cycle.end) && (bizDaysUntilEnd < cfg.daysBefore);
    if (!inWindow) {
      return new Response(JSON.stringify({ ok:true, skipped:'out_of_window', bizDaysUntilEnd }), { headers: { ...corsHeaders, 'Content-Type':'application/json' } });
    }

    // Charger employes actifs (hors direction + exclusions) + horaires du cycle
    const { data: emps } = await sb.from('rh_employes')
      .select('nom,email,statut,actif,heures_semaine')
      .eq('actif', true);
    const fromIso = isoDay(cycle.start);
    const toIso   = isoDay(cycle.end);
    const { data: hor } = await sb.from('rh_horaires')
      .select('nom,date_pointage,debut,fin,type_jour')
      .gte('date_pointage', fromIso).lte('date_pointage', toIso);
    const byEmp: Record<string, any[]> = {};
    for (const r of (hor || [])) (byEmp[r.nom] = byEmp[r.nom] || []).push(r);

    const bizDaysInCycle = businessDaysBetween(cycle.start, today);
    const sent: any[] = [];
    const skipped: any[] = [];

    for (const e of (emps || [])) {
      const emailLower = (e.email || '').toLowerCase();
      if (!emailLower) { skipped.push({nom:e.nom, reason:'no_email'}); continue; }
      if ((e.statut || '').toLowerCase() === 'direction') { skipped.push({nom:e.nom, reason:'direction'}); continue; }
      if (cfg.exclude.indexOf(emailLower) >= 0) { skipped.push({nom:e.nom, reason:'excluded'}); continue; }
      const rows = byEmp[e.nom] || [];
      const pointed: Record<string, true> = {};
      for (const r of rows) {
        if (r.debut && r.fin) pointed[r.date_pointage] = true;
        else if (r.type_jour && r.type_jour !== 'work') pointed[r.date_pointage] = true;
      }
      const bizExpected = bizDaysInCycle.length;
      const bizDone = bizDaysInCycle.filter(d => pointed[isoDay(d)]).length;
      const missingDays = bizExpected - bizDone;
      if (missingDays <= 0) { skipped.push({nom:e.nom, reason:'ok'}); continue; }
      const perDay = e.heures_semaine ? (parseFloat(e.heures_semaine) / 5) : 7;
      const missingH = Math.round(missingDays * perDay * 10) / 10;
      if (missingH < cfg.threshold) { skipped.push({nom:e.nom, reason:'below_threshold', missingH}); continue; }

      const vars = {
        prenom: (e.nom || '').split(' ')[0],
        nom: e.nom,
        date_fin: fmtFR(cycle.end),
        jours_restants: String(bizDaysUntilEnd),
        h_manquantes: String(missingH),
        jours_sans_pointage: String(missingDays)
      };
      const sub = fill(cfg.subject, vars);
      const text = fill(cfg.body, vars);
      const html = text.replace(/\n/g, '<br>');

      if (dryRun) {
        sent.push({ nom:e.nom, email:e.email, missingDays, missingH, dryRun:true });
        continue;
      }
      try {
        const id = await sendViaResend(e.email, cfg.ccAddr, cfg.fromAddr, sub, html, text);
        sent.push({ nom:e.nom, email:e.email, missingDays, missingH, id });
        await sb.from('rh_alert_log').insert({
          sent_at: new Date().toISOString(), employee_email: e.email,
          status: 'sent', provider_id: id, missing_days: missingDays, missing_hours: missingH
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        sent.push({ nom:e.nom, email:e.email, error: msg });
        await sb.from('rh_alert_log').insert({
          sent_at: new Date().toISOString(), employee_email: e.email,
          status: 'error', error_msg: msg, missing_days: missingDays, missing_hours: missingH
        });
      }
    }

    // Mettre a jour le compteur dernier envoi
    if (!dryRun) {
      const realSent = sent.filter(s => s.id).length;
      await sb.from('rh_config').upsert(
        [{cle:'alerts_last_run_at', valeur:new Date().toISOString(), categorie:'alertes'},
         {cle:'alerts_last_run_count', valeur:String(realSent), categorie:'alertes'}],
        { onConflict: 'cle' }
      );
    }

    return new Response(JSON.stringify({
      ok:true, dryRun, cycle: { start: isoDay(cycle.start), end: isoDay(cycle.end) },
      bizDaysUntilEnd, sentCount: sent.length, sent, skippedCount: skipped.length
    }, null, 2), { headers: { ...corsHeaders, 'Content-Type':'application/json' } });

  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return new Response(JSON.stringify({ ok:false, error: msg }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type':'application/json' }
    });
  }
});

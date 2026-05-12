# Rappels automatiques de pointage — Guide de setup

Ce document décrit comment activer l'envoi automatique des mails de rappel
aux employés qui n'ont pas complété leur pointage X jours ouvrables avant la
fin du cycle de paie.

## Vue d'ensemble

```
┌──────────────────┐    08:00 quotidien    ┌──────────────────────────┐
│   pg_cron        │ ────────────────────→ │  Edge Function           │
│   (Supabase)     │                       │  send-payroll-reminders  │
└──────────────────┘                       └──────────────────────────┘
                                                       │
                                              lit rh_config
                                              calcule cycle de paie
                                              identifie employes en retard
                                                       │
                                                       ▼
                                           ┌──────────────────┐
                                           │   Resend API     │
                                           │ (envoi des mails)│
                                           └──────────────────┘
                                                       │
                                                  log dans
                                                  rh_alert_log
```

## Phase 1 — Déjà fait (côté code)
- [x] Interface de configuration dans **Paramètres → Rappels automatiques**
- [x] Persistance config dans `rh_config` (clés `alerts_*`)
- [x] Bouton **Simuler aujourd'hui** (fonctionne déjà sans Resend)
- [x] Edge Function `supabase/functions/send-payroll-reminders/index.ts`
- [x] Table `rh_alert_log` (migration appliquée)

## Phase 2 — À faire pour activer l'envoi réel

### Étape 1 — Créer un compte Resend

1. Aller sur https://resend.com/signup
2. Créer un compte (gratuit jusqu'à 3 000 mails / mois)
3. Aller dans **API Keys** → **Create API Key**
4. Donner un nom (ex. `espacemuni-rappels`) et permissions **Full access**
5. **Copier la clé** (commence par `re_...`) — elle ne sera plus affichée

### Étape 2 — (Optionnel mais recommandé) Vérifier un domaine

Sans vérification, les mails partent depuis `onboarding@resend.dev` et sont
souvent flagués comme spam. Pour utiliser une adresse `rh@espacemuni.qc.ca` :

1. Resend → **Domains** → **Add Domain** → entrer `espacemuni.qc.ca`
2. Ajouter les enregistrements DNS (TXT, MX, DKIM) dans la zone DNS du domaine
3. Cliquer **Verify** dans Resend (5–15 min après ajout DNS)

### Étape 3 — Stocker la clé dans Supabase Secrets

```bash
# Avec le Supabase CLI
supabase secrets set RESEND_API_KEY=re_xxxxxxxxxx --project-ref xecfsdtzdxzmurwfdile
```

Ou via le dashboard :
**Supabase → Project Settings → Edge Functions → Secrets**
→ ajouter `RESEND_API_KEY` = `re_xxxxxxxxxx`

### Étape 4 — Déployer l'Edge Function

```bash
# Depuis la racine du repo
supabase functions deploy send-payroll-reminders --project-ref xecfsdtzdxzmurwfdile
```

Si tu n'as pas le CLI Supabase, voir https://supabase.com/docs/guides/cli

### Étape 5 — Test manuel de la fonction

Une fois déployée, tester sans envoi réel :

```bash
curl -X POST "https://xecfsdtzdxzmurwfdile.supabase.co/functions/v1/send-payroll-reminders" \
  -H "Authorization: Bearer <SUPABASE_ANON_KEY>" \
  -H "Content-Type: application/json" \
  -d '{"dryRun": true}'
```

Réponse attendue : JSON avec `cycle`, `bizDaysUntilEnd`, `sentCount`, et liste
des employés qui auraient reçu un mail.

Puis test avec envoi unique à toi-même :

```bash
curl -X POST "..." -d '{"testEmail": "info@dk-communication.com"}'
```

### Étape 6 — Activer pg_cron pour l'envoi quotidien

Dans **Supabase → SQL Editor**, exécuter :

```sql
-- Activer l'extension pg_cron (une seule fois)
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Programmer l'envoi quotidien a 12:00 UTC = 08:00 America/Toronto (hors DST)
-- Adapter l'heure selon le besoin et la saison (DST)
SELECT cron.schedule(
  'send-payroll-reminders-daily',
  '0 12 * * *',  -- minute heure jour mois jour-de-semaine
  $$
  SELECT net.http_post(
    url := 'https://xecfsdtzdxzmurwfdile.supabase.co/functions/v1/send-payroll-reminders',
    headers := jsonb_build_object(
      'Content-Type', 'application/json',
      'Authorization', 'Bearer ' || current_setting('app.settings.service_role_key', true)
    ),
    body := '{}'::jsonb
  );
  $$
);

-- Verifier que le cron est cree
SELECT * FROM cron.job WHERE jobname = 'send-payroll-reminders-daily';
```

Pour la **clé service_role**, il faut soit :
- la stocker dans `app.settings.service_role_key` (config DB)
- soit l'inliner directement dans le body du cron (moins propre)

Note : si tu préfères ne pas gérer pg_cron, alternative = **GitHub Actions cron**
qui appelle l'Edge Function tous les jours.

### Étape 7 — Activer dans l'UI

1. Se connecter au portail
2. **Paramètres → Rappels automatiques**
3. Activer le toggle "Activer les rappels automatiques"
4. Configurer délai (3 jours), heure (08:00), seuil, exclusions
5. Cliquer **Sauvegarder**
6. Cliquer **Simuler aujourd'hui** pour valider
7. Cliquer **Envoyer test** pour recevoir un mail de test (passera par Resend une fois la fonction déployée)

## Surveillance

- **Logs Edge Function** : Supabase → Edge Functions → send-payroll-reminders → Logs
- **Historique des envois** : table `rh_alert_log` (chaque envoi y est tracé)
- **Resend dashboard** : statut delivered / bounced / complained de chaque mail

```sql
-- Voir les derniers envois
SELECT sent_at, employee_email, status, missing_days, missing_hours, error_msg
FROM rh_alert_log
ORDER BY sent_at DESC
LIMIT 50;
```

## Sécurité

- La clé Resend ne quitte jamais Supabase (stockée dans secrets, accédée
  uniquement par l'Edge Function côté serveur)
- Le portail web (HTML public sur GitHub Pages) ne peut pas envoyer de mail
  directement — uniquement déclencher l'Edge Function avec le bon token
- La fonction respecte `alerts_enabled = false` (kill switch côté config)
- Les employés avec `statut = 'Direction'` ou `actif = false` sont exclus par défaut

## Coût

- **Resend** : gratuit jusqu'à 3 000 mails/mois, puis 20 $/mois pour 50 000
- **Supabase Edge Functions** : 500 000 invocations gratuites/mois
- **pg_cron** : inclus dans Supabase
- À 16 employés × 4 jours de rappel × 26 cycles/an ≈ 1 700 mails/an → **gratuit**

## Désactivation

À tout moment, désactiver le toggle "Activer les rappels automatiques" dans
les Paramètres. Aucun envoi ne sera fait, même si pg_cron déclenche la fonction.

Pour stopper complètement le cron :
```sql
SELECT cron.unschedule('send-payroll-reminders-daily');
```

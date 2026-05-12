# Sécurité — Portail RH Espace Muni

## Vue d'ensemble

Le portail RH manipule des données sensibles (salaires, photos, contacts).
La sécurité repose sur 3 couches :

1. **Authentification** : Supabase Auth (email + mot de passe + JWT)
2. **Autorisation côté DB** : Row Level Security (RLS) Postgres
3. **Protection côté frontend** : échappement HTML, pas de secrets

## Phase 1 — Sécurité active (mise en place)

### 1.1 Row Level Security (RLS) strictes

Avant Phase 1 : les politiques étaient `USING (true)` → n'importe quel utilisateur authentifié pouvait tout lire et tout écrire.

Maintenant :

| Table | SELECT | INSERT / UPDATE / DELETE |
|---|---|---|
| `rh_employes` | Tous authenticated | Admin uniquement |
| `rh_horaires` | Tous authenticated | Admin OU l'employé lui-même |
| `rh_config` | Tous authenticated | Admin uniquement |
| `rh_departements` | Tous authenticated | Admin uniquement |
| `rh_types_poste` | Tous authenticated | Admin uniquement |
| `rh_admins` | Admin uniquement | Admin uniquement |
| `rh_alert_log` | Admin uniquement | Tous authenticated (Edge Function) |

**Admin = `is_admin()`** retourne true si :
- l'utilisateur connecté a `statut = 'Direction'` dans `rh_employes` (et `actif = true`)
- OU son email est dans la table `rh_admins` (consultants externes)

### 1.2 Table `rh_admins`

Nouvelle table pour les **super-admins externes** (consultants, devs) qui ne sont pas employés mais ont besoin d'un accès total :

```sql
CREATE TABLE rh_admins (
  email text PRIMARY KEY,
  notes text,
  created_at timestamptz DEFAULT now()
);
```

Pour ajouter un nouvel admin externe :

```sql
INSERT INTO rh_admins (email, notes) VALUES ('admin@exemple.com', 'Note explicative');
```

Pour retirer un admin :

```sql
DELETE FROM rh_admins WHERE email = 'admin@exemple.com';
```

### 1.3 Signup public désactivé

Avant : n'importe qui pouvait cliquer « Créer un compte » sur le portail, créer un compte Supabase Auth et accéder aux données.

Maintenant :
- Le formulaire de signup est retiré du HTML
- La fonction `authSignup()` est neutralisée côté JS (affiche un message d'erreur)

**Action complémentaire recommandée (manuelle)** :
Désactiver aussi le signup au niveau Supabase pour bloquer toute tentative via l'API :
1. Aller sur https://supabase.com/dashboard/project/xecfsdtzdxzmurwfdile/auth/providers
2. Section **Email** → décocher « **Allow new users to sign up** »
3. Save

Ainsi, même un appel direct à `POST /auth/v1/signup` sera refusé.

### 1.4 Création de comptes (procédure)

Pour créer le compte d'un nouvel employé :

1. **Supabase Dashboard** → Authentication → Users → **Add user** → Create new user
2. Renseigner email + mot de passe temporaire
3. Cocher « **Auto Confirm User** » (pour éviter l'email de vérification)
4. **Lier l'employé** : dans la table `rh_employes`, vérifier que `email` du nouvel employé = email du compte Supabase Auth
5. Communiquer le mot de passe temporaire à l'employé (qui le changera au premier login)

### 1.5 Protection XSS (Cross-Site Scripting)

Helper `esc()` ajouté qui échappe `& < > " '`. Appliqué sur :
- Affichage des noms / postes / départements dans le Répertoire et fiche employé
- Email et téléphone (avec aussi `encodeURIComponent` pour les liens mailto/tel)
- Alertes Dashboard
- Liste des employés en retard dans la modale de simulation

**À faire pour les évolutions** : appliquer `esc()` sur toute donnée venant de la DB injectée dans `innerHTML` ou attributs HTML.

## Phase 2 — Recommandations restantes (non implémentées)

### 2.1 Leaked Password Protection (manuel)

Activer la protection HaveIBeenPwned dans Supabase :
- https://supabase.com/dashboard/project/xecfsdtzdxzmurwfdile/auth/policies
- Section « Auth Settings » → activer « Leaked password protection »

### 2.2 Bucket photos — désactiver le listing

Le bucket `employee-photos` est public et permet le listing de tous les fichiers. Pas critique mais à corriger :

```sql
-- Remplacer la politique SELECT large par une politique sur object_id specifique
DROP POLICY employee_photos_select ON storage.objects;
CREATE POLICY employee_photos_select ON storage.objects
  FOR SELECT TO public
  USING (bucket_id = 'employee-photos' AND name IS NOT NULL);
-- (Adapter selon le pattern reel des noms de fichiers)
```

### 2.3 Audit log (futur)

Pour tracer qui modifie quoi, créer un trigger sur les tables sensibles :

```sql
CREATE TABLE rh_audit_log (
  id bigserial PRIMARY KEY,
  table_name text,
  operation text,
  changed_by text,
  changed_at timestamptz DEFAULT now(),
  old_data jsonb,
  new_data jsonb
);

-- Trigger sur rh_employes et rh_config (à créer)
```

### 2.4 2FA / TOTP

Supabase Auth supporte le 2FA TOTP. À activer pour les comptes Direction.

### 2.5 Rate limiting custom

Supabase a un rate limiting de base sur Auth, mais pas sur l'API REST. Pour brute-force protection avancée, prévoir un middleware via Edge Function.

## Tests de sécurité (à refaire après chaque évolution)

### Test 1 — Un employé non-admin ne peut pas modifier les données d'autres employés

```js
// Se connecter en tant qu'employé non-Direction
// Ouvrir la console et essayer :
fetch(SUPA.url+'/rest/v1/rh_employes?nom=eq.Jean', {
  method:'PATCH',
  headers:{'apikey':SUPA.key,'Authorization':'Bearer '+SUPA.tok,'Content-Type':'application/json'},
  body:'{"salaire":999999}'
}).then(r=>r.text()).then(console.log);
// → DOIT retourner une erreur RLS, pas modifier le salaire
```

### Test 2 — Un employé peut modifier ses propres horaires uniquement

```js
fetch(SUPA.url+'/rest/v1/rh_horaires?employe=eq.SonNom&date_pointage=eq.2026-05-01', {
  method:'PATCH',
  headers:{'apikey':SUPA.key,'Authorization':'Bearer '+SUPA.tok,'Content-Type':'application/json'},
  body:'{"debut":"09:00","fin":"17:00"}'
});
// → OK
fetch(SUPA.url+'/rest/v1/rh_horaires?employe=eq.AutreNom&date_pointage=eq.2026-05-01', {
  method:'PATCH',
  headers:{'apikey':SUPA.key,'Authorization':'Bearer '+SUPA.tok,'Content-Type':'application/json'},
  body:'{"debut":"00:00","fin":"23:59"}'
});
// → REFUS (RLS)
```

### Test 3 — Signup bloqué

Ouvrir https://dk-comm.github.io/portail-rh/ → vérifier que le lien « Créer un compte » a disparu.
Tester en console :
```js
fetch(SUPA.url+'/auth/v1/signup',{method:'POST',headers:{'apikey':SUPA.key,'Content-Type':'application/json'},body:'{"email":"test@malicious.com","password":"Test12345"}'}).then(r=>r.json()).then(console.log);
```
→ Si « Allow new users to sign up » est désactivé dans Supabase Dashboard, retourne une erreur. Sinon, le compte se crée mais l'utilisateur ne peut rien lire/modifier (grâce aux RLS strictes).

## Contact sécurité

Pour toute question ou incident de sécurité, contacter info@dk-communication.com.

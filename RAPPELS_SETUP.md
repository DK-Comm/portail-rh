# Rappels de pointage — Guide

## Mode de fonctionnement actuel : Outlook (mailto)

Aucune dépendance externe — le portail prépare les mails et ouvre votre
Outlook avec tout pré-rempli. Vous validez et envoyez.

### Utilisation

1. **Paramètres → Rappels de pointage**
2. Activer le toggle « Activer le module de rappels »
3. Configurer :
   - Fenêtre de rappel (jours ouvrables avant fin de cycle)
   - Seuil heures manquantes
   - Exclusions
   - Modèle groupé (BCC, message commun)
   - Modèle individuel (personnalisé par employé)
4. **Sauvegarder**

### Envoyer les rappels

1. Cliquer **« Voir qui est en retard »**
2. La liste des employés concernés s'affiche, avec :
   - Bouton **« Envoyer rappel groupé (BCC) »** : ouvre un seul mail Outlook
     avec tous les retardataires en BCC (confidentialité préservée — chacun
     ne voit que lui)
   - Bouton **« ✉ Envoyer »** à côté de chaque employé : ouvre un mail
     Outlook personnalisé pour cet employé uniquement
3. Outlook s'ouvre avec le mail pré-rempli — il vous suffit de valider

### Variables disponibles

**Modèle individuel** :
- `{{prenom}}` — Prénom de l'employé
- `{{nom}}` — Nom complet
- `{{date_fin}}` — Date de fin du cycle de paie en cours
- `{{jours_restants}}` — Nombre de jours ouvrables restants
- `{{h_manquantes}}` — Heures manquantes estimées
- `{{jours_sans_pointage}}` — Nombre de jours non pointés

**Modèle groupé** :
- `{{date_fin}}` uniquement (le mail est commun, pas de variables individuelles)

### Confidentialité

Le mail groupé met les destinataires en **BCC** (Cci) — chaque employé ne voit
que sa propre adresse, jamais celle des autres retardataires.

Le mail individuel n'a qu'un seul destinataire.

### Limites de mailto:

- Outlook peut tronquer les mailto: très longs (>2000 caractères selon la
  version). Si le mail groupé contient beaucoup de destinataires + corps long,
  préférer le mode individuel.
- Le module signale automatiquement si le mailto: dépasse 1900 caractères.

---

## Alternative : envoi 100 % automatique (Phase 2 optionnelle)

Si à terme vous voulez supprimer le clic manuel et avoir un envoi vraiment
automatique (ex : tous les jours à 8h00), l'infrastructure est prête dans le
repo :

- `supabase/functions/send-payroll-reminders/index.ts` — Edge Function Deno
- Table `rh_alert_log` déjà créée (historique des envois)

Cela nécessite un service d'envoi mail. Options possibles :

### Option A — Microsoft Graph API (Espace Muni a Microsoft 365)
Utiliser l'API officielle Microsoft pour envoyer depuis une boîte
`rh@espacemuni.qc.ca`. Setup plus complexe (Azure App Registration, OAuth,
permissions `Mail.Send`).

### Option B — Resend (gratuit jusqu'à 3 000 mails/mois)
Setup simple (API key), envoi depuis un domaine vérifié.

### Option C — Power Automate (inclus dans Microsoft 365 entreprise)
Workflow no-code qui écoute un webhook et envoie via Outlook intégré.

Pour activer une de ces options : ouvrir un ticket, on en discute.

---

## Désactivation

Le toggle dans **Paramètres → Rappels de pointage** désactive complètement le
module. Aucun bouton ne sera plus utilisable.

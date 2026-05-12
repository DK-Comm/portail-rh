# Historique versionné des employés (SCD Type 2)

## Concept

Le portail RH utilise un système de **slowly changing dimension (SCD) type 2** pour
historiser les changements de salaire, heures/semaine, statut, département, etc.
Chaque modification crée une nouvelle ligne dans `rh_employes_history` avec une
**date d'effet** (`valid_from`), au lieu d'écraser la valeur précédente.

Résultat : les rapports rétrospectifs sont **exacts** même si un employé a changé
de salaire ou d'heures en cours d'année.

## Architecture

### Table `rh_employes_history`

```
id          uuid PK
employe_id  uuid FK → rh_employes.id (CASCADE)
nom         text     -- denormalize pour query simple
champ       text     -- 'heures_semaine','salaire','type_salaire','charges_pct',
                     --  'statut','departement','poste','type_poste'
valeur      text     -- nouvelle valeur (text pour generalite)
valid_from  date     -- a partir de quand cette valeur s'applique
changed_at  timestamptz DEFAULT now()
changed_by  text     -- email du user qui a fait le changement
```

**Immuable** : pas d'UPDATE ni DELETE. Les RLS bloquent ces opérations.

### Fonction `get_emp_value_at(nom, champ, date)`

SQL helper : retourne la valeur du champ qui était en cours pour cet employé à
la date donnée.

```sql
SELECT public.get_emp_value_at('Karine Jehelmann', 'salaire', '2026-03-15');
```

### Helpers JavaScript (côté client)

- `loadHistoryCache()` — charge tout l'historique en mémoire (cache singleton)
- `histValueAt(nom, champ, dateISO, fallback)` — lookup en O(log n) par nom+champ
- `histHSemAtMonth(nom, y, m, fallback)` — raccourci pour heures/semaine au 1er du mois
- `histSalaryAtMonth(nom, y, m, fallback)` — raccourci pour salaire au 1er du mois
- `invalidateHistoryCache()` — à appeler après modification (déjà fait dans `saveEmp`)

## Comment ça fonctionne

### Au login / au chargement
1. Tu te connectes
2. Quand tu ouvres une page qui en a besoin (Dashboard, Fiche, KPI, Récap, Paie),
   `loadHistoryCache()` est appelé automatiquement → l'historique est chargé en mémoire
3. Tous les calculs utilisent les valeurs **valides à la date concernée**

### Lors d'une modification employé

1. Tu ouvres la fiche d'un employé via le Répertoire
2. Tu modifies un champ (ex : heures/semaine 20h → 37.5h)
3. **Tu choisis la date d'effet** (champ jaune en bas de la modale) — par défaut aujourd'hui
4. Tu cliques Enregistrer
5. Le système :
   - Met à jour `rh_employes` (valeur courante)
   - Insère une ligne dans `rh_employes_history` avec `valid_from = date d'effet`
   - Invalide le cache historique pour le recharger

### Exemple concret

Karine passe de 20h/sem à 37.5h/sem le **1er juin 2026**.

1. Tu vas dans Répertoire → édite Karine
2. Tu changes "H/semaine" : 20 → 37.5
3. Tu mets "Date d'effet" : **2026-06-01**
4. Enregistrer

Résultat : la table d'historique a 2 lignes pour Karine sur `heures_semaine` :

| valid_from | valeur |
|---|---|
| 2026-01-01 | 20 (seed initial) |
| 2026-06-01 | 37.5 (ton changement) |

**Lecture des rapports** :
- Mois de mars 2026 → cible Karine = 20 × 4.33 = **86.6h**
- Mois de juin 2026 → cible Karine = 37.5 × 4.33 = **162.5h**

Les KPIs, alertes, % objectif tiennent compte de ce changement automatiquement.

## Calculs impactés

| Page | Calcul | Date de référence |
|---|---|---|
| **Dashboard direction** | Cible mensuelle équipe | `d1` (début de période) |
| **Mon résumé** | Cible mensuelle individuelle | 1er du mois |
| **Fiche employé** | Cible mensuelle (par mois) + total annuel | 1er de chaque mois |
| **KPI (annuel)** | Cible annuelle = somme cibles mensuelles | 1er de chaque mois |
| **KPI Heures supp** | Cible mensuelle pour heures supp | 1er de chaque mois |
| **KPI ETP** | Cible annuelle | Somme |
| **Récap mensuel** | Couleur cellule (rouge/vert) | 1er de chaque mois |
| **Paie** | Salaire + type_salaire + charges + heures_semaine | `d1` (début du cycle de paie) |

## Modal historique

Bouton **« 📚 Voir l'historique des changements »** sur la Fiche employé.

Affiche une **timeline groupée par champ** (heures_semaine, salaire, etc.) avec :
- La valeur en cours (badge vert)
- L'historique complet (qui a changé, quand, valeur à partir de quand)

## Migration initiale (déjà appliquée)

Au moment de l'activation (12 mai 2026), une **baseline** a été créée pour
les 16 employés existants : pour chaque champ historisé, une ligne avec
`valid_from = 2026-01-01` et la valeur actuelle.

→ Résultat : 16 employés × 8 champs = **128 lignes initiales** dans
`rh_employes_history`. Sans cela, `histValueAt()` retournerait NULL pour
les dates antérieures au premier changement enregistré.

## Cas particuliers

### Création d'un nouvel employé
- L'INSERT dans `rh_employes` ajoute la fiche
- Une ligne par champ historisé est aussi insérée dans `rh_employes_history`
  avec `valid_from = aujourd'hui` (ou la date choisie dans la modale)

### Suppression d'un employé
- ON DELETE CASCADE : les lignes d'historique de cet employé sont aussi supprimées
- ⚠️ Pour préserver l'historique d'audit, **désactiver** l'employé plutôt que le supprimer
  (champ `actif = false` ou ban Supabase Auth)

### Renommage d'un employé
- L'historique utilise `nom` comme clé de jointure (denormalize)
- Si tu changes le nom, l'historique ancien restera sous l'ancien nom
- ⚠️ Éviter de renommer un employé. Si vraiment nécessaire, faire un UPDATE
  manuel sur `rh_employes_history` pour aligner les `nom`.

## Bonnes pratiques

1. **Toujours mettre la bonne date d'effet** lors d'une modification
   - Promotion au 1er juin → date d'effet = 2026-06-01 (pas la date d'aujourd'hui)
2. **Utiliser le modal Historique** avant un changement pour vérifier
3. **Documenter via `changed_by`** : ton email est automatiquement enregistré
4. **Préférer une nouvelle ligne** plutôt qu'écraser une ligne existante (immuable)

## Reporting avancé (SQL direct)

Voir l'historique complet d'un employé :
```sql
SELECT champ, valeur, valid_from, changed_by
FROM rh_employes_history
WHERE nom = 'Karine Jehelmann'
ORDER BY champ, valid_from DESC;
```

Quel était le salaire de chaque employé le 1er mars 2026 ?
```sql
SELECT nom, get_emp_value_at(nom, 'salaire', '2026-03-01') AS salaire_au_1_mars
FROM rh_employes
WHERE actif = true
ORDER BY nom;
```

Tous les changements de salaire en 2026 :
```sql
SELECT nom, valeur, valid_from, changed_by
FROM rh_employes_history
WHERE champ = 'salaire'
  AND valid_from >= '2026-01-01'
  AND changed_by != 'system-seed'
ORDER BY valid_from;
```

## Limitations connues

1. **Historique sur le `nom` lui-même** : pas historisé (le nom n'est pas dans la liste
   des champs historisables). Si un employé se marie et change de nom, il faut faire
   un UPDATE manuel sur les anciennes lignes pour aligner.

2. **Pas de visualisation rétrospective de la liste complète** : tu ne peux pas dire
   "donne-moi la fiche employé telle qu'elle était le 1er mars" — il faut interroger
   champ par champ.

3. **Performance** : tout l'historique est chargé en cache au 1er besoin. Si la table
   dépasse 100k lignes (10+ ans pour 30 employés avec changements fréquents), il
   faudra paginer ou charger uniquement les employés actifs.

## Valeur ajoutée pour la commercialisation

Cette feature est ce qui sépare un "outil de pointage" d'un vrai SIRH (Système
d'Information RH). Elle permet :
- **Audits comptables** rétrospectifs (exact)
- **Conformité légale** (traces des modifications avec auteur et date)
- **Rapports historiques fiables** (pas de "pourquoi ces chiffres ne correspondent pas ?")
- **Argument de vente fort** vs solutions concurrentes basiques

Tarif marché type pour un SIRH avec historique versionné : **15-40k$** au lieu
de 5-10k$ pour un simple outil de pointage.

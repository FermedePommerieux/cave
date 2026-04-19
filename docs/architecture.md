# Architecture logique

## Vue d'ensemble

Le système repose sur un script Shelly unique qui :

1. lit des capteurs locaux (air + plaque)
2. lit des mesures externes MQTT (température + humidité) si disponibles
3. décide d'un état de régulation sûr
4. commande deux relais (froid/chauffage) avec garde-fous de sécurité
5. publie un état synthétique et des défauts

## Entrées / sorties

### Entrées

- `temperature:100` : température d'air locale (obligatoire)
- `temperature:101` : température plaque froide (sécurité froid)
- MQTT température externe (optionnel)
- MQTT humidité externe (optionnel)

### Sorties

- `switch:0` : compresseur
- `switch:1` : chauffage
- MQTT : état, mode, défauts, fraîcheur capteurs

## Machine à états

États runtime explicites :

- `IDLE` : aucune demande thermique/hygro active
- `COOLING` : demande de refroidissement thermique (air cave)
- `POST_COOL_INERTIA` : observation post-arrêt compresseur pour apprentissage (prioritaire, sorties OFF)
- `HEATING` : protection basse température uniquement
- `DRYING_ACTIVE` : séchage assisté (chauffage air + pilotage plaque)
- `FAULT` : arrêt forcé de tous les actionneurs

## Logique de régulation

### 1) Régulation air cave

- Fallback température : MQTT externe fraîche sinon sonde air locale.
- Chauffage limité à la protection basse température (`HEATING`) hors mode séchage.
- Refroidissement thermique via hystérésis air (`coolOnC` / `coolOffC`).

### 2) Régulation plaque de condensation

- Si humidité MQTT valide, calcul du point de rosée.
- Cible plaque : `plateTargetC = dewPointC - dewTargetMarginC`.
- En `DRYING_ACTIVE`, compresseur piloté d'abord par la cible plaque (hystérésis dédiée).
- Température plaque reste la vérité de sécurité (anti-gel/latch).

### Mode `DRYING_ACTIVE`

- Entrée : humidité valide au-dessus de `rhOn`.
- Sortie : humidité redescendue sous `rhOff` ou humidité invalide/périmée.
- Chauffage piloté par une consigne d'air dédiée (`dryingAirSetpointC`), jamais directement par l'humidité.
- Simultané chauffage + compresseur autorisé **uniquement** dans cet état.
- Si `airC >= hardMaxAirC`, `DRYING_ACTIVE` est suspendu et la priorité passe à `COOLING` (protection ambiance).
- Reprise possible de `DRYING_ACTIVE` seulement après retour sous `dryingResumeBelowHardMaxC` (hystérésis de reprise).

### Inertie post-refroidissement (apprentissage)

- À chaque arrêt compresseur, entrée en suivi `POST_COOL_INERTIA`.
- Tant que ce suivi est actif, il a priorité sur `DRYING_ACTIVE`, `HEATING` et `COOLING`: les sorties restent OFF pour mesurer proprement l'inertie.
- Le script mémorise le minimum plaque après arrêt (`platePostStopMinC`).
- Fin de suivi si la plaque remonte au-dessus du minimum + delta, ou si plus aucun nouveau minimum significatif n'arrive pendant une fenêtre stable, ou au timeout dur.
- Paramètres dédiés: `postCoolMinDeltaC` (nouveau minimum significatif), `postCoolStableWindowS` (fenêtre stable), `inertiaMaxS` (timeout dur).
- Overshoot : `overshootC = plateTargetC - platePostStopMinC`.
- Si `overshootC > 2.0`, réduction de la durée max apprise de cycle de `30s`.
- Initialisation de la durée max apprise à partir d'un cycle où la cible plaque est atteinte.

## Priorités de sécurité

Ordre de priorité :

1. Défaut critique capteur air local => état `FAULT`, tout OFF
2. Protection plaque froide / anti-gel
3. Interdiction simultané chauffage/froid hors `DRYING_ACTIVE`
4. Verrou anti-cycles compresseur (`lockoutS`)
5. Régulation fine thermique/hygrométrique

## Modes dégradés

- Température externe absente/périmée -> fallback air local.
- Humidité externe absente/périmée -> mode température seule (pas de logique point de rosée).
- Capteur plaque absent -> froid interdit (chauffage possible selon sécurité air).

## Philosophie KISS

- Machine à états explicite et télémétrée.
- Hystérésis et seuils lisibles dans `CONFIG`.
- Zéro dépendance runtime externe.
- Décisions critiques tracées (`state` + `fault`) pour exploitation terrain.
- Télémétrie d'arrêt séparée: `cycle_stop_reason` (cause arrêt compresseur), `last_plate_event` (événement plaque), `last_post_cool_finalize_reason` (fin d'inertie).
- Statut humidité explicite dans `state`: disponibilité (`humidity_control_available`), demande (`humidity_demand_active`), requête DRYING (`drying_mode_requested`), blocage (`drying_block_reason`), mode source (`humidity_mode`).

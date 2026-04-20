# Mise en service terrain (checklist validation)

Objectif: valider **sécurité**, **priorités d'état**, **télémétrie** avant exploitation continue.

> Pour chaque étape: exécuter, observer `.../state` et `.../fault`, corriger un seul paramètre à la fois.

## 1) Pre-power checks

- **Action**: vérifier câblage (`switch:0` compresseur, `switch:1` chauffage), protections électriques, flux d'air sur sondes 100/101.
- **Télémétrie**: au boot `fault=BOOT` puis `machine_state` actif, pas de défaut critique.
- **Attendu**: script démarre sans `AIR_SENSOR_MISSING`.
- **Danger/bug**: défaut critique immédiat, relais incohérents.
- **Paramètre à inspecter d'abord**: IDs capteurs/relais dans `CONFIG`.

## 2) Sensor validation

- **Action**: comparer `air_c` et `plate_c` à une référence.
- **Télémétrie**: `air_c`, `plate_c`, `fault`.
- **Attendu**: mesures plausibles et stables.
- **Danger/bug**: valeurs nulles/incohérentes, bruit extrême.
- **Paramètre d'abord**: placement physique sonde (avant tout tuning).

## 3) Output / relay validation

- **Action**: forcer des conditions de chauffe/froid et observer relais.
- **Télémétrie**: `cool_on`, `heat_on`, `machine_state`, `simultaneous_mode_active`.
- **Attendu**: simultané `cool_on=true` + `heat_on=true` **uniquement** en `DRYING_ACTIVE`.
- **Danger/bug**: simultané hors `DRYING_ACTIVE`.
- **Paramètre d'abord**: vérifier logique état et câblage relais.

## 4) Normal thermal cooling validation

- **Action**: sans humidité valide (ou RH stale), faire monter l'air au-dessus `coolOnC`.
- **Télémétrie**: `mode`, `machine_state`, `cool_reason`, `cool_on`.
- **Attendu**: `mode=temp_only`, entrée `COOLING`, arrêt près de `coolOffC`.
- **Danger/bug**: pas d'entrée en refroidissement malgré air haute.
- **Paramètre d'abord**: `coolOnC`, `coolOffC`.

## 5) Plate safety validation

- **Action**: simuler plaque trop froide.
- **Télémétrie**: `plate_too_cold_latch`, `cool_reason`, `cool_on`.
- **Attendu**: latch ON -> compresseur bloqué (`plate_safety_block`), reprise seulement après `plateMinResumeC`.
- **Danger/bug**: compresseur continue alors plaque sous seuil.
- **Paramètre d'abord**: `plateMinOffC`, `plateMinResumeC`.

## 6) Lockout validation

- **Action**: provoquer un arrêt compresseur puis redemande immédiate.
- **Télémétrie**: `lockout_remaining_s`, `cool_reason`, `cool_on`.
- **Attendu**: redémarrage refusé tant que lockout > 0.
- **Danger/bug**: redémarrage rapide répété.
- **Paramètre d'abord**: `lockoutS`.

## 7) Humidity / MQTT validation

- **Action**: publier RH et T externes valides puis les laisser périmer.
- **Télémétrie**: `external_temp_fresh`, `external_humidity_fresh`, `mode`, `fault`.
- **Attendu**:
  - T stale => fallback air locale.
  - RH stale => `mode=temp_only` (pas de DRYING piloté RH).
- **Danger/bug**: DRYING encore actif avec RH stale.
- **Paramètre d'abord**: `tempStaleS`, `humidityStaleS`.

## 8) DRYING_ACTIVE validation

- **Action**: injecter RH > `target_humidity_rh + (humiditySetpointHysteresisRh/2)` avec capteurs valides.
- **Télémétrie**: `machine_state`, `cool_reason`, `heat_reason`, `simultaneous_mode_active`, `plate_target_c`.
- **Attendu**: entrée `DRYING_ACTIVE`, simultané autorisé, compresseur piloté plaque, chauffage piloté consigne air dédiée.
- **Danger/bug**: chauffage piloté directement par RH sans logique consigne air.
- **Paramètre d'abord**: `humiditySetpointHysteresisRh`, `dryingAirSetpointC`, `dryingAirHysteresisC`.

## 9) POST_COOL_INERTIA validation

- **Action**: après arrêt compresseur, observer phase inertie.
- **Télémétrie**: `machine_state`, `post_cool_active`, `cool_on`, `heat_on`.
- **Attendu**: `POST_COOL_INERTIA` actif, sorties OFF pendant observation.
- **Danger/bug**: redémarrage froid/chauffage pendant inertie.
- **Paramètre d'abord**: `inertiaMaxS`, `inertiaRiseFinishDeltaC`, `postCoolStableWindowS`.

## 10) Overshoot learning validation

- **Action**: laisser finir un ou plusieurs cycles inertie.
- **Télémétrie**: `last_min_plate_after_stop_c`, `overshoot_c`, `learned_max_runtime_s`, `last_post_cool_finalize_reason`.
- **Attendu**: `overshoot_c` mis à jour après finalize; si >2.0, baisse de `learned_max_runtime_s`.
- **Danger/bug**: `overshoot_c` figé alors pas de cible plaque valide.
- **Paramètre d'abord**: `dewTargetMarginC`, `adaptiveCoolOvershootStepDownS`.

## 11) hardMaxAirC override validation

- **Action**: faire monter `air_c` à `>= hardMaxAirC` pendant DRYING.
- **Télémétrie**: `machine_state`, `heat_reason`, `cool_reason`, `drying_overtemp_suspend`, `heat_on`.
- **Attendu**: suspension DRYING, priorité protection ambiance (`COOLING`), chauffage OFF.
- **Danger/bug**: DRYING reste dominant malgré surchauffe.
- **Paramètre d'abord**: `hardMaxAirC`, `dryingResumeBelowHardMaxC`.

## 12) Critical fault validation

- **Action**:
  1. simuler absence sonde air locale,
  2. simuler absence sonde plaque.
- **Télémétrie**: `fault`, `machine_state`, `cool_on`, `heat_on`, `cool_reason`.
- **Attendu**:
  - air locale manquante => `FAULT`, sorties OFF.
  - plaque manquante => refroidissement bloqué, chauffage encore possible selon logique air.
- **Danger/bug**: compresseur actif sans sonde air critique ou sans sécurité plaque.
- **Paramètre d'abord**: IDs capteurs + état matériel sonde.

## 13) Post-start monitoring (24–72h)

- **Action**: suivre tendances jour/nuit.
- **Télémétrie**: `machine_state`, `cycle_stop_reason`, `plate_too_cold_latch`, `overshoot_c`, `learned_max_runtime_s`, `fault`.
- **Attendu**: défauts rares, runtime appris qui se stabilise, peu de latch anti-gel.
- **Danger/bug**: `plate_safety_block` fréquent, `learned_runtime_limit` à chaque cycle, défauts capteurs/MQTT répétés.
- **Paramètre d'abord**:
  - sécurité: `plateMinOffC/plateMinResumeC`, `lockoutS`
  - séchage: `target_humidity_rh` + `humiditySetpointHysteresisRh`, `dewTargetMarginC`
  - runtime: `adaptiveCoolMax*`, `adaptiveCoolOvershootStepDownS`

## 14) Validation `drying_ineffective` (transitions)

- **Action**:
  1. Forcer une demande de séchage durable (`RH` au-dessus du seuil ON).
  2. Observer d'abord une phase où la plaque passe bien sous rosée.
  3. Simuler ensuite un cas défavorable (plaque qui reste proche/au-dessus de rosée malgré compresseur actif).
- **Télémétrie**: `machine_state`, `cool_on`, `condensing_now`, `drying_condensing_percent`, `drying_recent_compressor_s`, `drying_ineffective`, `drying_ineffective_reason`, `cool_reason`.
- **Attendu**:
  - `drying_ineffective=false` tant que la part de condensation reste suffisante.
  - `drying_ineffective=true` seulement après dépassement de `dryingIneffectiveMinCompressorS` et si `drying_condensing_percent` < `dryingIneffectiveMinCondensingPct`.
  - retour à `drying_ineffective=false` quand la condensation redevient suffisante.
- **Danger/bug**: `drying_ineffective` bascule trop tôt (avant durée mini), ou reste bloqué malgré retour de condensation.
- **Paramètre d'abord**: `dryingIneffectiveMinCompressorS`, `dryingIneffectiveMinCondensingPct`, `condensingRecentWindowS`.

## 15) Contrôle mémoire discovery (Shelly)

- **Action**:
  1. Démarrer avec `discoveryExtendedEnabled=false` et `discoveryCondensationDiagnosticsEnabled=true`.
  2. Vérifier boot + publication discovery + boucle de régulation stable.
  3. Si besoin, comparer avec `discoveryCondensationDiagnosticsEnabled=false` (profil minimal strict).
- **Télémétrie**: logs Shelly (absence d'`out of memory`), disponibilité MQTT `state/fault`.
- **Attendu**: pas d'erreur mémoire, discovery publié, régulation inchangée.
- **Danger/bug**: erreurs mémoire au boot ou messages MQTT manquants après publication discovery.
- **Paramètre d'abord**: `discoveryCondensationDiagnosticsEnabled`, puis `discoveryExtendedEnabled`.

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
- **Télémétrie**: `machine_state`, `cool_reason`, `heat_reason`, `simultaneous_mode_active`, `plate_target_c`, `drying_air_setpoint_c`, `drying_decision_reason`.
- **Attendu**: entrée `DRYING_ACTIVE`, simultané autorisé, compresseur piloté plaque, chauffage piloté par consigne air modulée (pseudo-proportionnel borné RH).
- **Danger/bug**: chauffage piloté directement par RH sans logique consigne air.
- **Paramètre d'abord**: `humiditySetpointHysteresisRh`, `dryingAirSetpointMinC`, `dryingAirSetpointMaxC`, `dryingAirProportionalBandRh`, `dryingAirHysteresisC`.

### 8-bis) Validation anti-pompage DRYING (A→H)

- **A. RH = rhSp**  
  Attendu: `drying_air_setpoint_c = dryingAirSetpointMinC`.
- **B. RH = rhSp + dryingAirProportionalBandRh**  
  Attendu: `drying_air_setpoint_c = dryingAirSetpointMaxC`.
- **C. RH intermédiaire**  
  Attendu: interpolation linéaire croissante entre min/max.
- **D. RH >= rh_on_threshold**  
  Attendu: entrée `DRYING_ACTIVE` si `drying_rest_remaining_s = 0`.
- **E. En DRYING_ACTIVE, RH <= rh_pause_threshold**  
  Attendu: sortie DRYING, retour régulation thermique simple, `drying_decision_reason=pause_near_setpoint`, repos armé.
- **F. Pendant `dryingMinRestS`**  
  Attendu: pas de relance DRYING, `drying_decision_reason=resting_after_drying`.
- **G. Après repos**  
  Attendu: relance DRYING possible si RH remonte à `rh_on_threshold`.
- **H. Priorité sécurités**  
  Attendu: `hardMaxAirC`, air trop froid, plaque trop froide, RH stale, défaut air local gardent la priorité sur DRYING.

## 9) hardMaxAirC override validation

- **Action**: faire monter `air_c` à `>= hardMaxAirC` pendant DRYING.
- **Télémétrie**: `machine_state`, `heat_reason`, `cool_reason`, `drying_overtemp_suspend`, `heat_on`.
- **Attendu**: suspension DRYING, priorité protection ambiance (`COOLING`), chauffage OFF.
- **Danger/bug**: DRYING reste dominant malgré surchauffe.
- **Paramètre d'abord**: `hardMaxAirC`, `dryingResumeBelowHardMaxC`.

## 10) Publication sur transition (réactivité supervision)

- **Action**: provoquer successivement `IDLE -> COOLING -> IDLE` (ou `IDLE -> HEATING -> IDLE`) en faisant franchir les seuils.
- **Télémétrie**: timestamp MQTT des messages `.../state`, `machine_state`, `cool_on`, `heat_on`.
- **Attendu**: publication périodique conservée + publication immédiate lors de transition d'état/actionneur.
- **Danger/bug**: état relais changé sans nouveau message `state` rapide.
- **Paramètre d'abord**: `mqttPublishMs`, `mqttPublishOnTransition`.

## 11) Fraîcheur MQTT (anti-spam défauts info)

- **Action**: injecter une T/RH externe valide, attendre péremption, puis republier des valeurs valides.
- **Télémétrie**: topic `.../fault`, `external_temp_fresh`, `external_humidity_fresh`, `mode`.
- **Attendu**:
  - transition vers périmé => événement unique `EXTERNAL_*_STALE`,
  - retour frais => événement unique `EXTERNAL_*_FRESH`,
  - pas de spam répétitif à chaque boucle.
- **Danger/bug**: répétition continue des mêmes défauts info sans changement d'état.
- **Paramètre d'abord**: `tempStaleS`, `humidityStaleS`.

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

## 13) Validation configuration au boot (`CONFIG_INVALID`)

- **Action**: introduire volontairement une incohérence simple (ex: `coolOffC >= coolOnC`) puis redémarrer script.
- **Télémétrie**: topic `.../fault`, présence/absence des cycles réguliers `.../state`.
- **Attendu**: défaut critique `CONFIG_INVALID` publié, boucle de régulation non démarrée.
- **Danger/bug**: démarrage en régulation malgré configuration incohérente.
- **Paramètre d'abord**: `coolOnC/coolOffC`, `heatOnC/heatOffC`, `plateMinOffC/plateMinResumeC`, IDs capteurs/relais.

## 14) Post-start monitoring (24–72h)

- **Action**: suivre tendances jour/nuit.
- **Télémétrie**: `machine_state`, `cycle_stop_reason`, `last_plate_event`, `plate_too_cold_latch`, `fault`.
- **Attendu**: défauts rares, transitions d'état cohérentes, peu de latch anti-gel.
- **Danger/bug**: `plate_safety_block` fréquent, `last_plate_event=plate_safety_blocked` récurrent, défauts capteurs/MQTT répétés.
- **Paramètre d'abord**:
  - sécurité: `plateMinOffC/plateMinResumeC`, `lockoutS`
  - séchage: `target_humidity_rh` + `humiditySetpointHysteresisRh`, `dewTargetMarginC`
  - discovery/mémoire: `discoveryExtendedEnabled`, `discoveryDebugEnabled`.

## 15) Contrôle mémoire discovery (Shelly)

- **Action**:
  1. Démarrer avec `discoveryExtendedEnabled=false`.
  2. Vérifier boot + publication discovery + boucle de régulation stable.
  3. Si besoin, comparer avec `discoveryExtendedEnabled=true` (profil étendu).
- **Télémétrie**: logs Shelly (absence d'`out of memory`), disponibilité MQTT `state/fault`.
- **Attendu**: pas d'erreur mémoire, discovery publié, régulation inchangée.
- **Danger/bug**: erreurs mémoire au boot ou messages MQTT manquants après publication discovery.
- **Paramètre d'abord**: `discoveryExtendedEnabled`, puis `discoveryDebugEnabled`.

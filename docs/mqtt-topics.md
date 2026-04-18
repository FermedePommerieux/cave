# MQTT topics

Préfixe par défaut : `fdp_communs_cave_saucissons`

Objet HA (identifiant logique) : `cave_saucisson`

## Topics consommés

### 1) Température externe

- Topic : `fdp_communs_cave_saucissons/thermostat/external_temperature`
- Payload attendu : nombre (float) en °C
  - Exemples valides : `12.3`, `"12.3"`
- Fraîcheur max : `tempStaleS` (900 s par défaut)
- Si invalide/périmé : fallback automatique sur sonde air locale

### 2) Humidité externe

- Topic : `fdp_communs_cave_saucissons/thermostat/external_humidity`
- Payload attendu : nombre (float) en %RH (0..100)
  - Exemples valides : `78`, `"78.5"`
- Fraîcheur max : `humidityStaleS` (10800 s par défaut)
- Si invalide/périmé : mode température seule (pas de pilotage point de rosée)

### 3) Commandes Home Assistant humidifier

- Topic power : `fdp_communs_cave_saucissons/cave_saucisson/set/power`
  - Payloads valides : `ON`, `OFF`
  - `ON` => active le contrôleur (`enabled=true`)
  - `OFF` => désactive le contrôleur (`enabled=false`)
- Topic mode : `fdp_communs_cave_saucissons/cave_saucisson/set/mode`
  - Payloads valides : `off`, `auto`
  - `off` => désactive le contrôleur (`enabled=false`)
  - `auto` => active le contrôleur (`enabled=true`)
- Topic cible humidité : `fdp_communs_cave_saucissons/cave_saucisson/set/target_humidity`
  - Payload valide : nombre entre `0` et `100`
  - Payload invalide : ignoré
- Topic mode (HA humidifier dédié) : `fdp_communs_cave_saucissons/cave_saucisson/mode/set`
  - Payloads valides : `1`, `0`
  - `1` => active le contrôleur (`enabled=true`)
  - `0` => désactive le contrôleur (`enabled=false`)
- Topic cible humidité (HA humidifier dédié) : `fdp_communs_cave_saucissons/cave_saucisson/target/set`
  - Payload valide : nombre entre `0` et `100`
  - Payload invalide : ignoré

## Topics publiés

### 1) État global

- Topic : `fdp_communs_cave_saucissons/cave_saucisson/state`
- Fréquence : toutes les `mqttPublishMs` (5000 ms par défaut) + événements importants
- Champs clés publiés :
  - `enabled`, `target_humidity_rh`
  - `machine_state` : `IDLE|COOLING|POST_COOL_INERTIA|HEATING|DRYING_ACTIVE|FAULT`
  - `cool_reason`, `heat_reason`
  - `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`
  - `dew_point_c`, `plate_target_c`
  - `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`, `last_min_plate_after_stop_c`, `overshoot_c`
  - `learned_max_runtime_s`
  - `drying_overtemp_suspend` (suspension temporaire du séchage actif sur surchauffe ambiance)
  - `simultaneous_mode_active` (true seulement en `DRYING_ACTIVE`)

Payload JSON (exemple) :

```json
{
  "enabled": true,
  "target_humidity_rh": 78.0,
  "mode": "temp+humidity",
  "machine_state": "DRYING_ACTIVE",
  "cool_reason": "drying_plate_target",
  "heat_reason": "drying_air_setpoint",
  "simultaneous_mode_active": true,
  "air_c": 12.2,
  "plate_c": 5.4,
  "control_temp_c": 12.0,
  "humidity_rh": 81.0,
  "humidity_control_available": true,
  "humidity_demand_active": true,
  "drying_mode_requested": true,
  "drying_block_reason": "none",
  "humidity_mode": "external_valid",
  "dew_point_c": 8.9,
  "plate_target_c": 7.9,
  "cool_on": true,
  "heat_on": true,
  "cycle_stop_reason": "drying_plate_hysteresis",
  "last_plate_event": "plate_target_reached",
  "last_post_cool_finalize_reason": "plate_stable",
  "last_min_plate_after_stop_c": 6.8,
  "overshoot_c": 1.1,
  "learned_max_runtime_s": 225,
  "drying_overtemp_suspend": false,
  "fault": "none"
}
```

Sémantique humidité explicite :

- `humidity_control_available` : humidité externe exploitable (`true`) ou non (`false`).
- `humidity_demand_active` : demande séchage active selon hystérésis RH.
- `drying_mode_requested` : conditions DRYING remplies avant arbitrages de priorité globaux.
- `drying_block_reason` : `none|humidity_stale|below_rh_off|overtemp_suspend|no_plate_target`.
- `humidity_mode` : `external_valid|external_stale|not_available`.

### 2) Défauts / événements

- Topic : `fdp_communs_cave_saucissons/cave_saucisson/fault`
- Payload JSON (exemple)

```json
{
  "code": "AIR_SENSOR_MISSING",
  "severity": "critical",
  "message": "Local air sensor unavailable; outputs forced off",
  "ts": 1713400000
}
```

### 3) Topics dédiés humidifier (simples, retained)

- Base topic : `fdp_communs_cave_saucissons/cave_saucisson`
- `.../mode/state` :
  - `1` si `enabled=true`
  - `0` si `enabled=false`
- `.../target/state` : valeur numérique de `target_humidity_rh`
- `.../current` : humidité courante si disponible
  - si indisponible : payload retained `None` (reset explicite côté Home Assistant)
- `.../action` : `drying|idle|off` selon l'état machine courant

## Règles de fraîcheur

- Une mesure MQTT est exploitable seulement si :
  - payload numérique valide
  - timestamp de réception < fenêtre de péremption configurée

## Home Assistant MQTT Discovery

- Préfixe discovery : `homeassistant`
- Publication retained déclenchée depuis la boucle de contrôle uniquement quand MQTT est connecté.
- Retry automatique à chaque boucle tant que la discovery n'a pas encore été publiée avec succès.
- L'entité humidifier utilise des topics dédiés simples (sans templates JSON).
- Les entités `sensor`/`binary_sensor` restent basées sur `fdp_communs_cave_saucissons/cave_saucisson/state` avec templates.

## États et défauts principaux

- `AIR_SENSOR_MISSING` : état `FAULT` et arrêt immédiat de tous les actionneurs.
- `PLATE_SENSOR_MISSING` : froid interdit (chauffage toujours borné par règles température).
- `EXTERNAL_TEMP_STALE` : info, fallback air local.
- `EXTERNAL_HUMIDITY_STALE` : info, mode température seule.


## Home Assistant MQTT Discovery (entités publiées)

Les configs Discovery retained sont publiées sous:
`homeassistant/<component>/cave_saucisson_<entity_key>/config`

- `humidifier` (format dédié)
  - `homeassistant/humidifier/fdp_communs_cave_saucissons/cave_saucisson/config`

- `sensor`
  - `air_temperature`, `plate_temperature`, `control_temperature`
  - `humidity`, `target_humidity`, `dew_point`, `plate_target`, `overshoot`, `last_min_plate_after_stop`
  - `learned_max_runtime`, `lockout_remaining`
  - `machine_state`, `cool_reason`, `heat_reason`, `drying_block_reason`, `humidity_mode`, `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`, `fault`

- `binary_sensor`
  - `post_cool_active`, `plate_too_cold_latch`, `drying_overtemp_suspend`, `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `cool_on`, `heat_on`, `enabled`

Nettoyage de compatibilité: publication retained vide sur
`homeassistant/climate/cave_saucisson_climate/config` pour supprimer une ancienne entité climate si elle existe.
Nettoyage de compatibilité humidifier historique: publication retained vide sur
`homeassistant/humidifier/cave_saucisson_humidifier/config`.

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

### 3) Commandes Home Assistant humidifier/dehumidifier

- Topic mode : `fdp_communs_cave_saucissons/cave_saucisson/set/mode`
  - Payloads valides : `off`, `auto`
  - `off` => désactive le contrôleur (`enabled=false`)
  - `auto` => active le contrôleur (`enabled=true`)
  - Ce topic est utilisé à la fois comme `command_topic` (ON/OFF via mapping HA) et `mode_command_topic`.
- Topic cible humidité : `fdp_communs_cave_saucissons/cave_saucisson/set/target_humidity`
  - Payload valide : nombre entre `0` et `100`
  - Payload invalide : ignoré

## Topics publiés

### 1) État global

- Topic : `fdp_communs_cave_saucissons/cave_saucisson/state`
- Fréquence : toutes les `mqttPublishMs` (5000 ms par défaut) + événements importants
- Champs clés publiés :
  - `enabled`, `target_humidity_rh`, `target_humidity_requested_rh`
  - `machine_state` : `IDLE|COOLING|POST_COOL_INERTIA|HEATING|DRYING_ACTIVE|FAULT`
  - `cool_reason`, `heat_reason`
  - `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`
  - `dew_temp_source`, `dew_point_c`, `plate_target_c`, `plate_minus_dew_c`, `condensing_now`
  - `drying_ineffective`
  - `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`, `last_min_plate_after_stop_c`, `overshoot_c`
  - `learned_max_runtime_s`
  - `drying_overtemp_suspend` (suspension temporaire du séchage actif sur surchauffe ambiance)
  - `simultaneous_mode_active` (true seulement en `DRYING_ACTIVE`)

Payload JSON (exemple) :

```json
{
  "enabled": true,
  "target_humidity_rh": 78.0,
  "target_humidity_requested_rh": 82.0,
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
  "dew_temp_source": "local_air",
  "dew_point_c": 8.9,
  "plate_target_c": 7.9,
  "plate_minus_dew_c": -1.2,
  "condensing_now": true,
  "drying_ineffective": false,
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

- `target_humidity_requested_rh` : consigne brute demandée via MQTT/HA (non bornée).
- `target_humidity_rh` : consigne effectivement utilisée par la régulation (consigne demandée bornée par `humiditySetpointMinRh..humiditySetpointMaxRh`).
- `humidity_control_available` : humidité externe exploitable (`true`) ou non (`false`).
- `humidity_demand_active` : demande séchage active selon hystérésis RH.
- `drying_mode_requested` : conditions DRYING remplies avant arbitrages de priorité globaux.
- `drying_block_reason` : `none|humidity_stale|overtemp_suspend|no_humidity_request|no_plate_target`.
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

## Règles de fraîcheur

- Une mesure MQTT est exploitable seulement si :
  - payload numérique valide
  - timestamp de réception < fenêtre de péremption configurée

## Home Assistant MQTT Discovery

- Préfixe discovery : `homeassistant`
- Publication retained au boot.
- Entité principale publiée via composant MQTT `humidifier` avec `device_class=dehumidifier`.
- Topic de vérité unique pour les entités : `fdp_communs_cave_saucissons/cave_saucisson/state`
- Les entités extraient leurs champs via `value_template`/`*_template`.

### Profils discovery

#### 1) Mode minimal (recommandé Shelly, défaut)

`CONFIG.discoveryExtendedEnabled = false`

Entités publiées :
- `homeassistant/humidifier/cave_saucisson_humidifier/config`
- `homeassistant/sensor/cave_saucisson_air_temperature/config`
- `homeassistant/sensor/cave_saucisson_plate_temperature/config`
- `homeassistant/sensor/cave_saucisson_humidity/config`
- `homeassistant/sensor/cave_saucisson_machine_state/config`
- `homeassistant/sensor/cave_saucisson_fault/config`

Ce profil limite le pic mémoire au boot (moins de payloads JSON retained), n'ajoute aucune entité condensation et garde `CONFIG.discoveryCondensationDiagnosticsEnabled=false` par défaut.

#### 2) Mode étendu (optionnel)

`CONFIG.discoveryExtendedEnabled = true`

Publie uniquement le noyau condensation utile:
- `homeassistant/sensor/cave_saucisson_dew_point/config`
- `homeassistant/sensor/cave_saucisson_plate_target/config`
- `homeassistant/sensor/cave_saucisson_plate_minus_dew/config`
- `homeassistant/binary_sensor/cave_saucisson_condensing_now/config`

À activer seulement si la mémoire disponible le permet.

Compatibilité robuste appliquée:
- payloads discovery nettoyés des champs `null`/`undefined`
- binary_sensor avec `payload_on="true"` et `payload_off="false"` (pas de booléens JSON bruts)
- capteurs numériques avec `value_template` défensif : `{{ value_json.<champ> | default(none) }}`

### Procédure de purge retained discovery (avant redéploiement)

Quand HA a déjà appris des payloads discovery invalides, il faut supprimer les retained `homeassistant/.../config` puis republier.

> Important : `mosquitto_pub` **n'accepte pas les wildcards en publication**.  
> La commande `mosquitto_pub -t "homeassistant/+/cave_saucisson_+/config" -n -r` est donc incorrecte.

Le script applique désormais une migration robuste et frugale au boot :
- purge explicite retained des topics discovery `cave_saucisson` connus (minimal + étendu + obsolètes),
- puis republication du profil actif (minimal par défaut) avec payloads JSON valides.

Procédure opérable en conditions réelles (broker déjà pollué) :

1. Arrêter le script Shelly.
2. Lister les retained discovery existants du contrôleur :

```bash
mosquitto_sub -h <BROKER_HOST> -t 'homeassistant/#' -F '%t' -C 500 | grep 'cave_saucisson_'
```

3. Supprimer les retained par topics exacts (exemples) :

```bash
mosquitto_pub -h <BROKER_HOST> -t 'homeassistant/humidifier/cave_saucisson_humidifier/config' -n -r
mosquitto_pub -h <BROKER_HOST> -t 'homeassistant/sensor/cave_saucisson_air_temperature/config' -n -r
mosquitto_pub -h <BROKER_HOST> -t 'homeassistant/sensor/cave_saucisson_fault/config' -n -r
```

4. (Optionnel) Supprimer aussi d'éventuels topics historiques :

```bash
mosquitto_pub -h <BROKER_HOST> -t 'homeassistant/climate/cave_saucisson_climate/config' -n -r
```

5. Redémarrer le script Shelly pour republier tous les payloads discovery propres.
6. Vérifier l'absence d'erreurs `Unable to parse JSON ...` dans les logs HA.

### Debug discovery côté broker

Pour diagnostiquer un broker/retained récalcitrant sans toucher à la régulation :

- activer `CONFIG.discoveryDebugEnabled = true`,
- observer le topic `fdp_communs_cave_saucissons/cave_saucisson/debug/discovery_payload`.

> Recommandation stabilité : laisser `CONFIG.discoveryDebugEnabled = false` sur Shelly en production.

Chaque message contient :
- `action`: `purge` ou `publish`
- `discovery_topic`: topic Home Assistant ciblé
- `payload`: JSON exact envoyé (ou `null` pour purge)

## États et défauts principaux

- `AIR_SENSOR_MISSING` : état `FAULT` et arrêt immédiat de tous les actionneurs.
- `PLATE_SENSOR_MISSING` : froid interdit (chauffage toujours borné par règles température).
- `EXTERNAL_TEMP_STALE` : info, fallback air local.
- `EXTERNAL_HUMIDITY_STALE` : info, mode température seule.

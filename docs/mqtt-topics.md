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
- Si invalide/périmé : mode température seule (pas de déshumidification pilotée)

## Topics publiés

### 1) État global

- Topic : `fdp_communs_cave_saucissons/cave_saucisson/state`
- Fréquence : toutes les `mqttPublishMs` (5000 ms par défaut) + événements importants
- Payload JSON (exemple)

```json
{
  "enabled": true,
  "mode": "temp+humidity",
  "air_c": 12.4,
  "plate_c": 4.1,
  "control_temp_c": 12.1,
  "external_temp_fresh": true,
  "external_humidity_fresh": true,
  "humidity_rh": 79.0,
  "cool_on": false,
  "heat_on": false,
  "fault": "none"
}
```

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

## États et défauts principaux

- `AIR_SENSOR_MISSING` : arrêt immédiat de tous les actionneurs.
- `PLATE_SENSOR_MISSING` : froid interdit (chauffage toujours borné par règles température).
- `EXTERNAL_TEMP_STALE` : info, fallback air local.
- `EXTERNAL_HUMIDITY_STALE` : info, mode température seule.

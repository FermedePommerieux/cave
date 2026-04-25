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
- MQTT : état (retained), mode, défauts, fraîcheur capteurs
- MQTT Discovery Home Assistant (retained) : publication au boot

Contraintes de robustesse discovery Home Assistant:
- publication en JSON strict uniquement
- pas de champs `null`/`undefined` dans les payloads `.../config`
- capteurs booléens publiés en binary_sensor avec mapping explicite `payload_on="true"` / `payload_off="false"`
- entité principale `humidifier` (`device_class=dehumidifier`) avec:
  - état `auto|off` (`state_value_template` et `mode_state_template`)
  - action courante `off|idle|drying` (`action_topic` + `action_template`)
- templates discovery défensifs (`default(none)` pour numériques) pour éviter des états `unknown` cassants côté HA
- mode discovery minimal par défaut (`CONFIG.discoveryExtendedEnabled=false`) pour sobriété mémoire:
  - `humidifier` + capteurs essentiels (`air_temperature`, `plate_temperature`, `humidity`, `machine_state`, `fault`)
  - aucun `binary_sensor` ni capteur condensation additionnel en mode minimal strict
- mode discovery étendu optionnel (`CONFIG.discoveryExtendedEnabled=true`) réduit au noyau condensation:
  - `dew_point`, `plate_target`, `plate_minus_dew`, `condensing_now`
- migration discovery au boot: purge explicite des retained `cave_saucisson` connus (minimal + étendu/obsolètes), puis republication du profil actif
- debug discovery optionnel via topic MQTT dédié (`CONFIG.discoveryDebugEnabled=false` par défaut, sans effet sur la régulation)

### Commandes MQTT (minimales)

- `.../set/mode` :
  - `off` => `STATE.enabled=false`
  - `auto` => `STATE.enabled=true`
- `.../set/target_humidity` :
  - payload numérique accepté seulement en plage `0..100`
  - sinon ignoré sans effet de bord

## Machine à états

États runtime explicites (version KISS) :

- `IDLE` : aucune demande active
- `COOLING` : froid actif (demande thermique air ou cible plaque en déshumidification)
- `HEATING` : chauffage actif (protection air ou compensation déshumidification)
- `DRYING_ACTIVE` : demande de déshumidification active
- `FAULT` : arrêt forcé de tous les actionneurs

## Logique de régulation

### 1) Régulation air cave

- Fallback température : MQTT externe fraîche sinon sonde air locale.
- Chauffage limité à la protection basse température (`HEATING`) hors mode séchage.
- Refroidissement thermique via hystérésis air (`coolOnC` / `coolOffC`).

### 2) Régulation plaque de condensation

- Si humidité MQTT valide, calcul du point de rosée.
- Source température du point de rosée configurable (`dewPointTempSource`):
  - `local_air` (défaut)
  - `external_if_fresh` (température MQTT externe si fraîche, sinon fallback air locale)
- Cible plaque : `plateTargetC = dewPointC - dewTargetMarginC`.
- En `DRYING_ACTIVE`, compresseur piloté d'abord par la cible plaque (hystérésis dédiée).
- Température plaque reste la vérité de sécurité (anti-gel/latch).

### Mode `DRYING_ACTIVE`

- Entrée : humidité valide au-dessus de `target_humidity_rh + (humiditySetpointHysteresisRh / 2)`.
- Sortie anticipée près consigne : humidité `<= target_humidity_rh + dryingPauseAboveSetpointRh`, puis repos `dryingMinRestS` avant relance.
- La consigne utilisateur `target_humidity_rh` est bornée par `humiditySetpointMinRh..humiditySetpointMaxRh`.
- Le compresseur est piloté par la cible plaque autour du point de rosée (hystérésis ON/OFF simple).
- Le chauffage en déshumidification est une compensation thermique explicite avec pseudo-correcteur proportionnel borné sur consigne air:
  - RH proche consigne -> consigne `dryingAirSetpointMinC`
  - RH haute au-dessus consigne -> consigne interpolée jusqu'à `dryingAirSetpointMaxC`
  - pas de PID complet (pas d'intégrale, pas de dérivée, pas d'historique complexe)
- Simultané chauffage + compresseur autorisé **uniquement** en déshumidification active.
- Si l'air devient trop froid (`airC <= heatOnC`), le compresseur est bloqué (latch avec reprise à `airC >= heatOffC`), y compris en `DRYING_ACTIVE`.
- Si `airC >= hardMaxAirC`, la sécurité ambiance prime (chauffage coupé, froid de protection autorisé selon sécurité plaque + lockout).

## Priorités de sécurité

Ordre de priorité :

1. Défaut critique capteur air local => état `FAULT`, tout OFF
2. Protection plaque froide / anti-gel + blocage compresseur air trop froid
3. Interdiction simultané chauffage/froid hors `DRYING_ACTIVE`
4. Verrou anti-cycles compresseur (`lockoutS`)
5. Régulation fine thermique/hygrométrique

## Séquence de démarrage sûre (bootstrap)

- Au boot, le script force **physiquement** les deux relais (`switch:0` froid, `switch:1` chauffage) à `OFF` sans dépendre de l'état interne.
- L'état runtime est ensuite resynchronisé explicitement (`coolOn=false`, `heatOn=false`) pour aligner logiciel et matériel.
- Un verrou compresseur est armé immédiatement (`coolingLockoutUntil = now + lockoutS`) avant la reprise de la boucle de régulation.
- Avant démarrage normal, la configuration est validée (IDs distincts, seuils cohérents, hystérésis/lockout strictement positifs). En cas d'erreur: publication `CONFIG_INVALID`, pas d'entrée en boucle.
- La régulation normale reprend ensuite avec les mêmes règles métier; seul le bootstrap est durci pour la sûreté redémarrage.

## Modes dégradés

- Température externe absente/périmée -> fallback air local.
- Humidité externe absente/périmée -> mode température seule (pas de logique point de rosée).
- Capteur plaque absent -> froid interdit (chauffage possible selon sécurité air).

## Philosophie KISS

- Machine à états explicite et télémétrée.
- Hystérésis et seuils lisibles dans `CONFIG`.
- Zéro dépendance runtime externe.
- Décisions critiques tracées (`state` + `fault`) pour exploitation terrain.
- Télémétrie d'arrêt simplifiée: `cycle_stop_reason` + raisons chaud/froid.
- Publication MQTT `state` périodique + publication immédiate sur transition d'état/actionneurs (si `CONFIG.mqttPublishOnTransition=true`).
- Statut humidité explicite dans `state`: disponibilité (`humidity_control_available`), demande (`humidity_demand_active`), requête DRYING (`drying_mode_requested`), blocage (`drying_block_reason`), mode source (`humidity_mode`).

## Observabilité condensation

Le `state` publie désormais des métriques orientées efficacité réelle de séchage:
- `target_humidity_rh`, `target_humidity_requested_rh`
- `dew_temp_source`, `dew_point_c`, `plate_target_c`, `plate_minus_dew_c`
- `condensing_now`
- diagnostic DRYING modulé: `drying_air_setpoint_c`, `drying_air_hysteresis_c`, `drying_heat_on_c`, `drying_heat_off_c`
- seuils RH et repos: `rh_on_threshold`, `rh_pause_threshold`, `drying_rest_remaining_s`, `drying_decision_reason`

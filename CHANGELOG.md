# Changelog

Tous les changements notables de ce projet seront documentés dans ce fichier.

Le format s'inspire de Keep a Changelog et suit SemVer quand pertinent.

## [0.2.4] - 2026-04-19

### Fixed
- Migration MQTT Discovery Home Assistant durcie au boot: purge retained explicite des topics `homeassistant/.../cave_saucisson_*/config` connus avant republication, y compris les binary sensors en erreur (`post_cool_active`, `plate_too_cold_latch`, `drying_overtemp_suspend`, `humidity_control_available`, `drying_mode_requested`).
- Purge d'entités discovery historiques obsolètes ajoutée (`climate` legacy), pour éviter la réapparition d'anciens payloads invalides persistés broker.

### Added
- Télémétrie de debug discovery optionnelle (`CONFIG.discoveryDebugEnabled`) publiant l'action (`purge|publish`), le topic cible et le payload exact envoyé.

### Documentation
- Correction de la procédure de purge retained: suppression de la commande `mosquitto_pub` avec wildcard en publication (incorrecte MQTT), remplacée par une procédure par topics exacts + découverte préalable.

## [0.2.3] - 2026-04-19

### Fixed
- Robustesse MQTT Discovery Home Assistant: suppression des champs `null`/`undefined` dans les payloads `homeassistant/.../config`.
- Compatibilité `binary_sensor` renforcée: templates booléens normalisés et `payload_on="true"` / `payload_off="false"` explicites.
- Capteurs discovery plus tolérants aux champs absents (`default(none)`), notamment pour `learned_max_runtime`, `overshoot`, `lockout_remaining`, `last_min_plate_after_stop` et `drying_mode_requested`.

### Documentation
- Ajout d'une procédure opérationnelle de purge des retained discovery avant redéploiement.

## [0.2.2] - 2026-04-19

### Fixed
- Conformité MQTT Discovery de l'entité principale Home Assistant: ajout de `command_topic` (requis), `payload_on/off` et `state_value_template` (`ON`/`OFF`) pour l'entité `humidifier`.
- Clarification sémantique Home Assistant: l'entité conserve le composant MQTT `humidifier` mais publie désormais `device_class=dehumidifier` et le nom "Cave Dehumidifier".

## [0.2.1] - 2026-04-18

### Added
- Télémétrie MQTT humidité explicite dans `state`: `humidity_control_available`, `humidity_demand_active`, `drying_mode_requested`, `drying_block_reason`, `humidity_mode`.
- Home Assistant MQTT Discovery (retained, préfixe `homeassistant`) pour 1 humidifier + capteurs/binary sensors depuis le topic JSON `state`.
- Commandes MQTT minimales pour l'entité humidifier: `set/mode` (`off|auto`) et `set/target_humidity` (`0..100`).
- Champ `target_humidity_rh` publié dans `state`.

## [0.2.0] - 2026-04-18

### Changed
- Refactor de la régulation en machine à états (`IDLE`, `COOLING`, `POST_COOL_INERTIA`, `HEATING`, `DRYING_ACTIVE`, `FAULT`).
- Introduction d'une régulation à deux niveaux : air cave + plaque de condensation.
- Autorisation contrôlée du simultané chauffage+froid uniquement en `DRYING_ACTIVE`.
- Pilotage compresseur sur cible plaque dérivée du point de rosée quand l'humidité est valide.
- Apprentissage de runtime compresseur basé sur inertie post-arrêt et overshoot plaque.
- Priorité renforcée de `POST_COOL_INERTIA` : aucune reprise chauffage/froid avant fin de suivi inertiel.
- Fin d'inertie améliorée: sortie possible sur stabilité des minima (`plate_stable`) via `postCoolMinDeltaC` + `postCoolStableWindowS`, avec timeout raccourci.
- Télémetrie d'arrêt compresseur clarifiée avec trois champs distincts: `cycle_stop_reason`, `last_plate_event`, `last_post_cool_finalize_reason`.
- Priorité hard-max ambiance ajoutée: suspension de `DRYING_ACTIVE` à `airC >= hardMaxAirC` et reprise sous `dryingResumeBelowHardMaxC`.

### Added
- Nouvelle télémétrie MQTT de diagnostic: état machine, raisons chaud/froid, point de rosée, cible plaque, overshoot et runtime appris.

## [0.1.0] - 2026-04-18

### Added
- Initialisation complète du dépôt.
- Script Shelly unique `src/cave_saucisson.js` pour pilotage cave à saucissons.
- Documentation d'architecture, mise en service et MQTT.
- Fichiers de gouvernance (contribution, sécurité, modèles GitHub).
